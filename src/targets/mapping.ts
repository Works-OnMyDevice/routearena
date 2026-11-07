import type { PriceEntry, Target } from "./index.js";
import type { PrimaryId } from "../config.js";

/**
 * Canonical model ids are OpenRouter ids, lowercase: "vendor/model-name".
 * OpenAI-direct requests use bare ids ("gpt-4o-mini"); we canonicalize them to "openai/gpt-4o-mini".
 * OpenRouter variant suffixes (":free", ":nitro", ":floor", ":online", ":exacto", ":thinking") are stripped
 * for mapping purposes but kept in the raw model string that the report shows.
 */
export function canonicalModel(primary: PrimaryId, model: string): string {
  let m = (model || "").trim().toLowerCase();
  if (!m) return m;
  if (primary === "openai") {
    if (!m.includes("/")) m = `openai/${m}`;
    return m;
  }
  // OpenRouter: strip variant suffix
  const colon = m.indexOf(":");
  if (colon > 0) m = m.slice(0, colon);
  return m;
}

/** The generic shape-normalizer used only to *suggest* mappings; never used to produce report numbers. */
export function normalizeForSuggestion(id: string): string {
  let s = id.toLowerCase();
  s = s.replace(/^accounts\/[^/]+\/models\//, ""); // fireworks
  s = s.replace(/^[^/]+\//, ""); // drop vendor prefix
  s = s.replace(/[:@].*$/, ""); // variant / revision
  s = s.replace(/-instruct(-turbo)?$/, "");
  s = s.replace(/-turbo$/, "");
  s = s.replace(/[._]/g, "-");
  s = s.replace(/-+/g, "-");
  return s;
}

export interface MappedModel {
  canonical: string;
  entry: PriceEntry;
}

/** Explicit lookup only. Unmapped stays unmapped (that is product feedback, see coverage gaps). */
export function mapModel(target: Target, canonical: string): MappedModel | null {
  const entry = target.models[canonical.toLowerCase()];
  if (!entry) return null;
  return { canonical, entry };
}

/** Suggest a probable mapping for a coverage-gap line, clearly labeled as a guess. */
export function suggestMapping(target: Target, canonical: string): string | null {
  const want = normalizeForSuggestion(canonical);
  for (const [k, v] of Object.entries(target.models)) {
    if (normalizeForSuggestion(k) === want || normalizeForSuggestion(v.id) === want) return v.id;
  }
  return null;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
}

/** Token totals pulled out of a usage record, with missing fields read as 0. */
export interface TokenTotals {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
}

export function tokenTotals(usage: Usage | undefined | null): TokenTotals {
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    prompt_tokens: n(usage?.prompt_tokens),
    completion_tokens: n(usage?.completion_tokens),
    cached_tokens: n(usage?.prompt_tokens_details?.cached_tokens),
    reasoning_tokens: n(usage?.completion_tokens_details?.reasoning_tokens),
  };
}

export function addTokenTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
  };
}

export const zeroTokens = (): TokenTotals => ({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 });

/** USD cost for a usage record at the given prices. Cached tokens are charged at the cached rate when known. */
export function computeCost(entry: PriceEntry, usage: Usage | undefined | null): number | null {
  if (!usage) return null;
  const p = usage.prompt_tokens ?? 0;
  const c = usage.completion_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const uncached = Math.max(0, p - cached);
  const inRate = entry.input_per_m / 1e6;
  const cachedRate = (entry.cached_input_per_m ?? entry.input_per_m) / 1e6;
  const outRate = entry.output_per_m / 1e6;
  return uncached * inRate + cached * cachedRate + c * outRate;
}

/**
 * USD the cached-input discount was worth for this usage at these prices: cached tokens x (full input rate - cached rate).
 * Adding it back to a computed cost gives the cache-neutral cost (every prompt token at the full input rate).
 */
export function cacheDiscountUsd(entry: PriceEntry, usage: Usage | undefined | null): number {
  if (!usage) return 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  if (!cached || entry.cached_input_per_m === undefined) return 0;
  return Math.max(0, cached * (entry.input_per_m - entry.cached_input_per_m)) / 1e6;
}

/** Cost with every prompt token at the full input rate, so a cache hit on one side cannot flatter its price. */
export function computeCostCacheNeutral(entry: PriceEntry, usage: Usage | undefined | null): number | null {
  if (!usage) return null;
  const p = usage.prompt_tokens ?? 0;
  const c = usage.completion_tokens ?? 0;
  return (p * entry.input_per_m + c * entry.output_per_m) / 1e6;
}
