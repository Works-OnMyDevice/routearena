import type { LogRecord, SideResult } from "../proxy/logger.js";
import { addTokenTotals, tokenTotals, zeroTokens, type TokenTotals } from "../targets/mapping.js";
import { isReasoningLeak, type JudgeResult } from "./judge.js";

/**
 * Aggregation rules. RouteArena computes no prices and ships none: every cost figure here is a number a provider
 * reported for a request (usage.cost on the response) or billed for it (TokenRouter's own bill for a free-credit
 * key, read by the relay and joined to the pair by request id). A side without a reported or billed cost is counted
 * as `cost_not_reported` and stays in latency, error, token and agreement figures but never enters a cost total.
 */

export interface Quantiles {
  p50: number | null;
  p95: number | null;
  n: number;
}

export function quantiles(values: number[]): Quantiles {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { p50: null, p95: null, n: 0 };
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  return { p50: q(0.5), p95: q(0.95), n: v.length };
}

/**
 * Fields the proxy logger adds to each side. Older logs lack them, so every reader here treats them as optional
 * and falls back to the legacy fields (`ttft_ms` + `ttft_method`, `finish_reason` + `completion_text`).
 */
export type SideExt = SideResult & {
  ttft_first_byte_ms?: number;
  ttft_first_content_ms?: number;
  empty_output?: boolean;
  response_id?: string;
  /** The provider's own id for this request (from its request-id header), used to join billing rows to pairs. */
  target_request_id?: string;
};

/** Label for the TTFT measurement a pair was compared on. */
export type TtftMethod = "first-content" | "first-byte";

export interface PerSide<T> {
  primary: T;
  target: T;
}

/** Where a cost figure came from. "reported": the provider put it on the response. "billed": the provider's own bill for the request (TokenRouter's, for a free-credit key, read by the relay), joined by request id. */
export type CostOrigin = "reported" | "billed";

export interface CostSplit {
  /** Pairs that entered these totals: both sides returned ok and both sides have a provider-reported cost. */
  pairs: number;
  primary_cost_usd: number;
  target_cost_usd: number;
  delta_pct: number | null;
}

export interface TargetModelStats {
  target: string;
  model: string; // canonical
  target_model: string | null;
  /** Mirrored pairs where both sides returned status ok. */
  pairs: number;
  requests_mirrored: number;
  errors: number;
  error_rate: number | null;
  error_types: Record<string, number>;
  /** Status ok but no content and no tool calls (usually the token cap was spent on reasoning). Counted over pairs. */
  no_output: PerSide<number>;
  /** Paired sides with status ok and no provider-reported cost. Excluded from every cost figure, kept for latency, errors, tokens and agreement. */
  cost_not_reported: PerSide<number>;
  /** Pairs that entered the cost totals: both sides ok and both sides reported a cost. */
  cost_pairs: number;
  /** Sum of what each provider reported for its own response over `cost_pairs`. */
  primary_cost_usd: number;
  target_cost_usd: number;
  delta_pct: number | null;
  /** Where the target's per-pair costs came from; "mixed" when some pairs were filled from bills and others from the response. */
  target_cost_origin: CostOrigin | "mixed" | null;
  /** Reported cost restricted to pairs where both sides finished normally (stop / tool_calls) and neither was empty. */
  cost_complete_pairs: CostSplit;
  /** Token totals per side over pairs, as each provider reported them. */
  tokens: PerSide<TokenTotals>;
  /** cached_tokens / prompt_tokens per side; null when no prompt tokens were reported. */
  cache_share: PerSide<number | null>;
  latency: Quantiles;
  /** Target TTFT over pairs that are comparable (see `ttft_method`) and where neither side was empty. */
  ttft: Quantiles;
  primary_latency: Quantiles;
  /** Primary TTFT over the same comparable, non-empty pairs as `ttft`. */
  primary_ttft: Quantiles;
  /** Which measurement both TTFT quantiles use. null when no pair had the same measurement on both sides. */
  ttft_method: TtftMethod | null;
  /** Pairs with a TTFT on at least one side that could not be compared on the same measurement. */
  ttft_not_comparable: number;
  /** Per-side TTFT quantiles by measurement, independent of comparability. Shown separately, never compared across methods. */
  ttft_first_byte: PerSide<Quantiles>;
  ttft_first_content: PerSide<Quantiles>;
  /** Upstream hosts each side named in its responses, counted over paired requests. Explains most same-model differences. */
  primary_upstreams: Record<string, number>;
  target_upstreams: Record<string, number>;
  /** `exact`, `json`, `numeric` and `llm` are how the judged pairs were scored; they sum to `judged`. */
  agreement: { judged: number; agreed: number; rate: number | null; exact: number; json: number; numeric: number; llm: number } | null;
  /** Tool-call agreement counts (never the calls themselves): named tool_call_stats so the publish filter, which forbids any key called tool_calls, lets aggregates through. */
  tool_call_stats: { pairs: number; valid_json: number; name_match: number } | null;
  /** Pairs where a side hit its token cap (finish_reason "length"); excluded from agreement. */
  truncated: { pairs: number; primary_only: number; target_only: number; both: number };
  /** Judged pairs skipped because a side returned its reasoning channel instead of an answer. `pairs` is the total; the per-side counts say which side leaked (both can). */
  reasoning_leak: ReasoningLeak;
  /** The model judge's one-sentence reasons for up to three DISAGREE verdicts, so the rate can be explained. */
  disagreement_reasons: string[];
}

