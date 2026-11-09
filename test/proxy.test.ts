import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { PRIMARIES, logPath, type Config } from "../src/config.js";
import { readLog } from "../src/proxy/logger.js";
import { startProxy } from "../src/proxy/server.js";
import type { ResolvedTarget, Target } from "../src/targets/index.js";
import { startMockUpstream, tmpCwd, waitFor } from "./helpers.js";

function mockTarget(id: string, baseUrl: string, extra: Partial<Target> = {}): ResolvedTarget {
  const target: Target = { id, name: id, baseUrl, keyEnv: `${id.toUpperCase()}_API_KEY`, reportsCost: false, ...extra };
  return { target, status: "key", baseUrl, auth: `${id}-secret` };
}

const baseCfg = (port = 0, extra: Partial<Config> = {}): Config => ({ primary: "openrouter", sample: 1.0, port, hourlyCap: 500, maxInputTokens: 32_000, mirrorImages: false, createdAt: "", ...extra });

test("forwards non-streaming requests unchanged, swaps auth, mirrors the same model id to the target, logs both", async () => {
  const primary = await startMockUpstream({ reply: () => ({ text: "hello world", usage: { prompt_tokens: 12, completion_tokens: 2, cost: 0.00042 } }) });
  const target = await startMockUpstream({ reply: () => ({ text: "hello world", usage: { prompt_tokens: 12, completion_tokens: 2 } }) });
  const cwd = tmpCwd();
  // Point the "openrouter" primary at the mock.
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({
    config: baseCfg(),
    primaryKey: "sk-or-v1-primary-secret",
    credits: null,
    cwd,
    targets: [mockTarget("tgt", target.url)],
  });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-key-should-not-leak" },
      body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-mock"), "json"); // upstream headers relayed
    const json: any = await res.json();
    assert.equal(json.choices[0].message.content, "hello world");
    assert.equal(json.usage.cost, 0.00042);

    // primary saw our key, not the client's
    assert.equal(primary.seen[0].headers.authorization, "Bearer sk-or-v1-primary-secret");
    assert.equal(primary.seen[0].body.model, "openai/gpt-4o-mini");

    await proxy.engine.drain();
    await waitFor(() => target.seen.length === 1);
    assert.equal(target.seen[0].headers.authorization, "Bearer tgt-secret");
    assert.equal(target.seen[0].body.model, "openai/gpt-4o-mini", "no model_map: the target gets the id the client sent");
    assert.equal(target.seen[0].body.stream, true, "mirror streams for TTFT");
    assert.equal(target.seen[0].body.usage, undefined, "OpenRouter-only fields stripped");

    await waitFor(() => fs.existsSync(logPath(cwd)));
    const recs = await readLog(logPath(cwd));
    assert.equal(recs.length, 1);
    const r = recs[0];
    assert.equal(r.mirrored, true);
    assert.equal(r.primary.status, "ok");
    assert.equal(r.primary.cost_usd, 0.00042, "primary cost is what OpenRouter reported");
    assert.equal(r.primary.cost_source, "reported");
    assert.equal(r.targets.length, 1);
    assert.equal(r.targets[0].status, "ok");
    assert.equal(r.targets[0].model, "openai/gpt-4o-mini");
    assert.ok((r.targets[0].ttft_ms ?? 0) > 0);
    // The target returned tokens but no cost: RouteArena never prices tokens itself.
    assert.strictEqual(r.targets[0].cost_usd, null);
    assert.equal(r.targets[0].cost_source, "not_reported");
    assert.equal(r.targets[0].target_request_id, undefined, "no requestIdHeader configured");
    assert.ok(!("reported_cost_usd" in r.targets[0]));
    const rawLog = fs.readFileSync(logPath(cwd), "utf8");
    assert.ok(!rawLog.includes("secret"), "no key in log");
  } finally {
    await proxy.close();
    await primary.close();
    await target.close();
  }
});

