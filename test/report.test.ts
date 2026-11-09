import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PRIMARIES, logPath, saveConfig, saveCredits, type Credits } from "../src/config.js";
import { startProxy } from "../src/proxy/server.js";
import { buildReport, fetchBilledCosts, TOKENROUTER_COST_NOTE } from "../src/report/build.js";
import { renderReportHtml } from "../src/report/html.js";
import { aggregate, isEmptyOutput, isReported, pairTtft, type ReportAggregates } from "../src/report/aggregate.js";
import { assertPublishable } from "../src/report/publish.js";
import type { JudgeResult } from "../src/report/judge.js";
import type { LogRecord, SideResult } from "../src/proxy/logger.js";
import type { ResolvedTarget, Target } from "../src/targets/index.js";
import { startMockUpstream, tmpCwd } from "./helpers.js";

/** Words that would mean a shipped or computed price crept back into the report. */
const PRICE_WORDS = /price table|price-only|cache-neutral|cache_neutral|5\.5%|top-up fee|per_m|input_per_m|output_per_m|computed from/i;

const mk = (id: string, name: string, url: string, reportsCost: boolean): ResolvedTarget => ({
  target: { id, name, baseUrl: url, keyEnv: "X", reportsCost } as Target,
  status: "key",
  baseUrl: url,
  auth: "k",
});

test("end to end: proxy log -> aggregates -> html/json, with reported costs, a target that reports none, and a rejected model", async () => {
  const cwd = tmpCwd();
  const primary = await startMockUpstream({
    reply: (b) => ({ text: b.messages[0].content.includes("json") ? '{"a":1,"b":[1,2]}' : "The capital of France is Paris.", usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.00031 }, delayMs: 5 }),
  });
  // TokenRouter-like: no cost on the response; refuses the claude model.
  const silent = await startMockUpstream({ reply: (b) => (String(b.model).includes("claude") ? { status: 404 } : { text: b.messages[0].content.includes("json") ? '{"b":[1,2],"a":1}' : "Paris is the capital of France.", usage: { prompt_tokens: 905, completion_tokens: 38 }, delayMs: 2 }) });
  // Groq-like: reports usage.cost; flaky.
  let n = 0;
  const flaky = await startMockUpstream({ reply: () => (n++ % 5 === 0 ? { status: 429 } : { text: "Paris.", usage: { prompt_tokens: 910, completion_tokens: 12, cost: 0.0002 }, delayMs: 15 }) });
  (PRIMARIES.openrouter as any).baseUrl = primary.url;
  const targets = [mk("tokenrouter", "TokenRouter", silent.url, false), mk("groq", "Groq", flaky.url, true)];
  const cfg = { primary: "openrouter" as const, sample: 1, port: 0, createdAt: new Date().toISOString(), model_map: { groq: { "openai/gpt-4o-mini": "gpt-4o-mini-groq" } } };
  saveConfig(cfg as any, cwd);
  const proxy = await startProxy({ config: cfg as any, primaryKey: "k", credits: null, cwd, targets });
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
  const res = await buildReport({ cwd, judge: true, billed: null }); // no judge endpoint available in tests -> exact-match only; no relay
  const a = res.aggregates;
  assert.equal(res.records, 30);
  assert.equal(a.primary.cost_source, "reported");
  assert.ok(Math.abs(a.primary.cost_usd - 30 * 0.00031) < 1e-9);
  const tr = a.targets.find((t) => t.target === "tokenrouter")!;
  const gq = a.targets.find((t) => t.target === "groq")!;
  assert.equal(tr.requests_mirrored, 30);
  assert.equal(tr.pairs, 20);
  // the claude model was refused every time -> rejected, coverage 20/30
  assert.equal(tr.rejected.length, 1);
  assert.equal(tr.rejected[0].model, "anthropic/claude-sonnet-5.5");
  assert.equal(tr.rejected[0].error_type, "model_not_found");
  assert.equal(tr.rejected[0].attempts, 10);
  assert.ok(tr.coverage_pct !== null && Math.abs(tr.coverage_pct - (20 / 30) * 100) < 1e-9);
  // no cost on TokenRouter responses -> not reported, headline null with the TokenRouter note, tokens still there
  assert.equal(tr.reported.pairs, 0);
  assert.equal(tr.cost_not_reported.target, 20);
  assert.equal(tr.headline.delta_pct, null);
  assert.equal(tr.headline.note, TOKENROUTER_COST_NOTE);
  assert.ok(tr.tokens.target.prompt_tokens > 0 && tr.tokens.primary.prompt_tokens > 0);
  assert.equal(tr.projected_monthly_usd, null);
  // groq reports usage.cost -> reported pairs and a delta
  assert.ok(gq.errors >= 1 && (gq.error_rate ?? 0) > 0, "flaky target shows errors");
  assert.ok(gq.reported.pairs > 0 && gq.reported.delta_pct !== null && gq.projected_monthly_usd !== null, "reported costs on both sides give a delta");
  assert.equal(gq.target_cost_origin, "reported");
  assert.equal(gq.rejected.length, 0);
  assert.equal(gq.projection_confidence, "low", "a seconds-long run is a low-confidence projection");
  assert.equal(a.projection.basis, "elapsed_time");
  const gqRow = a.target_models.find((x) => x.target === "groq" && x.model === "openai/gpt-4o-mini")!;
  assert.equal(gqRow.target_model, "gpt-4o-mini-groq", "model_map decides the id sent to the target");
  // agreement: sampled 25% of pairs, exact-match path (json deep-equal agrees; prose differs -> skipped without judge)
  assert.ok(tr.agreement_judged >= 1, "some pairs judged by exact match");
  const html = fs.readFileSync(res.htmlPath, "utf8");
  assert.ok(html.includes("TokenRouter") && html.includes("Rejected by a target") && html.includes("anthropic/claude-sonnet-5.5"));
  assert.ok(html.includes("cost not reported by TokenRouter"));
  assert.ok(!PRICE_WORDS.test(html), "no price-table or fee language in html");
  assert.ok(!/sk-|Bearer/.test(html), "no key material in html");
  assert.ok(!html.includes("<script"), "no scripts in report");
  assert.ok(html.includes("rough extrapolation"), "short run is labelled as an extrapolation");
  const json = JSON.parse(fs.readFileSync(res.jsonPath, "utf8"));
  assert.equal(json.v, 1);
  assert.ok(!JSON.stringify(json).includes("capital of France"), "no completion text in aggregates");
  assert.ok(!PRICE_WORDS.test(JSON.stringify(json)), "no price-table language in aggregates");
  assertPublishable(json);
  // renderer handles empty targets too
  assert.ok(renderReportHtml({ ...a, targets: [], target_models: [] }).includes("No targets received"));
  if (process.env.ROUTEARENA_KEEP_HTML) fs.copyFileSync(res.htmlPath, path.join(process.env.ROUTEARENA_KEEP_HTML, "e2e-report.html"));
  await Promise.all([primary.close(), silent.close(), flaky.close()]);
});

