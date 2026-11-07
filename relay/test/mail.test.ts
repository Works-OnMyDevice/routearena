import assert from "node:assert/strict";
import { test } from "node:test";

process.env.RESEND_API_KEY = "re_test_key";
process.env.MAIL_FROM = "RouteArena <onboarding@resend.dev>";
const { sendMail } = await import("../lib/mail");

function mockFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string>; throws?: boolean }>) {
  const calls: Array<{ headers: Record<string, string>; body: any }> = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    calls.push({ headers: Object.fromEntries(Object.entries(init.headers)), body: JSON.parse(init.body) });
    const r = responses.shift();
    if (!r) throw new Error("no more mock responses");
    if (r.throws) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return calls;
}

test("sendMail sends the idempotency key and returns the email id", async () => {
  const calls = mockFetch([{ status: 200, body: { id: "em_1" } }]);
  const id = await sendMail("a@example.com", "Hi", "<p>x</p>", "claim-link/abc");
  assert.equal(id, "em_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["idempotency-key"], "claim-link/abc");
  assert.deepEqual(calls[0].body.to, ["a@example.com"]);
});

test("sendMail retries 429 and 5xx with the same idempotency key, then succeeds", async () => {
  const calls = mockFetch([{ status: 429, headers: { "retry-after": "0" } }, { status: 503 }, { status: 200, body: { id: "em_2" } }]);
  const id = await sendMail("a@example.com", "Hi", "<p>x</p>", "claim-link/def");
  assert.equal(id, "em_2");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.headers["idempotency-key"] === "claim-link/def"));
});

test("sendMail does not retry other 4xx", async () => {
  const calls = mockFetch([{ status: 422, body: { message: "bad from" } }]);
  await assert.rejects(sendMail("a@example.com", "Hi", "<p>x</p>"), /resend 422/);
  assert.equal(calls.length, 1);
});

test("sendMail retries a network error and gives up after the delays are exhausted", async () => {
  const calls = mockFetch([{ status: 0, throws: true }, { status: 0, throws: true }, { status: 0, throws: true }, { status: 0, throws: true }]);
  await assert.rejects(sendMail("a@example.com", "Hi", "<p>x</p>", "k"), /fetch failed/);
  assert.equal(calls.length, 4);
});
