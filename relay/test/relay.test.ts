import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonRes, mockFetch, withFakeState } from "./fakeState";

process.env.HMAC_SECRET = "test-secret-not-for-production";
process.env.TOKENROUTER_MANAGEMENT_KEY = "mock-mgmt";
process.env.TOKENROUTER_BASE_URL = "http://mock.tokenrouter.test";

test("publish validation rejects prompt-like payloads and accepts aggregates", async () => {
  const { validateAggregates } = await import("../api/publish");
  assert.equal(validateAggregates({ v: 1, primary: { requests: 3 }, targets: [{ target: "x", gaps: [{ model: "a/b", requests: 1 }] }] }), null);
  assert.match(validateAggregates({ messages: [] })!, /not allowed/);
  assert.match(validateAggregates({ a: { completion_text: "x" } })!, /not allowed/);
  assert.match(validateAggregates({ s: "x".repeat(501) })!, /longer/);
  assert.match(validateAggregates({ nested: { deep: { content: "x" } } })!, /not allowed/);
});

test("sealed text round-trips and is bound to its context", async () => {
  const { sealText, openText } = await import("../lib/token");
  const sealed = await sealText("email", "Person@Example.com");
  assert.ok(sealed.startsWith("v1."));
  assert.ok(!sealed.includes("Example"), "ciphertext does not contain the plaintext");
  assert.equal(await openText("email", sealed), "Person@Example.com");
  await assert.rejects(openText("other-context", sealed));
  await assert.rejects(openText("email", sealed.slice(0, -2) + "zz"));
});

test("no relay-mode surface remains: no ra_ tokens, no price table, no estimator", async () => {
  const token = await import("../lib/token");
  assert.ok(!("signToken" in token) && !("verifyToken" in token));
  for (const mod of ["../lib/prices", "../lib/estimate", "../api/v1/chat/completions", "../api/v1/models"]) await assert.rejects(() => import(mod), `${mod} must not exist`);
});

// ---------- /api/claim/usage ----------
const { claimUsage, UsageRateLimited, WINDOW_SEC, MAX_WINDOWS_PER_CALL } = await import("../lib/usage");

/** Mock hour/usages: enforces the 1-hour range rule, pages at 100, filters by created_at. */
function mockUsages(rows: any[], opts: { rateLimitAfter?: number } = {}) {
  let n = 0;
  return mockFetch([
    [
      "/api/management/hour/usages",
      (u) => {
        n++;
        if (opts.rateLimitAfter !== undefined && n > opts.rateLimitAfter) return jsonRes(429, { success: false, message: "too many requests, please try again later" });
        const start = Number(u.searchParams.get("start_timestamp"));
        const end = Number(u.searchParams.get("end_timestamp"));
        if (end - start > 3600) return jsonRes(400, { success: false, message: "time range must not exceed 1 hour" });
        const page = Number(u.searchParams.get("page") ?? 1);
        const size = Number(u.searchParams.get("page_size") ?? 100);
        const inRange = rows.filter((r) => r.created_at >= start && r.created_at <= end);
        return jsonRes(200, { success: true, data: { page, page_size: size, total: inRange.length, total_cost: 0, items: inRange.slice((page - 1) * size, page * size) } });
      },
    ],
  ]);
}

