import fs from "node:fs";
import readline from "node:readline";
import { ensureConfigDir, logPath, redact } from "../config.js";
import type { Usage } from "../targets/mapping.js";

export type CostSource = "measured" | "computed" | "unknown";

export interface SideResult {
  /** "openrouter" | "openai" for the primary; target id for mirrors. */
  provider: string;
  /** Model string as sent to this provider. */
  model: string;
  status: "ok" | "error" | "unmapped" | "skipped";
  http_status?: number;
  /** Wall time from just before fetch() to the end of the response (or to the failure, including timeouts). */
  latency_ms?: number;
  /**
   * Legacy TTFT. Equals ttft_first_content_ms when that is known, else undefined. Both sides measure it the same
   * way (first content chunk) so primary and target TTFT are comparable.
   */
  ttft_ms?: number;
  /** How ttft_ms was measured: "first-content-chunk" when ttft_ms is set, "n/a" for non-streaming or no content. */
  ttft_method?: "first-stream-chunk" | "first-content-chunk" | "n/a";
  /**
   * ms from just before fetch() to the first reader.read() value of any kind, including SSE comment lines such as
   * ": OPENROUTER PROCESSING". Measures connection + router pickup, not model output. Undefined for non-streaming.
   */
  ttft_first_byte_ms?: number;
  /**
   * ms from just before fetch() to the first parsed chunk carrying delta.content or delta.tool_calls. Reasoning
   * deltas (reasoning / reasoning_content) do not count. Undefined for non-streaming or when no content arrived.
   */
  ttft_first_content_ms?: number;
  /**
   * True when status is "ok" but the response carries no non-whitespace completion_text and no tool_calls
   * (typically finish_reason "length" after reasoning consumed max_tokens). Absent otherwise.
   */
  empty_output?: boolean;
  /** Provider's chat completion id (first chunk's id for streams; OpenRouter's "gen-..." id works with GET /api/v1/generation?id=). */
  response_id?: string;
  stream?: boolean;
  usage?: Usage | null;
  /** Null when the provider returned no usage (cost_source "unknown"), so the report can treat the request as unpriced. */
  cost_usd?: number | null;
  cost_source?: CostSource;
  /** A `usage.cost` the provider itself returned, if any. Informational; target cost is always computed. */
  reported_cost_usd?: number;
  error_type?: string;
  error?: string;
  /** Upstream host the router reported serving this request (OpenRouter's "provider" field). Most routers report none. */
  upstream?: string | null;
  finish_reason?: string | null;
  /** Stored locally for agreement judging. Never uploaded. */
  completion_text?: string | null;
  tool_calls?: Array<{ name: string; arguments: string }> | null;
  via?: "direct" | "relay";
}

export interface LogRecord {
  v: 1;
  id: string;
  ts: string;
  /** Canonical (OpenRouter-style) model id used for mapping and grouping. */
  canonical_model: string;
  request: {
    stream: boolean;
    n?: number;
    has_images: boolean;
    has_tools: boolean;
    est_input_tokens: number;
    response_format?: string;
    /**
     * Which reasoning control the client sent on the original request: top-level `reasoning_effort`, OpenRouter's
     * `reasoning.effort`, `reasoning.max_tokens` (translated to the nearest effort for mirrors), or "none".
     */
    reasoning_control?: "reasoning_effort" | "reasoning.effort" | "reasoning.max_tokens" | "none";
  };
  primary: SideResult;
  mirrored: boolean;
  skip_reason?: string;
  targets: SideResult[];
}

export class Logger {
  private file: string;
  constructor(cwd = process.cwd()) {
    ensureConfigDir(cwd);
    this.file = logPath(cwd);
  }
  append(rec: LogRecord): void {
    const line = redact(JSON.stringify(rec));
    fs.appendFileSync(this.file, line + "\n");
  }
  path(): string {
    return this.file;
  }
}

export async function readLog(file: string): Promise<LogRecord[]> {
  if (!fs.existsSync(file)) return [];
  const out: LogRecord[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as LogRecord;
      if (rec && rec.v === 1 && rec.primary) out.push(rec);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
