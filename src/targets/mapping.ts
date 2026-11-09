import type { Target } from "./index.js";
import type { PrimaryId } from "../config.js";

/**
 * Canonical model ids are OpenRouter ids, lowercase: "vendor/model-name". Used only to group requests in the
 * report. OpenAI-direct requests use bare ids ("gpt-4o-mini"); we canonicalize them to "openai/gpt-4o-mini".
 * OpenRouter variant suffixes (":free", ":nitro", ":floor", ":online", ":exacto", ":thinking") are stripped
 * for grouping but kept in the raw model string that the report shows.
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

/** Per-target model overrides: target id -> (model id as the client sends it -> id to send to that target). */
export type ModelMap = Record<string, Record<string, string>>;

/** Drop an OpenRouter variant suffix (":nitro", ":floor", ":free", ...) that other routers do not understand. */
function stripVariant(model: string): string {
  const colon = model.indexOf(":");
  return colon > 0 ? model.slice(0, colon) : model;
}

/**
 * The model id to send to `target` for a request the client made with `original` (the id exactly as sent).
 *
 * RouteArena ships no mappings: by default the client's id is forwarded unchanged (minus an OpenRouter variant
 * suffix). The user's agent can override per target through `model_map` in .routearena/config.json, keyed by
 * either the canonical id or the id as the client sent it.
 */
export function mapModel(target: Target, canonical: string, overrides: ModelMap | undefined, original: string = canonical): string {
  const forTarget = overrides?.[target.id];
  if (forTarget) {
    const byCanonical = forTarget[canonical] ?? forTarget[canonical.toLowerCase()];
    if (typeof byCanonical === "string" && byCanonical) return byCanonical;
    const byOriginal = forTarget[original] ?? forTarget[stripVariant(original)];
    if (typeof byOriginal === "string" && byOriginal) return byOriginal;
  }
  return stripVariant(original);
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** Per-request USD the provider itself reported (OpenRouter). Absent from most providers. */
  cost?: number;
}

/** The provider-reported cost in a usage record, or null when the provider reported none. Never computed. */
export function reportedCost(usage: Usage | undefined | null): number | null {
  const c = usage?.cost;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
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