test("model_map from config overrides the id sent to a target; other targets still get the client's id", async () => {
  const primary = await startMockUpstream({ reply: () => ({ text: "ok" }) });
  const mapped = await startMockUpstream({ reply: () => ({ text: "ok" }) });
  const plain = await startMockUpstream({ reply: () => ({ text: "ok" }) });
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({
    config: baseCfg(0, { model_map: { mapped: { "meta-llama/llama-3.3-70b-instruct": "llama-3.3-70b-versatile" } } }),
    primaryKey: "k",
    credits: null,
    cwd,
    targets: [mockTarget("mapped", mapped.url), mockTarget("plain", plain.url)],
  });
  try {
    const send = (model: string) =>
      fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      }).then((r) => r.text());
    await send("meta-llama/llama-3.3-70b-instruct:nitro");
    await send("qwen/qwen3-8b");
    await proxy.engine.drain();
    await waitFor(() => mapped.seen.length === 2 && plain.seen.length === 2);
    assert.deepEqual(mapped.seen.map((s) => s.body.model).sort(), ["llama-3.3-70b-versatile", "qwen/qwen3-8b"], "override applies only where the map has an entry");
    assert.deepEqual(plain.seen.map((s) => s.body.model).sort(), ["meta-llama/llama-3.3-70b-instruct", "qwen/qwen3-8b"], "unmapped target: client's id minus the OpenRouter variant suffix");
    assert.deepEqual(primary.seen.map((s) => s.body.model).sort(), ["meta-llama/llama-3.3-70b-instruct:nitro", "qwen/qwen3-8b"], "primary request body untouched");
    const recs = await readLog(logPath(cwd));
    const llama = recs.find((r) => r.canonical_model === "meta-llama/llama-3.3-70b-instruct")!;
    assert.equal(llama.targets.find((t) => t.provider === "mapped")!.model, "llama-3.3-70b-versatile", "log records the id actually sent");
    assert.equal(llama.targets.find((t) => t.provider === "plain")!.model, "meta-llama/llama-3.3-70b-instruct");
  } finally {
    await proxy.close();
    await primary.close();
    await mapped.close();
    await plain.close();
  }
});

test("target_request_id is captured from the target's requestIdHeader; cost_source reported when the target sends usage.cost", async () => {
  const primary = await startMockUpstream({ reply: () => ({ text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 } }) });
  const withId = await startMockUpstream({ reply: () => ({ text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 }, headers: { "x-tokenrouter-request-id": "tr-req-42", "x-other": "ignored" } }) });
  const reporting = await startMockUpstream({ reply: () => ({ text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0000077 }, headers: { "x-tokenrouter-request-id": "not-configured" } }) });
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({
    config: baseCfg(),
    primaryKey: "k",
    credits: null,
    cwd,
    targets: [mockTarget("tokenrouter", withId.url, { requestIdHeader: "x-tokenrouter-request-id" }), mockTarget("router2", reporting.url, { reportsCost: true })],
  });
  try {
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x/y", messages: [{ role: "user", content: "hi" }] }),
    })).text();
    await proxy.engine.drain();
    const [r] = await readLog(logPath(cwd));
    const tr = r.targets.find((t) => t.provider === "tokenrouter")!;
    assert.equal(tr.status, "ok");
    assert.equal(tr.target_request_id, "tr-req-42");
    assert.equal(tr.response_id, "chatcmpl-mock", "completion id still recorded alongside");
    assert.strictEqual(tr.cost_usd, null);
    assert.equal(tr.cost_source, "not_reported");
    const r2 = r.targets.find((t) => t.provider === "router2")!;
    assert.equal(r2.target_request_id, undefined, "header not captured unless the target declares it");
    assert.equal(r2.cost_usd, 0.0000077);
    assert.equal(r2.cost_source, "reported");
  } finally {
    await proxy.close();
    await primary.close();
    await withId.close();
    await reporting.close();
  }
});

