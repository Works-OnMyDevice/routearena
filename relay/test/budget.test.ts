import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeState, jsonRes, mockFetch, withFakeState } from "./fakeState";

process.env.HMAC_SECRET = "test-secret-not-for-production";
process.env.PER_CLAIM_USD = "1";
process.env.TOKENROUTER_MANAGEMENT_KEY = "mock-mgmt";
process.env.TOKENROUTER_BASE_URL = "http://mock.tokenrouter.test";
process.env.RESEND_API_KEY = "re_test_key"; // the owner alert goes through sendMail; fetch is mocked below

const { env } = await import("../lib/env");
const { normalizeEmail, pushPoolKeys, handOutPoolKey, capReachedForNewClaim, poolSize, poolIssued, claimIdForKey, alertPoolLow, EXHAUSTED, POOL_LOW_THRESHOLD } = await import("../lib/budget");

/** Mock management API: quota PUT echoes a capped key unless the key is in `brokenKeys`; Resend accepts everything. */
function mockMgmt(opts: { brokenKeys?: string[]; quotaStatus?: number; echoUnlimited?: boolean } = {}) {
  return mockFetch([
    [
      "/api/management/api-keys/quota",
      (_u, init) => {
        const b = JSON.parse(String(init.body));
        if (opts.brokenKeys?.includes(b.key)) return jsonRes(opts.quotaStatus ?? 429, { success: false, message: "too many requests, please try again later" });
        return jsonRes(200, { success: true, data: { name: "x", key: "sk-****", status: 1, unlimited_quota: opts.echoUnlimited ?? false, remain_quota: b.remain_quota, used_quota: 0, expired_time: -1 } });
      },
    ],
    ["api.resend.com", () => jsonRes(200, { id: "em_1" })],
  ]);
}

test("env: per-claim quota is clamped and the price-free config surface is exactly what key mode needs", () => {
  process.env.PER_CLAIM_USD = "1";
  assert.equal(env.perClaimUsd, 1);
  process.env.PER_CLAIM_USD = "999";
  assert.equal(env.perClaimUsd, 5, "cannot be raised above the hard ceiling");
  process.env.PER_CLAIM_USD = "nope";
  assert.equal(env.perClaimUsd, 1);
  process.env.PER_CLAIM_USD = "1";
  assert.equal(env.maxIssuedKeys, 300);
  process.env.MAX_ISSUED_KEYS = "7";
  assert.equal(env.maxIssuedKeys, 7);
  delete process.env.MAX_ISSUED_KEYS;
  for (const gone of ["masterKey", "relayEnabled", "relayMaxTokens", "relayRpm", "settleTimeoutMs", "globalCapUsd", "reservationMaxAgeSec"]) assert.ok(!(gone in env), `${gone} must not exist`);
});

test("email normalization collapses aliases", () => {
  assert.equal(normalizeEmail("First.Last+promo@Gmail.com"), "firstlast@gmail.com");
  assert.equal(normalizeEmail("a.b@googlemail.com"), "ab@gmail.com");
  assert.equal(normalizeEmail("User+tag@Example.org"), "user@example.org");
});

test("pool items are sealed at rest and round-trip", async () => {
  const { sealPoolItem, openPoolItem } = await import("../lib/token");
  const sealed = await sealPoolItem({ key: "sk-pool-abc", name: "ra-pool-001", capped: true });
  assert.ok(!sealed.includes("sk-pool-abc"));
  assert.deepEqual(await openPoolItem(sealed), { key: "sk-pool-abc", name: "ra-pool-001", capped: true });
  await assert.rejects(() => openPoolItem(sealed.slice(0, -4) + "zzzz"));
});

test("secretEquals is strict", async () => {
  const { secretEquals } = await import("../lib/env");
  assert.equal(secretEquals("abc", "abc"), true);
  assert.equal(secretEquals("abc", "abd"), false);
  assert.equal(secretEquals("", ""), false);
  assert.equal(secretEquals(null, "x"), false);
});

test("hand-out: re-caps through the Management API, verifies the response, links the key and schedules expiry", async () => {
  const calls = mockMgmt();
  await withFakeState(async (st) => {
    await pushPoolKeys([{ key: "sk-pool-aaaa", name: "ra-pool-001", capped: true }]);
    assert.equal(await capReachedForNewClaim(), false);
    const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
    const out = await handOutPoolKey("claim-1", exp);
    assert.deepEqual(out, { ok: true, key: "sk-pool-aaaa", name: "ra-pool-001" });
    const quota = calls.find((c) => c.url.includes("/api-keys/quota"));
    assert.ok(quota && quota.method === "PUT");
    assert.equal(quota!.body.key, "sk-pool-aaaa");
    assert.equal(quota!.body.unlimited_quota, false);
    assert.equal(quota!.body.remain_quota, 1, "the quota passed to TokenRouter is PER_CLAIM_USD");
    assert.equal(await claimIdForKey("sk-pool-aaaa"), "claim-1");
    assert.equal(st.expiring.size, 1, "key expiry scheduled");
    assert.equal([...st.expiring.values()][0], exp);
    assert.equal(await poolSize(), 0);
    assert.equal(await poolIssued(), 1);
  });
});

