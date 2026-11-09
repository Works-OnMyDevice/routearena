import { RELAY_URL, type Credits } from "../config.js";

/**
 * A mirror target: an OpenAI-compatible chat completions endpoint.
 *
 * RouteArena ships no prices and no model lists. Which model id a target receives is the id the client sent,
 * unless the user's agent set `model_map` in .routearena/config.json (see Config). What a request cost is only
 * ever what the provider itself reports in its response (`usage.cost`); when a provider reports nothing, the
 * cost is unknown, never estimated.
 */
export interface Target {
  id: string;
  name: string;
  baseUrl: string;
  keyEnv: string;
  supportsFreeCredits?: boolean;
  /** Cheapest capable text model on this target, used as the agreement judge. */
  judgeModel?: string;
  /** Extra headers required by this target (never keys). */
  headers?: Record<string, string>;
  /**
   * True only when this provider's chat completion response carries a per-request cost (OpenRouter-style
   * `usage.cost`). None of the shipped targets do today; the field exists so such a target can be added.
   */
  reportsCost: boolean;
  /** Response header carrying the provider's own request id, captured into SideResult.target_request_id. */
  requestIdHeader?: string;
}

export type TargetStatus = "key" | "free-credits" | "no-key";

export interface ResolvedTarget {
  target: Target;
  status: TargetStatus;
  /** Where mirror requests go: the target directly or the relay for free credits. */
  baseUrl: string;
  /** Bearer value for mirror requests. Never logged. */
  auth: string | null;
}

/** Targets are defined in code. Endpoint and key variable only; no model tables, no prices. */
export const TARGETS: readonly Target[] = [
  {
    id: "deepinfra",
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    keyEnv: "DEEPINFRA_API_KEY",
    judgeModel: "openai/gpt-oss-120b",
    reportsCost: false,
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyEnv: "FIREWORKS_API_KEY",
    judgeModel: "accounts/fireworks/models/gpt-oss-120b",
    reportsCost: false,
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    judgeModel: "openai/gpt-oss-120b",
    reportsCost: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    judgeModel: "gpt-4o-mini",
    reportsCost: false,
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyEnv: "TOGETHER_API_KEY",
    judgeModel: "openai/gpt-oss-120b",
    reportsCost: false,
  },
  {
    id: "tokenrouter",
    name: "TokenRouter",
    baseUrl: "https://api.tokenrouter.com/v1",
    keyEnv: "TOKENROUTER_API_KEY",
    supportsFreeCredits: true,
    judgeModel: "openai/gpt-4o-mini",
    reportsCost: false,
    requestIdHeader: "x-tokenrouter-request-id",
  },
];

/** The shipped targets, in id order. Kept as a function for callers that predate the constant. */
export function loadTargets(): Target[] {
  return [...TARGETS];
}

export function getTarget(id: string): Target | undefined {
  return TARGETS.find((t) => t.id === id);
}

export function targetStatus(t: Target, env: NodeJS.ProcessEnv, credits: Credits | null): TargetStatus {
  if (env[t.keyEnv]) return "key";
  if (t.supportsFreeCredits && credits && new Date(credits.expiresAt).getTime() > Date.now()) return "free-credits";
  return "no-key";
}

/**
 * Resolve which targets can receive mirror traffic right now, and how.
 * `only` restricts to the listed ids (unknown ids are an error for the caller to surface).
 */
export function resolveTargets(opts: {
  env?: NodeJS.ProcessEnv;
  credits?: Credits | null;
  only?: string[];
  excludePrimary?: string;
}): ResolvedTarget[] {
  const env = opts.env ?? process.env;
  const credits = opts.credits ?? null;
  const out: ResolvedTarget[] = [];
  for (const t of loadTargets()) {
    if (opts.only && !opts.only.includes(t.id)) continue;
    if (opts.excludePrimary && t.id === opts.excludePrimary) continue;
    const status = targetStatus(t, env, credits);
    if (status === "key") {
      out.push({ target: t, status, baseUrl: t.baseUrl, auth: env[t.keyEnv] as string });
    } else if (status === "free-credits") {
      const direct = credits!.mode === "key" || credits!.token.startsWith("sk-");
      out.push({ target: t, status, baseUrl: direct ? t.baseUrl : `${RELAY_URL}/v1`, auth: credits!.token });
    } else {
      out.push({ target: t, status, baseUrl: t.baseUrl, auth: null });
    }
  }
  return out;
}

export function unknownTargetIds(ids: string[]): string[] {
  const known = new Set(loadTargets().map((t) => t.id));
  return ids.filter((i) => !known.has(i));
}