test("OpenAI primary: usage without cost is not_reported (never computed), and the request is still mirrored", async () => {
  // Plenty of tokens (and a cache hit) but no usage.cost: the only honest answer is "not reported".
  const primary = await startMockUpstream({ reply: () => ({ text: "ok", usage: { prompt_tokens: 20_000, completion_tokens: 1_000, prompt_tokens_details: { cached_tokens: 10_000 } } }) });
  const target = await startMockUpstream({ reply: () => ({ text: "ok" }) });
  const cwd = tmpCwd();
  const saved = PRIMARIES.openai.baseUrl;
  (PRIMARIES.openai as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(0, { primary: "openai" }), primaryKey: "sk-openai", credits: null, cwd, targets: [mockTarget("tgt", target.url)] });
  try {
    for (const stream of [false, true]) {
      await (await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", stream, messages: [{ role: "user", content: "hi" }] }),
      })).text();
    }
    await proxy.engine.drain();
    await waitFor(() => target.seen.length === 2);
    const recs = await readLog(logPath(cwd));
    assert.equal(recs.length, 2);
    for (const r of recs) {
      assert.equal(r.primary.provider, "openai");
      assert.equal(r.primary.status, "ok");
      assert.equal(r.primary.usage?.prompt_tokens, 20_000);
      assert.strictEqual(r.primary.cost_usd, null, `stream=${r.primary.stream}: OpenAI reports no cost and RouteArena has no table`);
      assert.equal(r.primary.cost_source, "not_reported");
      assert.equal(r.canonical_model, "openai/gpt-4o-mini");
      assert.equal(r.mirrored, true);
      assert.equal(r.targets[0].model, "gpt-4o-mini", "the bare id the client sent goes to the target");
    }
  } finally {
    (PRIMARIES.openai as any).baseUrl = saved;
    await proxy.close();
    await primary.close();
    await target.close();
  }
});

test("streams primary bytes through untouched and records TTFT", async () => {
  const primary = await startMockUpstream({ reply: () => ({ text: "one two three", usage: { prompt_tokens: 3, completion_tokens: 3, cost: 0.000001 } }) });
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd, targets: [] });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x/y", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.ok(text.includes('"content":"one"'));
    assert.ok(text.trim().endsWith("data: [DONE]"));
    assert.equal(primary.seen[0].body.stream_options?.include_usage, true, "usage injected for streams");
    await waitFor(() => fs.existsSync(logPath(cwd)));
    const [r] = await readLog(logPath(cwd));
    assert.equal(r.primary.stream, true);
    assert.ok((r.primary.ttft_ms ?? 0) > 0);
    // Both sides measure ttft_ms on the first content chunk.
    assert.equal(r.primary.ttft_method, "first-content-chunk");
    assert.equal(r.primary.ttft_ms, r.primary.ttft_first_content_ms);
    assert.ok((r.primary.ttft_first_byte_ms ?? Infinity) <= (r.primary.ttft_first_content_ms ?? 0));
    assert.equal(r.primary.response_id, "chatcmpl-mock");
    assert.equal(r.primary.empty_output, undefined);
    assert.equal(r.primary.completion_text, "one two three");
    assert.equal(r.primary.cost_usd, 0.000001);
    assert.equal(r.primary.cost_source, "reported");
    assert.equal(r.skip_reason, "no_targets");
  } finally {
    await proxy.close();
    await primary.close();
  }
});

