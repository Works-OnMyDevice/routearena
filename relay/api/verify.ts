import { EXHAUSTED, getClaim, handOutPoolKey, markVerified } from "../lib/budget";
import { env, html, logEvent } from "../lib/env";
import { state } from "../lib/store";

function page(title: string, body: string, status = 200): Response {
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title>
<style>body{font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:10vh auto;padding:0 16px;color:#1a1a1a;background:#fbfbfa}@media(prefers-color-scheme:dark){body{color:#ececea;background:#121313}a{color:#8fb0ff}}h1{font-size:22px}p{margin:8px 0}.m{color:#888;font-size:13px}code{font-family:ui-monospace,Menlo,Consolas,monospace}</style></head><body><h1>${title}</h1>${body}<p class="m">RouteArena is an independent open-source tool. <a href="/">About this relay</a>.</p></body></html>`,
    status,
  );
}

/**
 * GET /api/verify?t=... : marks the claim verified and hands out a capped TokenRouter key. Idempotent.
 *
 * If no key can be issued (pool empty, ceiling reached, or TokenRouter did not confirm the cap) the claim is left
 * pending and the link stays valid for its remaining lifetime, so clicking it again after keys are loaded succeeds.
 */
export async function GET(req: Request): Promise<Response> {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[a-f0-9]{48}$/.test(t)) return page("Invalid link", "<p>This verification link is malformed.</p>", 400);
  const id = await state().kvGet(`verify:${t}`);
  if (!id) return page("Link expired", "<p>This link has expired or was already used. Run <code>routearena init --free-credits --email …</code> again for a new one.</p>", 410);
  const claim = await getClaim(id);
  if (!claim) return page("Unknown claim", "<p>We could not find this claim.</p>", 404);
  if (claim.status === "verified") return page("Already verified", "<p>Your credits are active. Return to your terminal; the CLI has picked them up.</p>");
  if (!env.claimsEnabled) return page("Paused", "<p>Free credits are paused right now. Run <code>routearena init --no-credits</code> instead.</p>", 503);
  if (!env.managementKey) return page("Not configured", "<p>This relay cannot issue credits right now. Run <code>routearena init --no-credits</code>.</p>", 503);

  const expUnix = Math.floor(Date.now() / 1000) + env.claimDays * 86400;
  const out = await handOutPoolKey(id, expUnix);
  if (!out.ok) {
    await state().kvSet(`handout-failed:${id}`, out.reason, 3600);
    await state().log("claim_handout_failed", { id, reason: out.reason });
    if (out.reason === "exhausted") {
      return page("Credits exhausted", `<p>${EXHAUSTED.error}</p><p>${EXHAUSTED.fix.replace("--no-credits", "<code>routearena init --no-credits</code>").replace("TOKENROUTER_API_KEY", "<code>TOKENROUTER_API_KEY</code>")}</p><p class="m">This link stays valid for a while; if credits are added again soon, opening it once more will activate them.</p>`, 503);
    }
    return page("Try again in a minute", "<p>TokenRouter did not confirm the spending cap on your key, so no key was issued.</p><p>Open this link again in a minute. If it keeps failing, run <code>routearena init --no-credits</code> or use your own TokenRouter key.</p>", 503);
  }

  await markVerified(id, { mode: "key", key_name: out.name, expires: expUnix });
  await state().kvSet(`handoff:${id}`, out.key, 15 * 60);
  await state().kvDel(`verify:${t}`);
  await state().kvDel(`handout-failed:${id}`);
  await state().log("claim_verified", { id, mode: "key", key_name: out.name });
  logEvent("claim_verified", { id, mode: "key" });
  return page(
    "Verified",
    `<p>Your $${env.perClaimUsd.toFixed(2)} of TokenRouter mirror credits are active for ${env.claimDays} days.</p><p><strong>Return to your terminal.</strong> The <code>routearena init</code> command that is waiting will pick the credits up within a few seconds.</p><p class="m">You received a dedicated TokenRouter key that TokenRouter itself caps at the budget. Your mirrored requests go straight to TokenRouter; this relay never sees them.</p>`,
  );
}
