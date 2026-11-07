// Proves that TokenRouter enforces per-key quotas before any pool key is handed out. Costs under a cent.
//
//   node relay/scripts/verify-quota.mjs sk-<a spare console key>
//
// Steps: cap the key at $1 -> read back -> one tiny request succeeds -> cap at $0 -> the same request is refused
// -> cap restored to $1. Env: TOKENROUTER_BASE_URL, TOKENROUTER_MANAGEMENT_KEY.
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
const key = process.argv[2];
if (!key || !MGMT) {
  console.error("usage: node relay/scripts/verify-quota.mjs sk-…   (needs TOKENROUTER_MANAGEMENT_KEY)");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function quota(remain) {
  const r = await fetch(`${BASE}/api/management/api-keys/quota`, { method: "PUT", headers: { authorization: `Bearer ${MGMT}`, "content-type": "application/json" }, body: JSON.stringify({ key, unlimited_quota: false, remain_quota: remain }) });
  const j = await r.json();
  if (!r.ok || j.success === false) throw new Error(`quota -> ${r.status} ${j.message ?? ""}`);
  return j.data;
}
async function tinyRequest() {
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Say OK." }], max_tokens: 2 }) });
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 200) };
}

const results = {};
let d = await quota(1);
results.cap_1 = { unlimited: d.unlimited_quota, remain: d.remain_quota, used: d.used_quota };
await sleep(1500);
results.request_at_1 = await tinyRequest();
await sleep(6500);
d = await quota(0);
results.cap_0 = { unlimited: d.unlimited_quota, remain: d.remain_quota };
await sleep(1500);
results.request_at_0 = await tinyRequest();
await sleep(6500);
d = await quota(1);
results.restored = { remain: d.remain_quota };
results.enforced = results.request_at_1.status === 200 && results.request_at_0.status >= 400;
console.log(JSON.stringify(results, null, 2));
if (!results.enforced) {
  console.error("QUOTA NOT ENFORCED AS EXPECTED. Do not load the pool.");
  process.exit(1);
}
console.error("quota enforcement confirmed");