test("TTFT symmetry: first byte (SSE comment) precedes first content on both sides; reasoning deltas do not count", async () => {
  // Primary: comment line, then a reasoning delta, then (after a gap) content. The target does the same.
  const reply = () => ({ text: "answer here", comment: true, reasoning: "thinking...", gapMs: 40, id: "gen-primary-1", usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.000002 } });
  const primary = await startMockUpstream({ reply });
  const target = await startMockUpstream({ reply: () => ({ ...reply(), id: "gen-target-1", usage: { prompt_tokens: 3, completion_tokens: 2 } }) });
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd, targets: [mockTarget("tgt", target.url)] });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x/y", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await res.text();
    assert.ok(text.startsWith(": OPENROUTER PROCESSING"), "comment line relayed byte-for-byte");
    await proxy.engine.drain();
    await waitFor(() => fs.existsSync(logPath(cwd)));
    const [r] = await readLog(logPath(cwd));
    for (const side of [r.primary, r.targets[0]]) {
      assert.equal(side.status, "ok", `${side.provider} ok`);
      assert.ok(typeof side.ttft_first_byte_ms === "number" && side.ttft_first_byte_ms > 0, `${side.provider} first byte recorded`);
      assert.ok(typeof side.ttft_first_content_ms === "number", `${side.provider} first content recorded`);
      // comment + reasoning + 40 ms gap all happen before the first content chunk
      assert.ok(side.ttft_first_byte_ms! < side.ttft_first_content_ms!, `${side.provider}: first byte ${side.ttft_first_byte_ms} < first content ${side.ttft_first_content_ms}`);
      assert.ok(side.ttft_first_content_ms! - side.ttft_first_byte_ms! >= 30, `${side.provider}: gap reflects the preamble`);
      assert.equal(side.ttft_ms, side.ttft_first_content_ms, `${side.provider}: legacy ttft_ms is first content`);
      assert.equal(side.ttft_method, "first-content-chunk");
      assert.equal(side.completion_text, "answer here");
      assert.equal(side.empty_output, undefined);
    }
    assert.equal(r.primary.response_id, "gen-primary-1");
    assert.equal(r.targets[0].response_id, "gen-target-1");
    assert.equal(r.request.reasoning_control, "none");
  } finally {
    await proxy.close();
    await primary.close();
    await target.close();
  }
});

test("empty output (finish_reason length, no content) is flagged on both sides and stays status ok", async () => {
  const reply = () => ({ text: "", reasoning: "thinking that never ends", finishReason: "length", usage: { prompt_tokens: 5, completion_tokens: 4000, cost: 0.001 } });
  const primary = await startMockUpstream({ reply });
  const target = await startMockUpstream({ reply });
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd, targets: [mockTarget("tgt", target.url)] });
  try {
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x/y", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })).text();
    await proxy.engine.drain();
    const [r] = await readLog(logPath(cwd));
    for (const side of [r.primary, r.targets[0]]) {
      assert.equal(side.status, "ok");
      assert.equal(side.empty_output, true, `${side.provider} flagged empty`);
      assert.equal(side.finish_reason, "length");
      assert.equal(side.completion_text, null);
      assert.equal(side.ttft_ms, undefined, "no content, no content TTFT");
      assert.equal(side.ttft_first_content_ms, undefined);
      assert.ok((side.ttft_first_byte_ms ?? 0) > 0);
      assert.equal(side.ttft_method, "n/a");
    }
  } finally {
    await proxy.close();
    await primary.close();
    await target.close();
  }
});

test("a 200 stream carrying an error chunk and no content is status error on the primary (and skips mirrors)", async () => {
  const primary = await startMockUpstream({ reply: () => ({ comment: true, errorChunk: { code: 502, message: "Provider returned error" } }) });
  const target = await startMockUpstream();
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd, targets: [mockTarget("tgt", target.url)] });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x/y", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200, "client still gets the 200 the primary sent");
    await res.text();
    await proxy.engine.drain();
    const [r] = await readLog(logPath(cwd));
    assert.equal(r.primary.status, "error");
    assert.equal(r.primary.http_status, 200);
    assert.equal(r.primary.error_type, "upstream_error");
    assert.match(r.primary.error ?? "", /Provider returned error/);
    assert.equal(r.primary.empty_output, undefined);
    assert.equal(r.skip_reason, "primary_failed");
    assert.equal(target.seen.length, 0);
  } finally {
    await proxy.close();
    await primary.close();
    await target.close();
  }
});

