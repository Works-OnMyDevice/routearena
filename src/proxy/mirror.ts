import { randomUUID } from "node:crypto";
import type { PrimaryId } from "../config.js";
import type { ResolvedTarget } from "../targets/index.js";
import { mapModel, type ModelMap } from "../targets/mapping.js";
import { DEFAULT_TIMEOUT_MS } from "./forward.js";
import type { Logger, LogRecord, SideResult } from "./logger.js";
import { chatCompletion, estimateInputTokens, hasImageContent, toSideResult } from "./openaiCall.js";

export interface MirrorOptions {
  primary: PrimaryId;
  targets: ResolvedTarget[]; // only those with status key|free-credits are used
  sample: number; // 0..1
  hourlyCap: number;
  maxInputTokens: number;
  mirrorImages: boolean;
  /** Per-mirror timeout. Defaults to the primary's timeout (DEFAULT_TIMEOUT_MS) so both sides fail on equal terms. */
  timeoutMs?: number;
  /**
   * Per-target model overrides from Config.model_map (set by the user's agent). Without an entry the mirror
   * receives the model id the client sent. RouteArena ships no mappings.
   */
  modelMap?: ModelMap;
  /** Injected for tests. */
  random?: () => number;
}

/** Mirror timeout used when MirrorOptions.timeoutMs is not set. Identical to the primary's default. */
export const DEFAULT_MIRROR_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export type ReasoningControl = NonNullable<LogRecord["request"]["reasoning_control"]>;

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** OpenRouter's documented mapping from a reasoning token budget (as a fraction of max_tokens) to an effort level. */
const EFFORT_FRACTIONS: Array<[string, number]> = [
  ["minimal", 0.1],
  ["low", 0.2],
  ["medium", 0.5],
  ["high", 0.8],
  ["max", 0.95],
];
/** Fallback when the client gave a reasoning budget but no max_tokens to take a fraction of (absolute token bands). */
const EFFORT_ABSOLUTE: Array<[string, number]> = [
  ["minimal", 1_024],
  ["low", 4_096],
  ["medium", 16_384],
  ["high", 32_768],
];

/** Which reasoning control the client sent on the original (OpenRouter-style) request body. */
export function reasoningControlOf(body: Record<string, any> | undefined): ReasoningControl {
  if (!body) return "none";
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) return "reasoning_effort";
  const r = body.reasoning;
  if (r && typeof r === "object") {
    if (typeof r.effort === "string" && r.effort) return "reasoning.effort";
    if (typeof r.max_tokens === "number" && r.max_tokens > 0) return "reasoning.max_tokens";
    if (r.enabled === false) return "reasoning.effort";
  }
  return "none";
}

/** Map a reasoning token budget to the nearest effort level. Exported for tests. */
export function effortForMaxTokens(reasoningMaxTokens: number, maxTokens: number | undefined): string {
  if (typeof maxTokens === "number" && maxTokens > 0) {
    const frac = reasoningMaxTokens / maxTokens;
    let best = EFFORT_FRACTIONS[0];
    for (const cand of EFFORT_FRACTIONS) if (Math.abs(cand[1] - frac) < Math.abs(best[1] - frac)) best = cand;
    return best[0];
  }
  for (const [effort, limit] of EFFORT_ABSOLUTE) if (reasoningMaxTokens <= limit) return effort;
  return "max";
}

/**
 * Translate OpenRouter's `reasoning` object into the OpenAI-style top-level `reasoning_effort` that other targets
 * understand, so a mirror gets the same reasoning budget the client asked the primary for. Never overrides a
 * `reasoning_effort` the client set itself. Exported for tests.
 */
export function translateReasoning(body: Record<string, any>, mirrorBody: Record<string, any>): void {
  const r = body.reasoning;
  if (!r || typeof r !== "object") return;
  if (mirrorBody.reasoning_effort !== undefined && mirrorBody.reasoning_effort !== null) return;
  if (r.enabled === false) {
    mirrorBody.reasoning_effort = "none";
    return;
  }
  if (typeof r.effort === "string" && (EFFORTS as readonly string[]).includes(r.effort)) {
    mirrorBody.reasoning_effort = r.effort;
    return;
  }
  if (typeof r.max_tokens === "number" && r.max_tokens > 0) {
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : undefined;
    mirrorBody.reasoning_effort = effortForMaxTokens(r.max_tokens, maxTokens);
  }
}

export interface Eligibility {
  ok: boolean;
  reason?: string;
}

export class MirrorEngine {
  private opts: MirrorOptions;
  private logger: Logger;
  private hourWindow: number[] = []; // timestamps of mirrored requests
  private inflight = new Set<Promise<void>>();
  stats = { requests: 0, mirrored: 0, skipped: 0, target_ok: 0, target_error: 0 };

  constructor(opts: MirrorOptions, logger: Logger) {
    this.opts = opts;
    this.logger = logger;
  }

  activeTargets(): ResolvedTarget[] {
    return this.opts.targets.filter((t) => t.status !== "no-key");
  }

