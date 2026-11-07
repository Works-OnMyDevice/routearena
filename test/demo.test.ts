import { test } from "node:test";
import assert from "node:assert/strict";
import { runDemo, type WorkloadItem } from "../src/demo/run.js";
import { startMockUpstream } from "./helpers.js";

function items(n: number): WorkloadItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${i}`,
    template: "t",
    source_url: "https://example.com",
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: `item ${i}` }],
  }));
}

test("demo backs off and serializes after a credit refusal, then continues when it clears", async () => {
  let calls = 0;
  const up = await startMockUpstream({
    reply: () => {
      calls++;
      // The first two calls are refused (402), everything after succeeds.
      return calls <= 2 ? { status: 402 } : { text: "ok" };
    },
  });
  try {
    const r = await runDemo(items(6), { proxyBase: up.url, primary: "openrouter", concurrency: 3, creditRetryDelaysMs: [5, 5, 5] });
    assert.equal(r.sent, 6);
    assert.equal(r.ok, 6, "every item completes once the refusal clears");
    assert.equal(r.failed, 0);
    assert.equal(r.stopped, undefined);
    assert.ok((r.credit_retries ?? 0) >= 1 && (r.credit_retries ?? 0) <= 2, `retries=${r.credit_retries}`);
  } finally {
    await up.close();
  }
});

test("demo halts instead of burning the workload when the primary keeps refusing for credits", async () => {
  const up = await startMockUpstream({ reply: () => ({ status: 402 }) });
  try {
    const r = await runDemo(items(40), { proxyBase: up.url, primary: "openrouter", concurrency: 4, creditRetryDelaysMs: [5, 5, 5] });
    assert.ok(r.stopped, "run reports that it stopped");
    assert.equal(r.stopped!.error_type, "insufficient_credits");
    assert.ok(r.sent <= 4, `only the first wave was attempted (sent=${r.sent})`);
    assert.equal(r.ok, 0);
    assert.ok(up.seen.length <= 4 * 4, `requests made=${up.seen.length}`);
  } finally {
    await up.close();
  }
});

test("demo halts on an auth refusal without retrying", async () => {
  const up = await startMockUpstream({ reply: () => ({ status: 401 }) });
  try {
    const r = await runDemo(items(10), { proxyBase: up.url, primary: "openrouter", concurrency: 1 });
    assert.ok(r.stopped);
    assert.equal(r.sent, 1);
    assert.equal(up.seen.length, 1);
  } finally {
    await up.close();
  }
});
