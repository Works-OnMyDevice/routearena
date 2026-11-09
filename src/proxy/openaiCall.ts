import { reportedCost, type Usage } from "../targets/mapping.js";
import type { CostSource, SideResult } from "./logger.js";

export interface ToolCallOut {
  name: string;
  arguments: string;
}

export interface CallResult {
  status: "ok" | "error";
  http_status?: number;
  latency_ms: number;
  /** Legacy TTFT: equals ttft_first_content_ms when known. */
  ttft_ms?: number;
  ttft_method: "first-stream-chunk" | "first-content-chunk" | "n/a";
  /** ms from just before fetch() to the first reader.read() value of any kind (SSE comments included). */
  ttft_first_byte_ms?: number;
  /** ms from just before fetch() to the first parsed chunk carrying delta.content or delta.tool_calls. */
  ttft_first_content_ms?: number;
  /** True when status is "ok" but the response has no non-whitespace text and no tool calls. */
  empty_output?: boolean;
  /** Provider's chat completion id (first chunk's id for streams). */
  response_id?: string;
  /** Response headers, lowercased, so callers can pick out a provider request id (Target.requestIdHeader). */
  response_headers?: Record<string, string>;
  usage: Usage | null;
  /** The provider-reported cost (`usage.cost`), or null when the response carries none. Never computed. */
  cost_usd: number | null;
  cost_source: CostSource;
  finish_reason: string | null;
  completion_text: string | null;
  tool_calls: ToolCallOut[] | null;
  error_type?: string;
  error?: string;
  /** Upstream host the router named in its response (OpenRouter's top-level "provider" field), when present. */
  upstream?: string | null;
  /** Raw JSON body for non-streaming successful responses (used by the judge path). */
  json?: any;
}

/** Accumulates an OpenAI-style streamed chat completion from parsed SSE JSON chunks. */
export class StreamAccumulator {
  text = "";
  usage: Usage | null = null;
  finish_reason: string | null = null;
  upstream: string | null = null;
  /** First non-empty `id` seen on any chunk. */
  id: string | null = null;
  /** First in-stream `error` object (OpenRouter sends these inside a 200 stream when the upstream fails mid-way). */
  error: { code?: unknown; message?: unknown } | null = null;
  private tools = new Map<number, { name: string; arguments: string }>();
  sawContent = false;

  push(chunk: any): void {
    if (!chunk || typeof chunk !== "object") return;
    if (this.id === null && typeof chunk.id === "string" && chunk.id) this.id = chunk.id;
    if (this.error === null && chunk.error && typeof chunk.error === "object") this.error = chunk.error;
    if (chunk.usage) this.usage = chunk.usage;
    if (typeof chunk.provider === "string" && chunk.provider) this.upstream = chunk.provider;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return;
    if (choice.finish_reason) this.finish_reason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      this.text += delta.content;
      this.sawContent = true;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const cur = this.tools.get(idx) ?? { name: "", arguments: "" };
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        this.tools.set(idx, cur);
        this.sawContent = true;
      }
    }
  }

  toolCalls(): ToolCallOut[] | null {
    if (this.tools.size === 0) return null;
    return [...this.tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }
}

/** Incremental SSE line parser. Call feed() with decoded text; it yields JSON payloads. */
export class SseParser {
  private buf = "";
  feed(text: string): any[] {
    this.buf += text;
    const out: any[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        // partial or non-JSON data line; ignore
      }
    }
    return out;
  }
}

export function extractFromJson(json: any): Pick<CallResult, "usage" | "finish_reason" | "completion_text" | "tool_calls" | "upstream" | "response_id"> {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const msg = choice?.message ?? {};
  let text: string | null = null;
  if (typeof msg.content === "string") text = msg.content;
  else if (Array.isArray(msg.content)) {
    text = msg.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  const tool_calls: ToolCallOut[] | null = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc: any) => ({ name: tc?.function?.name ?? "", arguments: tc?.function?.arguments ?? "" }))
    : null;
  return {
    usage: json?.usage ?? null,
    finish_reason: choice?.finish_reason ?? null,
    completion_text: text,
    tool_calls,
    upstream: typeof json?.provider === "string" && json.provider ? json.provider : null,
    response_id: typeof json?.id === "string" && json.id ? json.id : undefined,
  };
}

/** True when a completed response carries no non-whitespace text and no tool calls. */
export function isEmptyOutput(text: string | null | undefined, toolCalls: ToolCallOut[] | null | undefined): boolean {
  return !(text && text.trim().length > 0) && !(toolCalls && toolCalls.length > 0);
}