  /** Pure eligibility check, exposed for tests. Does not consume the sampling roll. */
  eligibility(body: any, promptTokens: number | undefined, primaryOk: boolean): Eligibility {
    if (!primaryOk) return { ok: false, reason: "primary_failed" };
    if (this.activeTargets().length === 0) return { ok: false, reason: "no_targets" };
    if (body?.n !== undefined && body.n !== 1) return { ok: false, reason: "n_gt_1" };
    if (!this.opts.mirrorImages && hasImageContent(body)) return { ok: false, reason: "has_images" };
    const tokens = promptTokens ?? estimateInputTokens(body);
    if (tokens > this.opts.maxInputTokens) return { ok: false, reason: "input_too_long" };
    this.pruneWindow();
    if (this.hourWindow.length >= this.opts.hourlyCap) return { ok: false, reason: "hourly_cap" };
    return { ok: true };
  }

  roll(): boolean {
    const r = (this.opts.random ?? Math.random)();
    return r < this.opts.sample;
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - 3600_000;
    while (this.hourWindow.length && this.hourWindow[0] < cutoff) this.hourWindow.shift();
  }

  /**
   * Record the primary result and, if eligible and sampled, fire mirrors in the background.
   * Never blocks the caller beyond synchronous bookkeeping.
   */
  handle(canonical: string, body: Record<string, any>, primary: SideResult, completed: boolean): LogRecord {
    this.stats.requests++;
    const rec: LogRecord = {
      v: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      canonical_model: canonical,
      request: {
        stream: body.stream === true,
        n: body.n,
        has_images: hasImageContent(body),
        has_tools: Array.isArray(body.tools) && body.tools.length > 0,
        est_input_tokens: primary.usage?.prompt_tokens ?? estimateInputTokens(body),
        response_format: body.response_format?.type,
        reasoning_control: reasoningControlOf(body),
      },
      primary: stripCompletionIfHuge(primary),
      mirrored: false,
      targets: [],
    };
    const elig = this.eligibility(body, primary.usage?.prompt_tokens, completed);
    if (!elig.ok) {
      rec.skip_reason = elig.reason;
      this.stats.skipped++;
      this.logger.append(rec);
      return rec;
    }
    if (!this.roll()) {
      rec.skip_reason = "not_sampled";
      this.stats.skipped++;
      this.logger.append(rec);
      return rec;
    }
    rec.mirrored = true;
    this.stats.mirrored++;
    this.hourWindow.push(Date.now());
    const p = this.runMirrors(rec, body).catch(() => undefined);
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return rec;
  }

  private async runMirrors(rec: LogRecord, body: Record<string, any>): Promise<void> {
    const results = await Promise.all(this.activeTargets().map((t) => this.mirrorOne(t, rec.canonical_model, body)));
    rec.targets = results;
    this.logger.append(rec);
  }

  private async mirrorOne(rt: ResolvedTarget, canonical: string, body: Record<string, any>): Promise<SideResult> {
    // Every request is sent. Model choice on a target belongs to the user's agent (Config.model_map); by default the
    // target gets the id the client sent. A target that does not know the model answers with an error we record.
    const original = typeof body.model === "string" ? body.model : canonical;
    const model = mapModel(rt.target, canonical, this.opts.modelMap, original);
    const mirrorBody: Record<string, any> = { ...body, model };
    // Fields that are OpenRouter-specific and would 400 elsewhere.
    delete mirrorBody.usage;
    delete mirrorBody.provider;
    delete mirrorBody.transforms;
    delete mirrorBody.route;
    delete mirrorBody.models;
    delete mirrorBody.plugins;
    // Carry the client's reasoning budget over as `reasoning_effort` before dropping OpenRouter's `reasoning` object.
    translateReasoning(body, mirrorBody);
    delete mirrorBody.reasoning;
    delete mirrorBody.include_reasoning;
    delete mirrorBody.stream_options; // re-added by chatCompletion when streaming
    delete mirrorBody.user; // avoid leaking end-user identifiers to the target
    delete mirrorBody.metadata;
    delete mirrorBody.store;
    const r = await chatCompletion({
      baseUrl: rt.baseUrl,
      auth: rt.auth,
      body: mirrorBody,
      headers: rt.target.headers,
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_MIRROR_TIMEOUT_MS,
      streamForTtft: true,
    });
    // cost_usd / cost_source come from chatCompletion: the provider's own usage.cost or "not_reported". Never computed.
    const side = toSideResult(rt.target.id, model, r, {
      via: viaOf(rt),
      stream: true,
    });
    const idHeader = rt.target.requestIdHeader?.toLowerCase();
    const requestId = idHeader ? r.response_headers?.[idHeader] : undefined;
    if (requestId) side.target_request_id = requestId;
    if (r.status === "ok") this.stats.target_ok++;
    else this.stats.target_error++;
    return stripCompletionIfHuge(side);
  }

  pending(): number {
    return this.inflight.size;
  }

  /** Wait for all in-flight mirrors (used by `demo` and graceful shutdown). */
  async drain(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 250))]);
    }
  }
}

function viaOf(rt: ResolvedTarget): "direct" | "relay" {
  return rt.baseUrl === rt.target.baseUrl ? "direct" : "relay";
}

const MAX_STORED_COMPLETION = 20_000;
function stripCompletionIfHuge(s: SideResult): SideResult {
  if (s.completion_text && s.completion_text.length > MAX_STORED_COMPLETION) {
    return { ...s, completion_text: s.completion_text.slice(0, MAX_STORED_COMPLETION) };
  }
  return s;
}
