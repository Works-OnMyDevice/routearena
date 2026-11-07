// End-to-end budget enforcement against the real Worker running locally (wrangler dev + Durable Object SQLite)
// with a mock TokenRouter. Proves the $1 per-person cap and the global cap under concurrency, missing usage,
// cancelled streams, unknown models, and key mode. Run: node test/integration.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.resolve(here, "..");
const PORT = 8800 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "test-admin-secret";
const PER_CLAIM = 1;
const GLOBAL_CAP = 2.9; // small so the global cap is exercised: alice (~$1 relay) + bob ($1 key) + one more claim must not fit
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

// 1. mock upstream
const mock = spawn(process.execPath, [path.join(here, "mock-upstream.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
const mockPort = await new Promise((resolve) => mock.stdout.once("data", (d) => resolve(JSON.parse(String(d)).port)));
const MOCK = `http://127.0.0.1:${mockPort}`;

// 2. wrangler dev with test vars (a fresh persisted state dir each run)
const RUN = Date.now().toString(36);
const stateDir = fs.mkdtempSync(path.join(relayDir, ".wrangler-test-"));
try {
  fs.rmSync(path.join(relayDir, ".wrangler", "state"), { recursive: true, force: true });
} catch {
  /* ignore */
}
const vars = {
  TOKENROUTER_BASE_URL: MOCK,
  TOKENROUTER_MASTER_KEY: "mock-master",
  TOKENROUTER_MANAGEMENT_KEY: "mock-mgmt",
  HMAC_SECRET: "integration-secret-0123456789abcdef",
  ADMIN_SECRET: ADMIN,
  PUBLIC_BASE_URL: BASE,
  PER_CLAIM_USD: String(PER_CLAIM),
  GLOBAL_CAP_USD: String(GLOBAL_CAP),
  CLAIM_DAYS: "7",
  RELAY_MAX_TOKENS: "2048",
  RELAY_RPM: "5000",
  DEV_EXPOSE_LINKS: "true",
  RELAY_SETTLE_TIMEOUT_MS: "4000",
};
const varArgs = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
const wr = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", stateDir, "--log-level", "warn", ...varArgs], { cwd: relayDir, stdio: ["ignore", "pipe", "pipe"], shell: true });
wr.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(d));
wr.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
async function waitReady() {
  try {
    const pre = await fetch(`${BASE}/health`);
    if (pre.ok) throw new Error(`port ${PORT} already serving something; a stale wrangler is running`);
  } catch (e) {
    if (String(e).includes("stale")) throw e;
  }
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not come up");
}
const cleanup = () => {
  try {
    process.kill(wr.pid);
  } catch {}
  try {
    spawn("taskkill", ["/pid", String(wr.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  try {
    mock.kill();
  } catch {}
  setTimeout(() => {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* wrangler may still hold the dir; it is gitignored */
    }
  }, 2500);
};
process.on("exit", cleanup);

const j = async (res) => {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _text: t };
  }
};
async function claimAndVerify(email) {
  const c = await j(await fetch(`${BASE}/api/claim`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `10.0.0.${Math.floor(Math.random() * 200)}` }, body: JSON.stringify({ email }) }));
  if (!c.dev_verify_url) return { claim: c };
  const v = await fetch(c.dev_verify_url);
  const s = await j(await fetch(`${BASE}/api/claim/status?id=${c.id}`));
  return { claim: c, verifyStatus: v.status, status: s };
}
const chat = (token, content, extra = {}) =>
  fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content }], max_tokens: 2000, ...extra }) });
const balance = async (token) => j(await fetch(`${BASE}/api/balance`, { headers: { authorization: `Bearer ${token}` } }));
const settled = async (token) => {
  let b;
  for (let i = 0; i < 40; i++) {
    b = await balance(token);
    if (b.reserved_usd === 0) return b;
    await new Promise((r) => setTimeout(r, 250));
  }
  return b;
};
const stats = async () => j(await fetch(`${BASE}/api/admin/stats`, { headers: { authorization: `Bearer ${ADMIN}` } }));

