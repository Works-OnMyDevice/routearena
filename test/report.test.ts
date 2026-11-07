import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PRIMARIES, saveConfig } from "../src/config.js";
import { startProxy } from "../src/proxy/server.js";
import { buildReport } from "../src/report/build.js";
import { renderReportHtml } from "../src/report/html.js";
import { aggregate, isEmptyOutput, pairTtft, type ReportAggregates } from "../src/report/aggregate.js";
import type { JudgeResult } from "../src/report/judge.js";
import type { LogRecord, SideResult } from "../src/proxy/logger.js";
import type { ResolvedTarget, Target } from "../src/targets/index.js";
import { startMockUpstream, tmpCwd } from "./helpers.js";

const mk = (id: string, name: string, url: string, models: Target["models"]): ResolvedTarget => ({
  target: { id, name, baseUrl: url, keyEnv: "X", models, pricesCaptured: "2026-11-05" },
  status: "key",
  baseUrl: url,
  auth: "k",
});

test("end to end: proxy log -> aggregates -> html/json, with exact-match agreement and gaps", async () => {
  const cwd = tmpCwd();
  const primary = await startMockUpstream({
    reply: (b) => ({ text: b.messages[0].content.includes("json") ? '{"a":1,"b":[1,2]}' : "The capital of France is Paris.", usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.00031 }, delayMs: 5 }),
  });
  const fast = await startMockUpstream({ reply: (b) => ({ text: b.messages[0].content.includes("json") ? '{"b":[1,2],"a":1}' : "Paris is the capital of France.", usage: { prompt_tokens: 905, completion_tokens: 38 }, delayMs: 2 }) });
  let n = 0;
  const flaky = await startMockUpstream({ reply: () => (n++ % 5 === 0 ? { status: 429 } : { text: "Paris.", usage: { prompt_tokens: 910, completion_tokens: 12 }, delayMs: 15 }) });
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const targets = [
    mk("tokenrouter", "TokenRouter", fast.url, {
      "openai/gpt-4o-mini": { id: "openai/gpt-4o-mini", input_per_m: 0.15, output_per_m: 0.6 },
      "deepseek/deepseek-v4.1-flash": { id: "deepseek/deepseek-v4.1-flash", input_per_m: 0.18, output_per_m: 0.72 },
    }),
    mk("groq", "Groq", flaky.url, { "openai/gpt-4o-mini": { id: "gpt-4o-mini-groq", input_per_m: 0.2, output_per_m: 0.8 } }),
  ];
  saveConfig({ primary: "openrouter", sample: 1, port: 0, createdAt: new Date().toISOString() }, cwd);
  const proxy = await startProxy({ config: { primary: "openrouter", sample: 1, port: 0, createdAt: "" }, primaryKey: "k", credits: null, cwd, targets });
  const models = ["openai/gpt-4o-mini", "deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5.5"];
  try {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: models[i % 3], stream: i % 3 === 0, messages: [{ role: "user", content: i % 2 ? "reply in json" : "capital of France?" }] }),
      });
      await r.text();
    }
    await proxy.engine.drain();
  } finally {
    await proxy.close();
  }
  const res = await buildReport({ cwd, judge: true }); // no judge endpoint available in tests -> exact-match only
  const a = res.aggregates;
  assert.equal(res.records, 30);
  assert.equal(a.primary.cost_source, "measured");
  assert.ok(Math.abs(a.primary.cost_usd - 30 * 0.00031) < 1e-9);
  const tr = a.targets.find((t) => t.target === "tokenrouter")!;
  const gq = a.targets.find((t) => t.target === "groq")!;
  assert.equal(tr.requests_mirrored, 30);
  assert.equal(tr.unmapped_requests, 10, "claude model unmapped on tokenrouter mock");
  assert.equal(tr.gaps[0].model, "anthropic/claude-sonnet-5.5");
  assert.equal(tr.pairs, 20);
  assert.equal(tr.error_rate, 0);
  assert.ok(gq.errors >= 1 && (gq.error_rate ?? 0) > 0, "flaky target shows errors");
  assert.ok(tr.delta_pct !== null && tr.projected_monthly_usd !== null);
  assert.equal(tr.projection_confidence, "low", "a seconds-long run is a low-confidence projection");
  assert.equal(a.projection.basis, "elapsed_time");
  // agreement: sampled 25% of pairs, exact-match path (json deep-equal agrees; prose differs -> skipped without judge)
  assert.ok(tr.agreement_judged >= 1, "some pairs judged by exact match");
  const html = fs.readFileSync(res.htmlPath, "utf8");
  assert.ok(html.includes("TokenRouter") && html.includes("Coverage gaps") && html.includes("anthropic/claude-sonnet-5.5"));
  assert.ok(!/sk-|Bearer/.test(html), "no key material in html");
  assert.ok(!html.includes("<script"), "no scripts in report");
  assert.ok(html.includes("rough extrapolation"), "short run is labelled as an extrapolation");
  const json = JSON.parse(fs.readFileSync(res.jsonPath, "utf8"));
  assert.equal(json.v, 1);
  assert.ok(!JSON.stringify(json).includes("capital of France"), "no completion text in aggregates");
  // renderer handles empty targets too
  assert.ok(renderReportHtml({ ...a, targets: [], target_models: [] }).includes("No targets received"));
  if (process.env.ROUTEARENA_KEEP_HTML) fs.copyFileSync(res.htmlPath, path.join(process.env.ROUTEARENA_KEEP_HTML, "e2e-report.html"));
  await Promise.all([primary.close(), fast.close(), flaky.close()]);
});