export interface ReasoningLeak {
  pairs: number;
  primary: number;
  target: number;
}

export type ProjectionConfidence = "low" | "ok";

/** A model the target refused: every listed attempt failed with a rejection (model_not_found, bad_request, unsupported_parameter, auth). */
export interface Rejected {
  model: string;
  target_model: string | null;
  /** Rejected attempts. */
  attempts: number;
  error_type: string;
}

export interface TargetSummary {
  target: string;
  name?: string;
  via: "direct" | "relay" | "mixed" | "none";
  requests_mirrored: number;
  pairs: number;
  errors: number;
  error_rate: number | null;
  /** Models the target refused outright (see `Rejected`). */
  rejected: Rejected[];
  /** Share of mirrored requests the target accepted (did not reject with model_not_found, bad_request, unsupported_parameter or auth). */
  coverage_pct: number | null;
  no_output: PerSide<number>;
  cost_not_reported: PerSide<number>;
  truncated: { pairs: number; primary_only: number; target_only: number; both: number };
  reasoning_leak: ReasoningLeak;
  /** Projection: primary's full spend on each mirrored model, scaled by that model's paired cost ratio, then to 30 days. */
  projected_monthly_usd: number | null;
  comparable_monthly_usd: number | null;
  delta_usd: number | null;
  delta_pct: number | null;
  projection_confidence: ProjectionConfidence;
  /** Reported-or-billed cost over pairs with a cost on both sides, across all models (no projection). */
  reported: CostSplit;
  target_cost_origin: CostOrigin | "mixed" | null;
  avg_cost_per_request_usd: PerSide<number | null>;
  cost_complete_pairs: CostSplit;
  /** Token totals per side over pairs, as each provider reported them. Always present so an agent can take the counts to a provider's current pricing page. */
  tokens: PerSide<TokenTotals>;
  cache_share: PerSide<number | null>;
  /** Set when one side's cache share exceeds the other's by more than 20 points: the reported delta includes that discount. */
  cache_warning: string | null;
  /** The number shown first: the delta of reported-or-billed costs over pairs with a cost on both sides. null delta when the target has no cost; `note` then explains why and what to do. */
  headline: { delta_pct: number | null; basis: "as_served"; note: string };
  /** Fraction of completed pairs the judge scored (1 = every pair). */
  judge_fraction: number;
  /** Up to three of the model judge's reasons for DISAGREE verdicts across this target's models. */
  disagreement_reasons: string[];
  latency: Quantiles;
  /** Target TTFT over comparable, non-empty pairs (see `ttft_method`). */
  ttft: Quantiles;
  primary_ttft: Quantiles;
  ttft_method: TtftMethod | "mixed" | null;
  ttft_not_comparable: number;
  ttft_first_byte: PerSide<Quantiles>;
  ttft_first_content: PerSide<Quantiles>;
  agreement_rate: number | null;
  agreement_judged: number;
}

export interface ReportAggregates {
  v: 1;
  generated_at: string;
  tool: { name: "routearena"; version: string };
  period: { from: string; to: string; days: number; span_hours: number } | null;
  /** How monthly figures were scaled: by elapsed time when the log spans under 24 hours (floored at 1 hour), else by calendar days. */
  projection: { basis: "elapsed_time" | "calendar_days"; factor: number; confidence: ProjectionConfidence; reason: string | null };
  primary: {
    provider: string;
    requests: number;
    requests_ok: number;
    errors: number;
    no_output: number;
    /** Ok responses with no provider-reported cost. */
    cost_not_reported: number;
    /** Sum of the costs the primary reported. */
    cost_usd: number;
    cost_source: "reported" | "not_reported" | "mixed";
    avg_cost_per_request_usd: number | null;
    monthly_usd: number;
    latency: Quantiles;
    /** TTFT over ok, non-empty primary responses that reported one. Labelled by `ttft_method`; not compared with targets here. */
    ttft: Quantiles;
    ttft_method: TtftMethod | "mixed" | null;
    ttft_first_byte: Quantiles;
    ttft_first_content: Quantiles;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
  };
  sampling: { rate: number | null; mirrored: number; skipped: Record<string, number> };
  models: Array<{ model: string; requests: number; no_output: number; prompt_tokens: number; completion_tokens: number; cached_tokens: number; reasoning_tokens: number; cost_usd: number; latency: Quantiles; ttft: Quantiles }>;
  targets: TargetSummary[];
  target_models: TargetModelStats[];
  method: {
    costs: string;
    complete_pairs: string;
    empty_outputs: string;
    sampling: string;
    ttft: string;
    projection: string;
    agreement: string;
    judge_model: string | null;
    sample_size_note: string | null;
  };
}

function ok(s: SideResult | undefined): s is SideResult {
  return !!s && s.status === "ok";
}

function countBy(vals: Array<string | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of vals) if (v) out[v] = (out[v] ?? 0) + 1;
  return out;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const pct = (target: number | null, base: number): number | null => (target === null || base <= 0 ? null : ((target - base) / base) * 100);

/**
 * Status ok with nothing in it: no content and no tool calls. Uses the logger's `empty_output` flag when present;
 * older logs fall back to finish_reason "length" with no text (the cap was spent before any content), or zero completion tokens.
 */
