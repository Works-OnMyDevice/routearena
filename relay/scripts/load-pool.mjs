// Caps console-created TokenRouter keys at PER_CLAIM_USD, verifies the cap by reading it back, then loads
// the verified keys into the relay pool. Run locally; never commit pool.local.json.
//
//   node relay/scripts/load-pool.mjs relay/pool.local.json
//
// Env (from relay/.env or the shell): TOKENROUTER_BASE_URL, TOKENROUTER_MANAGEMENT_KEY, ADMIN_SECRET,
// PUBLIC_BASE_URL (the deployed relay), PER_CLAIM_USD (default 1).
// Input file: [{ "key": "sk-…", "name": "ra-pool-001" }, …]
// The Management API allows 10 quota calls per minute, so 50 keys take about 5 minutes.
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
for (const f of [path.join(here, "..", ".env"), path.join(here, "..", ".env.local")]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const BASE = (process.env.TOKENROUTER_BASE_URL || "https://api.tokenrouter.com").replace(/\/$/, "");
const MGMT = process.env.TOKENROUTER_MANAGEMENT_KEY;
const ADMIN = process.env.ADMIN_SECRET;
const RELAY = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const BUDGET = Math.min(Number(process.env.PER_CLAIM_USD || 1), 5);
const file = process.argv[2];
if (!file || !MGMT || !ADMIN || !RELAY) {
  console.error("usage: node relay/scripts/load-pool.mjs <pool.local.json>   (needs TOKENROUTER_MANAGEMENT_KEY, ADMIN_SECRET, PUBLIC_BASE_URL)");
  process.exit(2);
}
const input = JSON.parse(fs.readFileSync(file, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mgmt(method, p, body) {
  const r = await fetch(`${BASE}/api/management${p}`, { method, headers: { authorization: `Bearer ${MGMT}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`${method} ${p} -> ${r.status} ${j.message ?? ""}`);
  return j;
}
async function listAll() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await mgmt("GET", `/api-keys?page=${page}&page_size=100`);
    out.push(...(j.data?.items ?? []));
    if ((j.data?.items ?? []).length < 100) break;
  }
  return out;
}

// 1. Cap every key (paced to the 10/min limit).
const capped = [];
for (const [i, k] of input.entries()) {
  if (!k.key?.startsWith("sk-") || !k.name) {
    console.error(`skip entry ${i}: needs key (sk-…) and name`);
    continue;
  }
  try {
    const j = await mgmt("PUT", "/api-keys/quota", { key: k.key, unlimited_quota: false, remain_quota: Math.round(BUDGET) });
    const d = j.data ?? {};
    if (d.unlimited_quota !== false || Number(d.remain_quota) > BUDGET) throw new Error(`cap not applied: ${JSON.stringify({ unlimited: d.unlimited_quota, remain: d.remain_quota })}`);
    if (Number(d.used_quota ?? 0) > 0) throw new Error(`key already used ($${d.used_quota}); refusing`);
    capped.push({ key: k.key, name: k.name, capped: true });
    console.error(`capped ${k.name} at $${d.remain_quota}`);
  } catch (e) {
    console.error(`FAILED ${k.name}: ${e.message}`);
  }
  if (i < input.length - 1) await sleep(6500);
}

// 2. Read back the masked listing and confirm every capped key is limited and <= budget.
await sleep(6500);
const listing = await listAll();
const verified = capped.filter((k) => {
  const row = listing.find((r) => r.name === k.name);
  const ok = row && row.unlimited_quota === false && Number(row.remain_quota) <= BUDGET && row.status === 1;
  if (!ok) console.error(`NOT VERIFIED ${k.name}: ${JSON.stringify(row ?? null)}`);
  return ok;
});

// 3. Load into the relay pool.
if (!verified.length) {
  console.error("nothing verified; pool unchanged");
  process.exit(1);
}
const r = await fetch(`${RELAY}/api/admin/pool`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ keys: verified }) });
console.log(await r.text());
console.error(`loaded ${verified.length} of ${input.length} keys. Delete ${file} now.`);