// ---------------------------------------------------------------------------------------------
// Synthetic-pair tests for the aggregate fixes: TTFT comparability, empty outputs, cache-neutral
// and price-only deltas, complete-pairs cost, unpriced targets, projection confidence.
// ---------------------------------------------------------------------------------------------

type Side = Partial<SideResult> & Record<string, unknown>;
const ENTRY = { id: "gpt-4o-mini", input_per_m: 1, output_per_m: 2, cached_input_per_m: 0.5 };

let seq = 0;
function rec(ts: string, primary: Side = {}, target: Side | null = {}, model = "openai/gpt-4o-mini"): LogRecord {
  const p: SideResult = {
    provider: "openrouter",
    model,
    status: "ok",
    stream: true,
    latency_ms: 100,
    ttft_ms: 50,
    ttft_method: "first-stream-chunk",
    usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
    cost_usd: 0.001,
    cost_source: "measured",
    finish_reason: "stop",
    completion_text: "hello",
    tool_calls: null,
    ...(primary as any),
  };
  const t: SideResult = {
    provider: "tokenrouter",
    model: "gpt-4o-mini",
    status: "ok",
    stream: true,
    via: "direct",
    latency_ms: 80,
    ttft_ms: 40,
    ttft_method: "first-content-chunk",
    usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
    cost_usd: 0.0008,
    cost_source: "computed",
    finish_reason: "stop",
    completion_text: "hello",
    tool_calls: null,
    ...(target as any),
  };
  return {
    v: 1,
    id: `r${++seq}`,
    ts,
    canonical_model: model,
    request: { stream: true, has_images: false, has_tools: false, est_input_tokens: 1000 },
    primary: p,
    mirrored: target !== null,
    skip_reason: target === null ? "not_sampled" : undefined,
    targets: target === null ? [] : [t],
  };
}

function agg(records: LogRecord[], extra: Partial<Parameters<typeof aggregate>[0]> = {}): ReportAggregates {
  return aggregate({
    records,
    judgements: [],
    version: "test",
    sampleRate: 1,
    byok: false,
    judgeModel: null,
    targetMeta: { tokenrouter: { name: "TokenRouter", pricesCaptured: "2026-11-06" } },
    priceTables: { tokenrouter: { "openai/gpt-4o-mini": ENTRY } },
    now: () => new Date("2026-11-08T12:00:00Z"),
    ...extra,
  });
}

const row = (a: ReportAggregates) => a.target_models.find((x) => x.target === "tokenrouter")!;
const tgt = (a: ReportAggregates) => a.targets.find((x) => x.target === "tokenrouter")!;
const near = (x: number | null | undefined, y: number, msg?: string) => assert.ok(x !== null && x !== undefined && Math.abs(x - y) < 1e-9, `${msg ?? ""} expected ${y}, got ${x}`);

