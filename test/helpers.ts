import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MockReply {
  text?: string;
  /** `null` sends no usage at all (stream: no usage on the final chunk; JSON: no usage field). */
  usage?: any;
  status?: number;
  delayMs?: number;
  toolCalls?: Array<{ name: string; arguments: string }>;
  /** Completion id to put on every chunk / the JSON body. Default "chatcmpl-mock". */
  id?: string;
  /** Streaming only: write an SSE comment line (": OPENROUTER PROCESSING") first, like OpenRouter does. */
  comment?: boolean;
  /** Streaming only: emit a `delta.reasoning` chunk (no content) before the first content chunk. */
  reasoning?: string;
  /** Streaming only: ms to wait between the comment/reasoning preamble and the first content chunk. */
  gapMs?: number;
  /** Override finish_reason on the final chunk / JSON choice. */
  finishReason?: string;
  /** Streaming only: emit an OpenRouter-style in-stream error chunk (HTTP status stays 200) instead of content. */
  errorChunk?: { code?: number | string; message: string };
}

export interface MockUpstreamOptions {
  /** Called with each parsed request body and headers; return text to reply with. */
  reply?: (body: any, headers: http.IncomingHttpHeaders) => MockReply;
  /** Record requests for assertions. */
  seen: Array<{ body: any; headers: http.IncomingHttpHeaders; path: string }>;
}

/** Minimal OpenAI-compatible mock. Supports stream and non-stream chat completions. */
export async function startMockUpstream(opts: Partial<MockUpstreamOptions> = {}): Promise<{ url: string; close: () => Promise<void>; seen: MockUpstreamOptions["seen"] }> {
  const seen: MockUpstreamOptions["seen"] = opts.seen ?? [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* ignore */
    }
    seen.push({ body, headers: req.headers, path: req.url ?? "" });
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model" }] }));
      return;
    }
    const r = opts.reply?.(body, req.headers) ?? {};
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    if (r.status && r.status >= 400) {
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock error ${r.status}`, type: "mock" } }));
      return;
    }
    const text = r.text ?? `echo: ${body?.messages?.[body.messages.length - 1]?.content ?? ""}`;
    const usage = r.usage === null ? undefined : r.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const id = r.id ?? "chatcmpl-mock";
    const finish = r.finishReason ?? (r.toolCalls ? "tool_calls" : "stop");
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-mock": "stream" });
      const send = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const pause = (ms: number) => new Promise((x) => setTimeout(x, ms));
      if (r.comment) {
        res.write(": OPENROUTER PROCESSING\n\n");
        await pause(5);
      }
      if (r.reasoning !== undefined) {
        send({ id, object: "chat.completion.chunk", model: body.model, provider: "mock-host", choices: [{ index: 0, delta: { role: "assistant", content: null, reasoning: r.reasoning }, finish_reason: null }] });
        await pause(5);
      }
      if (r.gapMs) await pause(r.gapMs);
      if (r.errorChunk) {
        send({ id, object: "chat.completion.chunk", model: body.model, provider: "mock-host", error: r.errorChunk, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const words = text.length ? text.split(" ") : [];
      for (let i = 0; i < words.length; i++) {
        send({ id, object: "chat.completion.chunk", model: body.model, provider: "mock-host", choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: words[i] } : { content: " " + words[i] }, finish_reason: null }] });
        await pause(2);
      }
      if (r.toolCalls) {
        r.toolCalls.forEach((tc, i) => send({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name: tc.name, arguments: tc.arguments } }] }, finish_reason: null }] }));
      }
      send({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(usage ? { usage } : {}) });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-mock": "json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        model: body.model,
        provider: "mock-host",
        choices: [{ index: 0, message: { role: "assistant", content: r.toolCalls ? null : text, tool_calls: r.toolCalls?.map((tc, i) => ({ id: `call_${i}`, type: "function", function: tc })) }, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

export function tmpCwd(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "routearena-test-"));
  return d;
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
