import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CliError, pkgRoot } from "../config.js";
import { chatCompletion } from "../proxy/openaiCall.js";

export interface WorkloadItem {
  id: string;
  /** Template name from demo/templates (e.g. "article-extractor"). */
  template: string;
  /** Source page URL (public). */
  source_url: string;
  /** When the page text was captured. */
  fetched_at?: string;
  /** Model id to send, as the primary expects it. Supplied by the agent (`--models`), never by the workload file. */
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string };
  temperature?: number;
  max_tokens?: number;
  /** Set for reasoning models so they do not spend the whole budget thinking. */
  reasoning_effort?: string;
}

/** A workload line before a model is assigned. The file ships prompts only; RouteArena ships no model lists. */
export type WorkloadPrompt = Omit<WorkloadItem, "model">;

export function workloadPath(): string {
  return path.join(pkgRoot(), "demo", "workload.jsonl");
}

/** Read demo/workload.jsonl. Items carry no model; any `model` key in the file is ignored. Use assignModels(). */
export async function loadWorkload(file = workloadPath()): Promise<WorkloadPrompt[]> {
  if (!fs.existsSync(file)) {
    throw new CliError(`Demo workload not found at ${file}.`, "Reinstall routearena (npm i -g routearena@latest) or run from a full clone with demo/workload.jsonl present.");
  }
  const items: WorkloadPrompt[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { model: _ignored, ...rest } = JSON.parse(line) as WorkloadPrompt & { model?: unknown };
    void _ignored;
    items.push(rest);
  }
  return items;
}

/**
 * Round-robin the agent-supplied model ids over the workload: item i gets models[i % models.length].
 * Returns new items; the input is not modified.
 */
export function assignModels(items: WorkloadPrompt[], models: string[]): WorkloadItem[] {
  const ids = models.map((m) => m.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new CliError("No models given for the demo.", "Pass the model ids to send with --models, e.g. --models openai/gpt-4o-mini,deepseek/deepseek-chat (RouteArena ships no model list).");
  }
  return items.map((it, i) => ({ ...it, model: ids[i % ids.length] }));
}

export interface DemoRunResult {
  sent: number;
  ok: number;
  failed: number;
  by_model: Record<string, number>;
  /** Set when the run halted early because the primary refused requests for a reason that will not clear by itself. */
  stopped?: { after: number; error_type: string; message: string };
  /** Number of retries made after the primary refused a request for lack of credits. */
  credit_retries?: number;
}

const HALT_TYPES = new Set(["insufficient_credits", "auth", "invalid_key", "unauthorized", "forbidden"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Backoff before each retry of a credit refusal. OpenRouter reserves an estimate per in-flight request, so a low balance fails under concurrency first. */
export const CREDIT_RETRY_DELAYS_MS = [3000, 6000, 12000];

/**
 * Send workload items through the local proxy at `proxyBase` (e.g. http://localhost:4000/v1).
 * Each item's model is whatever the agent assigned (assignModels). For an OpenAI primary a leading "openai/"
 * (OpenRouter style) is stripped so either spelling works; nothing else is rewritten.
 */
export async function runDemo(
  items: WorkloadItem[],
  opts: {
    proxyBase: string;
    primary: "openrouter" | "openai";
    concurrency?: number;
    onProgress?: (done: number, total: number, ok: number) => void;
    /** Test hook: override the backoff schedule for credit refusals. */
    creditRetryDelaysMs?: number[];
  },
): Promise<DemoRunResult> {
  const result: DemoRunResult = { sent: 0, ok: 0, failed: 0, by_model: {} };
  const conc = opts.concurrency ?? 4;
  let i = 0;
  let done = 0;
  let halted = false;
  // Once the primary refuses for credits, run the rest one at a time: the refusal is about in-flight reservations.
  let lowCredit = false;
  let lock: Promise<void> = Promise.resolve();
  const serialized = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = lock;
    let release!: () => void;
    lock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const retryDelays = opts.creditRetryDelaysMs ?? CREDIT_RETRY_DELAYS_MS;
  const worker = async () => {
    while (i < items.length && !halted) {
      const it = items[i++];
      let model = it.model;
      if (opts.primary === "openai" && model.startsWith("openai/")) model = model.slice("openai/".length);
      result.sent++;
      result.by_model[it.model] = (result.by_model[it.model] ?? 0) + 1;
      const send = () =>
        chatCompletion({
          baseUrl: opts.proxyBase,
          auth: "demo", // the proxy ignores the client key and uses the env key
          body: {
            model,
            messages: it.messages,
            temperature: it.temperature ?? 0,
            max_tokens: it.max_tokens ?? 2000,
            ...(it.response_format ? { response_format: it.response_format } : {}),
            ...(it.reasoning_effort ? { reasoning_effort: it.reasoning_effort } : {}),
          },
          timeoutMs: 120_000,
          streamForTtft: true,
        });
      let r = lowCredit ? await serialized(send) : await send();
      for (let attempt = 0; r.status !== "ok" && r.error_type === "insufficient_credits" && attempt < retryDelays.length && !halted; attempt++) {
        lowCredit = true;
        result.credit_retries = (result.credit_retries ?? 0) + 1;
        await sleep(retryDelays[attempt]);
        r = await serialized(send);
      }
      if (r.status === "ok") result.ok++;
      else result.failed++;
      done++;
      opts.onProgress?.(done, items.length, result.ok);
      if (r.status !== "ok" && r.error_type && HALT_TYPES.has(r.error_type) && !halted) {
        halted = true;
        result.stopped = { after: done, error_type: r.error_type, message: r.error ?? r.error_type };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return result;
}
