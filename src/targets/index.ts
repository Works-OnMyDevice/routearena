import fs from "node:fs";
import path from "node:path";
import { pkgRoot, RELAY_URL, type Credits } from "../config.js";

export interface PriceEntry {
  /** Model id as the target's API expects it. */
  id: string;
  input_per_m: number;
  output_per_m: number;
  /** Optional cached-input price (USD per M). */
  cached_input_per_m?: number;
  /** Free-form note shown in the coverage table (e.g. "quantized", "preview"). */
  note?: string;
}

export interface Target {
  id: string;
  name: string;
  baseUrl: string;
  keyEnv: string;
  supportsFreeCredits?: boolean;
  /** Cheapest capable text model on this target, used as the agreement judge. */
  judgeModel?: string;
  /** Prices page the table was captured from, and when. */
  pricesSource?: string;
  pricesCaptured?: string;
  /** Does GET /v1/models work with a key? Informational. */
  modelsEndpoint?: boolean;
  /** Extra headers required by this target (never keys). */
  headers?: Record<string, string>;
  /** Keys are canonical OpenRouter model ids (lowercase). */
  models: Record<string, PriceEntry>;
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

export function targetsDir(): string {
  return path.join(pkgRoot(), "targets");
}

let cache: Target[] | null = null;

export function loadTargets(): Target[] {
  if (cache) return cache;
  const dir = targetsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  cache = files.map((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Target;
    // normalize map keys
    const models: Record<string, PriceEntry> = {};
    for (const [k, v] of Object.entries(t.models ?? {})) models[k.toLowerCase()] = v;
    t.models = models;
    return t;
  });
  return cache;
}

export function getTarget(id: string): Target | undefined {
  return loadTargets().find((t) => t.id === id);
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
