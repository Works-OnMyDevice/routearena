import { poolSize, pushPoolKeys, stats } from "../lib/budget";
import { bearer, env, json, logEvent, secretEquals } from "../lib/env";
import { state } from "../lib/store";
import { disableKey } from "../lib/tokenrouterMgmt";
import { openPoolItem, openText } from "../lib/token";

function authed(req: Request): boolean {
  return secretEquals(bearer(req), env.adminSecret);
}

/** GET /api/admin/pool -> { available } */
export async function poolGet(req: Request): Promise<Response> {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  return json({ available: await poolSize() });
}

/**
 * POST /api/admin/pool { keys: [{ key, name, capped: true }] } -> { added, available }
 * Keys are created in the TokenRouter console, capped and verified by scripts/load-pool.mjs, then loaded once. Never logged.
 */
export async function poolPost(req: Request): Promise<Response> {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const body: any = await req.json().catch(() => null);
  const items = Array.isArray(body?.keys) ? body.keys.filter((k: any) => typeof k?.key === "string" && k.key.startsWith("sk-") && typeof k?.name === "string" && k.name && k.capped === true) : [];
  if (!items.length) return json({ error: "keys: [{ key, name, capped: true }] required. Cap and verify keys with scripts/load-pool.mjs before loading." }, 400);
  const available = await pushPoolKeys(items.map((k: any) => ({ key: k.key, name: k.name, capped: true })));
  logEvent("pool_loaded", { added: items.length, available });
  return json({ added: items.length, available });
}

/** GET /api/admin/stats -> counters (claims, verified, published, pool_available, pool_issued) plus the active config. */
export async function statsGet(req: Request): Promise<Response> {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  return json({ ...(await stats()), claims_enabled: env.claimsEnabled, max_issued_keys: env.maxIssuedKeys, per_claim_usd: env.perClaimUsd });
}

/**
 * GET /api/admin/emails?limit=500&offset=0[&format=csv] -> verified claimant emails.
 * Addresses are stored sealed (AES-GCM) and decrypted only here, behind the admin secret. Each export is logged.
 */
export async function emailsGet(req: Request): Promise<Response> {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const u = new URL(req.url);
  const limit = Math.min(5000, Math.max(1, Number(u.searchParams.get("limit") ?? 500) || 500));
  const offset = Math.max(0, Number(u.searchParams.get("offset") ?? 0) || 0);
  const rows = await state().listEmails(limit, offset);
  const out: Array<{ email: string; verified_at: string }> = [];
  for (const r of rows) {
    try {
      out.push({ email: await openText("email", r.sealed), verified_at: new Date(r.created * 1000).toISOString() });
    } catch {
      /* skip rows sealed under a rotated secret */
    }
  }
  logEvent("emails_exported", { n: out.length });
  if (u.searchParams.get("format") === "csv") {
    return new Response("email,verified_at\n" + out.map((r) => `${r.email},${r.verified_at}`).join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8" } });
  }
  return json({ total: await state().countEmails(), offset, emails: out });
}

/** GET /api/admin/log -> recent metadata events (no bodies ever). */
export async function logGet(req: Request): Promise<Response> {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  return json({ events: await state().recentLog(200) });
}

/** Scheduled daily: disable pooled TokenRouter keys whose claims passed expiry, and sweep expired rows. */
export async function expireSweep(): Promise<{ due: number; disabled: number }> {
  const now = Math.floor(Date.now() / 1000);
  const due = await state().dueExpiring(now);
  let disabled = 0;
  for (const sealed of due) {
    try {
      const item = await openPoolItem(sealed);
      await disableKey(item.key);
      disabled++;
    } catch (e) {
      logEvent("expire_failed", { err: String(e).slice(0, 120) });
    }
    await state().removeExpiring(sealed);
  }
  await state().sweep();
  logEvent("cron_expire", { due: due.length, disabled });
  return { due: due.length, disabled };
}