test("pairTtft compares only same-method values", () => {
  const side = (o: Side): SideResult => ({ provider: "x", model: "m", status: "ok", ...(o as any) });
  // legacy: first-byte on the primary vs first-content on the target -> not comparable
  assert.equal(pairTtft(side({ ttft_ms: 50, ttft_method: "first-stream-chunk" }), side({ ttft_ms: 40, ttft_method: "first-content-chunk" })), null);
  // legacy, same method on both sides -> compared, labelled
  assert.deepEqual(pairTtft(side({ ttft_ms: 50, ttft_method: "first-content-chunk" }), side({ ttft_ms: 40, ttft_method: "first-content-chunk" })), { primary: 50, target: 40, method: "first-content" });
  assert.deepEqual(pairTtft(side({ ttft_ms: 50, ttft_method: "first-stream-chunk" }), side({ ttft_ms: 40, ttft_method: "first-stream-chunk" })), { primary: 50, target: 40, method: "first-byte" });
  // new fields win over legacy, even when legacy methods differ
  assert.deepEqual(pairTtft(side({ ttft_ms: 50, ttft_method: "first-stream-chunk", ttft_first_content_ms: 120 }), side({ ttft_ms: 40, ttft_method: "first-content-chunk", ttft_first_content_ms: 90 })), { primary: 120, target: 90, method: "first-content" });
  // first-byte on both sides, no first-content anywhere -> compared as first-byte
  assert.deepEqual(pairTtft(side({ ttft_first_byte_ms: 30 }), side({ ttft_first_byte_ms: 20 })), { primary: 30, target: 20, method: "first-byte" });
  // missing on one side -> null
  assert.equal(pairTtft(side({ ttft_ms: 50, ttft_method: "first-stream-chunk" }), side({})), null);
});

test("aggregate: TTFT is not comparable for legacy mixed-method logs and comparable when both sides share a method", () => {
  // legacy log as the proxy wrote it: primary first byte, target first content
  const legacy = agg([rec("2026-11-08T01:00:00Z"), rec("2026-11-08T01:00:10Z")]);
  assert.equal(row(legacy).ttft_method, null);
  assert.equal(row(legacy).ttft.n, 0);
  assert.equal(row(legacy).primary_ttft.n, 0);
  assert.equal(row(legacy).ttft_not_comparable, 2);
  assert.equal(tgt(legacy).ttft_method, null);
  // per-side quantiles still surface separately
  assert.equal(row(legacy).ttft_first_byte.primary.n, 2);
  assert.equal(row(legacy).ttft_first_byte.target.n, 0);
  assert.equal(row(legacy).ttft_first_content.target.n, 2);
  assert.equal(legacy.primary.ttft_method, "first-byte");
  const html = renderReportHtml(legacy);
  assert.ok(html.includes("not comparable"), "html says TTFT is not comparable");
  assert.ok(!/like for like/i.test(html), "no like-for-like phrasing");

  // new log: both sides carry first_content and first_byte
  const fresh = agg([
    rec("2026-11-08T01:00:00Z", { ttft_first_byte_ms: 30, ttft_first_content_ms: 300 }, { ttft_first_byte_ms: 20, ttft_first_content_ms: 200 }),
    rec("2026-11-08T01:00:10Z", { ttft_first_byte_ms: 35, ttft_first_content_ms: 350 }, { ttft_first_byte_ms: 25, ttft_first_content_ms: 250 }),
  ]);
  assert.equal(row(fresh).ttft_method, "first-content");
  assert.equal(row(fresh).ttft.n, 2);
  assert.equal(row(fresh).primary_ttft.p50, 300);
  assert.equal(row(fresh).ttft.p50, 200);
  assert.equal(row(fresh).ttft_not_comparable, 0);
  assert.equal(row(fresh).ttft_first_byte.primary.p50, 30);
  assert.equal(row(fresh).ttft_first_byte.target.p50, 20);
  assert.equal(tgt(fresh).ttft_method, "first-content");
  assert.equal(tgt(fresh).primary_ttft.p50, 300);
  assert.ok(renderReportHtml(fresh).includes("first content token"));
});