// ---------------------------------------------------------------------------------------------
// Synthetic-pair tests: reported costs, not_reported exclusion, billed fill, rejected list,
// TTFT comparability, empty outputs, complete-pairs cost, projection confidence.
// ---------------------------------------------------------------------------------------------

type Side = Partial<SideResult> & Record<string, unknown>;

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
    cost_source: "reported",
    finish_reason: "stop",
    completion_text: "hello",
    tool_call_stats: null,
    ...(primary as any),
  } as SideResult;
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
    cost_source: "reported",
    finish_reason: "stop",
    completion_text: "hello",
    tool_call_stats: null,
    ...(target as any),
  } as SideResult;
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

/** A target side with no provider cost, as the proxy logs TokenRouter. */
const NOT_REPORTED: Side = { cost_usd: null, cost_source: "not_reported" };

function agg(records: LogRecord[], extra: Partial<Parameters<typeof aggregate>[0]> = {}): ReportAggregates {
  return aggregate({
    records,
    judgements: [],
    version: "test",
    sampleRate: 1,
    judgeModel: null,
    targetMeta: { tokenrouter: { name: "TokenRouter", reportsCost: false, costHint: TOKENROUTER_COST_NOTE } },
    now: () => new Date("2026-11-08T12:00:00Z"),
    ...extra,
  });
}

const row = (a: ReportAggregates) => a.target_models.find((x) => x.target === "tokenrouter")!;
const tgt = (a: ReportAggregates) => a.targets.find((x) => x.target === "tokenrouter")!;
const near = (x: number | null | undefined, y: number, msg?: string) => assert.ok(x !== null && x !== undefined && Math.abs(x - y) < 1e-9, `${msg ?? ""} expected ${y}, got ${x}`);

