// End-to-end check of key mode against the real Worker running locally (wrangler dev + Durable Object SQLite) with a
// mock TokenRouter Management API. Proves: pool hand-out with cap verification, refusal when TokenRouter does not
// confirm the cap (key returned, claim retry-able), exhausted pool -> 503 with a fix (claim retry-able once keys are
// added), the MAX_ISSUED_KEYS ceiling, usage rows from TokenRouter billing, email rules, stats and publish.
// No chat traffic ever touches the Worker: /v1/* must be 404. Run: node test/integration.mjs
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
const MAX_ISSUED = 5;
const EXHAUSTED = { error: "Free credits are temporarily exhausted.", fix: "Use --no-credits, or set TOKENROUTER_API_KEY with your own key." };
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

// 1. mock TokenRouter management API
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
  TOKENROUTER_MANAGEMENT_KEY: "mock-mgmt",
  HMAC_SECRET: "integration-secret-0123456789abcdef",
  ADMIN_SECRET: ADMIN,
  PUBLIC_BASE_URL: BASE,
  PER_CLAIM_USD: String(PER_CLAIM),
  MAX_ISSUED_KEYS: String(MAX_ISSUED),
  CLAIM_DAYS: "7",
  DEV_EXPOSE_LINKS: "true",
};
// Run wrangler in-process through its programmatic API: worker.stop() shuts workerd down cleanly, which a killed
// child process never does (an orphaned workerd would keep the port and the persisted SQLite files open).
const { unstable_dev } = await import("wrangler");
const worker = await unstable_dev(path.join(relayDir, "src", "worker.ts"), {
  config: path.join(relayDir, "wrangler.toml"),
  ip: "127.0.0.1",
  port: PORT,
  persistTo: stateDir,
  vars,
  logLevel: process.env.VERBOSE ? "info" : "warn",
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false },
});
async function waitReady() {
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
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    await worker.stop();
  } catch {}
  try {
    mock.kill();
  } catch {}
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
      if (!fs.existsSync(stateDir)) return;
    } catch {
      /* workerd may still be releasing its SQLite files */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`note: could not remove ${stateDir} (gitignored); delete it by hand`);
}
process.on("exit", () => {
  try {
    mock.kill();
  } catch {}
});

