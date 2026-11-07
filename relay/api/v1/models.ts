import { env, json } from "../../lib/env";
import { state } from "../../lib/store";

/** GET /v1/models: TokenRouter's list via the master key, cached 10 minutes. Public information, no auth. */
export async function GET(): Promise<Response> {
  const cached = await state().kvGet("cache:models").catch(() => null);
  if (cached) return new Response(cached, { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=600", "x-cache": "hit" } });
  if (!env.masterKey) return json({ error: { message: "Relay has no TokenRouter key configured", type: "config" } }, 503);
  const r = await fetch(`${env.trBase}/v1/models`, { headers: { authorization: `Bearer ${env.masterKey}` }, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  if (r.ok) await state().kvSet("cache:models", text, 600).catch(() => undefined);
  return new Response(text, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "public, max-age=600", "x-cache": "miss" } });
}