test("isReported: only a provider figure counts; legacy computed costs do not", () => {
  const side = (o: Side): SideResult => ({ provider: "x", model: "m", status: "ok", ...(o as any) });
  assert.equal(isReported(side({ cost_usd: 0.1, cost_source: "reported" })), true);
  assert.equal(isReported(side({ cost_usd: 0.1, cost_source: "measured" })), true, "legacy name for a reported cost");
  assert.equal(isReported(side({ cost_usd: 0.1 })), true, "no source recorded: the number came from the provider");
  assert.equal(isReported(side({ cost_usd: 0.1, cost_source: "computed" })), false, "legacy price-table figure is not a provider figure");
  assert.equal(isReported(side({ cost_usd: null, cost_source: "not_reported" })), false);
  assert.equal(isReported(side({ cost_source: "reported" })), false);
});

test("aggregate: reported costs on both sides give the delta; the headline is that delta, basis as_served", () => {
  const a = agg([
    rec("2026-11-08T01:00:00Z", { cost_usd: 0.002 }, { cost_usd: 0.001 }),
    rec("2026-11-08T01:00:10Z", { cost_usd: 0.002 }, { cost_usd: 0.0015 }),
  ]);
  const r = row(a);
  assert.equal(r.pairs, 2);
  assert.equal(r.cost_pairs, 2);
  near(r.primary_cost_usd, 0.004);
  near(r.target_cost_usd, 0.0025);
  near(r.delta_pct, -37.5);
  assert.equal(r.target_cost_origin, "reported");
  assert.deepEqual(r.cost_not_reported, { primary: 0, target: 0 });
  const t = tgt(a);
  near(t.reported.delta_pct, -37.5);
  assert.equal(t.reported.pairs, 2);
  assert.equal(t.headline.basis, "as_served");
  near(t.headline.delta_pct, -37.5);
  assert.ok(/reported costs over 2 pairs/.test(t.headline.note));
  near(t.avg_cost_per_request_usd.target!, 0.00125);
  assert.ok(t.projected_monthly_usd !== null && t.delta_pct !== null);
  assert.equal(a.primary.cost_source, "reported");
  assert.equal(a.primary.cost_not_reported, 0);
  const html = renderReportHtml(a);
  assert.ok(html.includes("reported cost delta over 2 pairs"));
  assert.ok(!PRICE_WORDS.test(html));
});

test("aggregate: a side with no provider cost is cost_not_reported, excluded from cost totals, kept in latency, tokens and pairs", () => {
  const a = agg([
    rec("2026-11-08T01:00:00Z", { cost_usd: 0.001 }, { cost_usd: 0.0005, latency_ms: 80 }),
    rec("2026-11-08T01:00:10Z", { cost_usd: 0.009 }, { ...NOT_REPORTED, latency_ms: 500 }),
    rec("2026-11-08T01:00:20Z", { cost_usd: 0.009 }, { cost_usd: undefined, latency_ms: 600 }),
    rec("2026-11-08T01:00:30Z", { cost_usd: null, cost_source: "not_reported" }, { cost_usd: 0.0005, latency_ms: 90 }),
  ]);
  const r = row(a);
  assert.equal(r.pairs, 4);
  assert.deepEqual(r.cost_not_reported, { primary: 1, target: 2 });
  assert.equal(r.cost_pairs, 1);
  near(r.primary_cost_usd, 0.001, "primary cost of pairs without a target cost is excluded too");
  near(r.target_cost_usd, 0.0005);
  near(r.delta_pct, -50);
  assert.equal(r.latency.n, 4);
  assert.equal(r.latency.p95, 600);
  assert.equal(r.tokens.target.prompt_tokens, 4000, "tokens are summed over every pair, costed or not");
  assert.equal(r.errors, 0);
  const t = tgt(a);
  assert.deepEqual(t.cost_not_reported, { primary: 1, target: 2 });
  assert.equal(t.reported.pairs, 1);
  near(t.delta_pct, -50, "projection uses the costed pair ratio");
  assert.equal(a.primary.cost_source, "mixed");
  assert.equal(a.primary.cost_not_reported, 1);
  near(a.primary.cost_usd, 0.019);
  const html = renderReportHtml(a);
  assert.ok(html.includes("no cost: TokenRouter 2, OpenRouter 1"));
  assert.ok(html.includes("not reported 1 / 2"));
});

