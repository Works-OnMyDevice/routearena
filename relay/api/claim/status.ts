import { EXHAUSTED, getClaim } from "../../lib/budget";
import { json } from "../../lib/env";
import { state } from "../../lib/store";

/**
 * GET /api/claim/status?id=... -> { status, token?, expires_at?, budget_usd?, mode: "key" }
 * The key is handed out only during the 15 minutes after verification, while the CLI is polling.
 * A pending claim whose last verification attempt found no issuable key keeps `status: "pending"` (so the CLI keeps
 * polling and the same link can succeed later) and carries `error`/`fix` explaining why.
 */
export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[a-f0-9]{24}$/.test(id)) return json({ status: "unknown" }, 400);
  const c = await getClaim(id);
  if (!c) return json({ status: "unknown" }, 404);
  if (c.status === "pending") {
    if (Date.now() / 1000 - c.created > 3600) return json({ status: "expired" });
    const failed = await state().kvGet(`handout-failed:${id}`);
    if (failed === "exhausted") return json({ status: "pending", ...EXHAUSTED });
    if (failed === "unverified") return json({ status: "pending", error: "TokenRouter did not confirm the spending cap on your key.", fix: "Open the verification link again in a minute, or use --no-credits." });
    return json({ status: "pending" });
  }
  if (c.status === "verified") {
    const token = await state().kvGet(`handoff:${id}`);
    return json({ status: "verified", token: token ?? undefined, expires_at: c.expires ? new Date(c.expires * 1000).toISOString() : undefined, budget_usd: c.budget, mode: "key" });
  }
  return json({ status: c.status });
}
