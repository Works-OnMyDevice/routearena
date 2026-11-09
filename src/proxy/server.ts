import http from "node:http";
import { PRIMARIES, type Config, type Credits } from "../config.js";
import { resolveTargets, type ResolvedTarget } from "../targets/index.js";
import { canonicalModel } from "../targets/mapping.js";
import { forwardChat } from "./forward.js";
import { Logger } from "./logger.js";
import { MirrorEngine } from "./mirror.js";

export interface ProxyOptions {
  config: Config;
  primaryKey: string;
  credits: Credits | null;
  cwd?: string;
  injectUsage?: boolean;
  /** Allow browser (cross-origin) clients. Off by default: an open localhost proxy would let any website spend your key. */
  cors?: boolean;
  /** Overrides for tests. */
  targets?: ResolvedTarget[];
  mirrorTimeoutMs?: number;
}

export interface RunningProxy {
  server: http.Server;
  port: number;
  engine: MirrorEngine;
  logger: Logger;
  targets: ResolvedTarget[];
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export async function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const cfg = opts.config;
  const primary = PRIMARIES[cfg.primary];
  const logger = new Logger(opts.cwd);
  const targets =
    opts.targets ??
    resolveTargets({ credits: opts.credits, only: cfg.targets, excludePrimary: cfg.primary });
  const engine = new MirrorEngine(
    {
      primary: cfg.primary,
      targets,
      sample: cfg.sample,
      hourlyCap: cfg.hourlyCap ?? 500,
      maxInputTokens: cfg.maxInputTokens ?? 32_000,
      mirrorImages: cfg.mirrorImages ?? false,
      timeoutMs: opts.mirrorTimeoutMs,
      modelMap: cfg.model_map,
    },
    logger,
  );
  const injectUsage = opts.injectUsage ?? true;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // Browser requests carry an Origin header. Refuse them unless --cors was given, so a web page you happen to
    // visit cannot drive this proxy (and your key) from JavaScript.
    if (req.headers.origin !== undefined) {
      if (!opts.cors) {
        sendJson(res, 403, { error: { message: "routearena: browser requests are refused by default. Start with --cors to allow them.", type: "forbidden_origin" } });
        return;
      }
      res.setHeader("access-control-allow-origin", String(req.headers.origin));
      res.setHeader("access-control-allow-headers", "*");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("vary", "origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(opts.cors ? 204 : 403);
      res.end();
      return;
    }
    try {
      if (path === "/health" || path === "/routearena/status") {
        sendJson(res, 200, {
          ok: true,
          primary: cfg.primary,
          sample: cfg.sample,
          targets: targets.map((t) => ({ id: t.target.id, status: t.status })),
          stats: engine.stats,
          pending_mirrors: engine.pending(),
          log: logger.path(),
        });
        return;
      }
      if (path === "/v1/models" && req.method === "GET") {
        const r = await fetch(`${primary.baseUrl}/models`, { headers: { authorization: `Bearer ${opts.primaryKey}` } });
        const text = await r.text();
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(text);
        return;
      }
      if (path === "/v1/chat/completions" && req.method === "POST") {
        const raw = await readBody(req);
        let body: Record<string, any>;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { error: { message: "routearena: request body is not valid JSON", type: "invalid_request_error" } });
          return;
        }
        const canonical = canonicalModel(cfg.primary, String(body.model ?? ""));
        const outcome = await forwardChat(cfg.primary, opts.primaryKey, body, req, res, { injectUsage });
        engine.handle(canonical, body, outcome.side, outcome.completed);
        return;
      }
      if (path === "/v1/responses" && req.method === "POST") {
        // Pass-through only (no mirroring in v1).
        const raw = await readBody(req);
        const r = await fetch(`${primary.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.primaryKey}` },
          body: raw,
        });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json", "x-routearena": "passthrough" });
        if (r.body) {
          const reader = r.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
        return;
      }
      sendJson(res, 404, {
        error: {
          message: `routearena: ${req.method} ${path} is not proxied. Supported: POST /v1/chat/completions, GET /v1/models, POST /v1/responses (pass-through), GET /health.`,
          type: "not_found",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { error: { message: `routearena: ${msg}`, type: "proxy_error" } });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;

  return {
    server,
    port,
    engine,
    logger,
    targets,
    async close() {
      await engine.drain(5_000);
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