test("aggregate: empty outputs are counted per side and excluded from TTFT on both sides", () => {
  const ok = { ttft_ms: 100, ttft_method: "first-content-chunk" as const };
  const records = [
    rec("2026-11-08T01:00:00Z", ok, ok),
    // old-log primary empty: finish length, no text, but a first-content ttft value is present -> must be dropped
    rec("2026-11-08T01:00:10Z", { ...ok, ttft_ms: 5, finish_reason: "length", completion_text: null, usage: { prompt_tokens: 1000, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 2000 } } }, ok),
    // old-log target empty: finish length, no text, no ttft
    rec("2026-11-08T01:00:20Z", ok, { finish_reason: "length", completion_text: null, ttft_ms: undefined }),
    // new flag on a "stop" response
    rec("2026-11-08T01:00:30Z", ok, { ...ok, ttft_ms: 7, empty_output: true, completion_text: "" }),
  ];
  const a = agg(records);
  assert.equal(isEmptyOutput(records[1].primary), true);
  assert.equal(isEmptyOutput(records[2].targets[0]), true);
  assert.equal(isEmptyOutput(records[3].targets[0]), true);
  assert.equal(isEmptyOutput(records[0].primary), false);
  assert.deepEqual(row(a).no_output, { primary: 1, target: 2 });
  assert.deepEqual(tgt(a).no_output, { primary: 1, target: 2 });
  assert.equal(a.primary.no_output, 1);
  assert.equal(a.models[0].no_output, 1);
  // only the first pair has two live sides with the same method
  assert.equal(row(a).ttft.n, 1);
  assert.equal(row(a).primary_ttft.n, 1);
  assert.equal(row(a).primary_ttft.p50, 100);
  assert.equal(a.primary.ttft.n, 3, "primary-level TTFT drops the empty primary response");
  // truncated counts both directions
  assert.deepEqual(row(a).truncated, { pairs: 2, primary_only: 1, target_only: 1, both: 0 });
  const html = renderReportHtml(a);
  assert.ok(html.includes("target only 1") && html.includes("No output"));
});

test("aggregate: cache-neutral and price-only deltas on a synthetic pair", () => {
  const a = agg([
    rec(
      "2026-11-08T01:00:00Z",
      { usage: { prompt_tokens: 1_000_000, completion_tokens: 50_000, prompt_tokens_details: { cached_tokens: 0 } }, cost_usd: 2.0 },
      { usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 500_000 } }, cost_usd: 0.95 },
    ),
  ]);
  const r = row(a);
  near(r.primary_cost_usd, 2.0);
  near(r.target_cost_usd, 0.95);
  near(r.delta_pct, -52.5, "as served");
  near(r.target_cost_cache_neutral_usd, 1.2, "cache-neutral = 0.95 + 500k x (1.0 - 0.5)/1e6");
  near(r.delta_pct_cache_neutral, -40, "cache-neutral delta");
  near(r.target_cost_price_only_usd, 1.1, "price-only = 1M x 1 + 50k x 2");
  near(r.delta_pct_price_only, -45, "price-only delta");
  assert.deepEqual(r.tokens.target, { prompt_tokens: 1_000_000, completion_tokens: 100_000, cached_tokens: 500_000, reasoning_tokens: 0 });
  assert.equal(r.tokens.primary.completion_tokens, 50_000);
  assert.equal(r.cache_share.target, 0.5);
  assert.equal(r.cache_share.primary, 0);
  const t = tgt(a);
  near(t.delta_pct_cache_neutral, -40);
  near(t.delta_pct_price_only, -45);
  near(t.measured.delta_pct, -52.5);
  assert.ok(t.cache_warning && /50%/.test(t.cache_warning), "cache asymmetry above 20 points warns");
  const html = renderReportHtml(a);
  assert.ok(html.includes("cache-neutral") && html.includes("price-only") && html.includes(t.cache_warning!.slice(0, 30)));
  // no price-table entry -> recomputations are null, as-served still reported
  const b = agg([rec("2026-11-08T01:00:00Z")], { priceTables: { tokenrouter: {} } });
  assert.equal(row(b).target_cost_cache_neutral_usd, null);
  assert.equal(row(b).delta_pct_price_only, null);
  assert.equal(tgt(b).delta_pct_cache_neutral, null);
  assert.equal(tgt(b).cache_warning, null);
  near(row(b).delta_pct, -20);
});