export function isEmptyOutput(s: SideResult | undefined): boolean {
  if (!s || s.status !== "ok") return false;
  const x = s as SideExt;
  if (typeof x.empty_output === "boolean") return x.empty_output;
  const hasText = typeof s.completion_text === "string" && s.completion_text.trim().length > 0;
  const hasTools = !!(s.tool_calls && s.tool_calls.length);
  if (hasText || hasTools) return false;
  return s.finish_reason === "length" || s.usage?.completion_tokens === 0;
}

/**
 * The provider itself reported a cost for this response. `cost_source` "reported" (or the legacy "measured", which
 * meant the same thing) with a finite `cost_usd`. Legacy "computed" costs came from a price table and are not
 * provider figures, so they count as not reported.
 */
export function isReported(s: SideResult): boolean {
  if (!isNum(s.cost_usd)) return false;
  const src = s.cost_source as string | undefined;
  return src === undefined || src === "reported" || src === "billed" || src === "measured";
}

/** Finished on its own (stop or tool_calls) and produced something. */
export function isComplete(s: SideResult): boolean {
  return (s.finish_reason === "stop" || s.finish_reason === "tool_calls") && !isEmptyOutput(s);
}

const legacyMethod = (m: SideResult["ttft_method"] | undefined): TtftMethod | null => (m === "first-stream-chunk" ? "first-byte" : m === "first-content-chunk" ? "first-content" : null);

/** First-byte TTFT for one side, from the new field or a legacy first-stream-chunk measurement. */
export function ttftFirstByte(s: SideResult): number | null {
  const x = s as SideExt;
  if (isNum(x.ttft_first_byte_ms)) return x.ttft_first_byte_ms;
  if (isNum(s.ttft_ms) && s.ttft_method === "first-stream-chunk") return s.ttft_ms;
  return null;
}

/** First-content TTFT for one side, from the new field or a legacy first-content-chunk measurement. */
export function ttftFirstContent(s: SideResult): number | null {
  const x = s as SideExt;
  if (isNum(x.ttft_first_content_ms)) return x.ttft_first_content_ms;
  if (isNum(s.ttft_ms) && s.ttft_method === "first-content-chunk") return s.ttft_ms;
  return null;
}

/**
 * TTFT for a pair measured the same way on both sides, or null when the two sides cannot be compared.
 * Preference: first-content on both (new fields), then the legacy `ttft_ms` when both sides recorded the same
 * `ttft_method`, then first-byte on both. A first-byte value is never compared with a first-content value.
 */
export function pairTtft(p: SideResult, t: SideResult): { primary: number; target: number; method: TtftMethod } | null {
  const pe = p as SideExt, te = t as SideExt;
  if (isNum(pe.ttft_first_content_ms) && isNum(te.ttft_first_content_ms)) return { primary: pe.ttft_first_content_ms, target: te.ttft_first_content_ms, method: "first-content" };
  if (isNum(p.ttft_ms) && isNum(t.ttft_ms) && p.ttft_method && p.ttft_method === t.ttft_method) {
    const m = legacyMethod(p.ttft_method);
    if (m) return { primary: p.ttft_ms, target: t.ttft_ms, method: m };
  }
  const pb = ttftFirstByte(p), tb = ttftFirstByte(t);
  if (pb !== null && tb !== null) return { primary: pb, target: tb, method: "first-byte" };
  return null;
}

const hasAnyTtft = (s: SideResult): boolean => isNum(s.ttft_ms) || isNum((s as SideExt).ttft_first_byte_ms) || isNum((s as SideExt).ttft_first_content_ms);

/** Comparable TTFT over a set of pairs: one method for the whole set (first-content when any pair has it), empty outputs excluded. */
function comparableTtft(pairs: Array<{ primary: SideResult; target: SideResult }>): { primary: Quantiles; target: Quantiles; method: TtftMethod | null; not_comparable: number } {
  const live = pairs.filter((x) => !isEmptyOutput(x.primary) && !isEmptyOutput(x.target));
  const cands = live.map((x) => pairTtft(x.primary, x.target));
  const withAny = live.filter((x) => hasAnyTtft(x.primary) || hasAnyTtft(x.target)).length;
  const method: TtftMethod | null = cands.some((c) => c?.method === "first-content") ? "first-content" : cands.some((c) => c?.method === "first-byte") ? "first-byte" : null;
  const used = cands.filter((c): c is NonNullable<typeof c> => !!c && c.method === method);
  return { primary: quantiles(used.map((c) => c.primary)), target: quantiles(used.map((c) => c.target)), method, not_comparable: withAny - used.length };
}

function sideTtftByMethod(sides: SideResult[]): { first_byte: Quantiles; first_content: Quantiles } {
  const live = sides.filter((s) => ok(s) && !isEmptyOutput(s));
  return {
    first_byte: quantiles(live.map(ttftFirstByte).filter((v): v is number => v !== null)),
    first_content: quantiles(live.map(ttftFirstContent).filter((v): v is number => v !== null)),
  };
}

/** The method label for a side's own TTFT values (legacy `ttft_method`, or whichever new field is present). */
function dominantMethod(sides: SideResult[]): TtftMethod | "mixed" | null {
  const labels = new Set<TtftMethod>();
  for (const s of sides) {
    if (!ok(s) || isEmptyOutput(s)) continue;
    const x = s as SideExt;
    if (isNum(x.ttft_first_content_ms)) labels.add("first-content");
    else if (isNum(x.ttft_first_byte_ms)) labels.add("first-byte");
    else if (isNum(s.ttft_ms)) {
      const m = legacyMethod(s.ttft_method);
      if (m) labels.add(m);
    }
  }
  return labels.size === 0 ? null : labels.size === 1 ? [...labels][0] : "mixed";
}