/**
 * Classify an `error` object carried inside an otherwise successful (200) response body or stream chunk.
 * OpenRouter uses HTTP-like numeric codes (402, 429, 502, ...); other routers send string codes.
 */
export function classifyInBodyError(err: { code?: unknown; message?: unknown } | null | undefined): string {
  if (!err) return "upstream_error";
  const byText = classifyError(undefined, undefined, JSON.stringify({ error: err }));
  if (byText !== "unknown") return byText;
  const code = err.code;
  if (typeof code === "number" && code >= 400) return classifyError(code);
  if (typeof code === "string" && /^\d{3}$/.test(code) && Number(code) >= 400) return classifyError(Number(code));
  if (typeof code === "string" && code.trim()) return code.trim().toLowerCase().slice(0, 64);
  return "upstream_error";
}

export function inBodyErrorMessage(err: { code?: unknown; message?: unknown } | null | undefined): string {
  if (!err) return "upstream returned an error with no content";
  const m = typeof err.message === "string" && err.message ? err.message : JSON.stringify(err);
  return m.slice(0, 300);
}

export function classifyError(httpStatus: number | undefined, err?: unknown, bodyText?: string): string {
  if (bodyText) {
    try {
      const e = JSON.parse(bodyText)?.error;
      const code = String(e?.code ?? "").toLowerCase();
      const msg = String(e?.message ?? "").toLowerCase();
      if (code.includes("model_not_found") || /no available channel|model .* (not found|does not exist)|unknown model/.test(msg)) return "model_not_found";
      if (code.includes("insufficient") || /insufficient (credits|balance|quota)|quota/.test(msg)) return "insufficient_credits";
      if (code.includes("context_length") || /context length|too many tokens|maximum context/.test(msg)) return "context_too_long";
      if (/temperature|unsupported parameter|not supported for this model|is deprecated for this model/.test(msg)) return "unsupported_parameter";
    } catch {
      /* not json */
    }
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
    const code = (err as any).cause?.code ?? (err as any).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "connection";
    return "network";
  }
  if (httpStatus === undefined) return "unknown";
  if (httpStatus === 401 || httpStatus === 403) return "auth";
  if (httpStatus === 402) return "insufficient_credits";
  if (httpStatus === 404) return "model_not_found";
  if (httpStatus === 408) return "timeout";
  if (httpStatus === 400 || httpStatus === 422) return "bad_request";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus >= 500) return "upstream_error";
  return `http_${httpStatus}`;
}

export interface CallOptions {
  baseUrl: string;
  auth: string | null;
  body: Record<string, any>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Force streaming to measure TTFT on content, then collect to completion. */
  streamForTtft?: boolean;
}

/**
 * Send one chat completion and collect the result. Used for mirrors and the judge.
 * Never retries. Never throws for HTTP errors; returns status: "error" with a type instead.
 */