const j = async (res) => {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { _text: t };
  }
};
const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const randomIp = () => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function claim(email) {
  const res = await post(`${BASE}/api/claim`, { email }, { "cf-connecting-ip": randomIp() });
  return { httpStatus: res.status, ...(await j(res)) };
}
async function verify(c) {
  const v = await fetch(c.dev_verify_url);
  const s = await j(await fetch(`${BASE}/api/claim/status?id=${c.id}`));
  return { verifyStatus: v.status, verifyBody: await v.text(), status: s };
}
async function claimAndVerify(email) {
  const c = await claim(email);
  if (!c.dev_verify_url) return { claim: c };
  return { claim: c, ...(await verify(c)) };
}
const admin = { authorization: `Bearer ${ADMIN}` };
const seedKey = (key, name, extra = {}) => post(`${MOCK}/_seed_key`, { key, name, ...extra });
const loadPool = async (keys) => j(await post(`${BASE}/api/admin/pool`, { keys }, admin));
const stats = async () => j(await fetch(`${BASE}/api/admin/stats`, { headers: admin }));
const mgmtLog = async () => j(await fetch(`${MOCK}/_mgmt_log`));
const balance = async (token) => j(await fetch(`${BASE}/api/balance`, { headers: { authorization: `Bearer ${token}` } }));
const usage = (token) => fetch(`${BASE}/api/claim/usage`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

try {
  await waitReady();
  console.log(`worker up on ${BASE}, mock management API on ${MOCK}`);

  // ---------- no relay surface ----------
  {
    const chat = await post(`${BASE}/v1/chat/completions`, { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer anything" });
    const models = await fetch(`${BASE}/v1/models`);
    check(chat.status === 404 && models.status === 404, "no /v1 endpoints: chat completions and models are 404");
  }

  // ---------- empty pool: claims fail clearly ----------
  {
    const c = await claim(`nobody-${RUN}@example.com`);
    check(c.httpStatus === 503 && c.error === EXHAUSTED.error && c.fix === EXHAUSTED.fix, `empty pool -> 503 with the exhausted error and fix (${c.httpStatus} ${c.error})`);
    const s = await stats();
    check(s.pool_available === 0 && s.pool_issued === 0 && !("relay_spent_usd" in s) && !("committed_usd" in s) && !("global_cap_usd" in s), `stats are count-only (${JSON.stringify(s)})`);
  }

  // ---------- pool loading ----------
  await seedKey("sk-pool-aaaa", "ra-pool-001");
  await seedKey("sk-pool-bbbb", "ra-pool-002");
  {
    const load = await loadPool([{ key: "sk-pool-aaaa", name: "ra-pool-001", capped: true }, { key: "sk-pool-bbbb", name: "ra-pool-002", capped: false }]);
    check(load.added === 1 && load.available === 1, `pool loader refuses keys not marked capped (${JSON.stringify(load)})`);
    const unauth = await post(`${BASE}/api/admin/pool`, {}, { authorization: "Bearer wrong" });
    check(unauth.status === 401, "admin endpoints need the secret");
  }

  // ---------- happy path: hand-out with cap verification ----------
  const alice = await claimAndVerify(`alice-${RUN}@example.com`);
  check(alice.claim.status === "sent" && alice.verifyStatus === 200, `claim + verify succeeds ${alice.claim.status === "sent" ? "" : JSON.stringify(alice.claim)}`);
  if (!alice.status) throw new Error("claim failed: " + JSON.stringify(alice.claim));
  check(alice.status.status === "verified" && alice.status.mode === "key" && alice.status.token === "sk-pool-aaaa" && alice.status.budget_usd === PER_CLAIM, `status hands out the pooled key in key mode (${JSON.stringify(alice.status)})`);
  {
    const mg = await mgmtLog();
    const capCall = mg.calls.find((c) => c.path === "quota" && c.key_tail === "aaaa");
    check(capCall && capCall.unlimited === false && capCall.remain === PER_CLAIM, `pooled key re-capped at $${PER_CLAIM} via the Management API at hand-out`);
    const kb = await balance("sk-pool-aaaa");
    check(kb.mode === "key" && kb.remaining_usd === PER_CLAIM && kb.key_status === "enabled", `balance reads the key's remaining quota from TokenRouter (${JSON.stringify(kb)})`);
    const e = await j(await fetch(`${BASE}/api/admin/emails`, { headers: admin }));
    check(Array.isArray(e.emails) && e.emails.some((x) => x.email === `alice-${RUN}@example.com`) && e.total >= 1, `admin email export lists the verified address (total ${e.total})`);
    const noauth = await fetch(`${BASE}/api/admin/emails`);
    check(noauth.status === 401, "admin email export refuses without the admin secret");
    const s = await stats();
    check(s.pool_available === 0 && s.pool_issued === 1 && s.verified === 1, `stats after hand-out (${JSON.stringify(s)})`);
  }

  // ---------- usage: TokenRouter's billed rows for the claim's key ----------
  {
    const now = Math.floor(Date.now() / 1000);
    await post(`${MOCK}/_seed_usage`, {
      rows: [
        { request_id: "req-a1", key_name: "ra-pool-001", model_name: "openai/gpt-4o-mini", prompt_tokens: 11, completion_tokens: 22, cost: 0.000033, created_at: now - 20 },
        { request_id: "req-a2", key_name: "ra-pool-001", model_name: "z-ai/glm-5.3-flash", prompt_tokens: 5, completion_tokens: 9, cost: 0.000007, created_at: now - 10 },
        { request_id: "req-x", key_name: "someone-else", model_name: "openai/gpt-4o-mini", prompt_tokens: 1, completion_tokens: 1, cost: 5, created_at: now - 10 },
      ],
    });
    const callsBefore = (await mgmtLog()).calls.filter((c) => c.path === "usages").length;
    const r = await usage("sk-pool-aaaa");
    const u = await j(r);
    check(r.status === 200 && u.source === "tokenrouter_billing" && Array.isArray(u.rows) && u.rows.length === 2, `usage returns this key's billed rows only (${r.status}, ${u.rows?.length} rows)`);
    const a1 = u.rows?.find((x) => x.request_id === "req-a1");
    check(a1 && a1.model === "openai/gpt-4o-mini" && a1.prompt_tokens === 11 && a1.completion_tokens === 22 && a1.cost_usd === 0.000033 && a1.created_at === new Date((now - 20) * 1000).toISOString(), `usage rows carry request_id, model, tokens, TokenRouter's cost and ISO created_at (${JSON.stringify(a1)})`);
    check(typeof u.from === "string" && typeof u.to === "string" && typeof u.fetched_at === "string" && !u.partial, `usage carries from/to/fetched_at (${u.from} -> ${u.to})`);
    const callsAfter = (await mgmtLog()).calls.filter((c) => c.path === "usages").length;
    const u2 = await j(await usage("sk-pool-aaaa"));
    const callsAfter2 = (await mgmtLog()).calls.filter((c) => c.path === "usages").length;
    check(callsAfter > callsBefore && callsAfter2 === callsAfter && u2.fetched_at === u.fetched_at, `usage is cached per claim for 60s (${callsAfter - callsBefore} upstream call(s), then 0)`);
    const noTok = await usage(null);
    const badTok = await usage("sk-not-issued");
    check(noTok.status === 401 && badTok.status === 401, "usage requires the issued key");
    const mg = await mgmtLog();
    check(mg.calls.filter((c) => c.path === "usages").every((c) => c.end - c.start <= 3600), "usage queries never exceed the Management API's one-hour window");
  }

  // ---------- email rules (pool non-empty so the capacity check passes first) ----------
  await seedKey("sk-pool-cccc", "ra-pool-003", { fail_quota: true });
  check((await loadPool([{ key: "sk-pool-cccc", name: "ra-pool-003", capped: true }])).available === 1, "loaded a key whose quota call will fail");
  {
    const dup = await claim(`Alice-${RUN}+again@Example.com`);
    check(dup.httpStatus === 429 && /already claimed/.test(dup.error), "alias of a claimed email is refused");
    const disp = await claim("x@mailinator.com");
    check(disp.httpStatus === 400 && /Disposable/.test(disp.error), "disposable email refused");
    let ipHits = 0;
    const loopIp = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 7; i++) {
      const rr = await post(`${BASE}/api/claim`, { email: `ipuser${i}-${RUN}@example.org` }, { "cf-connecting-ip": loopIp });
      if (rr.status === 429) ipHits++;
    }
    check(ipHits === 2, `per-IP claim limit enforced (${ipHits} refused of 7)`);
  }

  // ---------- cap not confirmed: key returned, nothing issued, same link works once TokenRouter answers ----------
  {
    const bob = await claimAndVerify(`bob-${RUN}@example.com`);
    check(bob.verifyStatus === 503 && /did not confirm/.test(bob.verifyBody), `verify refuses when TokenRouter does not confirm the cap (${bob.verifyStatus})`);
    check(bob.status.status === "pending" && /did not confirm/.test(bob.status.error ?? ""), `claim stays pending with the reason (${JSON.stringify(bob.status)})`);
    const s = await stats();
    check(s.pool_available === 1 && s.pool_issued === 1, `unconfirmed key went back to the pool (${JSON.stringify(s)})`);
    const mg = await mgmtLog();
    check(mg.calls.some((c) => c.path === "quota" && c.key_tail === "cccc"), "the cap was attempted upstream");
    await seedKey("sk-pool-cccc", "ra-pool-003"); // TokenRouter recovers
    const retry = await verify(bob.claim);
    check(retry.verifyStatus === 200 && retry.status.status === "verified" && retry.status.token === "sk-pool-cccc", `re-opening the same link issues the key once the cap is confirmed (${JSON.stringify(retry.status)})`);
    // TokenRouter-side state is authoritative (balance reads a masked listing cached 60s, so it may still be stale here).
    const cccc = (await mgmtLog()).keys.find((k) => k.key_tail === "cccc");
    check(cccc && cccc.unlimited_quota === false && cccc.remain_quota === PER_CLAIM, `the retried key is capped at TokenRouter (${JSON.stringify(cccc)})`);

    // 429 from the Management API on an uncached claim -> 429 with a fix
    await post(`${MOCK}/_usage_429`, { on: true });
    const limited = await usage("sk-pool-cccc");
    const lb = await j(limited);
    check(limited.status === 429 && /rate-limited/.test(lb.error) && typeof lb.fix === "string", `usage surfaces the upstream rate limit as 429 with a fix (${limited.status})`);
    await post(`${MOCK}/_usage_429`, { on: false });
  }

  // ---------- exhausted between claim and verify: 503 + fix, claim stays pending, succeeds after keys are added ----------
  {
    await seedKey("sk-pool-dddd", "ra-pool-004");
    await loadPool([{ key: "sk-pool-dddd", name: "ra-pool-004", capped: true }]);
    const carolClaim = await claim(`carol-${RUN}@example.com`);
    const daveClaim = await claim(`dave-${RUN}@example.com`);
    check(carolClaim.status === "sent" && daveClaim.status === "sent", "two claims accepted while one key remains");
    const carol = await verify(carolClaim);
    check(carol.verifyStatus === 200 && carol.status.token === "sk-pool-dddd", "first verifier takes the last key");
    const dave = await verify(daveClaim);
    check(dave.verifyStatus === 503 && dave.verifyBody.includes(EXHAUSTED.error), `second verifier gets 503 exhausted (${dave.verifyStatus})`);
    check(dave.status.status === "pending" && dave.status.error === EXHAUSTED.error && dave.status.fix === EXHAUSTED.fix, `status stays pending and carries the exhausted error + fix (${JSON.stringify(dave.status)})`);
    const mg = await mgmtLog();
    check(!mg.calls.some((c) => c.path === "quota" && c.key_tail === "dddd" && mg.calls.indexOf(c) !== mg.calls.findIndex((x) => x.path === "quota" && x.key_tail === "dddd")), "no upstream call for the exhausted attempt");
    await seedKey("sk-pool-eeee", "ra-pool-005");
    await loadPool([{ key: "sk-pool-eeee", name: "ra-pool-005", capped: true }]);
    const daveRetry = await verify(daveClaim);
    check(daveRetry.verifyStatus === 200 && daveRetry.status.status === "verified" && daveRetry.status.token === "sk-pool-eeee" && !daveRetry.status.error, `same link succeeds once keys are added (${JSON.stringify(daveRetry.status)})`);
  }

  // ---------- MAX_ISSUED_KEYS ceiling ----------
  {
    await seedKey("sk-pool-ffff", "ra-pool-006");
    await seedKey("sk-pool-gggg", "ra-pool-007");
    await loadPool([{ key: "sk-pool-ffff", name: "ra-pool-006", capped: true }, { key: "sk-pool-gggg", name: "ra-pool-007", capped: true }]);
    const erin = await claimAndVerify(`erin-${RUN}@example.com`);
    check(erin.status?.status === "verified" && erin.status.token === "sk-pool-ffff", `issued key #${MAX_ISSUED} (${JSON.stringify(erin.status ?? erin.claim)})`);
    const frank = await claim(`frank-${RUN}@example.com`);
    const s = await stats();
    check(frank.httpStatus === 503 && frank.error === EXHAUSTED.error && s.pool_available === 1 && s.pool_issued === MAX_ISSUED && s.max_issued_keys === MAX_ISSUED, `MAX_ISSUED_KEYS=${MAX_ISSUED} refuses further claims while a key still sits in the pool (${JSON.stringify(s)})`);
  }

  // ---------- publish + render ----------
  const agg = { v: 1, generated_at: new Date().toISOString(), tool: { name: "routearena", version: "0.1.0" }, period: null, primary: { provider: "openrouter", requests: 3, requests_ok: 3, errors: 0, cost_usd: 0.01, cost_source: "measured", monthly_usd: 0.3, topup_fee_usd: 0.0165, latency: { p50: 100, p95: 200, n: 3 }, ttft: { p50: null, p95: null, n: 0 }, prompt_tokens: 100, completion_tokens: 50 }, sampling: { rate: 1, mirrored: 3, skipped: {} }, models: [], targets: [], target_models: [], method: { costs: "x", sampling: "y", ttft: "z", agreement: "w", judge_model: null, prices: [] } };
  const pub = await j(await post(`${BASE}/api/publish`, { aggregates: agg }));
  check(pub.url && /\/r\/[a-f0-9]{16}$/.test(pub.url), "publish returns a report url");
  const page = await fetch(pub.url);
  const pageText = await page.text();
  check(page.status === 200 && pageText.includes("RouteArena report") && !pageText.includes("<script"), "published report renders without scripts");
  const bad = await post(`${BASE}/api/publish`, { aggregates: { ...agg, models: [{ messages: [] }] } });
  check(bad.status === 400, "publish rejects prompt-like fields");
  const llms = await fetch(`${BASE}/llms.txt`);
  check(llms.status === 200 && (await llms.text()).includes("routearena"), "llms.txt served");

  const finalStats = await stats();
  check(finalStats.published === 1 && finalStats.verified === 5, `final stats (${JSON.stringify(finalStats)})`);
  console.log(`\nstats: ${JSON.stringify(finalStats)}`);
  console.log(failures === 0 ? "\nALL INTEGRATION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error("integration error:", e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
