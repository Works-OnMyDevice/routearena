import assert from "node:assert/strict";
import { test } from "node:test";

process.env.HMAC_SECRET = "test-secret-not-for-production";

test("relay tokens sign and verify; tampering and expiry fail", async () => {
  const { signToken, verifyToken } = await import("../lib/token");
  const id = "abcdefabcdefabcdefabcdef";
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const tok = await signToken(id, exp);
  assert.ok(tok.startsWith("ra_"));
  assert.deepEqual(await verifyToken(tok), { claimId: id, exp });
  assert.equal(await verifyToken(tok.slice(0, -1) + (tok.endsWith("a") ? "b" : "a")), null);
  assert.equal(await verifyToken(await signToken(id, Math.floor(Date.now() / 1000) - 10)), null);
  assert.equal(await verifyToken("sk-not-a-relay-token"), null);
});

test("publish validation rejects prompt-like payloads and accepts aggregates", async () => {
  const { validateAggregates } = await import("../api/publish");
  assert.equal(validateAggregates({ v: 1, primary: { requests: 3 }, targets: [{ target: "x", gaps: [{ model: "a/b", requests: 1 }] }] }), null);
  assert.match(validateAggregates({ messages: [] })!, /not allowed/);
  assert.match(validateAggregates({ a: { completion_text: "x" } })!, /not allowed/);
  assert.match(validateAggregates({ s: "x".repeat(501) })!, /longer/);
  assert.match(validateAggregates({ nested: { deep: { content: "x" } } })!, /not allowed/);
});

test("cost table computes from TokenRouter ids and defaults for unknown models", async () => {
  const { costFor, priceFor } = await import("../lib/prices");
  const e = priceFor("openai/gpt-4o-mini");
  assert.ok(e && e.input_per_m === 0.15 && e.output_per_m === 0.6);
  const c = costFor("openai/gpt-4o-mini", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.ok(Math.abs(c.usd - 0.75) < 1e-9 && c.known);
  const u = costFor("some/unknown-model", { prompt_tokens: 1_000_000, completion_tokens: 0 });
  assert.ok(u.usd === 15 && !u.known, "unknown models are charged conservatively");
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
