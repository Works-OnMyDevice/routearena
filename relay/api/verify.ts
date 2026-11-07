import { capReachedForNewClaim, getClaim, linkKeyToClaim, markVerified, popPoolKey, returnPoolKey, scheduleKeyExpiry } from "../lib/budget";
import { env, html, logEvent } from "../lib/env";
import { state } from "../lib/store";
import { signToken } from "../lib/token";
import { setKeyQuota } from "../lib/tokenrouterMgmt";

function page(title: string, body: string, status = 200): Response {
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title>
<style>body{font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:10vh auto;padding:0 16px;color:#1a1a1a;background:#fbfbfa}@media(prefers-color-scheme:dark){body{color:#ececea;background:#121313}a{color:#8fb0ff}}h1{font-size:22px}p{margin:8px 0}.m{color:#888;font-size:13px}code{font-family:ui-monospace,Menlo,Consolas,monospace}</style></head><body><h1>${title}</h1>${body}<p class="m">RouteArena is an independent open-source tool. <a href="/">About this relay</a>.</p></body></html>`,
    status,
  );
}

/** GET /api/verify?t=... : marks the claim verified and provisions credits. Idempotent. */
export async function GET(req: Request): Promise<Response> {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[a-f0-9]{48}$/.test(t)) return page("Invalid link", "<p>This verification link is malformed.</p>", 400);
  const id = await state().kvGet(`verify:${t}`);
  if (!id) return page("Link expired", "<p>This link has expired or was already used. Run <code>routearena init --free-credits --email …</code> again for a new one.</p>", 410);
  const claim = await getClaim(id);
  if (!claim) return page("Unknown claim", "<p>We could not find this claim.</p>", 404);
  if (claim.status === "verified") return page("Already verified", "<p>Your credits are active. Return to your terminal; the CLI has picked them up.</p>");
  if (!env.claimsEnabled) return page("Paused", "<p>Free credits are paused right now. Run <code>routearena init --no-credits</code> instead.</p>", 503);
  if (await capReachedForNewClaim()) return page("Pool exhausted", "<p>The free-credit pool is fully allocated. Run <code>routearena init --no-credits</code> or use your own TokenRouter key.</p>", 503);
  if (!env.managementKey && !env.masterKey) return page("Not configured", "<p>This relay has no credit mode configured. Run <code>routearena init --no-credits</code>.</p>", 503);

  const expUnix = Math.floor(Date.now() / 1000) + env.claimDays * 86400;
  let token: string;
  let mode: "key" | "relay" = "relay";
  let keyName: string | undefined;

  // Preferred: hand out a console-created TokenRouter key capped via the Management API (prompts never touch the relay).
  if (env.managementKey) {
    const pooled = await popPoolKey();
    if (pooled) {
      // Keys are capped and verified when loaded (scripts/load-pool.mjs). Re-cap here as defense in depth;
      // if the Management API is rate-limited right now, a pre-capped key is still safe to hand out.
      let capped = pooled.capped === true;
      try {
        await setKeyQuota(pooled.key, env.perClaimUsd);
        capped = true;
      } catch (e) {
        logEvent("quota_recap_failed", { id, precapped: pooled.capped, err: String(e).slice(0, 160) });
      }
      if (capped) {
        token = pooled.key;
        mode = "key";
        keyName = pooled.name;
        await linkKeyToClaim(pooled.key, id);
        await scheduleKeyExpiry({ ...pooled, capped: true }, expUnix);
      } else {
        await returnPoolKey(pooled); // never hand out an uncapped key
        token = await signToken(id, expUnix);
      }
    } else {
      logEvent("pool_empty", { id });
      token = await signToken(id, expUnix);
    }
  } else {
    token = await signToken(id, expUnix);
  }
  if (mode === "relay" && !env.masterKey) {
    return page("Pool exhausted", "<p>No free-credit keys are available right now. Run <code>routearena init --no-credits</code> or use your own TokenRouter key.</p>", 503);
  }

  await markVerified(id, { mode, key_name: keyName, expires: expUnix });
  await state().kvSet(`handoff:${id}`, token, 15 * 60);
  await state().kvDel(`verify:${t}`);
  await state().log("claim_verified", { id, mode });
  logEvent("claim_verified", { id, mode });
  return page(
    "Verified",
    `<p>Your $${env.perClaimUsd.toFixed(2)} of TokenRouter mirror credits are active for ${env.claimDays} days.</p><p><strong>Return to your terminal.</strong> The <code>routearena init</code> command that is waiting will pick the credits up within a few seconds.</p>${mode === "key" ? '<p class="m">Mode: a dedicated TokenRouter key capped at the budget. Your mirrored requests go straight to TokenRouter; this relay never sees them.</p>' : '<p class="m">Mode: metered relay. Mirrored requests pass through this relay to TokenRouter; bodies are forwarded, never stored or logged.</p>'}`,
  );
}
