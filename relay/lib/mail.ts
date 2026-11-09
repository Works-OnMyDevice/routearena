import { env, logEvent } from "./env";

const RETRY_DELAYS_MS = (typeof process !== "undefined" && process.env?.NODE_TEST_CONTEXT) ? [1, 1, 1] : [500, 1500, 4000];

/**
 * Send via Resend's REST API. Throws on failure so callers can surface it.
 * `idempotencyKey` makes retries safe: Resend returns the original result instead of sending twice (24 h window).
 * Network errors, 429 and 5xx are retried with backoff (honouring retry-after); other 4xx fail immediately.
 */
export async function sendMail(to: string, subject: string, htmlBody: string, idempotencyKey?: string): Promise<string | undefined> {
  if (!env.resendKey) throw new Error("RESEND_API_KEY not set");
  const headers: Record<string, string> = { authorization: `Bearer ${env.resendKey}`, "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey.slice(0, 256);
  const body = JSON.stringify({ from: env.mailFrom, to: [to], subject, html: htmlBody });
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch("https://api.resend.com/emails", { method: "POST", headers, body });
    } catch (e) {
      lastErr = e;
    }
    if (res) {
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { id?: string };
        logEvent("mail_sent", { id: data.id, attempt });
        return data.id;
      }
      const t = await res.text().catch(() => "");
      logEvent("mail_error", { status: res.status, attempt, body: t.slice(0, 200) });
      lastErr = new Error(`resend ${res.status}`);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) throw lastErr;
      if (attempt < RETRY_DELAYS_MS.length) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : RETRY_DELAYS_MS[attempt]);
        continue;
      }
    } else if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function magicLinkEmail(link: string, budget: number, days: number): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:520px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 12px">Confirm your RouteArena mirror credits</h2>
<p>Click the link below to activate $${budget.toFixed(2)} of TokenRouter credits for RouteArena mirror requests. They expire in ${days} days.</p>
<p><a href="${link}" style="display:inline-block;background:#2a4d9b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">Activate credits</a></p>
<p style="color:#6b6b6b;font-size:13px">If the button does not work, open this URL:<br>${link}</p>
<p style="color:#6b6b6b;font-size:13px">You asked for this from the <code>routearena init --free-credits</code> command. If you did not, ignore this email. The link expires in one hour.</p>
<p style="color:#6b6b6b;font-size:12px">RouteArena is an independent open-source tool (github.com/Works-OnMyDevice/routearena). It compares LLM providers; TokenRouter is one of six targets. You receive a dedicated TokenRouter key capped at the budget; your requests go straight to TokenRouter and the relay never sees them.</p>
</body></html>`;
}
