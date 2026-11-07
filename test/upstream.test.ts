import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion } from "../src/proxy/openaiCall.js";
import { startMockUpstream } from "./helpers.js";

test("records the upstream host a router names in its response, streaming and not", async () => {
  const up = await startMockUpstream({ reply: () => ({ text: "a b c" }) });
  try {
    const plain = await chatCompletion({ baseUrl: up.url, auth: "k", body: { model: "m", messages: [{ role: "user", content: "x" }] }, timeoutMs: 5000 });
    assert.equal(plain.status, "ok");
    assert.equal(plain.upstream, "mock-host");
    const streamed = await chatCompletion({ baseUrl: up.url, auth: "k", body: { model: "m", messages: [{ role: "user", content: "x" }], stream: true }, timeoutMs: 5000, streamForTtft: true });
    assert.equal(streamed.status, "ok");
    assert.equal(streamed.upstream, "mock-host");
  } finally {
    await up.close();
  }
});

test("chatCompletion (mirror side) records first-byte and first-content TTFT, response id, and ignores reasoning deltas", async () => {
  const up = await startMockUpstream({ reply: () => ({ text: "a b", comment: true, reasoning: "hmm", gapMs: 40, id: "gen-abc" }) });
  try {
    const r = await chatCompletion({ baseUrl: up.url, auth: "k", body: { model: "m", messages: [{ role: "user", content: "x" }] }, timeoutMs: 5000, streamForTtft: true });
    assert.equal(r.status, "ok");
    assert.ok(typeof r.ttft_first_byte_ms === "number" && r.ttft_first_byte_ms > 0);
    assert.ok(typeof r.ttft_first_content_ms === "number");
    assert.ok(r.ttft_first_byte_ms! < r.ttft_first_content_ms!, `${r.ttft_first_byte_ms} < ${r.ttft_first_content_ms}`);
    assert.ok(r.ttft_first_content_ms! - r.ttft_first_byte_ms! >= 30);
    assert.equal(r.ttft_ms, r.ttft_first_content_ms);
    assert.equal(r.ttft_method, "first-content-chunk");
    assert.equal(r.response_id, "gen-abc");
    assert.equal(r.empty_output, undefined);
    assert.equal(r.completion_text, "a b");

    const plain = await chatCompletion({ baseUrl: up.url, auth: "k", body: { model: "m", messages: [{ role: "user", content: "x" }] }, timeoutMs: 5000 });
    assert.equal(plain.response_id, "gen-abc");
    assert.equal(plain.ttft_method, "n/a");
    assert.equal(plain.ttft_first_byte_ms, undefined);
    assert.equal(plain.ttft_first_content_ms, undefined);
  } finally {
    await up.close();
  }
});

test("chatCompletion: length finish with no content is ok + empty_output; an in-stream error chunk is status error", async () => {
  const empty = await startMockUpstream({ reply: () => ({ text: "", reasoning: "...", finishReason: "length" }) });
  const errored = await startMockUpstream({ reply: () => ({ comment: true, errorChunk: { code: 429, message: "Rate limit exceeded upstream" }, id: "gen-err" }) });
  const strCode = await startMockUpstream({ reply: () => ({ errorChunk: { code: "model_not_found", message: "no such model" } }) });
  try {
    const body = { model: "m", messages: [{ role: "user", content: "x" }] };
    const e = await chatCompletion({ baseUrl: empty.url, auth: "k", body, timeoutMs: 5000, streamForTtft: true });
    assert.equal(e.status, "ok");
    assert.equal(e.empty_output, true);
    assert.equal(e.finish_reason, "length");
    assert.equal(e.completion_text, null);
    assert.equal(e.ttft_ms, undefined);
    assert.equal(e.ttft_method, "n/a");
    assert.ok((e.ttft_first_byte_ms ?? 0) > 0);

    const r = await chatCompletion({ baseUrl: errored.url, auth: "k", body, timeoutMs: 5000, streamForTtft: true });
    assert.equal(r.status, "error");
    assert.equal(r.http_status, 200);
    assert.equal(r.error_type, "rate_limited");
    assert.match(r.error ?? "", /Rate limit exceeded/);
    assert.equal(r.response_id, "gen-err");
    assert.equal(r.empty_output, undefined);

    const s = await chatCompletion({ baseUrl: strCode.url, auth: "k", body, timeoutMs: 5000, streamForTtft: true });
    assert.equal(s.status, "error");
    assert.equal(s.error_type, "model_not_found");
  } finally {
    await empty.close();
    await errored.close();
    await strCode.close();
  }
});

test("chatCompletion: a timeout is error_type timeout with elapsed latency", async () => {
  const slow = await startMockUpstream({ reply: () => ({ text: "late", delayMs: 300 }) });
  try {
    const r = await chatCompletion({ baseUrl: slow.url, auth: "k", body: { model: "m", messages: [{ role: "user", content: "x" }] }, timeoutMs: 50, streamForTtft: true });
    assert.equal(r.status, "error");
    assert.equal(r.error_type, "timeout");
    assert.ok(r.latency_ms >= 40 && r.latency_ms < 1000, `latency ${r.latency_ms}`);
  } finally {
    await slow.close();
  }
});
