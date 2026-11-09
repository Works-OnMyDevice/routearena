import { env, html } from "../lib/env";

/** GET / : what this relay is and what it logs. */
export async function GET(): Promise<Response> {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>RouteArena relay</title>
<style>body{font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:8vh auto;padding:0 16px;color:#1a1a1a;background:#fbfbfa}@media(prefers-color-scheme:dark){body{color:#ececea;background:#121313}a{color:#8fb0ff}}h1{font-size:22px}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}li{margin:4px 0}.m{color:#888;font-size:13px}</style></head><body>
<h1>RouteArena relay</h1>
<p>This is the hosted half of <a href="https://github.com/Works-OnMyDevice/routearena">RouteArena</a>, a CLI that shows what your LLM traffic would cost on other providers. The CLI runs on your machine; this service does two small things:</p>
<ul>
<li><strong>Free TokenRouter mirror credits.</strong> <code>POST /api/claim</code> emails a magic link; <code>GET /api/verify</code> activates $${env.perClaimUsd.toFixed(2)} for ${env.claimDays} days by handing you a dedicated TokenRouter key that TokenRouter itself caps at that amount. Your mirrored requests go straight to TokenRouter and never pass through here; this relay forwards nothing and keeps no price table.</li>
<li><strong>Published reports.</strong> <code>POST /api/publish</code> stores report aggregates (numbers only; anything that looks like a prompt or completion is rejected) and <code>GET /r/:id</code> renders them.</li>
</ul>
<p><strong>What is logged:</strong> claim id, pool key name, status, timestamps. <strong>Never:</strong> prompts, completions, request bodies, or your other providers' keys; your mirrored requests do not come here at all. Source for every endpoint is in the <a href="https://github.com/Works-OnMyDevice/routearena/tree/main/relay">relay/</a> folder.</p>
<p class="m">Independent project, not affiliated with TokenRouter, OpenRouter, or any provider. TokenRouter is one of six comparison targets; credits are offered because TokenRouter is the only target that has them for this purpose. <a href="/llms.txt">llms.txt</a></p>
</body></html>`);
}