test("mirror body: reasoning.effort and reasoning.max_tokens become reasoning_effort; request.reasoning_control recorded", async () => {
  const primary = await startMockUpstream({ reply: () => ({ text: "ok" }) });
  const target = await startMockUpstream({ reply: () => ({ text: "ok" }) });
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd, targets: [mockTarget("tgt", target.url)] });
  const send = (extra: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x/y", messages: [{ role: "user", content: "hi" }], ...extra }),
    }).then((r) => r.text());
  try {
    await send({ reasoning: { effort: "low" }, include_reasoning: true });
    await send({ reasoning: { max_tokens: 2000 }, max_tokens: 4000 });
    await send({ reasoning_effort: "high", reasoning: { effort: "low" } });
    await send({ reasoning: { enabled: false } });
    await send({});
    await proxy.engine.drain();
    await waitFor(() => target.seen.length === 5);
    const bodies = target.seen.map((s) => s.body);
    assert.equal(bodies[0].reasoning_effort, "low");
    assert.equal(bodies[0].reasoning, undefined, "OpenRouter reasoning object stripped");
    assert.equal(bodies[0].include_reasoning, undefined, "include_reasoning stripped");
    assert.equal(bodies[1].reasoning_effort, "medium", "2000/4000 = 50% -> medium");
    assert.equal(bodies[2].reasoning_effort, "high", "client's own reasoning_effort wins");
    assert.equal(bodies[3].reasoning_effort, "none");
    assert.equal(bodies[4].reasoning_effort, undefined);
    const recs = await readLog(logPath(cwd));
    const byOrder = recs.sort((a, b) => a.ts.localeCompare(b.ts));
    assert.deepEqual(
      byOrder.map((r) => r.request.reasoning_control),
      ["reasoning.effort", "reasoning.max_tokens", "reasoning_effort", "reasoning.effort", "none"],
    );
  } finally {
    await proxy.close();
    await primary.close();
    await target.close();
  }
});

test("reasoning.max_tokens maps to the nearest documented effort fraction", async () => {
  const { effortForMaxTokens, translateReasoning } = await import("../src/proxy/mirror.js");
  assert.equal(effortForMaxTokens(400, 4000), "minimal"); // 10%
  assert.equal(effortForMaxTokens(800, 4000), "low"); // 20%
  assert.equal(effortForMaxTokens(1300, 4000), "low"); // 32.5% -> nearer 20% than 50%
  assert.equal(effortForMaxTokens(2000, 4000), "medium"); // 50%
  assert.equal(effortForMaxTokens(3200, 4000), "high"); // 80%
  assert.equal(effortForMaxTokens(3900, 4000), "max"); // 97.5%
  // No max_tokens on the request: absolute bands
  assert.equal(effortForMaxTokens(500, undefined), "minimal");
  assert.equal(effortForMaxTokens(3000, undefined), "low");
  assert.equal(effortForMaxTokens(10_000, undefined), "medium");
  assert.equal(effortForMaxTokens(30_000, undefined), "high");
  assert.equal(effortForMaxTokens(60_000, undefined), "max");
  const out: Record<string, any> = {};
  translateReasoning({ reasoning: { effort: "xhigh" } }, out);
  assert.equal(out.reasoning_effort, "xhigh");
  const keep: Record<string, any> = { reasoning_effort: "minimal" };
  translateReasoning({ reasoning: { effort: "max" } }, keep);
  assert.equal(keep.reasoning_effort, "minimal");
  const none: Record<string, any> = {};
  translateReasoning({ reasoning: { effort: "none" } }, none);
  assert.equal(none.reasoning_effort, "none");
});