test("aggregate: complete-pairs cost excludes truncated and empty pairs", () => {
  const a = agg([
    rec("2026-11-08T01:00:00Z", { cost_usd: 0.001 }, { cost_usd: 0.0005 }),
    rec("2026-11-08T01:00:10Z", { cost_usd: 0.001 }, { cost_usd: 0.004, finish_reason: "length" }),
    rec("2026-11-08T01:00:20Z", { cost_usd: 0.001, finish_reason: "length", completion_text: null }, { cost_usd: 0.0005 }),
    rec("2026-11-08T01:00:30Z", { cost_usd: 0.001, finish_reason: "tool_calls", completion_text: null, tool_calls: [{ name: "f", arguments: "{}" }] }, { cost_usd: 0.0005, finish_reason: "tool_calls", completion_text: null, tool_calls: [{ name: "f", arguments: "{}" }] }),
  ]);
  const r = row(a);
  assert.equal(r.cost_pairs, 4);
  near(r.primary_cost_usd, 0.004);
  near(r.target_cost_usd, 0.0055);
  near(r.delta_pct, 37.5, "as served over all priced pairs");
  assert.equal(r.cost_complete_pairs.pairs, 2, "stop+stop and tool_calls+tool_calls");
  near(r.cost_complete_pairs.primary_cost_usd, 0.002);
  near(r.cost_complete_pairs.target_cost_usd, 0.001);
  near(r.cost_complete_pairs.delta_pct, -50);
  assert.equal(tgt(a).cost_complete_pairs.pairs, 2);
  near(tgt(a).cost_complete_pairs.delta_pct, -50);
});

test("aggregate: an ok target with no price is unpriced, not $0, and stays in latency and pair counts", () => {
  const a = agg([
    rec("2026-11-08T01:00:00Z", { cost_usd: 0.001 }, { cost_usd: 0.0005, latency_ms: 80 }),
    rec("2026-11-08T01:00:10Z", { cost_usd: 0.009 }, { cost_usd: null, latency_ms: 500 }),
    rec("2026-11-08T01:00:20Z", { cost_usd: 0.009 }, { cost_usd: undefined, latency_ms: 600 }),
  ]);
  const r = row(a);
  assert.equal(r.pairs, 3);
  assert.equal(r.unpriced, 2);
  assert.equal(r.cost_pairs, 1);
  near(r.primary_cost_usd, 0.001, "primary cost of unpriced pairs is excluded too");
  near(r.target_cost_usd, 0.0005);
  near(r.delta_pct, -50);
  assert.equal(r.latency.n, 3);
  assert.equal(r.latency.p95, 600);
  assert.equal(r.errors, 0);
  const t = tgt(a);
  assert.equal(t.unpriced, 2);
  assert.equal(t.measured.pairs, 1);
  assert.ok(t.projected_monthly_usd !== null, "projection still uses the priced pair ratio");
  near(t.delta_pct, -50);
  assert.ok(renderReportHtml(a).includes("2 unpriced"));
});

test("aggregate: a 2-minute log gets low projection confidence and time-based scaling", () => {
  const recs = [rec("2026-11-08T01:00:00Z", { cost_usd: 0.002 }), rec("2026-11-08T01:02:00Z", { cost_usd: 0.002 })];
  const a = agg(recs);
  assert.equal(a.projection.confidence, "low");
  assert.equal(a.projection.basis, "elapsed_time");
  assert.equal(a.period!.days, 1);
  assert.ok(a.period!.span_hours < 0.04);
  near(a.projection.factor, 720, "span floored at 1 hour -> 30 x 24");
  near(a.primary.monthly_usd, 0.004 * 720);
  near(a.primary.avg_cost_per_request_usd, 0.002);
  assert.equal(tgt(a).projection_confidence, "low");
  assert.ok(a.method.sample_size_note && /low/.test(a.method.sample_size_note));
  assert.ok(/rough extrapolation/.test(a.method.projection));
  const html = renderReportHtml(a);
  assert.ok(html.includes("rough extrapolation") && html.includes("Measured spend") && html.includes("Projection confidence: low"));

  // 3 days, 60 pairs -> ok, calendar-day scaling
  const many: LogRecord[] = [];
  for (let i = 0; i < 60; i++) many.push(rec(new Date(Date.parse("2026-11-01T00:00:00Z") + i * 72 * 60_000).toISOString(), { cost_usd: 0.001 }));
  const b = agg(many);
  assert.equal(b.projection.confidence, "ok");
  assert.equal(b.projection.basis, "calendar_days");
  assert.equal(b.period!.days, 3);
  near(b.projection.factor, 10);
  assert.equal(b.method.sample_size_note, null);
  assert.ok(!renderReportHtml(b).includes("Projection confidence: low"));
});