test("aggregate: a target with no cost at all gets a null headline and the TokenRouter note; tokens stay", () => {
  const a = agg([rec("2026-11-08T01:00:00Z", {}, NOT_REPORTED), rec("2026-11-08T01:00:10Z", {}, NOT_REPORTED)]);
  const t = tgt(a);
  assert.equal(t.reported.pairs, 0);
  assert.equal(t.headline.delta_pct, null);
  assert.equal(t.headline.basis, "as_served");
  assert.equal(t.headline.note, TOKENROUTER_COST_NOTE);
  assert.equal(t.target_cost_origin, null);
  assert.equal(t.projected_monthly_usd, null);
  assert.equal(t.tokens.target.completion_tokens, 200);
  assert.equal(t.pairs, 2);
  const html = renderReportHtml(a);
  assert.ok(html.includes("cost not reported by TokenRouter"));
  assert.ok(html.includes("leaves dollars to you"));
  // a target without a hint gets the generic note naming it
  const b = agg([rec("2026-11-08T01:00:00Z", {}, { ...NOT_REPORTED, provider: "groq" })], { targetMeta: { groq: { name: "Groq" } } });
  assert.ok(/Groq did not report a cost per response/.test(b.targets[0].headline.note));
});

test("aggregate: billed amounts fill target costs by target_request_id and are labelled billed", () => {
  const recs = [
    rec("2026-11-08T01:00:00Z", { cost_usd: 0.001 }, { ...NOT_REPORTED, target_request_id: "req-a" }),
    rec("2026-11-08T01:00:10Z", { cost_usd: 0.001 }, { ...NOT_REPORTED, target_request_id: "req-b" }),
    rec("2026-11-08T01:00:20Z", { cost_usd: 0.001 }, { ...NOT_REPORTED, target_request_id: "req-missing" }),
    rec("2026-11-08T01:00:30Z", { cost_usd: 0.001 }, NOT_REPORTED), // no request id at all
  ];
  const a = agg(recs, { billed: { tokenrouter: { "req-a": 0.0004, "req-b": 0.0006, "req-unrelated": 5 } } });
  const r = row(a);
  assert.equal(r.cost_pairs, 2);
  assert.deepEqual(r.cost_not_reported, { primary: 0, target: 2 });
  near(r.primary_cost_usd, 0.002);
  near(r.target_cost_usd, 0.001);
  near(r.delta_pct, -50);
  assert.equal(r.target_cost_origin, "billed");
  const t = tgt(a);
  assert.equal(t.target_cost_origin, "billed");
  near(t.headline.delta_pct, -50);
  assert.ok(/billed costs over 2 pairs/.test(t.headline.note));
  assert.ok(t.projected_monthly_usd !== null, "billed pairs drive the projection like reported ones");
  const html = renderReportHtml(a);
  assert.ok(html.includes("billed cost delta over 2 pairs") && html.includes("read via the relay"));
  // a bill wins over a response cost for the same request; mixing both gives origin "mixed"
  const b = agg([rec("2026-11-08T01:00:00Z", { cost_usd: 0.001 }, { cost_usd: 0.0009, target_request_id: "req-a" }), rec("2026-11-08T01:00:10Z", { cost_usd: 0.001 }, { cost_usd: 0.0009 })], { billed: { tokenrouter: { "req-a": 0.0001 } } });
  near(row(b).target_cost_usd, 0.001);
  assert.equal(row(b).target_cost_origin, "mixed");
  // bills for another target never leak across
  const c = agg(recs, { billed: { groq: { "req-a": 0.0004 } } });
  assert.equal(row(c).cost_pairs, 0);
});

