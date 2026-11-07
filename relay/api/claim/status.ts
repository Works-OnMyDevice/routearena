import { getClaim } from "../../lib/budget";
import { json } from "../../lib/env";
import { state } from "../../lib/store";

/**
 * GET /api/claim/status?id=... -> { status, token?, expires_at?, budget_usd?, mode? }
 * The token is handed out only during the 15 minutes after verification, while the CLI is polling.
 */
export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[a-f0-9]{24}$/.test(id)) return json({ status: "unknown" }, 400);
  const c = await getClaim(id);
  if (!c) return json({ status: "unknown" }, 404);
  if (c.status === "pending") {
    if (Date.now() / 1000 - c.created > 3600) return json({ status: "expired" });
    return json({ status: "pending" });
  }
  if (c.status === "verified") {
    const token = await state().kvGet(`handoff:${id}`);
    return json({ status: "verified", token: token ?? undefined, expires_at: c.expires ? new Date(c.expires * 1000).toISOString() : undefined, budget_usd: c.budget, mode: c.mode ?? undefined });
  }
  return json({ status: c.status });
}
