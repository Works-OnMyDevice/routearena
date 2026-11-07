import type { LogRecord, SideResult } from "../proxy/logger.js";
import { OPENROUTER_TOPUP_FEE } from "../replay/estimate.js";
import type { PriceEntry } from "../targets/index.js";
import { loadTargets } from "../targets/index.js";
import { addTokenTotals, cacheDiscountUsd, computeCost, tokenTotals, zeroTokens, type TokenTotals } from "../targets/mapping.js";
import { isReasoningLeak, type JudgeResult } from "./judge.js";

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
 * Fields the proxy logger is adding to each side. Older logs lack them, so every reader here treats them as optional
 * and falls back to the legacy fields (`ttft_ms` + `ttft_method`, `finish_reason` + `completion_text`).
 */
export type SideExt = SideResult & {
  ttft_first_byte_ms?: number;
  ttft_first_content_ms?: number;
  empty_output?: boolean;
  response_id?: string;
};

/** Label for the TTFT measurement a pair was compared on. */
export type TtftMethod = "first-content" | "first-byte";

export interface PerSide<T> {
  primary: T;
  target: T;
}

export interface CostSplit {
  /** Pairs that entered these totals. */
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
  unmapped: number;
  /** Status ok but no content and no tool calls (usually the token cap was spent on reasoning). Counted over pairs. */
  no_output: PerSide<number>;
  /** Target sides with status ok but no cost (model not in the price table). Excluded from every cost figure, kept for latency and errors. */
  unpriced: number;
  /** Primary sides with status ok but no cost. Excluded from cost figures the same way. */
  unpriced_primary: number;
  /** Pairs that entered the as-served cost totals: both sides ok and both sides priced. */
  cost_pairs: number;
  /** As-served cost over `cost_pairs`: what each side actually charged (or would charge, from its price table) for its own response. */
  primary_cost_usd: number;
  target_cost_usd: number;
  delta_pct: number | null;
  /** Target cost with the target's cached tokens re-priced at its full input rate. null when the target's price table has no entry for this model. */
  target_cost_cache_neutral_usd: number | null;
  delta_pct_cache_neutral: number | null;
  /** Target price table applied to the PRIMARY's token counts (same prompt, completion and cached tokens). Isolates price from output volume. */
  target_cost_price_only_usd: number | null;
  delta_pct_price_only: number | null;
  /** As-served cost restricted to pairs where both sides finished normally (stop / tool_calls) and neither was empty. */
  cost_complete_pairs: CostSplit;
  /** Token totals per side over pairs. */
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
  tool_calls: { pairs: number; valid_json: number; name_match: number } | null;
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

export interface TargetSummary {
  target: string;
  name?: string;
  via: "direct" | "relay" | "mixed" | "none";
  requests_mirrored: number;
  pairs: number;
  errors: number;
  error_rate: number | null;
  unmapped_requests: number;
  coverage_pct: number | null;
  no_output: PerSide<number>;
  unpriced: number;
  unpriced_primary: number;
  truncated: { pairs: number; primary_only: number; target_only: number; both: number };
  reasoning_leak: ReasoningLeak;
  /** Projection: primary's full spend on each mapped model, scaled by that model's paired cost ratio, then to 30 days. */
  projected_monthly_usd: number | null;
  comparable_monthly_usd: number | null;
  delta_usd: number | null;
  delta_pct: number | null;
  projection_confidence: ProjectionConfidence;
  /** As-served cost over priced pairs across all models (no projection). */
  measured: CostSplit;
  avg_cost_per_request_usd: PerSide<number | null>;
  target_cost_cache_neutral_usd: number | null;
  delta_pct_cache_neutral: number | null;
  target_cost_price_only_usd: number | null;
  delta_pct_price_only: number | null;
  cost_complete_pairs: CostSplit;
  tokens: PerSide<TokenTotals>;
  cache_share: PerSide<number | null>;
  /** Set when one side's cache share exceeds the other's by more than 20 points. */
  cache_warning: string | null;
  /** The number shown first: cache-neutral when the cache warning fires (one side ran warm), otherwise as served. */
  headline: { delta_pct: number | null; basis: "as_served" | "cache_neutral"; note: string };
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
  gaps: Array<{ model: string; requests: number; suggestion?: string | null }>;
  /** Mapped models where every attempt failed with a non-transient error: listed by the target but not usable. */
  failing: Array<{ model: string; target_model: string | null; attempts: number; error_type: string }>;
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
    unpriced: number;
    cost_usd: number;
    cost_source: "measured" | "computed" | "mixed" | "unknown";
    avg_cost_per_request_usd: number | null;
    monthly_usd: number;
    topup_fee_usd: number | null;
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
    cost_deltas: string;
    complete_pairs: string;
    empty_outputs: string;
    sampling: string;
    ttft: string;
    projection: string;
    agreement: string;
    judge_model: string | null;
    sample_size_note: string | null;
    prices: Array<{ target: string; captured?: string; source?: string }>;
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

/** A side has a usable cost. Status ok with no cost is "unpriced" and stays out of cost totals. */
export function isPriced(s: SideResult): boolean {
  return isNum(s.cost_usd);
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

/** Which delta leads: cache-neutral when one side ran from a much warmer prompt cache, else as served. */
function headlineFor(warning: string | null, asServed: number | null, neutral: number | null): TargetSummary["headline"] {
  if (warning && neutral !== null) return { delta_pct: neutral, basis: "cache_neutral", note: "cache-neutral: one side was served from a much warmer prompt cache, so the target's cached tokens are priced at its full input rate" };
  return { delta_pct: asServed, basis: "as_served", note: "as served: what each side actually charged over pairs priced on both sides" };
}

function cacheWarning(primaryName: string, targetName: string, s: PerSide<number | null>): string | null {
  if (s.primary === null || s.target === null) return null;
  const diff = (s.target - s.primary) * 100;
  if (Math.abs(diff) <= 20) return null;
  const [hi, lo, hiShare, loShare] = diff > 0 ? [targetName, primaryName, s.target, s.primary] : [primaryName, targetName, s.primary, s.target];
  return `${hi} served ${Math.round(hiShare * 100)}% of prompt tokens from cache vs ${Math.round(loShare * 100)}% on ${lo}; the as-served delta includes that discount. Read the cache-neutral delta instead.`;
}

export interface AggregateInput {
  records: LogRecord[];
  judgements: JudgeResult[];
  version: string;
  sampleRate: number | null;
  byok: boolean;
  judgeModel: string | null;
  /** Fraction of completed pairs that were eligible for judging (default 0.25). */
  judgeFraction?: number;
  targetMeta: Record<string, { name: string; pricesCaptured?: string; pricesSource?: string }>;
  suggestions?: (target: string, model: string) => string | null;
  /** Price tables by target id (canonical model -> entry). Defaults to the shipped target files. */
  priceTables?: Record<string, Record<string, PriceEntry>>;
  /** Clock for `generated_at`; tests pin it. */
  now?: () => Date;
}

function priceTablesOrShipped(given?: Record<string, Record<string, PriceEntry>>): Record<string, Record<string, PriceEntry>> {
  if (given) return given;
  try {
    const out: Record<string, Record<string, PriceEntry>> = {};
    for (const t of loadTargets()) out[t.id] = t.models;
    return out;
  } catch {
    return {};
  }
}

export function aggregate(input: AggregateInput): ReportAggregates {
  const { records } = input;
  const judgeByKey = new Map<string, JudgeResult>();
  for (const j of input.judgements) judgeByKey.set(`${j.record_id}|${j.target}`, j);
  const prices = priceTablesOrShipped(input.priceTables);
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
  const pricedRecs = okRecs.filter((r) => isPriced(r.primary));
  const primaryCost = pricedRecs.reduce((s, r) => s + r.primary.cost_usd!, 0);
  const costSources = new Set(okRecs.map((r) => r.primary.cost_source ?? "unknown").filter((s) => s !== "unknown"));
  const costSource: ReportAggregates["primary"]["cost_source"] = costSources.size === 0 ? "unknown" : costSources.size === 1 ? ([...costSources][0] as any) : "mixed";
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
        cost_usd: good.reduce((s, r) => s + (r.primary.cost_usd ?? 0), 0),
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
    const paired = e.recs.filter((x) => ok(x.side) && ok(x.rec.primary));
    const errors = e.recs.filter((x) => x.side.status === "error");
    const unmapped = e.recs.filter((x) => x.side.status === "unmapped").length;
    const attempted = e.recs.length - unmapped;
    const error_types: Record<string, number> = {};
    for (const x of errors) error_types[x.side.error_type ?? "unknown"] = (error_types[x.side.error_type ?? "unknown"] ?? 0) + 1;
    const entry: PriceEntry | undefined = prices[e.target]?.[e.model.toLowerCase()];

    // Cost: only pairs priced on both sides. An ok target with no price is "unpriced", never $0.
    const unpriced = paired.filter((x) => !isPriced(x.side)).length;
    const unpricedPrimary = paired.filter((x) => !isPriced(x.rec.primary)).length;
    const priced = paired.filter((x) => isPriced(x.side) && isPriced(x.rec.primary));
    const pCost = priced.reduce((s, x) => s + x.rec.primary.cost_usd!, 0);
    const tCost = priced.reduce((s, x) => s + x.side.cost_usd!, 0);
    const tNeutral = entry ? tCost + priced.reduce((s, x) => s + cacheDiscountUsd(entry, x.side.usage), 0) : null;
    const tPriceOnly = entry ? priced.reduce((s, x) => s + (computeCost(entry, x.rec.primary.usage) ?? 0), 0) : null;
    const complete = priced.filter((x) => isComplete(x.rec.primary) && isComplete(x.side));
    const cpP = complete.reduce((s, x) => s + x.rec.primary.cost_usd!, 0);
    const cpT = complete.reduce((s, x) => s + x.side.cost_usd!, 0);
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
      target_model: e.recs.find((x) => x.side.status !== "unmapped")?.side.model ?? null,
      pairs: paired.length,
      requests_mirrored: e.recs.length,
      errors: errors.length,
      error_rate: attempted > 0 ? errors.length / attempted : null,
      error_types,
      unmapped,
      no_output: { primary: paired.filter((x) => isEmptyOutput(x.rec.primary)).length, target: paired.filter((x) => isEmptyOutput(x.side)).length },
      unpriced,
      unpriced_primary: unpricedPrimary,
      cost_pairs: priced.length,
      primary_cost_usd: pCost,
      target_cost_usd: tCost,
      delta_pct: pct(tCost, pCost),
      target_cost_cache_neutral_usd: tNeutral,
      delta_pct_cache_neutral: pct(tNeutral, pCost),
      target_cost_price_only_usd: tPriceOnly,
      delta_pct_price_only: pct(tPriceOnly, pCost),
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
      tool_calls: toolPairs.length ? { pairs: toolPairs.length, valid_json, name_match } : null,
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
    const allSides = records.flatMap((r) => r.targets.filter((s) => s.provider === t).map((s) => ({ r, s })));
    const vias = new Set(allSides.map((x) => x.s.via).filter(Boolean));
    const mirrored = allSides.length;
    const unmappedReq = allSides.filter((x) => x.s.status === "unmapped").length;
    const pairs = tms.reduce((s, x) => s + x.pairs, 0);
    const errors = tms.reduce((s, x) => s + x.errors, 0);
    const attempted = mirrored - unmappedReq;
    // Projection: for each model with priced pairs, scale the primary's full spend on that model by the paired cost ratio.
    let projected = 0;
    let comparable = 0;
    for (const tm of tms) {
      if (tm.cost_pairs === 0 || tm.primary_cost_usd <= 0) continue;
      const ratio = tm.target_cost_usd / tm.primary_cost_usd;
      const modelTotal = models.find((m) => m.model === tm.model)?.cost_usd ?? 0;
      projected += modelTotal * ratio;
      comparable += modelTotal;
    }
    const sum = (f: (x: TargetModelStats) => number) => tms.reduce((s, x) => s + f(x), 0);
    const costPairs = sum((x) => x.cost_pairs);
    const pCost = sum((x) => x.primary_cost_usd);
    const tCost = sum((x) => x.target_cost_usd);
    // Cache-neutral and price-only: only rows where the recomputation was possible, compared with the primary cost of those same rows.
    const withNeutral = tms.filter((x) => x.target_cost_cache_neutral_usd !== null);
    const withPriceOnly = tms.filter((x) => x.target_cost_price_only_usd !== null);
    const tNeutral = withNeutral.length ? withNeutral.reduce((s, x) => s + x.target_cost_cache_neutral_usd!, 0) : null;
    const pNeutralBase = withNeutral.reduce((s, x) => s + x.primary_cost_usd, 0);
    const tPriceOnly = withPriceOnly.length ? withPriceOnly.reduce((s, x) => s + x.target_cost_price_only_usd!, 0) : null;
    const pPriceOnlyBase = withPriceOnly.reduce((s, x) => s + x.primary_cost_usd, 0);
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
    const methods = new Set(tms.map((x) => x.ttft_method).filter((m): m is TtftMethod => m !== null));
    const tSides = sideTtftByMethod(allSides.map((x) => x.s));
    const pSides = sideTtftByMethod(pairedSides.map((x) => x.primary));
    const agreementJudged = tms.reduce((s, x) => s + (x.agreement?.judged ?? 0), 0);
    const agreementAgreed = tms.reduce((s, x) => s + (x.agreement?.agreed ?? 0), 0);
    const gaps = tms
      .filter((x) => x.unmapped > 0)
      .map((x) => ({ model: x.model, requests: x.unmapped, suggestion: input.suggestions?.(t, x.model) ?? null }))
      .sort((a, b) => b.requests - a.requests);
    const NON_TRANSIENT = new Set(["model_not_found", "bad_request", "unsupported_parameter", "auth"]);
    const failing = tms
      .filter((x) => x.pairs === 0 && x.errors >= 2 && x.errors === x.requests_mirrored - x.unmapped && Object.keys(x.error_types).every((e) => NON_TRANSIENT.has(e)))
      .map((x) => ({ model: x.model, target_model: x.target_model, attempts: x.errors, error_type: Object.keys(x.error_types).sort((a, b) => x.error_types[b] - x.error_types[a])[0] }))
      .sort((a, b) => b.attempts - a.attempts);
    const name = input.targetMeta[t]?.name;
    targets.push({
      target: t,
      name,
      via: vias.size === 0 ? "none" : vias.size === 1 ? ([...vias][0] as any) : "mixed",
      requests_mirrored: mirrored,
      pairs,
      errors,
      error_rate: attempted > 0 ? errors / attempted : null,
      unmapped_requests: unmappedReq,
      coverage_pct: mirrored > 0 ? ((mirrored - unmappedReq) / mirrored) * 100 : null,
      no_output: { primary: sum((x) => x.no_output.primary), target: sum((x) => x.no_output.target) },
      unpriced: sum((x) => x.unpriced),
      unpriced_primary: sum((x) => x.unpriced_primary),
      truncated: { pairs: sum((x) => x.truncated.pairs), primary_only: sum((x) => x.truncated.primary_only), target_only: sum((x) => x.truncated.target_only), both: sum((x) => x.truncated.both) },
      reasoning_leak: { pairs: sum((x) => x.reasoning_leak.pairs), primary: sum((x) => x.reasoning_leak.primary), target: sum((x) => x.reasoning_leak.target) },
      projected_monthly_usd: comparable > 0 ? projected * monthlyFactor : null,
      comparable_monthly_usd: comparable > 0 ? comparable * monthlyFactor : null,
      delta_usd: comparable > 0 ? (projected - comparable) * monthlyFactor : null,
      delta_pct: comparable > 0 ? ((projected - comparable) / comparable) * 100 : null,
      projection_confidence: shortSpan || pairs < 50 ? "low" : "ok",
      measured: { pairs: costPairs, primary_cost_usd: pCost, target_cost_usd: tCost, delta_pct: pct(tCost, pCost) },
      avg_cost_per_request_usd: { primary: costPairs > 0 ? pCost / costPairs : null, target: costPairs > 0 ? tCost / costPairs : null },
      target_cost_cache_neutral_usd: tNeutral,
      delta_pct_cache_neutral: pct(tNeutral, pNeutralBase),
      target_cost_price_only_usd: tPriceOnly,
      delta_pct_price_only: pct(tPriceOnly, pPriceOnlyBase),
      cost_complete_pairs: { pairs: cpPairs, primary_cost_usd: cpP, target_cost_usd: cpT, delta_pct: pct(cpT, cpP) },
      tokens,
      cache_share,
      cache_warning: cacheWarning(primaryName, name ?? t, cache_share),
      headline: headlineFor(cacheWarning(primaryName, name ?? t, cache_share), pct(tCost, pCost), pct(tNeutral, pNeutralBase)),
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
      gaps,
      failing,
    });
  }

  // Effective sampling rate from the log itself: mirrored over (mirrored + eligible-but-not-sampled).
  const mirroredCount = records.filter((r) => r.mirrored).length;
  const notSampled = skipped["not_sampled"] ?? 0;
  const sampleRate = mirroredCount + notSampled > 0 ? mirroredCount / (mirroredCount + notSampled) : input.sampleRate;
  const monthly = primaryCost * monthlyFactor;
  const isOpenRouter = primaryProvider === "openrouter";
  const maxPairs = targets.reduce((m, t) => Math.max(m, t.pairs), 0);
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
      unpriced: okRecs.length - pricedRecs.length,
      cost_usd: primaryCost,
      cost_source: costSource,
      avg_cost_per_request_usd: pricedRecs.length ? primaryCost / pricedRecs.length : null,
      monthly_usd: monthly,
      topup_fee_usd: isOpenRouter && !input.byok ? monthly * OPENROUTER_TOPUP_FEE : null,
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
        (costSource === "measured"
          ? `${primaryName} costs are measured (usage.cost returned by ${primaryName}). Target costs are computed from each target's public price table using the token counts the target reported.`
          : `${primaryName} costs are computed from a checked-in price table using reported token counts. Target costs are computed the same way from each target's public price table.`) +
        " Cost figures cover only pairs where both sides returned a response and both have a price; a target response with no price-table entry is counted as unpriced, not as $0, and the pair stays in latency and error counts.",
      cost_deltas:
        "Three deltas are shown per model, all against the same primary cost. As served: what the target charged for its own response, with its own output length and cache hits. Cache-neutral: the target's cached prompt tokens re-priced at its full input rate, so a cache hit on one side does not pose as a price difference. Price-only: the target's price table applied to the primary's own token counts (prompt, completion and cached), which isolates the price list from how much each model chose to write.",
      complete_pairs:
        "Complete-pairs cost repeats the as-served delta over only the pairs where both sides finished on their own (finish_reason stop or tool_calls) and neither returned an empty response, so a side that was cut off at its token cap or returned nothing cannot lower or raise its bill.",
      empty_outputs:
        "An empty output is a response with status ok that carried no content and no tool calls (typically the whole token cap was spent on reasoning). Counted separately as no_output per side; excluded from TTFT on both sides, from agreement, and from complete-pairs cost. Older logs without the flag use finish_reason length with no text, or zero completion tokens. A reasoning leak is different: a response with status ok whose content is the model's reasoning channel (an \"analysis\" object or harmony-format text) rather than an answer; such pairs are counted as reasoning_leak per side, billed as served, and skipped by the judge.",
      sampling: sampleRate === null ? "Sampling rate unknown." : `${Math.round(sampleRate * 100)}% of eligible requests were mirrored (measured from the log). Requests with images, more than the input-token cap, or n>1 were not eligible.`,
      ttft:
        "TTFT is compared only when both sides were measured the same way: first content token on both when available, otherwise the legacy value when both sides recorded the same method, otherwise first byte on both. Pairs measured differently are reported as not comparable rather than compared. Per-side first-byte and first-content quantiles are listed separately. Streaming requests only; empty responses excluded.",
      projection:
        shortSpan
          ? `Monthly figures scale ${spanText} to 30 days (span floored at 1 hour). Per-request averages and measured totals are the reliable numbers here; the monthly figure is a rough extrapolation.`
          : `Monthly figures scale ${period?.days ?? 0} calendar days to 30 days.${confidence === "low" ? " Few pairs were measured, so the monthly figure is a rough extrapolation." : ""}`,
      agreement:
        `Agreement is scored on a ${Math.round(judgeFraction * 100)}% sample of completed pairs, excluding pairs where either side stopped at its token cap, returned nothing, or returned its reasoning channel instead of an answer (those are counted as truncated, no_output or reasoning_leak instead). Short outputs and plain numbers are compared exactly; JSON outputs are scored by field-weighted similarity, where arrays compare as multisets, empty values (null, "", [], {}) count as equal, and long strings earn partial credit for near matches: a similarity of 0.85 or more counts as agreement, under 0.5 as disagreement; anything in between, and free text, is judged by a cheap model asked whether the two answers are equivalent. ${judgeFraction >= 1 ? "Every completed pair was judged." : "Sampled, not exhaustive."} Agreement is noisy by nature: the same route asked the same prompt twice at temperature 0 does not always agree with itself (measured 2026-11-08: about half the time on JSON extraction with reasoning models), so compare targets against each other and read the judge's reasons rather than expecting 100%.`,
      judge_model: input.judgeModel,
      sample_size_note: confidence === "low" ? `Projection confidence is low: ${confidenceReason}. Read per-request averages and measured totals; the monthly figure is a rough extrapolation.` : null,
      prices: Object.entries(input.targetMeta).map(([target, m]) => ({ target, captured: m.pricesCaptured, source: m.pricesSource })),
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