/** Legacy single TTFT number for a side (whatever it measured), used only for the primary's own, uncompared quantiles. */
function sideTtft(s: SideResult): number | null {
  const x = s as SideExt;
  if (isNum(x.ttft_first_content_ms)) return x.ttft_first_content_ms;
  if (isNum(x.ttft_first_byte_ms)) return x.ttft_first_byte_ms;
  return isNum(s.ttft_ms) ? s.ttft_ms : null;
}

function sumTokens(sides: SideResult[]): TokenTotals {
  return sides.reduce((acc, s) => addTokenTotals(acc, tokenTotals(s.usage)), zeroTokens());
}

const share = (t: TokenTotals): number | null => (t.prompt_tokens > 0 ? t.cached_tokens / t.prompt_tokens : null);

function cacheWarning(primaryName: string, targetName: string, s: PerSide<number | null>): string | null {
  if (s.primary === null || s.target === null) return null;
  const diff = (s.target - s.primary) * 100;
  if (Math.abs(diff) <= 20) return null;
  const [hi, lo, hiShare, loShare] = diff > 0 ? [targetName, primaryName, s.target, s.primary] : [primaryName, targetName, s.primary, s.target];
  return `${hi} served ${Math.round(hiShare * 100)}% of prompt tokens from cache vs ${Math.round(loShare * 100)}% on ${lo}; the reported costs include that discount.`;
}

/** Error types that mean the target refused the request as sent, as opposed to a transient failure. */
export const REJECTION_TYPES = new Set(["model_not_found", "bad_request", "unsupported_parameter", "auth"]);

export interface AggregateInput {
  records: LogRecord[];
  judgements: JudgeResult[];
  version: string;
  sampleRate: number | null;
  judgeModel: string | null;
  /** Fraction of completed pairs that were eligible for judging (default 0.25). */
  judgeFraction?: number;
  /** Display names and, optionally, a one-line note on why a target carries no cost and what to do about it. */
  targetMeta: Record<string, { name: string; reportsCost?: boolean; costHint?: string }>;
  /** Per-request bills by target id, keyed by the provider's request id (USD); joined to pairs by `target_request_id`. */
  billed?: Record<string, Record<string, number>>;
  /** Clock for `generated_at`; tests pin it. */
  now?: () => Date;
}

/** Shown when a target has no cost and no target-specific note was given. */
export const NO_COST_NOTE = (target: string) => `${target} did not report a cost per response and no bill was available; RouteArena shows token counts and leaves dollars to you (take the counts to ${target}'s current pricing page).`;

/** The cost a provider gave for a target side: its bill when one is joined by request id, else the cost on its response. */
function targetCost(side: SideResult, bills: Record<string, number> | undefined): { usd: number; origin: CostOrigin } | null {
  const rid = (side as SideExt).target_request_id;
  if (bills && rid && isNum(bills[rid])) return { usd: bills[rid], origin: "billed" };
  if (isReported(side)) return { usd: side.cost_usd!, origin: "reported" };
  return null;
}

function originOf(origins: CostOrigin[]): CostOrigin | "mixed" | null {
  const set = new Set(origins);
  return set.size === 0 ? null : set.size === 1 ? [...set][0] : "mixed";
}