test("mirror default timeout equals the primary default; a timed-out mirror records latency", async () => {
  const { DEFAULT_MIRROR_TIMEOUT_MS, MirrorEngine } = await import("../src/proxy/mirror.js");
  const { DEFAULT_TIMEOUT_MS } = await import("../src/proxy/forward.js");
  assert.equal(DEFAULT_MIRROR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 600_000);

  const slow = await startMockUpstream({ reply: () => ({ text: "late", delayMs: 400 }) });
  const cwd = tmpCwd();
  const { Logger } = await import("../src/proxy/logger.js");
  const engine = new MirrorEngine(
    { primary: "openrouter", targets: [mockTarget("slow", slow.url)], sample: 1, hourlyCap: 10, maxInputTokens: 1000, mirrorImages: false, random: () => 0, timeoutMs: 50 },
    new Logger(cwd),
  );
  try {
    engine.handle("x/y", { model: "x/y", messages: [{ role: "user", content: "hi" }] }, { provider: "openrouter", model: "x/y", status: "ok" }, true);
    await engine.drain(5000);
    const [r] = await readLog(logPath(cwd));
    const t = r.targets[0];
    assert.equal(t.status, "error");
    assert.equal(t.error_type, "timeout");
    assert.ok(typeof t.latency_ms === "number" && t.latency_ms >= 40, `latency recorded on timeout: ${t.latency_ms}`);
    assert.strictEqual(t.cost_usd, null);
    assert.equal(t.cost_source, "not_reported");
  } finally {
    await slow.close();
  }
});

test("a target 200 without usage is unpriced: cost_usd null, cost_source not_reported", async () => {
  const primary = await startMockUpstream({ reply: () => ({ text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 } }) });
  const target = await startMockUpstream({ reply: () => ({ text: "ok", usage: null }) });
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd, targets: [mockTarget("tgt", target.url)] });
  try {
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x/y", messages: [{ role: "user", content: "hi" }] }),
    })).text();
    await proxy.engine.drain();
    const [r] = await readLog(logPath(cwd));
    assert.equal(r.targets[0].status, "ok");
    assert.equal(r.targets[0].usage, null);
    assert.equal(r.targets[0].cost_source, "not_reported");
    assert.strictEqual(r.targets[0].cost_usd, null);
    assert.equal(r.primary.cost_source, "reported");
  } finally {
    await proxy.close();
    await primary.close();
    await target.close();
  }
});

test("every model is sent; a target that rejects it is status error / model_not_found, never skipped", async () => {
  const primary = await startMockUpstream();
  const target = await startMockUpstream({ reply: () => ({ status: 404 }) });
  const cwd = tmpCwd();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd, targets: [mockTarget("tgt", target.url)] });
  try {
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vendor/rare-model:free", messages: [{ role: "user", content: "hi" }] }),
    })).text();
    await proxy.engine.drain();
    await waitFor(() => target.seen.length === 1);
    assert.equal(target.seen[0].body.model, "vendor/rare-model", "sent as the client spelled it, minus the variant suffix");
    const [r] = await readLog(logPath(cwd));
    assert.equal(r.canonical_model, "vendor/rare-model");
    assert.equal(r.mirrored, true);
    assert.equal(r.targets[0].status, "error");
    assert.equal(r.targets[0].error_type, "model_not_found");
    assert.equal(r.targets[0].http_status, 404);
    assert.equal(r.targets[0].cost_source, "not_reported");
    assert.deepEqual(Object.keys(proxy.engine.stats).sort(), ["mirrored", "requests", "skipped", "target_error", "target_ok"], "no unmapped counter");
    assert.equal(proxy.engine.stats.target_error, 1);
  } finally {
    await proxy.close();
    await primary.close();
    await target.close();
  }
});

