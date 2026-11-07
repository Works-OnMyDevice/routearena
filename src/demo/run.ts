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
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string };
  temperature?: number;
  max_tokens?: number;
  /** Set for reasoning models so they do not spend the whole budget thinking. */
  reasoning_effort?: string;
}

export function workloadPath(): string {
  return path.join(pkgRoot(), "demo", "workload.jsonl");
}

export async function loadWorkload(file = workloadPath()): Promise<WorkloadItem[]> {
  if (!fs.existsSync(file)) {
    throw new CliError(`Demo workload not found at ${file}.`, "Reinstall routearena (npm i -g routearena@latest) or run from a full clone with demo/workload.jsonl present.");
  }
  const items: WorkloadItem[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    items.push(JSON.parse(line));
  }
  return items;
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
 * The model in each item is an OpenRouter id; for an OpenAI primary the "openai/" prefix is stripped.
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
      if (opts.primary === "openai") {
        if (!model.startsWith("openai/")) {
          // Only OpenAI models can run on an OpenAI primary.
          done++;
          result.failed++;
          opts.onProgress?.(done, items.length, result.ok);
          continue;
        }
        model = model.slice("openai/".length);
      }
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