test("aggregate: rejected models are listed from rejection error types; coverage is the share of mirrored requests accepted", () => {
  const err = (type: string, model: string): Side => ({ status: "error", error_type: type, model, cost_usd: undefined, usage: undefined, latency_ms: 30 });
  const a = agg([
    rec("2026-11-08T01:00:00Z"),
    rec("2026-11-08T01:00:10Z"),
    rec("2026-11-08T01:00:20Z", {}, err("model_not_found", "claude-x"), "anthropic/claude-x"),
    rec("2026-11-08T01:00:30Z", {}, err("model_not_found", "claude-x"), "anthropic/claude-x"),
    rec("2026-11-08T01:00:40Z", {}, err("bad_request", "claude-x"), "anthropic/claude-x"),
    rec("2026-11-08T01:00:50Z", {}, err("rate_limited", "gpt-4o-mini")), // transient: an error, not a rejection
    rec("2026-11-08T01:01:00Z", {}, err("unsupported_parameter", "llama"), "meta-llama/llama-3.1-8b-instruct"),
    rec("2026-11-08T01:01:10Z", {}, {}, "meta-llama/llama-3.1-8b-instruct"),
  ]);
  const t = tgt(a);
  assert.equal(t.requests_mirrored, 8);
  assert.equal(t.errors, 5);
  near(t.error_rate!, 5 / 8);
  assert.deepEqual(t.rejected, [
    { model: "anthropic/claude-x", target_model: "claude-x", attempts: 3, error_type: "model_not_found" },
    { model: "meta-llama/llama-3.1-8b-instruct", target_model: "llama", attempts: 1, error_type: "unsupported_parameter" },
  ]);
  near(t.coverage_pct!, 50, "4 of 8 mirrored requests were rejected");
  assert.equal((a.target_models.find((x) => x.model === "openai/gpt-4o-mini")!).error_types.rate_limited, 1);
  const html = renderReportHtml(a);
  assert.ok(html.includes("Rejected by a target") && html.includes("3 requests rejected (model not found)") && html.includes("2 models rejected"));
  assert.ok(html.includes("50% of mirrored requests"));
  // nothing rejected -> says so
  assert.ok(renderReportHtml(agg([rec("2026-11-08T01:00:00Z")])).includes("None. Every mirrored request was accepted"));
  assert.deepEqual(tgt(agg([rec("2026-11-08T01:00:00Z")])).rejected, []);
});

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
  // reasoning tokens flow through the token totals
  assert.equal(row(a).tokens.primary.reasoning_tokens, 2000);
  const html = renderReportHtml(a);
  assert.ok(html.includes("target only 1") && html.includes("No output") && html.includes("reasoning 2,000 / 0"));
});