test("aggregate: agreement breakdown counts json and numeric methods; reasoning leaks are attributed per side", () => {
  const leakText = '{"analysis":"the user wants a summary, so I should..."}';
  const records = [
    rec("2026-11-08T01:00:00Z"),
    rec("2026-11-08T01:00:10Z"),
    rec("2026-11-08T01:00:20Z"),
    rec("2026-11-08T01:00:30Z"),
    rec("2026-11-08T01:00:40Z", {}, { completion_text: leakText }),
    rec("2026-11-08T01:00:50Z", { completion_text: leakText }, {}),
    rec("2026-11-08T01:01:00Z", {}, {}),
  ];
  const j = (i: number, verdict: JudgeResult["verdict"], method: JudgeResult["method"], note?: string): JudgeResult => ({ record_id: records[i].id, target: "tokenrouter", verdict, method, note });
  const a = agg(records, {
    judgements: [
      j(0, "agree", "exact"),
      j(1, "agree", "json"),
      j(2, "disagree", "numeric"),
      j(3, "agree", "llm"),
      j(4, "skipped", "none", "reasoning_leak"),
      j(5, "skipped", "none", "reasoning_leak"),
      j(6, "skipped", "none", "reasoning_leak:target"), // a future note that names the side is honoured without looking at text
    ],
  });
  const r = row(a);
  assert.deepEqual(r.agreement, { judged: 4, agreed: 3, rate: 0.75, exact: 1, json: 1, numeric: 1, llm: 1 });
  assert.deepEqual(r.reasoning_leak, { pairs: 3, primary: 1, target: 2 });
  assert.deepEqual(tgt(a).reasoning_leak, { pairs: 3, primary: 1, target: 2 });
  assert.equal(tgt(a).agreement_judged, 4);
  assert.ok(/reasoning channel/.test(a.method.agreement) && /multisets/.test(a.method.agreement) && !/identical leaf values/.test(a.method.agreement));
  const html = renderReportHtml(a);
  assert.ok(html.includes("reasoning leak 1 / 2") && html.includes("leak 1 / 2"));
  // no leaks -> no leak counter rendered (the Method text still explains the term)
  assert.ok(!/reasoning leak \d+ \/ \d+/.test(renderReportHtml(agg([rec("2026-11-08T01:00:00Z")]))));
});

test("aggregate: existing JSON fields are still present", () => {
  const a = agg([rec("2026-11-08T01:00:00Z")]);
  for (const k of ["v", "generated_at", "tool", "period", "primary", "sampling", "models", "targets", "target_models", "method"]) assert.ok(k in a, k);
  for (const k of ["provider", "requests", "requests_ok", "errors", "cost_usd", "cost_source", "monthly_usd", "topup_fee_usd", "latency", "ttft", "prompt_tokens", "completion_tokens"]) assert.ok(k in a.primary, `primary.${k}`);
  const r = row(a);
  for (const k of ["target", "model", "target_model", "pairs", "requests_mirrored", "errors", "error_rate", "error_types", "unmapped", "primary_cost_usd", "target_cost_usd", "delta_pct", "latency", "ttft", "primary_latency", "primary_ttft", "primary_upstreams", "target_upstreams", "agreement", "tool_calls", "truncated"]) assert.ok(k in r, `target_models.${k}`);
  const t = tgt(a);
  for (const k of ["target", "name", "via", "requests_mirrored", "pairs", "errors", "error_rate", "unmapped_requests", "coverage_pct", "projected_monthly_usd", "comparable_monthly_usd", "delta_usd", "delta_pct", "latency", "ttft", "agreement_rate", "agreement_judged", "gaps", "failing"]) assert.ok(k in t, `targets.${k}`);
  for (const k of ["costs", "sampling", "ttft", "agreement", "judge_model", "sample_size_note", "prices"]) assert.ok(k in a.method, `method.${k}`);
});
