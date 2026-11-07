import { blockedReason, getClaim, reserve, settleWith } from "../../../lib/budget";
import { bearer, env, json, logEvent } from "../../../lib/env";
import { constrainBody, estimateRequest } from "../../../lib/estimate";
import { costFor, type Usage } from "../../../lib/prices";
import { state, waitUntil } from "../../../lib/store";
import { verifyToken } from "../../../lib/token";

const FIX: Record<string, string> = {
  relay_disabled: "The relay is paused. Use your own TOKENROUTER_API_KEY or another target.",
  not_verified: "Click the link in your email, then retry.",
  expired: "Your free credits expired. Use your own TOKENROUTER_API_KEY.",
  budget_exhausted: "Your free credits are used up. Use your own TOKENROUTER_API_KEY.",
  global_cap: "The free-credit pool is exhausted for everyone. Use your own TOKENROUTER_API_KEY.",
  rate_limited: "Too many requests per minute on free credits. Lower --sample or wait a minute.",
  unknown_model: "This model is not in the relay's price table, so it cannot be metered. Use your own TOKENROUTER_API_KEY for it.",
};
const MAX_BODY = 300_000; // ~75K tokens of JSON; mirrors are capped at 32K input tokens by the CLI anyway

function refuse(reason: string, status: number): Response {
  return json({ error: { message: `routearena relay: ${reason}`, type: reason, fix: FIX[reason] } }, status);
}

/**
 * POST /v1/chat/completions (relay mode only).
 * Order: auth -> kill switch/expiry -> per-claim rate limit -> parse -> price-table check -> atomic reservation ->
 * forward with the master key -> settle against real usage (or the full estimate). Bodies are never logged or stored.
 */
export async function POST(req: Request): Promise<Response> {
  const st = state(); // captured once: stream callbacks and timers run outside this request's async context
  const tok = bearer(req);
  if (!tok) return json({ error: { message: "Missing Authorization: Bearer <routearena token>", type: "auth" } }, 401);
  if (!tok.startsWith("ra_")) return json({ error: { message: "This endpoint is for RouteArena relay tokens. TokenRouter keys go to https://api.tokenrouter.com/v1 directly.", type: "auth" } }, 400);
  const v = await verifyToken(tok);
  if (!v) return json({ error: { message: "Invalid or expired token", type: "auth" } }, 401);
  const claim = await getClaim(v.claimId);
  if (!claim) return json({ error: { message: "Unknown claim", type: "auth" } }, 401);
  const blocked = blockedReason(claim);
  if (blocked) return refuse(blocked, blocked === "relay_disabled" ? 503 : 402);
  if (!env.masterKey) return json({ error: { message: "Relay has no TokenRouter master key configured", type: "config" } }, 503);
  if (!(await st.rateLimit(`rl:relay:${v.claimId}`, env.relayRpm, 60))) return refuse("rate_limited", 429);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: { message: `Body too large for the relay (${MAX_BODY} bytes)`, type: "invalid_request_error" } }, 413);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: { message: "Body is not JSON", type: "invalid_request_error" } }, 400);
  }
  const model = String(body.model ?? "");
  const est = estimateRequest(model, body);
  if (!est) return refuse("unknown_model", 400);
  body = constrainBody(body, est);
  const stream = body.stream === true;
  if (stream) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };

  const reservation = await reserve(v.claimId, est.usd);
  if (reservation.status === "budget") return refuse("budget_exhausted", 402);
  if (reservation.status === "global") return refuse("global_cap", 402);
  const resId = reservation.id!;

  const t0 = Date.now();
  let settled = false;
  let resolveSettled: () => void = () => undefined;
  const settledPromise = new Promise<void>((r) => (resolveSettled = r));
  const finish = async (usage: Usage | null, status: number, extra: Record<string, unknown> = {}) => {
    if (settled) return;
    settled = true;
    try {
      // No usage => charge the full estimate. Never charge less than what we can prove.
      const actual = usage ? Math.min(Math.max(costFor(model, usage).usd, 0), est.usd) : est.usd;
      await settleWith(st, resId, actual);
      const fields = { claim: v.claimId, model, status, latency_ms: Date.now() - t0, prompt_tokens: usage?.prompt_tokens, completion_tokens: usage?.completion_tokens, estimate: est.usd, cost: actual, ...extra };
      logEvent("relay_request", fields);
      await st.log("relay_request", fields).catch(() => undefined);
    } finally {
      resolveSettled();
    }
  };
  // Safety net: if the stream is abandoned and neither flush nor cancel ever runs, charge the full estimate.
  waitUntil(Promise.race([settledPromise, new Promise<void>((r) => setTimeout(r, env.settleTimeoutMs)).then(() => finish(null, 0, { timeout: true }))]));

  let upstream: Response;
  try {
    upstream = await fetch(`${env.trBase}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.masterKey}`, "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    await finish(null, 0, { error: String(e).slice(0, 80) });
    return json({ error: { message: "routearena relay: upstream unreachable", type: "upstream_unreachable" } }, 502);
  }

  const headers = new Headers();
  upstream.headers.forEach((val, k) => {
    if (!["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie", "openai-organization", "openai-project"].includes(k)) headers.set(k, val);
  });
  headers.set("x-routearena-relay", "forwarded");

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    // Failed upstream calls are not billed by TokenRouter; release the reservation without charge.
    await finish({ prompt_tokens: 0, completion_tokens: 0 }, upstream.status);
    return new Response(text, { status: upstream.status, headers });
  }

  const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!isSse) {
    const text = await upstream.text();
    let usage: Usage | null = null;
    try {
      usage = JSON.parse(text)?.usage ?? null;
    } catch {
      /* charge estimate */
    }
    await finish(usage, 200);
    return new Response(text, { status: 200, headers });
  }

  // Streaming: pump upstream bytes to the client, parse SSE for the final usage chunk, settle at the end.
  // A client cancel mid-stream charges the full estimate, since TokenRouter may still bill the generation.
  let buf = "";
  let usage: Usage | null = null;
  const dec = new TextDecoder();
  const reader = upstream.body.getReader();
  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        await finish(usage, 200, { stream: true });
        controller.close();
        return;
      }
      controller.enqueue(value);
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try {
          const j = JSON.parse(d);
          if (j?.usage) usage = j.usage;
        } catch {
          /* partial */
        }
      }
    },
    async cancel(reason) {
      await reader.cancel().catch(() => undefined);
      await finish(null, 200, { stream: true, cancelled: true, reason: String(reason).slice(0, 60) });
    },
  });
  return new Response(out, { status: 200, headers });
}
