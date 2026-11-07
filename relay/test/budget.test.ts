import assert from "node:assert/strict";
import { test } from "node:test";

process.env.HMAC_SECRET = "test-secret-not-for-production";
process.env.PER_CLAIM_USD = "1";

test("estimate is a conservative upper bound and unknown models are refused", async () => {
  const { estimateRequest, constrainBody, SAFETY } = await import("../lib/estimate");
  const body = { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "x".repeat(3000) }], max_tokens: 100 };
  const e = estimateRequest("openai/gpt-4o-mini", body)!;
  assert.ok(e.input_tokens >= 1000, "chars/3 over-estimates tokens");
  assert.equal(e.output_tokens, 100);
  const expected = ((e.input_tokens * 0.15) / 1e6 + (100 * 0.6) / 1e6) * SAFETY;
  assert.ok(Math.abs(e.usd - expected) < 1e-12);
  assert.equal(estimateRequest("made-up/model", body), null);
  assert.equal(estimateRequest("openai/gpt-4o-mini", { ...body, max_tokens: undefined })!.output_tokens, 2048);
  assert.equal(estimateRequest("openai/gpt-4o-mini", { ...body, max_tokens: 1_000_000 })!.output_tokens, 2048);
  const c = constrainBody({ ...body, max_tokens: 1_000_000, n: 4 }, estimateRequest("openai/gpt-4o-mini", { ...body, max_tokens: 1_000_000 })!);
  assert.equal(c.max_tokens, 2048);
  assert.equal(c.n, 1);
});

test("per-claim cap is clamped regardless of env", async () => {
  const { env } = await import("../lib/env");
  process.env.PER_CLAIM_USD = "1";
  assert.equal(env.perClaimUsd, 1);
  process.env.PER_CLAIM_USD = "999";
  assert.equal(env.perClaimUsd, 5, "cannot be raised above the hard ceiling");
  process.env.PER_CLAIM_USD = "nope";
  assert.equal(env.perClaimUsd, 1);
  process.env.PER_CLAIM_USD = "1";
});

test("email normalization collapses aliases", async () => {
  const { normalizeEmail } = await import("../lib/budget");
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