try {
  await waitReady();
  console.log(`worker up on ${BASE}, mock upstream on ${MOCK}`);

  // ---------- relay mode (empty pool) ----------
  const a = await claimAndVerify(`alice-${RUN}@example.com`);
  check(a.claim.status === "sent" && a.verifyStatus === 200, `claim + verify (relay mode) ${a.claim.status === "sent" ? "" : JSON.stringify(a.claim)}`);
  if (!a.status) throw new Error("claim failed: " + JSON.stringify(a.claim));
  check(a.status.status === "verified" && a.status.mode === "relay" && String(a.status.token).startsWith("ra_"), "status hands out an ra_ token");
  const tokA = a.status.token;
  {
    const e = await j(await fetch(`${BASE}/api/admin/emails`, { headers: { authorization: `Bearer ${ADMIN}` } }));
    check(Array.isArray(e.emails) && e.emails.some((x) => x.email === `alice-${RUN}@example.com`) && e.total >= 1, `admin email export lists the verified address (total ${e.total})`);
    const noauth = await fetch(`${BASE}/api/admin/emails`);
    check(noauth.status === 401, "admin email export refuses without the admin secret");
  }

  // One request: estimate vs actual. Prompt ~ 60 chars -> ~20 input tokens; max_tokens 2000 -> est = (20*0.15 + 2000*0.6)/1e6*1.25 ≈ $0.0015.
  let r = await chat(tokA, "hello there, this is a normal request with usage");
  check(r.status === 200, "relay forwards a normal request");
  let b = await settled(tokA);
  // actual = 1000*0.15/1e6 + 2000*0.6/1e6 = 0.00135
  check(Math.abs(b.spent_usd - 0.00135) < 1e-9 && b.reserved_usd === 0, `settled at real usage ($${b.spent_usd}) and released the reservation`);

  // Missing usage -> full estimate charged
  const before = b.spent_usd;
  r = await chat(tokA, "nousage please");
  b = await settled(tokA);
  const est = ((Math.ceil((JSON.stringify([{ role: "user", content: "nousage please" }]).length + 4) / 3) * 0.15) / 1e6 + (2000 * 0.6) / 1e6) * 1.25;
  check(r.status === 200 && Math.abs(b.spent_usd - before - est) < 1e-7, `missing usage charges the full estimate (est $${est.toFixed(6)}, charged $${(b.spent_usd - before).toFixed(6)}, status ${r.status})`);

  // Cancelled stream -> full estimate charged
  const before2 = b.spent_usd;
  const ctrl = new AbortController();
  const sr = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "slow stream to cancel" }], max_tokens: 2000, stream: true }), signal: ctrl.signal });
  const reader = sr.body.getReader();
  await reader.read();
  ctrl.abort();
  await new Promise((x) => setTimeout(x, 6500));
  b = await settled(tokA);
  const estCancel = ((Math.ceil((JSON.stringify([{ role: "user", content: "slow stream to cancel" }]).length + 4) / 3) * 0.15) / 1e6 + (2000 * 0.6) / 1e6) * 1.25;
  check(Math.abs(b.spent_usd - before2 - estCancel) < 1e-7, `cancelled stream charges the estimate (+$${(b.spent_usd - before2).toFixed(6)} vs est $${estCancel.toFixed(6)})`);

  // Upstream failure -> nothing charged, reservation released
  const before3 = b.spent_usd;
  r = await chat(tokA, "fail this one");
  b = await settled(tokA);
  check(r.status === 500 && b.spent_usd === before3 && b.reserved_usd === 0, "upstream failure releases the reservation without charge");

  // Unknown model refused before any reservation
  r = await chat(tokA, "hi", { model: "nope/unknown" });
  check(r.status === 400, "unknown model refused");

  // Burst: 60 concurrent requests, each ~$0.0015 estimate; budget is $1 so all fit. Then exhaust with big prompts.
  const burst = await Promise.all(Array.from({ length: 60 }, () => chat(tokA, "burst request ok")));
  b = await settled(tokA);
  const hist = {};
  for (const x of burst) hist[x.status] = (hist[x.status] ?? 0) + 1;
  check(burst.every((x) => x.status === 200) && b.reserved_usd === 0, `60 concurrent requests settle cleanly (spent $${b.spent_usd.toFixed(4)}, statuses ${JSON.stringify(hist)}, reserved ${b.reserved_usd})`);

  // Exhaust the budget with large prompts (~20K chars -> ~6.7K tokens -> est ≈ $0.0028 each) in concurrent waves until refused.
  const big = "y".repeat(20000);
  let ok = 0,
    refused = 0;
  const other = {};
  // Keep sending waves until an entire wave is refused: a partial refusal only means that wave's reservations did
  // not all fit; the ones that fit are legitimately allowed to complete.
  let lastWaveOk = 1;
  for (let wave = 0; wave < 80 && lastWaveOk > 0; wave++) {
    const rs = await Promise.all(Array.from({ length: 50 }, () => chat(tokA, big + " burst")));
    lastWaveOk = 0;
    for (const x of rs) x.status === 200 ? (ok++, lastWaveOk++) : x.status === 402 ? refused++ : (other[x.status] = (other[x.status] ?? 0) + 1);
  }
  b = await settled(tokA);
  const st = await stats();
  check(refused > 0, `budget eventually refuses (ok=${ok}, refused=${refused}, other=${JSON.stringify(other)})`);
  check(b.spent_usd <= PER_CLAIM + 1e-9, `spent never exceeds $${PER_CLAIM}: $${b.spent_usd.toFixed(6)}`);
  check(b.reserved_usd === 0, "no dangling reservations after the burst");
  // After exhaustion every further request is refused, including concurrently
  const after = await Promise.all(Array.from({ length: 20 }, () => chat(tokA, big)));
  check(after.every((x) => x.status === 402), "all requests refused once the budget is spent");
  const b2 = await settled(tokA);
  check(Math.abs(b2.spent_usd - b.spent_usd) < 1e-9, `refused requests do not change spend (${b.spent_usd} -> ${b2.spent_usd})`);

  // ---------- email rules ----------
  const dup = await j(await fetch(`${BASE}/api/claim`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "10.1.1.1" }, body: JSON.stringify({ email: `Alice-${RUN}+again@Example.com` }) }));
  check(dup.error && /already claimed/.test(dup.error), "alias of a claimed email is refused");
  const disp = await j(await fetch(`${BASE}/api/claim`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "10.1.1.2" }, body: JSON.stringify({ email: "x@mailinator.com" }) }));
  check(disp.error && /Disposable/.test(disp.error), "disposable email refused");
  let ipHits = 0;
  const ipStatuses = [];
  const loopIp = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  for (let i = 0; i < 7; i++) {
    const rr = await fetch(`${BASE}/api/claim`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": loopIp }, body: JSON.stringify({ email: `ipuser${i}-${RUN}@example.org` }) });
    if (rr.status === 429) ipHits++;
    else ipStatuses.push(rr.status + ":" + ((await j(rr)).error ?? "ok").slice(0, 30));
  }
  check(ipHits >= 2, `per-IP claim limit enforced (${ipHits} refused of 7) ${ipStatuses.join(" | ")}`);

  // ---------- key mode ----------
  for (const [k, name] of [["sk-pool-aaaa", "ra-pool-001"], ["sk-pool-bbbb", "ra-pool-002"]]) await fetch(`${MOCK}/_seed_key`, { method: "POST", body: JSON.stringify({ key: k, name }) });
  const load = await j(await fetch(`${BASE}/api/admin/pool`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ keys: [{ key: "sk-pool-aaaa", name: "ra-pool-001", capped: true }, { key: "sk-pool-bbbb", name: "ra-pool-002", capped: false }] }) }));
  check(load.added === 1, "pool loader refuses keys not marked capped");
  const unauth = await fetch(`${BASE}/api/admin/pool`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" });
  check(unauth.status === 401, "admin endpoints need the secret");
  const k1 = await claimAndVerify(`bob-${RUN}@example.com`);
  check(k1.status.mode === "key" && k1.status.token === "sk-pool-aaaa", "key mode hands out the pooled key");
  const mg = await j(await fetch(`${MOCK}/_mgmt_log`));
  const capCall = mg.calls.find((c) => c.path === "quota" && c.key_tail === "aaaa");
  check(capCall && capCall.unlimited === false && capCall.remain === PER_CLAIM, `pooled key re-capped at $${PER_CLAIM} via the Management API at hand-out ${capCall ? "" : JSON.stringify(mg.calls).slice(0, 200)}`);
  const kb = await balance("sk-pool-aaaa");
  check(kb.mode === "key" && kb.remaining_usd === PER_CLAIM, "balance resolves a pooled key through the masked listing");
  const relayWithKey = await chat("sk-pool-aaaa", "hi");
  check(relayWithKey.status === 400, "TokenRouter keys are refused on the relay path");

  // ---------- global cap ----------
  // committed = relay spent (~$1 alice) + issued keys (1 × $1) = ~$2; cap 3 -> one more claim fits, the next does not.
  const c3 = await claimAndVerify(`carol-${RUN}@example.com`);
  check(c3.claim.error && /fully allocated/.test(c3.claim.error), `global cap refuses a third claim (${JSON.stringify(c3.claim).slice(0, 80)})`);
  const st2 = await stats();
  check(st2.committed_usd <= GLOBAL_CAP + 1e-9, `committed $${st2.committed_usd.toFixed(4)} never exceeds the global cap $${GLOBAL_CAP}`);

  // ---------- publish + render ----------
  const agg = { v: 1, generated_at: new Date().toISOString(), tool: { name: "routearena", version: "0.1.0" }, period: null, primary: { provider: "openrouter", requests: 3, requests_ok: 3, errors: 0, cost_usd: 0.01, cost_source: "measured", monthly_usd: 0.3, topup_fee_usd: 0.0165, latency: { p50: 100, p95: 200, n: 3 }, ttft: { p50: null, p95: null, n: 0 }, prompt_tokens: 100, completion_tokens: 50 }, sampling: { rate: 1, mirrored: 3, skipped: {} }, models: [], targets: [], target_models: [], method: { costs: "x", sampling: "y", ttft: "z", agreement: "w", judge_model: null, prices: [] } };
  const pub = await j(await fetch(`${BASE}/api/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aggregates: agg }) }));
  check(pub.url && /\/r\/[a-f0-9]{16}$/.test(pub.url), "publish returns a report url");
  const page = await fetch(pub.url);
  const pageText = await page.text();
  check(page.status === 200 && pageText.includes("RouteArena report") && !pageText.includes("<script"), "published report renders without scripts");
  const bad = await fetch(`${BASE}/api/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aggregates: { ...agg, models: [{ messages: [] }] } }) });
  check(bad.status === 400, "publish rejects prompt-like fields");
  const llms = await fetch(`${BASE}/llms.txt`);
  check(llms.status === 200 && (await llms.text()).includes("routearena"), "llms.txt served");

  console.log(`\nstats: ${JSON.stringify(st2)}`);
  console.log(failures === 0 ? "\nALL INTEGRATION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("integration error:", e);
  process.exitCode = 1;
} finally {
  cleanup();
}