test("aggregate: tokens, cache share and the cache warning are factual and carry no price", () => {
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
  near(r.delta_pct, -52.5, "reported");
  assert.deepEqual(r.tokens.target, { prompt_tokens: 1_000_000, completion_tokens: 100_000, cached_tokens: 500_000, reasoning_tokens: 0 });
  assert.equal(r.tokens.primary.completion_tokens, 50_000);
  assert.equal(r.cache_share.target, 0.5);
  assert.equal(r.cache_share.primary, 0);
  const t = tgt(a);
  near(t.reported.delta_pct, -52.5);
  assert.ok(t.cache_warning && /50%/.test(t.cache_warning) && /reported costs include that discount/.test(t.cache_warning), "cache asymmetry above 20 points warns, factually");
  assert.ok(!("target_cost_cache_neutral_usd" in r) && !("delta_pct_price_only" in r) && !("delta_pct_cache_neutral" in t), "no recomputed deltas");
  const html = renderReportHtml(a);
  assert.ok(html.includes(t.cache_warning!.slice(0, 30)) && html.includes("in 1,000,000 / 1,000,000"));
  assert.ok(!PRICE_WORDS.test(html));
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
  near(r.delta_pct, 37.5, "reported over all costed pairs");
  assert.equal(r.cost_complete_pairs.pairs, 2, "stop+stop and tool_calls+tool_calls");
  near(r.cost_complete_pairs.primary_cost_usd, 0.002);
  near(r.cost_complete_pairs.target_cost_usd, 0.001);
  near(r.cost_complete_pairs.delta_pct, -50);
  assert.equal(tgt(a).cost_complete_pairs.pairs, 2);
  near(tgt(a).cost_complete_pairs.delta_pct, -50);
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
  assert.ok(html.includes("rough extrapolation") && html.includes("Reported spend") && html.includes("Projection confidence: low"));

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
  const j = (i: number, verdict: JudgeResult["verdict"], method: JudgeResult["method"], note?: string, reason?: string): JudgeResult => ({ record_id: records[i].id, target: "tokenrouter", verdict, method, note, reason });
  const a = agg(records, {
    judgements: [
      j(0, "agree", "exact"),
      j(1, "agree", "json"),
      j(2, "disagree", "numeric", undefined, "the totals differ by an order of magnitude"),
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
  assert.deepEqual(tgt(a).disagreement_reasons, ["the totals differ by an order of magnitude"]);
  assert.ok(/reasoning channel/.test(a.method.agreement) && /multisets/.test(a.method.agreement));
  const html = renderReportHtml(a);
  assert.ok(html.includes("reasoning leak 1 / 2") && html.includes("leak 1 / 2") && html.includes("order of magnitude"));
  // no leaks -> no leak counter rendered (the Method text still explains the term)
  assert.ok(!/reasoning leak \d+ \/ \d+/.test(renderReportHtml(agg([rec("2026-11-08T01:00:00Z")]))));
});

test("aggregate: JSON shape has the new fields and none of the removed ones; method text names no prices", () => {
  const a = agg([rec("2026-11-08T01:00:00Z")]);
  for (const k of ["v", "generated_at", "tool", "period", "projection", "primary", "sampling", "models", "targets", "target_models", "method"]) assert.ok(k in a, k);
  for (const k of ["provider", "requests", "requests_ok", "errors", "no_output", "cost_not_reported", "cost_usd", "cost_source", "monthly_usd", "latency", "ttft", "prompt_tokens", "completion_tokens", "cached_tokens", "reasoning_tokens"]) assert.ok(k in a.primary, `primary.${k}`);
  assert.ok(!("topup_fee_usd" in a.primary) && !("unpriced" in a.primary));
  const r = row(a);
  for (const k of ["target", "model", "target_model", "pairs", "requests_mirrored", "errors", "error_rate", "error_types", "no_output", "cost_not_reported", "cost_pairs", "primary_cost_usd", "target_cost_usd", "delta_pct", "target_cost_origin", "cost_complete_pairs", "tokens", "cache_share", "latency", "ttft", "primary_latency", "primary_ttft", "ttft_method", "ttft_not_comparable", "primary_upstreams", "target_upstreams", "agreement", "tool_call_stats", "truncated", "reasoning_leak", "disagreement_reasons"]) assert.ok(k in r, `target_models.${k}`);
  for (const k of ["unmapped", "unpriced", "unpriced_primary", "target_cost_cache_neutral_usd", "delta_pct_cache_neutral", "target_cost_price_only_usd", "delta_pct_price_only"]) assert.ok(!(k in r), `removed target_models.${k}`);
  const t = tgt(a);
  for (const k of ["target", "name", "via", "requests_mirrored", "pairs", "errors", "error_rate", "rejected", "coverage_pct", "no_output", "cost_not_reported", "truncated", "reasoning_leak", "projected_monthly_usd", "comparable_monthly_usd", "delta_usd", "delta_pct", "projection_confidence", "reported", "target_cost_origin", "avg_cost_per_request_usd", "cost_complete_pairs", "tokens", "cache_share", "cache_warning", "headline", "judge_fraction", "disagreement_reasons", "latency", "ttft", "primary_ttft", "ttft_method", "agreement_rate", "agreement_judged"]) assert.ok(k in t, `targets.${k}`);
  for (const k of ["gaps", "failing", "unmapped_requests", "unpriced", "measured", "measured_total", "cost_note", "delta_pct_cache_neutral", "delta_pct_price_only"]) assert.ok(!(k in t), `removed targets.${k}`);
  for (const k of ["costs", "complete_pairs", "empty_outputs", "sampling", "ttft", "projection", "agreement", "judge_model", "sample_size_note"]) assert.ok(k in a.method, `method.${k}`);
  assert.ok(!("prices" in a.method) && !("cost_deltas" in a.method));
  assert.ok(/reported or billed/.test(a.method.costs) && /computes no prices and ships none/.test(a.method.costs));
  assert.ok(!PRICE_WORDS.test(JSON.stringify(a)));
  assertPublishable(a);
});

// ---------------------------------------------------------------------------------------------
// build.ts network path: the relay's claim usage endpoint, mocked.
// ---------------------------------------------------------------------------------------------

const KEY_CLAIM: Credits = { token: "sk-test-free-credit-key", claimId: "c1", expiresAt: "2030-01-01T00:00:00Z", budgetUsd: 1, mode: "key" };
const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("fetchBilledCosts: reads the relay's claim usage with the claim token; swallows failures; skips relay-mode claims", async () => {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization });
    return okJson({ rows: [{ request_id: "a", model: "gpt-4o-mini", prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.001, created_at: "2026-11-08T01:00:00Z" }, { request_id: "b", cost_usd: 0.002 }, { request_id: "a", cost_usd: 0.0005 }, { request_id: "", cost_usd: 1 }, { request_id: "c", cost_usd: "n/a" }], from: "x", to: "y", fetched_at: "z", source: "tokenrouter_billing" });
  }) as unknown as typeof fetch;
  const m = await fetchBilledCosts(KEY_CLAIM, { fetchImpl, relayUrl: "https://relay.test" });
  assert.deepEqual(m, { a: 0.0015, b: 0.002 }, "rows for one request id add up; malformed rows dropped");
  assert.equal(calls[0].url, "https://relay.test/api/claim/usage");
  assert.equal(calls[0].auth, "Bearer sk-test-free-credit-key");
  // HTTP error, bad shape, thrown error -> undefined
  assert.equal(await fetchBilledCosts(KEY_CLAIM, { fetchImpl: (async () => new Response("nope", { status: 500 })) as any }), undefined);
  assert.equal(await fetchBilledCosts(KEY_CLAIM, { fetchImpl: (async () => okJson({ rows: "not-an-array" })) as any }), undefined);
  assert.equal(await fetchBilledCosts(KEY_CLAIM, { fetchImpl: (async () => { throw new Error("offline"); }) as any }), undefined);
  // relay-mode or missing claim: nothing to ask for
  let called = 0;
  const counting = (async () => { called++; return okJson({ rows: [] }); }) as any;
  assert.equal(await fetchBilledCosts({ ...KEY_CLAIM, mode: "relay" }, { fetchImpl: counting }), undefined);
  assert.equal(await fetchBilledCosts(null, { fetchImpl: counting }), undefined);
  assert.equal(called, 0);
});