export async function chatCompletion(opts: CallOptions): Promise<CallResult> {
  const t0 = performance.now();
  const body = { ...opts.body };
  const stream = opts.streamForTtft ?? false;
  if (stream) {
    body.stream = true;
    // Ask for usage in the final chunk where supported (OpenAI, Groq, Together, Fireworks, DeepInfra, OpenRouter).
    body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  } else {
    delete body.stream;
    delete body.stream_options;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        status: "error",
        http_status: res.status,
        latency_ms: performance.now() - t0,
        ttft_method: "n/a",
        response_headers: headersOf(res),
        usage: null,
        cost_usd: null,
        cost_source: "not_reported",
        finish_reason: null,
        completion_text: null,
        tool_calls: null,
        error_type: classifyError(res.status, undefined, txt),
        error: safeErrorMessage(txt),
      };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (stream && ct.includes("text/event-stream") && res.body) {
      const acc = new StreamAccumulator();
      const parser = new SseParser();
      const dec = new TextDecoder();
      let firstByte: number | undefined;
      let firstContent: number | undefined;
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstByte === undefined) firstByte = performance.now() - t0;
        const chunks = parser.feed(dec.decode(value, { stream: true }));
        for (const c of chunks) {
          acc.push(c);
          if (firstContent === undefined && acc.sawContent) firstContent = performance.now() - t0;
        }
      }
      const text = acc.text || null;
      const toolCalls = acc.toolCalls();
      const empty = isEmptyOutput(text, toolCalls);
      const base = {
        http_status: res.status,
        latency_ms: performance.now() - t0,
        ttft_ms: firstContent,
        ttft_method: firstContent === undefined ? ("n/a" as const) : ("first-content-chunk" as const),
        ttft_first_byte_ms: firstByte,
        ttft_first_content_ms: firstContent,
        response_id: acc.id ?? undefined,
        response_headers: headersOf(res),
        usage: acc.usage,
        ...costOf(acc.usage),
        finish_reason: acc.finish_reason,
        completion_text: text,
        tool_calls: toolCalls,
        upstream: acc.upstream,
      };
      if (acc.error && empty) {
        // A 200 whose stream carried an error chunk and no content is a failed request, not an empty success.
        return { status: "error", ...base, error_type: classifyInBodyError(acc.error), error: inBodyErrorMessage(acc.error) };
      }
      return { status: "ok", ...base, empty_output: empty || undefined };
    }
    const json: any = await res.json();
    const ex = extractFromJson(json);
    const empty = isEmptyOutput(ex.completion_text, ex.tool_calls);
    if (json && typeof json === "object" && json.error && typeof json.error === "object" && empty) {
      return {
        status: "error",
        http_status: res.status,
        latency_ms: performance.now() - t0,
        ttft_method: "n/a",
        response_headers: headersOf(res),
        ...ex,
        ...costOf(ex.usage),
        error_type: classifyInBodyError(json.error),
        error: inBodyErrorMessage(json.error),
        json,
      };
    }
    return {
      status: "ok",
      http_status: res.status,
      latency_ms: performance.now() - t0,
      ttft_method: "n/a",
      response_headers: headersOf(res),
      ...ex,
      ...costOf(ex.usage),
      empty_output: empty || undefined,
      json,
    };
  } catch (err) {
    return {
      status: "error",
      latency_ms: performance.now() - t0,
      ttft_method: "n/a",
      usage: null,
      cost_usd: null,
      cost_source: "not_reported",
      finish_reason: null,
      completion_text: null,
      tool_calls: null,
      error_type: classifyError(undefined, err),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/** cost_usd / cost_source for a usage record: the provider's own `usage.cost` or nothing. */
export function costOf(usage: Usage | null | undefined): { cost_usd: number | null; cost_source: CostSource } {
  const c = reportedCost(usage);
  return c === null ? { cost_usd: null, cost_source: "not_reported" } : { cost_usd: c, cost_source: "reported" };
}

function safeErrorMessage(txt: string): string {
  try {
    const j = JSON.parse(txt);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === "string") return m.slice(0, 300);
  } catch {
    /* not json */
  }
  return txt.slice(0, 300);
}

export function toSideResult(provider: string, model: string, r: CallResult, extra: Partial<SideResult> = {}): SideResult {
  return {
    provider,
    model,
    status: r.status,
    http_status: r.http_status,
    latency_ms: round(r.latency_ms),
    ttft_ms: r.ttft_ms === undefined ? undefined : round(r.ttft_ms),
    ttft_method: r.ttft_method,
    ttft_first_byte_ms: r.ttft_first_byte_ms === undefined ? undefined : round(r.ttft_first_byte_ms),
    ttft_first_content_ms: r.ttft_first_content_ms === undefined ? undefined : round(r.ttft_first_content_ms),
    empty_output: r.empty_output,
    response_id: r.response_id,
    usage: r.usage,
    cost_usd: r.cost_usd,
    cost_source: r.cost_source,
    finish_reason: r.finish_reason,
    completion_text: r.completion_text,
    tool_calls: r.tool_calls,
    error_type: r.error_type,
    error: r.error,
    upstream: r.upstream,
    ...extra,
  };
}

export function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Rough token estimate (chars/4) over message text, used only for eligibility before usage is known. */
export function estimateInputTokens(body: any): number {
  let chars = 0;
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of msgs) {
    if (typeof m?.content === "string") chars += m.content.length;
    else if (Array.isArray(m?.content)) for (const p of m.content) if (typeof p?.text === "string") chars += p.text.length;
    if (Array.isArray(m?.tool_calls)) chars += JSON.stringify(m.tool_calls).length;
  }
  if (body?.tools) chars += JSON.stringify(body.tools).length;
  return Math.ceil(chars / 4);
}

export function hasImageContent(body: any): boolean {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of msgs) {
    if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        const t = p?.type;
        if (t === "image_url" || t === "input_image" || t === "input_audio" || t === "file") return true;
      }
    }
  }
  return false;
}
