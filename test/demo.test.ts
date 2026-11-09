import { test } from "node:test";
import assert from "node:assert/strict";
import { assignModels, loadWorkload, runDemo, type WorkloadItem, type WorkloadPrompt } from "../src/demo/run.js";
import { startMockUpstream } from "./helpers.js";

function prompts(n: number): WorkloadPrompt[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${i}`,
    template: "t",
    source_url: "https://example.com",
    messages: [{ role: "user", content: `item ${i}` }],
  }));
}

function items(n: number): WorkloadItem[] {
  return assignModels(prompts(n), ["openai/gpt-4o-mini"]);
}

test("the shipped workload carries prompts only: no model on any item", async () => {
  const work = await loadWorkload();
  assert.ok(work.length >= 50, `workload has ${work.length} items`);
  for (const it of work) {
    assert.ok(!("model" in it), `${it.id} has no model`);
    assert.ok(it.id && it.template && it.source_url, `${it.id} keeps id/template/source_url`);
    assert.ok(Array.isArray(it.messages) && it.messages.length > 0, `${it.id} keeps messages`);
  }
  assert.ok(work.some((it) => it.response_format?.type === "json_object"), "response_format kept");
  // Items carry no model, so they carry no model-specific knobs either: one output budget for all, no reasoning_effort.
  assert.ok(work.every((it) => it.reasoning_effort === undefined), "no reasoning_effort on any item");
  assert.ok(work.every((it) => it.max_tokens === 8000 && typeof it.temperature === "number"), "uniform max_tokens 8000 and temperature kept");
});

test("assignModels round-robins the agent's model ids and leaves the input alone", () => {
  const src = prompts(5);
  const out = assignModels(src, ["a/one", "b/two"]);
  assert.deepEqual(out.map((i) => i.model), ["a/one", "b/two", "a/one", "b/two", "a/one"]);
  assert.deepEqual(out.map((i) => i.id), src.map((i) => i.id), "order and ids preserved");
  assert.ok(src.every((i) => !("model" in i)), "input not mutated");
  assert.deepEqual(assignModels(prompts(3), ["only"]).map((i) => i.model), ["only", "only", "only"]);
  assert.deepEqual(assignModels(prompts(2), [" a ", "", "b"]).map((i) => i.model), ["a", "b"], "trimmed, blanks dropped");
  assert.deepEqual(assignModels([], ["a"]), []);
  assert.throws(() => assignModels(prompts(1), []), /No models given/);
  assert.throws(() => assignModels(prompts(1), ["  "]), /No models given/);
});

test("runDemo sends the assigned model as-is; an OpenAI primary strips only an OpenRouter-style openai/ prefix", async () => {
  const up = await startMockUpstream({ reply: () => ({ text: "ok" }) });
  try {
    const mixed = assignModels(prompts(3), ["openai/gpt-4o-mini", "gpt-4.1-mini", "vendor/other"]);
    const r = await runDemo(mixed, { proxyBase: up.url, primary: "openai", concurrency: 1 });
    assert.equal(r.sent, 3);
    assert.equal(r.ok, 3);
    assert.deepEqual(up.seen.map((s) => s.body.model), ["gpt-4o-mini", "gpt-4.1-mini", "vendor/other"]);
    assert.deepEqual(r.by_model, { "openai/gpt-4o-mini": 1, "gpt-4.1-mini": 1, "vendor/other": 1 });
    up.seen.length = 0;
    const or = await runDemo(assignModels(prompts(2), ["openai/gpt-4o-mini"]), { proxyBase: up.url, primary: "openrouter", concurrency: 1 });
    assert.equal(or.ok, 2);
    assert.deepEqual(up.seen.map((s) => s.body.model), ["openai/gpt-4o-mini", "openai/gpt-4o-mini"]);
  } finally {
    await up.close();
  }
});

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