test("buildReport: with a key-mode claim the relay's bills fill TokenRouter costs; without them costs stay not reported", async () => {
  const cwd = tmpCwd();
  saveConfig({ primary: "openrouter", sample: 1, port: 0, createdAt: "" } as any, cwd);
  saveCredits(KEY_CLAIM, cwd);
  const recs = [
    rec("2026-11-08T01:00:00Z", { cost_usd: 0.001 }, { ...NOT_REPORTED, target_request_id: "tr-1" }),
    rec("2026-11-08T01:00:10Z", { cost_usd: 0.001 }, { ...NOT_REPORTED, target_request_id: "tr-2" }),
  ];
  fs.mkdirSync(path.dirname(logPath(cwd)), { recursive: true });
  fs.writeFileSync(logPath(cwd), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  let urls: string[] = [];
  const fetchImpl = (async (url: any) => {
    urls.push(String(url));
    return okJson({ rows: [{ request_id: "tr-1", cost_usd: 0.0003 }, { request_id: "tr-2", cost_usd: 0.0005 }], from: "", to: "", fetched_at: "", source: "tokenrouter_billing" });
  }) as unknown as typeof fetch;
  const res = await buildReport({ cwd, judge: false, fetchImpl, relayUrl: "https://relay.test", now: () => new Date("2026-11-08T12:00:00Z") });
  assert.deepEqual(urls, ["https://relay.test/api/claim/usage"]);
  const t = res.aggregates.targets.find((x) => x.target === "tokenrouter")!;
  assert.equal(t.reported.pairs, 2);
  assert.equal(t.target_cost_origin, "billed");
  near(t.reported.target_cost_usd, 0.0008);
  near(t.headline.delta_pct, -60);
  assert.ok(fs.readFileSync(res.htmlPath, "utf8").includes("billed cost delta over 2 pairs"));

  // relay down -> not reported, note shown, nothing thrown
  urls = [];
  const down = await buildReport({ cwd, judge: false, fetchImpl: (async () => { throw new Error("offline"); }) as any, relayUrl: "https://relay.test" });
  const td = down.aggregates.targets.find((x) => x.target === "tokenrouter")!;
  assert.equal(td.reported.pairs, 0);
  assert.equal(td.headline.delta_pct, null);
  assert.equal(td.headline.note, TOKENROUTER_COST_NOTE);
  assert.deepEqual(td.cost_not_reported, { primary: 0, target: 2 });

  // billed: null skips the network entirely
  let called = 0;
  await buildReport({ cwd, judge: false, billed: null, fetchImpl: (async () => { called++; return okJson({ rows: [] }); }) as any });
  assert.equal(called, 0);
});
