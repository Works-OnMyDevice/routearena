import type { IncomingMessage, ServerResponse } from "node:http";
import { PRIMARIES, type PrimaryId } from "../config.js";
import { getTarget } from "../targets/index.js";
import { canonicalModel, computeCost, mapModel } from "../targets/mapping.js";
import type { SideResult } from "./logger.js";
import { SseParser, StreamAccumulator, classifyError, classifyInBodyError, extractFromJson, inBodyErrorMessage, isEmptyOutput, round } from "./openaiCall.js";

/** Default upstream timeout for the primary. Mirrors use the same value unless configured, so timeouts are like-for-like. */
export const DEFAULT_TIMEOUT_MS = 600_000;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "host",
  "authorization",
  "cookie",
  "x-api-key",
  "api-key",
]);

export interface ForwardOutcome {
  side: SideResult;
  /** True if the client got a complete response (so a mirror makes sense). */
  completed: boolean;
}

/**
 * Forward a chat completion to the primary and relay the response to the client byte-for-byte.
 * The client's Authorization header is dropped; the primary key from env is used instead.
 *
 * The only change we make to the outgoing request body: on streamed requests, `stream_options.include_usage = true`
 * so the final chunk carries usage (OpenAI needs this; OpenRouter always includes usage and cost). Additive and
 * handled by the official SDKs. Disable with `--no-inject-usage` if a client chokes on the trailing usage chunk.
 */
export async function forwardChat(
  primary: PrimaryId,
  key: string,
  body: Record<string, any>,
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  opts: { injectUsage: boolean; timeoutMs?: number } = { injectUsage: true },
): Promise<ForwardOutcome> {
  const p = PRIMARIES[primary];
  const stream = body.stream === true;
  const model = String(body.model ?? "");
  const canonical = canonicalModel(primary, model);
  const outBody = { ...body };
  if (opts.injectUsage && stream) {
    outBody.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(clientReq.headers)) {
    if (!v || HOP_BY_HOP.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["authorization"] = `Bearer ${key}`;
  headers["content-type"] = "application/json";
  if (primary === "openrouter") {
    headers["http-referer"] ??= "https://github.com/Works-OnMyDevice/routearena";
    headers["x-title"] ??= "RouteArena";
  }

  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  clientReq.on("close", () => {
    /* if the client goes away mid-stream, stop reading upstream */
    if (!clientRes.writableEnded) ctrl.abort();
  });

  let upstream: Response;
  try {
    upstream = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(outBody),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: { message: `routearena: could not reach ${p.name}: ${msg}`, type: "upstream_unreachable" } }));
    }
    return {
      completed: false,
      side: {
        provider: primary,
        model,
        status: "error",
        latency_ms: round(performance.now() - t0),
        error_type: classifyError(undefined, err),
        error: msg,
        stream,
        cost_source: "unknown",
      },
    };
  }

  // Relay status + headers
  const resHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k)) resHeaders[k] = v;
  });
  resHeaders["x-routearena"] = "primary";
  clientRes.writeHead(upstream.status, resHeaders);

  const side: SideResult = {
    provider: primary,
    model,
    status: upstream.ok ? "ok" : "error",
    http_status: upstream.status,
    stream,
    cost_source: "unknown",
  };

  if (!upstream.body) {
    clientRes.end();
    clearTimeout(timer);
    side.latency_ms = round(performance.now() - t0);
    return { side, completed: upstream.ok };
  }

  const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  const parser = new SseParser();
  const acc = new StreamAccumulator();
  const rawChunks: Uint8Array[] = [];
  let firstByte: number | undefined;
  let firstContent: number | undefined;
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstByte === undefined) firstByte = performance.now() - t0;
      bytes += value.byteLength;
      // write-through
      if (!clientRes.write(value)) await new Promise<void>((r) => clientRes.once("drain", () => r()));
      if (isSse) {
        for (const c of parser.feed(dec.decode(value, { stream: true }))) {
          acc.push(c);
          if (firstContent === undefined && acc.sawContent) firstContent = performance.now() - t0;
        }
      } else if (bytes <= 8 * 1024 * 1024) {
        rawChunks.push(value);
      }
    }
    clientRes.end();
  } catch (err) {
    side.status = "error";
    side.error_type = classifyError(upstream.status, err);
    side.error = err instanceof Error ? err.message : String(err);
    try {
      clientRes.end();
    } catch {
      /* ignore */
    }
  } finally {
    clearTimeout(timer);
  }

  side.latency_ms = round(performance.now() - t0);
  // Same two TTFT measures as the mirror side (openaiCall.ts): first byte of any kind, and first content chunk.
  if (isSse && stream) {
    side.ttft_first_byte_ms = firstByte === undefined ? undefined : round(firstByte);
    side.ttft_first_content_ms = firstContent === undefined ? undefined : round(firstContent);
  }
  if (isSse && stream && firstContent !== undefined) {
    side.ttft_ms = round(firstContent);
    side.ttft_method = "first-content-chunk";
  } else {
    side.ttft_method = "n/a";
  }

  if (isSse) {
    side.usage = acc.usage;
    side.upstream = acc.upstream;
    side.finish_reason = acc.finish_reason;
    side.completion_text = acc.text || null;
    side.tool_calls = acc.toolCalls();
    if (acc.id) side.response_id = acc.id;
    const empty = isEmptyOutput(side.completion_text, side.tool_calls);
    if (side.status === "ok" && acc.error && empty) {
      // OpenRouter streaming: a 200 whose stream carries an error chunk and no content is a failed request.
      side.status = "error";
      side.error_type = classifyInBodyError(acc.error);
      side.error = inBodyErrorMessage(acc.error);
    } else if (side.status === "ok" && empty) {
      side.empty_output = true;
    }
  } else if (upstream.ok) {
    try {
      const text = Buffer.concat(rawChunks.map((c) => Buffer.from(c))).toString("utf8");
      const json = JSON.parse(text);
      Object.assign(side, extractFromJson(json));
      const empty = isEmptyOutput(side.completion_text, side.tool_calls);
      if (json && typeof json === "object" && json.error && typeof json.error === "object" && empty) {
        side.status = "error";
        side.error_type = classifyInBodyError(json.error);
        side.error = inBodyErrorMessage(json.error);
      } else if (side.status === "ok" && empty) {
        side.empty_output = true;
      }
    } catch {
      /* non-JSON success body; leave empty */
    }
  } else {
    try {
      const text = Buffer.concat(rawChunks.map((c) => Buffer.from(c))).toString("utf8");
      const j = JSON.parse(text);
      side.error = String(j?.error?.message ?? j?.error ?? text).slice(0, 300);
      side.error_type = classifyError(upstream.status, undefined, text);
    } catch {
      side.error_type = classifyError(upstream.status);
    }
  }

  // Cost
  if (side.usage) {
    if (primary === "openrouter" && typeof side.usage.cost === "number") {
      side.cost_usd = side.usage.cost;
      side.cost_source = "measured";
    } else {
      const table = getTarget(primary === "openai" ? "openai" : "openrouter");
      const m = table ? mapModel(table, canonical) : null;
      if (m) {
        side.cost_usd = computeCost(m.entry, side.usage);
        side.cost_source = "computed";
      }
    }
  }
  // No usage (or no price entry) means unpriced, never free: keep cost_usd null so the report treats it as unknown.
  if (side.cost_source === "unknown" && side.status === "ok") side.cost_usd = null;
  return { side, completed: side.status === "ok" };
}

export { canonicalModel };
