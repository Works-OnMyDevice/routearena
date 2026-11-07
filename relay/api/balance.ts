import { claimIdForKey, getClaim } from "../lib/budget";
import { bearer, env, json } from "../lib/env";
import { state } from "../lib/store";
import { verifyToken } from "../lib/token";
import { listKeys } from "../lib/tokenrouterMgmt";

/**
 * GET /api/balance with Bearer <ra_ token | pooled TokenRouter key>
 * -> { remaining_usd, spent_usd, budget_usd, expires_at, requests, mode }
 */
export async function GET(req: Request): Promise<Response> {
  const tok = bearer(req);
  if (!tok) return json({ error: "missing token" }, 401);
  let claimId: string | null = null;
  if (tok.startsWith("ra_")) claimId = (await verifyToken(tok))?.claimId ?? null;
  else claimId = await claimIdForKey(tok);
  if (!claimId) return json({ error: "unknown token" }, 401);
  const c = await getClaim(claimId);
  if (!c || c.status !== "verified") return json({ error: "not verified" }, 401);
  const expires_at = c.expires ? new Date(c.expires * 1000).toISOString() : null;

  if (c.mode === "key" && c.key_name) {
    // Pooled key: ask TokenRouter's Management API (masked listing) and match by key name. Cached 60s.
    let keys: any[] | null = null;
    const cached = await state().kvGet("cache:mgmt:keys").catch(() => null);
    if (cached) keys = JSON.parse(cached);
    else {
      try {
        keys = await listKeys();
        await state().kvSet("cache:mgmt:keys", JSON.stringify(keys), 60);
      } catch {
        keys = null;
      }
    }
    const k = keys?.find((x) => x.name === c.key_name);
    if (k) return json({ mode: "key", budget_usd: c.budget, spent_usd: Number(k.used_quota ?? 0), remaining_usd: Number(k.remain_quota ?? 0), requests: c.requests, expires_at, key_status: k.status === 1 ? "enabled" : "disabled" });
    return json({ mode: "key", budget_usd: c.budget, spent_usd: null, remaining_usd: null, requests: c.requests, expires_at, note: "balance unavailable right now (management API rate limit); the key itself is capped at the budget" });
  }
  return json({ mode: "relay", budget_usd: c.budget, spent_usd: c.spent, remaining_usd: Math.max(0, c.budget - c.spent - c.reserved), reserved_usd: c.reserved, requests: c.requests, expires_at, relay_enabled: env.relayEnabled });
}