test("hand-out: a key whose cap TokenRouter did not confirm goes back to the pool and nothing is issued", async () => {
  mockMgmt({ brokenKeys: ["sk-pool-bbbb"] });
  await withFakeState(async (st) => {
    await pushPoolKeys([{ key: "sk-pool-bbbb", name: "ra-pool-002", capped: true }]);
    const out = await handOutPoolKey("claim-2", 0);
    assert.deepEqual(out, { ok: false, reason: "unverified" });
    assert.equal(await poolSize(), 1, "key returned");
    assert.equal(await poolIssued(), 0);
    assert.equal(await claimIdForKey("sk-pool-bbbb"), null, "not linked");
    assert.equal(st.expiring.size, 0);
  });
  // A 200 that still reports unlimited_quota: true is also a refusal.
  mockMgmt({ echoUnlimited: true });
  await withFakeState(async () => {
    await pushPoolKeys([{ key: "sk-pool-cccc", name: "ra-pool-003", capped: true }]);
    assert.deepEqual(await handOutPoolKey("claim-3", 0), { ok: false, reason: "unverified" });
    assert.equal(await poolSize(), 1);
  });
});

test("hand-out: empty pool is 'exhausted' and nothing is called upstream", async () => {
  const calls = mockMgmt();
  await withFakeState(async () => {
    assert.equal(await capReachedForNewClaim(), true);
    assert.deepEqual(await handOutPoolKey("claim-4", 0), { ok: false, reason: "exhausted" });
    assert.equal(calls.filter((c) => c.url.includes("/api/management")).length, 0);
  });
  assert.equal(EXHAUSTED.error, "Free credits are temporarily exhausted.");
  assert.equal(EXHAUSTED.fix, "Use --no-credits, or set TOKENROUTER_API_KEY with your own key.");
});

test("MAX_ISSUED_KEYS caps hand-outs even while keys remain in the pool", async () => {
  mockMgmt();
  process.env.MAX_ISSUED_KEYS = "2";
  try {
    await withFakeState(async () => {
      await pushPoolKeys([1, 2, 3].map((i) => ({ key: `sk-pool-${i}`, name: `ra-pool-00${i}`, capped: true })));
      assert.equal((await handOutPoolKey("c1", 0)).ok, true);
      assert.equal((await handOutPoolKey("c2", 0)).ok, true);
      assert.equal(await capReachedForNewClaim(), true);
      assert.deepEqual(await handOutPoolKey("c3", 0), { ok: false, reason: "exhausted" });
      assert.equal(await poolSize(), 1, "the third key stays in the pool");
    });
  } finally {
    delete process.env.MAX_ISSUED_KEYS;
  }
});

test("owner alert fires once per day when the pool drops below the threshold", async () => {
  const calls = mockMgmt();
  process.env.ALERT_EMAIL = "owner@example.com";
  try {
    await withFakeState(async () => {
      assert.equal(await alertPoolLow(POOL_LOW_THRESHOLD), false, "at threshold: no alert");
      assert.equal(await alertPoolLow(POOL_LOW_THRESHOLD - 1), true);
      assert.equal(await alertPoolLow(0), false, "deduplicated for the day");
      const mails = calls.filter((c) => c.url.includes("api.resend.com"));
      assert.equal(mails.length, 1);
      assert.deepEqual(mails[0].body.to, ["owner@example.com"]);
      assert.match(mails[0].body.subject, /pool is low/);
      assert.ok(!JSON.stringify(mails[0].body).includes("sk-"), "alert never carries key values");
    });
    // The hand-out path triggers it on its own.
    const calls2 = mockMgmt();
    await withFakeState(async () => {
      await pushPoolKeys([{ key: "sk-pool-zzzz", name: "ra-pool-009", capped: true }]);
      assert.equal((await handOutPoolKey("c9", 0)).ok, true);
      await new Promise((r) => setTimeout(r, 10)); // alert is fire-and-forget
      assert.equal(calls2.filter((c) => c.url.includes("api.resend.com")).length, 1);
    });
  } finally {
    delete process.env.ALERT_EMAIL;
  }
});

test("FakeState mirrors the Durable Object's stats shape (no money fields)", async () => {
  await withFakeState(async (st: FakeState) => {
    const s = await st.stats();
    assert.deepEqual(Object.keys(s).sort(), ["claims", "pool_available", "pool_issued", "published", "verified"]);
  });
});