export function aggregate(input: AggregateInput): ReportAggregates {
  const { records } = input;
  const judgeByKey = new Map<string, JudgeResult>();
  for (const j of input.judgements) judgeByKey.set(`${j.record_id}|${j.target}`, j);
  const primaryProvider = records[0]?.primary.provider ?? "unknown";
  const primaryName = primaryProvider === "openrouter" ? "OpenRouter" : primaryProvider === "openai" ? "OpenAI" : primaryProvider;

  // Period and projection factor
  const ts = records.map((r) => r.ts).sort();
  const tsMs = records.map((r) => Date.parse(r.ts)).filter(isNum);
  const spanHours = tsMs.length ? (Math.max(...tsMs) - Math.min(...tsMs)) / 3_600_000 : 0;
  const period = ts.length
    ? (() => {
        const from = ts[0].slice(0, 10);
        const to = ts[ts.length - 1].slice(0, 10);
        const days = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1);
        return { from, to, days, span_hours: Math.round(spanHours * 100) / 100 };
      })()
    : null;
  const shortSpan = spanHours < 24;
  const monthlyFactor = !period ? 1 : shortSpan ? (30 * 24) / Math.max(spanHours, 1) : 30 / Math.max(period.days, 1);
  const spanText = shortSpan ? `${spanHours < 1 ? "under 1 hour" : `${spanHours.toFixed(1)} hours`} of traffic` : `${period!.days} day${period!.days === 1 ? "" : "s"} of traffic`;

  // Primary totals
  const okRecs = records.filter((r) => ok(r.primary));
  const reportedRecs = okRecs.filter((r) => isReported(r.primary));
  const primaryCost = reportedRecs.reduce((s, r) => s + r.primary.cost_usd!, 0);
  const costSource: ReportAggregates["primary"]["cost_source"] = okRecs.length === 0 ? "not_reported" : reportedRecs.length === okRecs.length ? "reported" : reportedRecs.length === 0 ? "not_reported" : "mixed";
  const primaryTokens = sumTokens(okRecs.map((r) => r.primary));
  const primaryTtftSides = sideTtftByMethod(okRecs.map((r) => r.primary));

  // Per model (primary)
  const modelMap = new Map<string, LogRecord[]>();
  for (const r of records) {
    const arr = modelMap.get(r.canonical_model) ?? [];
    arr.push(r);
    modelMap.set(r.canonical_model, arr);
  }
  const models = [...modelMap.entries()]
    .map(([model, recs]) => {
      const good = recs.filter((r) => ok(r.primary));
      const tok = sumTokens(good.map((r) => r.primary));
      return {
        model,
        requests: recs.length,
        no_output: good.filter((r) => isEmptyOutput(r.primary)).length,
        prompt_tokens: tok.prompt_tokens,
        completion_tokens: tok.completion_tokens,
        cached_tokens: tok.cached_tokens,
        reasoning_tokens: tok.reasoning_tokens,
        cost_usd: good.filter((r) => isReported(r.primary)).reduce((s, r) => s + r.primary.cost_usd!, 0),
        latency: quantiles(good.map((r) => r.primary.latency_ms!).filter((x) => x !== undefined)),
        ttft: quantiles(good.filter((r) => !isEmptyOutput(r.primary)).map((r) => sideTtft(r.primary)).filter((v): v is number => v !== null)),
      };
    })
    .sort((a, b) => b.cost_usd - a.cost_usd || b.requests - a.requests);

  // Skip reasons
  const skipped: Record<string, number> = {};
  for (const r of records) if (!r.mirrored) skipped[r.skip_reason ?? "unknown"] = (skipped[r.skip_reason ?? "unknown"] ?? 0) + 1;

  // Target x model
  const tmMap = new Map<string, { target: string; model: string; recs: Array<{ rec: LogRecord; side: SideResult }> }>();
  const targetsSeen = new Set<string>();
  for (const r of records) {
    for (const s of r.targets) {
      targetsSeen.add(s.provider);
      const key = `${s.provider}|${r.canonical_model}`;
      const e = tmMap.get(key) ?? { target: s.provider, model: r.canonical_model, recs: [] };
      e.recs.push({ rec: r, side: s });
      tmMap.set(key, e);
    }
  }
  const target_models: TargetModelStats[] = [];
  for (const e of tmMap.values()) {
    const m = input.billed?.[e.target];
    const paired = e.recs.filter((x) => ok(x.side) && ok(x.rec.primary));
    const errors = e.recs.filter((x) => x.side.status === "error");
    const attempted = e.recs.length;
    const error_types: Record<string, number> = {};
    for (const x of errors) error_types[x.side.error_type ?? "unknown"] = (error_types[x.side.error_type ?? "unknown"] ?? 0) + 1;

    // Cost: only pairs where both providers reported a cost. An ok side with no reported cost is counted, never $0.
    const withCost = paired.map((x) => ({ ...x, p: isReported(x.rec.primary) ? x.rec.primary.cost_usd! : null, t: targetCost(x.side, m) }));
    const tNotReported = withCost.filter((x) => x.t === null).length;
    const pNotReported = withCost.filter((x) => x.p === null).length;
    const costed = withCost.filter((x): x is typeof x & { p: number; t: { usd: number; origin: CostOrigin } } => x.p !== null && x.t !== null);
    const pCost = costed.reduce((s, x) => s + x.p, 0);
    const tCost = costed.reduce((s, x) => s + x.t.usd, 0);
    const complete = costed.filter((x) => isComplete(x.rec.primary) && isComplete(x.side));
    const cpP = complete.reduce((s, x) => s + x.p, 0);
    const cpT = complete.reduce((s, x) => s + x.t.usd, 0);
    const tokens: PerSide<TokenTotals> = { primary: sumTokens(paired.map((x) => x.rec.primary)), target: sumTokens(paired.map((x) => x.side)) };

    // agreement
    let judged = 0,
      agreed = 0,
      exact = 0,
      json = 0,
      numeric = 0,
      llm = 0;
    const leak: ReasoningLeak = { pairs: 0, primary: 0, target: 0 };
    const disagreementReasons: string[] = [];
    for (const x of paired) {
      const j = judgeByKey.get(`${x.rec.id}|${e.target}`);
      if (!j) continue;
      if (j.verdict === "disagree" && j.reason && disagreementReasons.length < 3) disagreementReasons.push(j.reason);
      if (j.verdict === "skipped") {
        if (j.note?.startsWith("reasoning_leak")) {
          leak.pairs++;
          // The note may name the side ("reasoning_leak:primary|target|both"); otherwise look at the stored text.
          const sideHint = j.note.split(":")[1];
          const pLeak = sideHint ? sideHint === "primary" || sideHint === "both" : isReasoningLeak(x.rec.primary.completion_text);
          const tLeak = sideHint ? sideHint === "target" || sideHint === "both" : isReasoningLeak(x.side.completion_text);
          if (pLeak) leak.primary++;
          if (tLeak) leak.target++;
        }
        continue;
      }
      judged++;
      if (j.verdict === "agree") agreed++;
      if (j.method === "exact") exact++;
      else if (j.method === "json") json++;
      else if (j.method === "numeric") numeric++;
      else if (j.method === "llm") llm++;
    }
    const trunc = { pairs: 0, primary_only: 0, target_only: 0, both: 0 };
    for (const x of paired) {
      const p = x.rec.primary.finish_reason === "length";
      const t = x.side.finish_reason === "length";
      if (p || t) {
        trunc.pairs++;
        if (p && t) trunc.both++;
        else if (p) trunc.primary_only++;
        else trunc.target_only++;
      }
    }
    const toolPairs = paired.filter((x) => x.rec.request.has_tools && (x.rec.primary.tool_calls?.length || x.side.tool_calls?.length));
    let valid_json = 0,
      name_match = 0;
    for (const x of toolPairs) {
      const t = x.side.tool_calls ?? [];
      const allValid = t.length > 0 && t.every((c) => isJson(c.arguments));
      if (allValid) valid_json++;
      const pNames = (x.rec.primary.tool_calls ?? []).map((c) => c.name).sort().join(",");
      const tNames = t.map((c) => c.name).sort().join(",");
      if (pNames && pNames === tNames) name_match++;
    }
    const ttft = comparableTtft(paired.map((x) => ({ primary: x.rec.primary, target: x.side })));
    const pSides = sideTtftByMethod(paired.map((x) => x.rec.primary));
    const tSides = sideTtftByMethod(paired.map((x) => x.side));
    target_models.push({
      target: e.target,
      model: e.model,
      target_model: e.recs.find((x) => x.side.model)?.side.model ?? null,
      pairs: paired.length,
      requests_mirrored: e.recs.length,
      errors: errors.length,
      error_rate: attempted > 0 ? errors.length / attempted : null,
      error_types,
      no_output: { primary: paired.filter((x) => isEmptyOutput(x.rec.primary)).length, target: paired.filter((x) => isEmptyOutput(x.side)).length },
      cost_not_reported: { primary: pNotReported, target: tNotReported },
      cost_pairs: costed.length,
      primary_cost_usd: pCost,
      target_cost_usd: tCost,
      delta_pct: pct(tCost, pCost),
      target_cost_origin: originOf(costed.map((x) => x.t.origin)),
      cost_complete_pairs: { pairs: complete.length, primary_cost_usd: cpP, target_cost_usd: cpT, delta_pct: pct(cpT, cpP) },
      tokens,
      cache_share: { primary: share(tokens.primary), target: share(tokens.target) },
      latency: quantiles(paired.map((x) => x.side.latency_ms!)),
      ttft: ttft.target,
      primary_latency: quantiles(paired.map((x) => x.rec.primary.latency_ms!)),
      primary_ttft: ttft.primary,
      ttft_method: ttft.method,
      ttft_not_comparable: ttft.not_comparable,
      ttft_first_byte: { primary: pSides.first_byte, target: tSides.first_byte },
      ttft_first_content: { primary: pSides.first_content, target: tSides.first_content },
      agreement: judged > 0 ? { judged, agreed, rate: agreed / judged, exact, json, numeric, llm } : null,
      tool_call_stats: toolPairs.length ? { pairs: toolPairs.length, valid_json, name_match } : null,
      truncated: trunc,
      reasoning_leak: leak,
      disagreement_reasons: disagreementReasons,
      primary_upstreams: countBy(paired.map((x) => x.rec.primary.upstream)),
      target_upstreams: countBy(paired.map((x) => x.side.upstream)),
    });
  }
  target_models.sort((a, b) => a.target.localeCompare(b.target) || b.pairs - a.pairs);

  // Target summaries
  const targets: TargetSummary[] = [];
  for (const t of [...targetsSeen].sort()) {
    const tms = target_models.filter((x) => x.target === t);
    const meta = input.targetMeta[t];
    const name = meta?.name;
    const label = name ?? t;
    const allSides = records.flatMap((r) => r.targets.filter((s) => s.provider === t).map((s) => ({ r, s })));
    const vias = new Set(allSides.map((x) => x.s.via).filter(Boolean));
    const mirrored = allSides.length;
    const pairs = tms.reduce((s, x) => s + x.pairs, 0);
    const errors = tms.reduce((s, x) => s + x.errors, 0);
    // Rejections: the target refused the request as sent. Listed per model; coverage is the share of mirrored requests not rejected.
    const rejectedSides = allSides.filter((x) => x.s.status === "error" && REJECTION_TYPES.has(x.s.error_type ?? ""));
    const rejected: Rejected[] = tms
      .map((x) => {
        const rej = Object.entries(x.error_types).filter(([k]) => REJECTION_TYPES.has(k));
        const attempts = rej.reduce((s, [, v]) => s + v, 0);
        if (!attempts) return null;
        return { model: x.model, target_model: x.target_model, attempts, error_type: rej.sort((a, b) => b[1] - a[1])[0][0] };
      })
      .filter((x): x is Rejected => x !== null)
      .sort((a, b) => b.attempts - a.attempts);
    // Projection: for each model with costed pairs, scale the primary's full spend on that model by the paired cost ratio.
    let projected = 0;
    let comparable = 0;
    for (const tm of tms) {
      if (tm.cost_pairs === 0 || tm.primary_cost_usd <= 0) continue;
      const ratio = tm.target_cost_usd / tm.primary_cost_usd;
      const modelTotal = models.find((mm) => mm.model === tm.model)?.cost_usd ?? 0;
      projected += modelTotal * ratio;
      comparable += modelTotal;
    }
    const sum = (f: (x: TargetModelStats) => number) => tms.reduce((s, x) => s + f(x), 0);
    const costPairs = sum((x) => x.cost_pairs);
    const pCost = sum((x) => x.primary_cost_usd);
    const tCost = sum((x) => x.target_cost_usd);
    const cpPairs = sum((x) => x.cost_complete_pairs.pairs);
    const cpP = sum((x) => x.cost_complete_pairs.primary_cost_usd);
    const cpT = sum((x) => x.cost_complete_pairs.target_cost_usd);
    const tokens: PerSide<TokenTotals> = {
      primary: tms.reduce((acc, x) => addTokenTotals(acc, x.tokens.primary), zeroTokens()),
      target: tms.reduce((acc, x) => addTokenTotals(acc, x.tokens.target), zeroTokens()),
    };
    const cache_share = { primary: share(tokens.primary), target: share(tokens.target) };
    const pairedSides = records.flatMap((r) => (ok(r.primary) ? r.targets.filter((s) => s.provider === t && ok(s)).map((s) => ({ primary: r.primary, target: s })) : []));
    const ttft = comparableTtft(pairedSides);
    const methods = new Set(tms.map((x) => x.ttft_method).filter((mm): mm is TtftMethod => mm !== null));
    const tSides = sideTtftByMethod(allSides.map((x) => x.s));
    const pSides = sideTtftByMethod(pairedSides.map((x) => x.primary));
    const agreementJudged = tms.reduce((s, x) => s + (x.agreement?.judged ?? 0), 0);
    const agreementAgreed = tms.reduce((s, x) => s + (x.agreement?.agreed ?? 0), 0);

    const perPairDelta = pct(tCost, pCost);
    const targetOrigin = originOf(tms.flatMap((x) => (x.target_cost_origin === "mixed" ? (["reported", "billed"] as CostOrigin[]) : x.target_cost_origin ? [x.target_cost_origin] : [])));
    const headline: TargetSummary["headline"] = {
      delta_pct: perPairDelta,
      basis: "as_served",
      note:
        costPairs > 0
          ? `${targetOrigin === "billed" ? "billed" : targetOrigin === "mixed" ? "reported or billed" : "reported"} costs over ${costPairs} pair${costPairs === 1 ? "" : "s"} where both sides have a cost`
          : pairs === 0
            ? `no completed pairs on ${label}`
            : sum((x) => x.cost_not_reported.target) > 0
              ? meta?.costHint ?? NO_COST_NOTE(label)
              : `${primaryName} did not report a cost for these requests.`,
    };
    targets.push({
      target: t,
      name,
      via: vias.size === 0 ? "none" : vias.size === 1 ? ([...vias][0] as any) : "mixed",
      requests_mirrored: mirrored,
      pairs,
      errors,
      error_rate: mirrored > 0 ? errors / mirrored : null,
      rejected,
      coverage_pct: mirrored > 0 ? ((mirrored - rejectedSides.length) / mirrored) * 100 : null,
      no_output: { primary: sum((x) => x.no_output.primary), target: sum((x) => x.no_output.target) },
      cost_not_reported: { primary: sum((x) => x.cost_not_reported.primary), target: sum((x) => x.cost_not_reported.target) },
      truncated: { pairs: sum((x) => x.truncated.pairs), primary_only: sum((x) => x.truncated.primary_only), target_only: sum((x) => x.truncated.target_only), both: sum((x) => x.truncated.both) },
      reasoning_leak: { pairs: sum((x) => x.reasoning_leak.pairs), primary: sum((x) => x.reasoning_leak.primary), target: sum((x) => x.reasoning_leak.target) },
      projected_monthly_usd: comparable > 0 ? projected * monthlyFactor : null,
      comparable_monthly_usd: comparable > 0 ? comparable * monthlyFactor : null,
      delta_usd: comparable > 0 ? (projected - comparable) * monthlyFactor : null,
      delta_pct: comparable > 0 ? ((projected - comparable) / comparable) * 100 : null,
      projection_confidence: shortSpan || pairs < 50 ? "low" : "ok",
      reported: { pairs: costPairs, primary_cost_usd: pCost, target_cost_usd: tCost, delta_pct: perPairDelta },
      target_cost_origin: targetOrigin,
      avg_cost_per_request_usd: { primary: costPairs > 0 ? pCost / costPairs : null, target: costPairs > 0 ? tCost / costPairs : null },
      cost_complete_pairs: { pairs: cpPairs, primary_cost_usd: cpP, target_cost_usd: cpT, delta_pct: pct(cpT, cpP) },
      tokens,
      cache_share,
      cache_warning: cacheWarning(primaryName, label, cache_share),
      headline,
      judge_fraction: input.judgeFraction ?? 0.25,
      disagreement_reasons: [...new Set(tms.flatMap((x) => x.disagreement_reasons ?? []))].slice(0, 3),
      latency: quantiles(allSides.filter((x) => ok(x.s)).map((x) => x.s.latency_ms!)),
      ttft: ttft.target,
      primary_ttft: ttft.primary,
      ttft_method: methods.size === 0 ? null : methods.size === 1 ? [...methods][0] : "mixed",
      ttft_not_comparable: ttft.not_comparable,
      ttft_first_byte: { primary: pSides.first_byte, target: tSides.first_byte },
      ttft_first_content: { primary: pSides.first_content, target: tSides.first_content },
      agreement_rate: agreementJudged > 0 ? agreementAgreed / agreementJudged : null,
      agreement_judged: agreementJudged,
    });
  }

  // Effective sampling rate from the log itself: mirrored over (mirrored + eligible-but-not-sampled).
  const mirroredCount = records.filter((r) => r.mirrored).length;
  const notSampled = skipped["not_sampled"] ?? 0;
  const sampleRate = mirroredCount + notSampled > 0 ? mirroredCount / (mirroredCount + notSampled) : input.sampleRate;
  const monthly = primaryCost * monthlyFactor;
  const maxPairs = targets.reduce((mx, t) => Math.max(mx, t.pairs), 0);
  const fewPairs = (targets.length ? maxPairs : okRecs.length) < 50;
  const confidence: ProjectionConfidence = shortSpan || fewPairs ? "low" : "ok";
  const confidenceReason = confidence === "ok" ? null : [shortSpan ? `the log spans ${spanText.replace(" of traffic", "")}` : null, fewPairs ? `only ${targets.length ? maxPairs : okRecs.length} ${targets.length ? "pairs" : "requests"} (under 50)` : null].filter(Boolean).join(" and ");
  const primaryEmpty = okRecs.filter((r) => isEmptyOutput(r.primary)).length;
  const judgeFraction = input.judgeFraction ?? 0.25;
  return {
    v: 1,
    generated_at: (input.now?.() ?? new Date()).toISOString(),
    tool: { name: "routearena", version: input.version },
    period,
    projection: {
      basis: shortSpan ? "elapsed_time" : "calendar_days",
      factor: monthlyFactor,
      confidence,
      reason: confidenceReason,
    },
    primary: {
      provider: primaryProvider,
      requests: records.length,
      requests_ok: okRecs.length,
      errors: records.length - okRecs.length,
      no_output: primaryEmpty,
      cost_not_reported: okRecs.length - reportedRecs.length,
      cost_usd: primaryCost,
      cost_source: costSource,
      avg_cost_per_request_usd: reportedRecs.length ? primaryCost / reportedRecs.length : null,
      monthly_usd: monthly,
      latency: quantiles(okRecs.map((r) => r.primary.latency_ms!)),
      ttft: quantiles(okRecs.filter((r) => !isEmptyOutput(r.primary)).map((r) => sideTtft(r.primary)).filter((v): v is number => v !== null)),
      ttft_method: dominantMethod(okRecs.map((r) => r.primary)),
      ttft_first_byte: primaryTtftSides.first_byte,
      ttft_first_content: primaryTtftSides.first_content,
      prompt_tokens: primaryTokens.prompt_tokens,
      completion_tokens: primaryTokens.completion_tokens,
      cached_tokens: primaryTokens.cached_tokens,
      reasoning_tokens: primaryTokens.reasoning_tokens,
    },
    sampling: { rate: sampleRate, mirrored: mirroredCount, skipped },
    models,
    targets,
    target_models,
    method: {
      costs:
        "Costs are what each provider reported or billed: OpenRouter's usage.cost on the response; for TokenRouter, its own bill for the free-credit key, read by the relay and joined by request id. RouteArena computes no prices and ships none. Cost totals cover only pairs with a cost on both sides; a side without one is counted as cost_not_reported, not as $0, and stays in latency, error, token and agreement counts. Token counts per side are always listed.",
      complete_pairs:
        "Complete-pairs cost repeats the reported delta over only the pairs where both sides finished on their own (finish_reason stop or tool_calls) and neither returned an empty response, so a side that was cut off at its token cap or returned nothing cannot lower or raise its bill.",
      empty_outputs:
        "An empty output is a status-ok response with no content and no tool calls, usually because the whole token cap went to reasoning. Counted per side as no_output; excluded from TTFT on both sides, from agreement and from complete-pairs cost (older logs: finish_reason length with no text). A reasoning leak is a status-ok response whose content is the model's reasoning channel instead of an answer; counted per side as reasoning_leak, billed as reported, skipped by the judge.",
      sampling: sampleRate === null ? "Sampling rate unknown." : `${Math.round(sampleRate * 100)}% of eligible requests were mirrored (measured from the log). Requests with images, more than the input-token cap, or n>1 were not eligible.`,
      ttft:
        "TTFT is compared only when both sides were measured the same way: first content token on both when available, otherwise the legacy value when both sides recorded the same method, otherwise first byte on both. Pairs measured differently are reported as not comparable rather than compared. Per-side first-byte and first-content quantiles are listed separately. Streaming requests only; empty responses excluded.",
      projection:
        shortSpan
          ? `Monthly figures scale ${spanText} to 30 days (span floored at 1 hour). Per-request averages and reported totals are the reliable numbers here; the monthly figure is a rough extrapolation.`
          : `Monthly figures scale ${period?.days ?? 0} calendar days to 30 days.${confidence === "low" ? " Few pairs were measured, so the monthly figure is a rough extrapolation." : ""}`,
      agreement:
        `Agreement is scored on a ${Math.round(judgeFraction * 100)}% sample of completed pairs, excluding pairs that were truncated, empty, or a leaked reasoning channel. Short outputs must match exactly; JSON is scored by field-weighted similarity (arrays as multisets; null, "", [] and {} equal; partial credit for near-identical long strings): 0.85 or more agrees, under 0.5 disagrees, in between a cheap model judges and says why. ${judgeFraction >= 1 ? "Every completed pair was judged." : "Sampled."} A router asked twice does not always agree with itself; compare routers, not against 100%.`,
      judge_model: input.judgeModel,
      sample_size_note: confidence === "low" ? `Projection confidence is low: ${confidenceReason}. Read per-request averages and reported totals; the monthly figure is a rough extrapolation.` : null,
    },
  };
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
