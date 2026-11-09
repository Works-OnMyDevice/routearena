import { EXHAUSTED, alertPoolLow, capReachedForNewClaim, createClaim, emailAlreadyClaimed, markEmailClaimed, poolSize } from "../lib/budget";
import { isDisposable } from "../lib/disposable";
import { clientIp, env, json, logEvent } from "../lib/env";
import { magicLinkEmail, sendMail } from "../lib/mail";
import { state } from "../lib/store";
import { randomId } from "../lib/token";

/** POST /api/claim { email } -> { status: "sent", id } */
export async function POST(req: Request): Promise<Response> {
  if (!env.claimsEnabled) return json({ error: "Free credits are paused.", fix: "Run init with --no-credits, or set TOKENROUTER_API_KEY with your own key." }, 503);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON { email }", fix: "Use the CLI: routearena init --free-credits --email you@example.com" }, 400);
  }
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "Invalid email.", fix: "Pass a real address with --email." }, 400);
  if (await capReachedForNewClaim()) {
    void alertPoolLow(await poolSize());
    return json(EXHAUSTED, 503);
  }
  const ip = clientIp(req);
  if (!(await state().rateLimit(`rl:claim:ip:${ip}`, 5, 86400))) return json({ error: "Too many claims from this network today.", fix: "Try again tomorrow, or use --no-credits." }, 429);
  if (await emailAlreadyClaimed(email)) return json({ error: "This email has already claimed credits.", fix: "Each email can claim once. Use --no-credits, or set TOKENROUTER_API_KEY with your own key." }, 429);
  if (await isDisposable(email)) return json({ error: "Disposable email addresses are not accepted.", fix: "Use a regular email address." }, 400);

  const id = randomId(12);
  const verifyTok = randomId(24);
  await createClaim(id, email);
  await state().kvSet(`verify:${verifyTok}`, id, 3600);
  const link = `${env.publicBase}/api/verify?t=${verifyTok}`;
  if (env.devExposeLinks) {
    await markEmailClaimed(email);
    return json({ status: "sent", id, dev_verify_url: link });
  }
  try {
    await sendMail(email, "Confirm your RouteArena mirror credits", magicLinkEmail(link, env.perClaimUsd, env.claimDays), `claim-link/${id}`);
  } catch (e) {
    logEvent("claim_mail_failed", { id, err: String(e).slice(0, 120) });
    return json({ error: "Could not send the verification email.", fix: "Try again in a minute, or use --no-credits." }, 502);
  }
  await markEmailClaimed(email);
  logEvent("claim_sent", { id });
  return json({ status: "sent", id });
}