test("usage: returns TokenRouter's billed rows for the claim's key only, mapped to the documented shape", async () => {
  const now = 1_800_000_000;
  const created = now - 600;
  const rows = [
    { request_id: "req-1", key_name: "ra-pool-001", model_name: "openai/gpt-4o-mini", prompt_tokens: 12, completion_tokens: 34, cost: 0.000123, created_at: now - 500 },
    { request_id: "req-2", key_name: "ra-pool-001", model_name: "z-ai/glm-5.3-flash", prompt_tokens: 5, completion_tokens: 6, cost: 0.00002, created_at: now - 100 },
    { request_id: "req-other", key_name: "ra-pool-002", model_name: "openai/gpt-4o-mini", prompt_tokens: 1, completion_tokens: 1, cost: 1, created_at: now - 100 },
  ];
  const calls = mockUsages(rows);
  await withFakeState(async () => {
    const r = await claimUsage({ id: "c1", created, key_name: "ra-pool-001" }, now);
    assert.equal(r.source, "tokenrouter_billing");
    assert.deepEqual(
      r.rows.map((x) => x.request_id),
      ["req-1", "req-2"],
    );
    assert.deepEqual(r.rows[0], { request_id: "req-1", model: "openai/gpt-4o-mini", prompt_tokens: 12, completion_tokens: 34, cost_usd: 0.000123, created_at: new Date((now - 500) * 1000).toISOString() });
    assert.equal(r.from, new Date((created - 60) * 1000).toISOString());
    assert.equal(r.to, new Date(now * 1000).toISOString());
    assert.equal(r.fetched_at, r.to);
    assert.equal(r.partial, undefined);
    const q = new URL(calls[0].url);
    assert.equal(q.searchParams.get("start_timestamp"), String(created - 60));
    assert.equal(q.searchParams.get("end_timestamp"), String(now));
    assert.equal(calls.length, 1, "one window, one page");
    // Second call within 60s is served from the cache without touching the Management API.
    const again = await claimUsage({ id: "c1", created, key_name: "ra-pool-001" }, now + 5);
    assert.deepEqual(again, r);
    assert.equal(calls.length, 1);
  });
});

test("usage: pages at 100 rows and walks hour windows for claims older than an hour, persisting progress", async () => {
  const now = 1_800_000_000;
  const created = now - 3 * 3600; // 3h + 60s of history -> 4 windows
  const rows = Array.from({ length: 150 }, (_, i) => ({ request_id: `r${i}`, key_name: "k", model_name: "m", prompt_tokens: 1, completion_tokens: 1, cost: 0.001, created_at: now - 3000 + i }));
  const calls = mockUsages(rows);
  await withFakeState(async (st) => {
    const r = await claimUsage({ id: "c2", created, key_name: "k" }, now);
    assert.equal(r.rows.length, 150);
    const windows = calls.map((c) => {
      const u = new URL(c.url);
      return [Number(u.searchParams.get("start_timestamp")), Number(u.searchParams.get("end_timestamp")), Number(u.searchParams.get("page"))];
    });
    assert.ok(windows.every(([s, e]) => e - s <= WINDOW_SEC), "no window exceeds the API's one-hour limit");
    assert.equal(new Set(windows.map(([s, e]) => `${s}-${e}`)).size, 4, "4 distinct hour windows");
    assert.equal(windows.filter(([, , p]) => p === 2).length, 1, "the window holding 150 rows fetched a second page");
    assert.equal(r.partial, undefined);
    const stored = JSON.parse((await st.kvGet("usage:rows:c2"))!);
    assert.equal(stored.synced, now);
    // Later call (cache expired): only the overlap-plus-new range is fetched and rows are deduplicated by request_id.
    await st.kvDel("usage:cache:c2");
    rows.push({ request_id: "r150", key_name: "k", model_name: "m", prompt_tokens: 1, completion_tokens: 1, cost: 0.001, created_at: now + 30 });
    const before = calls.length;
    const r2 = await claimUsage({ id: "c2", created, key_name: "k" }, now + 60);
    assert.equal(r2.rows.length, 151);
    assert.equal(calls.length - before, 1, "one incremental window");
    const u = new URL(calls[calls.length - 1].url);
    assert.ok(Number(u.searchParams.get("start_timestamp")) < now, "re-scans the overlap");
  });
});

test("usage: long history is caught up a few windows per call and marked partial; a 429 upstream surfaces as UsageRateLimited", async () => {
  const now = 1_800_000_000;
  const created = now - 20 * 3600;
  const calls = mockUsages([]);
  await withFakeState(async () => {
    const r = await claimUsage({ id: "c3", created, key_name: "k" }, now);
    assert.equal(r.partial, true);
    assert.equal(calls.length, MAX_WINDOWS_PER_CALL);
    assert.equal(r.to, new Date((created - 60 + MAX_WINDOWS_PER_CALL * WINDOW_SEC) * 1000).toISOString());
  });
  mockUsages([], { rateLimitAfter: 1 });
  await withFakeState(async (st) => {
    await assert.rejects(() => claimUsage({ id: "c4", created: now - 7200, key_name: "k" }, now), UsageRateLimited);
    assert.equal(await st.kvGet("usage:cache:c4"), null, "a rate-limited attempt is not cached as a result");
    assert.ok(await st.kvGet("usage:rows:c4"), "progress from the completed window is kept");
  });
});
