import { claimIdForKey, getClaim } from "../../lib/budget";
import { bearer, json, logEvent } from "../../lib/env";
import { claimUsage, UsageRateLimited } from "../../lib/usage";

/**
 * GET /api/claim/usage with Bearer <the issued TokenRouter key>
 * -> { rows: [{ request_id, model, prompt_tokens, completion_tokens, cost_usd, created_at }], from, to, fetched_at, source: "tokenrouter_billing", partial? }
 * TokenRouter's own billed rows for this claim's key, read with the relay's management key so free-credit users see
 * real TokenRouter cost without holding any credential of their own. Authenticated exactly like /api/balance.
 * Cached 60s per claim; 429 when TokenRouter's management rate limit is hit.
 */
export async function GET(req: Request): Promise<Response> {
  const tok = bearer(req);
  if (!tok) return json({ error: "missing token" }, 401);
  const claimId = await claimIdForKey(tok);
  if (!claimId) return json({ error: "unknown token" }, 401);
  const c = await getClaim(claimId);
  if (!c || c.status !== "verified") return json({ error: "not verified" }, 401);
  if (!c.key_name) return json({ error: "no key name recorded for this claim" }, 404);
  try {
    return json(await claimUsage({ id: c.id, created: Number(c.created), key_name: c.key_name }));
  } catch (e) {
    if (e instanceof UsageRateLimited) return json({ error: "TokenRouter's management API is rate-limited right now.", fix: "Try again in a minute. Usage is cached for 60 seconds per claim, so repeated calls do not help." }, 429);
    logEvent("usage_failed", { id: c.id, err: String(e).slice(0, 160) });
    return json({ error: "Could not read TokenRouter usage for this key right now.", fix: "Try again in a minute. The key itself keeps working; only this report is unavailable." }, 502);
  }
}