test("eligibility: images, n>1, long input, primary failure, hourly cap", async () => {
  const { MirrorEngine } = await import("../src/proxy/mirror.js");
  const { Logger } = await import("../src/proxy/logger.js");
  const cwd = tmpCwd();
  const engine = new MirrorEngine(
    { primary: "openrouter", targets: [mockTarget("t", "http://127.0.0.1:1")], sample: 1, hourlyCap: 2, maxInputTokens: 100, mirrorImages: false, random: () => 0 },
    new Logger(cwd),
  );
  assert.deepEqual(engine.eligibility({ messages: [{ role: "user", content: "x" }] }, 10, true), { ok: true });
  assert.equal(engine.eligibility({ messages: [] }, 10, false).reason, "primary_failed");
  assert.equal(engine.eligibility({ n: 2, messages: [] }, 10, true).reason, "n_gt_1");
  assert.equal(engine.eligibility({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }, 10, true).reason, "has_images");
  assert.equal(engine.eligibility({ messages: [] }, 101, true).reason, "input_too_long");
  assert.equal(engine.eligibility({ messages: [{ role: "user", content: "a".repeat(800) }] }, undefined, true).reason, "input_too_long");
  // hourly cap: two mirrored requests allowed, third refused
  const ok = { provider: "openrouter", model: "m", status: "ok" as const, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  engine.handle("x/m", { messages: [] }, ok, true);
  engine.handle("x/m", { messages: [] }, ok, true);
  const third = engine.handle("x/m", { messages: [] }, ok, true);
  assert.equal(third.skip_reason, "hourly_cap");
  await engine.drain(2000);
});

test("sampling respects the fraction", async () => {
  const { MirrorEngine } = await import("../src/proxy/mirror.js");
  const { Logger } = await import("../src/proxy/logger.js");
  const cwd = tmpCwd();
  let i = 0;
  const rolls = [0.05, 0.5, 0.95, 0.09];
  const engine = new MirrorEngine(
    { primary: "openrouter", targets: [mockTarget("t", "http://127.0.0.1:1")], sample: 0.1, hourlyCap: 500, maxInputTokens: 1000, mirrorImages: false, random: () => rolls[i++ % rolls.length] },
    new Logger(cwd),
  );
  const ok = { provider: "openrouter", model: "m", status: "ok" as const };
  const results = rolls.map(() => engine.handle("x/m", { messages: [] }, ok, true).mirrored);
  assert.deepEqual(results, [true, false, false, true]);
  await engine.drain(2000);
});

test("browser-originated requests are refused unless --cors", async () => {
  const primary = await startMockUpstream();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const closed = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd: tmpCwd(), targets: [] });
  const open = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd: tmpCwd(), targets: [], cors: true });
  try {
    const body = JSON.stringify({ model: "x/y", messages: [{ role: "user", content: "hi" }] });
    const r1 = await fetch(`http://127.0.0.1:${closed.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body });
    assert.equal(r1.status, 403);
    assert.equal(primary.seen.length, 0, "nothing forwarded");
    const r2 = await fetch(`http://127.0.0.1:${closed.port}/v1/chat/completions`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(r2.status, 403);
    const r3 = await fetch(`http://127.0.0.1:${open.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" }, body });
    assert.equal(r3.status, 200);
    assert.equal(r3.headers.get("access-control-allow-origin"), "http://localhost:5173");
  } finally {
    await closed.close();
    await open.close();
    await primary.close();
  }
});

test("unknown routes 404 with guidance; bad JSON 400", async () => {
  const primary = await startMockUpstream();
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const proxy = await startProxy({ config: baseCfg(), primaryKey: "k", credits: null, cwd: tmpCwd(), targets: [] });
  try {
    const r1 = await fetch(`http://127.0.0.1:${proxy.port}/v1/embeddings`, { method: "POST" });
    assert.equal(r1.status, 404);
    const j1: any = await r1.json();
    assert.match(j1.error.message, /not proxied/);
    const r2 = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", body: "{nope" });
    assert.equal(r2.status, 400);
    const r3 = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    assert.equal(r3.status, 200);
    const r4 = await fetch(`http://127.0.0.1:${proxy.port}/health`);
    assert.equal((await r4.json() as any).ok, true);
  } finally {
    await proxy.close();
    await primary.close();
  }
});
