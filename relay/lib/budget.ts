import { env, logEvent } from "./env";
import { sendMail } from "./mail";
import { state } from "./store";
import { openPoolItem, sealPoolItem, sha256, type PoolItem, sealText } from "./token";
import { quotaApplied, setKeyQuota } from "./tokenrouterMgmt";
import type { ClaimRow } from "../src/state";

/**
 * Credit model: key mode only.
 *
 * A verified claimant receives a dedicated TokenRouter key that TokenRouter itself caps at PER_CLAIM_USD via the
 * Management API quota. Keys are capped when loaded into the pool (scripts/load-pool.mjs reads the cap back) and
 * re-capped at hand-out; a key is issued only after TokenRouter's own response confirms the cap. Mirrored requests
 * go straight to TokenRouter; this relay never forwards, meters, estimates or prices anything.
 *
 * When the pool is empty (or the issued-key ceiling is reached) new claims fail with a clear 503, and a claim that
 * was already created stays pending so the same magic link succeeds once keys are added.
 */
export type Claim = ClaimRow;

export const EXHAUSTED = {
  error: "Free credits are temporarily exhausted.",
  fix: "Use --no-credits, or set TOKENROUTER_API_KEY with your own key.",
} as const;

export async function createClaim(id: string, email: string): Promise<void> {
  await state().createClaim(id, await sha256(normalizeEmail(email)), env.perClaimUsd);
}

export async function getClaim(id: string): Promise<Claim | null> {
  const c = await state().getClaim(id);
  if (!c) return null;
  return { ...c, budget: Math.min(Number(c.budget), env.perClaimUsd) };
}

/** Normalize so aliases cannot multiply claims: lowercase, strip +tags, drop dots in gmail local parts. */
export function normalizeEmail(email: string): string {
  let [local, domain] = email.trim().toLowerCase().split("@");
  if (!domain) return email.trim().toLowerCase();
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export async function emailAlreadyClaimed(email: string): Promise<boolean> {
  return state().emailClaimed(await sha256(normalizeEmail(email)));
}
export async function markEmailClaimed(email: string): Promise<void> {
  await state().markEmailClaimed(await sha256(normalizeEmail(email)), await sealText("email", email.trim().toLowerCase()));
}
export async function markVerified(id: string, patch: { mode: "key"; key_name?: string; expires: number }): Promise<void> {
  await state().markVerified(id, patch);
}

// ---------- pool ----------
export async function popPoolKey(): Promise<PoolItem | null> {
  const sealed = await state().popPool();
  return sealed ? openPoolItem(sealed) : null;
}
export async function returnPoolKey(item: PoolItem): Promise<void> {
  await state().returnPool(await sealPoolItem(item));
}
export async function poolSize(): Promise<number> {
  return state().poolSize();
}
export async function poolIssued(): Promise<number> {
  return state().poolIssued();
}
export async function pushPoolKeys(items: PoolItem[]): Promise<number> {
  if (!items.length) return poolSize();
  return state().pushPool(await Promise.all(items.map(sealPoolItem)));
}
export async function linkKeyToClaim(key: string, claimId: string): Promise<void> {
  await state().linkKey(await sha256(key), claimId);
}
export async function claimIdForKey(key: string): Promise<string | null> {
  return state().claimIdForKey(await sha256(key));
}
export async function scheduleKeyExpiry(item: PoolItem, dueUnix: number): Promise<void> {
  await state().addExpiring(await sealPoolItem(item), dueUnix);
}

// ---------- capacity ----------
/** True when the pool is empty or the issued-key ceiling (MAX_ISSUED_KEYS) has been reached. No fallback exists. */
export async function capReachedForNewClaim(): Promise<boolean> {
  const [available, issued] = await Promise.all([poolSize(), poolIssued()]);
  return available <= 0 || issued >= env.maxIssuedKeys;
}

export type HandOut = { ok: true; key: string; name: string } | { ok: false; reason: "exhausted" | "unverified" };

/**
 * Hand one pooled key to a claim. The key is re-capped at PER_CLAIM_USD through the Management API and issued only
 * if TokenRouter's response confirms the cap; otherwise it goes back to the pool and nothing is issued.
 * The claim is left untouched by this function so the caller can retry later.
 */
export async function handOutPoolKey(claimId: string, expUnix: number): Promise<HandOut> {
  if (await capReachedForNewClaim()) {
    logEvent("pool_exhausted", { id: claimId });
    void alertPoolLow(await poolSize());
    return { ok: false, reason: "exhausted" };
  }
  const pooled = await popPoolKey();
  if (!pooled) {
    logEvent("pool_exhausted", { id: claimId });
    void alertPoolLow(0);
    return { ok: false, reason: "exhausted" };
  }
  let applied = false;
  try {
    applied = quotaApplied(await setKeyQuota(pooled.key, env.perClaimUsd), env.perClaimUsd);
    if (!applied) logEvent("quota_unverified", { id: claimId, key_name: pooled.name });
  } catch (e) {
    logEvent("quota_recap_failed", { id: claimId, key_name: pooled.name, err: String(e).slice(0, 160) });
  }
  if (!applied) {
    await returnPoolKey(pooled); // never hand out a key whose cap TokenRouter did not confirm
    return { ok: false, reason: "unverified" };
  }
  await linkKeyToClaim(pooled.key, claimId);
  await scheduleKeyExpiry({ ...pooled, capped: true }, expUnix);
  void alertPoolLow(await poolSize());
  return { ok: true, key: pooled.key, name: pooled.name };
}

// ---------- owner alert ----------
export const POOL_LOW_THRESHOLD = 3;

/** Email the owner once per day when fewer than POOL_LOW_THRESHOLD keys remain. Never throws. */
export async function alertPoolLow(available: number): Promise<boolean> {
  if (available >= POOL_LOW_THRESHOLD) return false;
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (!(await state().kvSetNx(`alert:pool-low:${day}`, "1", 86400))) return false;
    logEvent("alert_pool_low", { available });
    if (env.alertEmail) {
      await sendMail(
        env.alertEmail,
        `RouteArena relay: free-credit pool is ${available === 0 ? "empty" : "low"} (${available} left)`,
        `<p>${available} capped TokenRouter key${available === 1 ? "" : "s"} remain in the pool.</p><p>Create more keys in the TokenRouter console and run <code>node relay/scripts/load-pool.mjs</code>. Until then new claims fail with "${EXHAUSTED.error}". Set CLAIMS_ENABLED=false to pause claims entirely.</p>`,
        `pool-low/${day}`,
      ).catch((e) => logEvent("alert_mail_failed", { err: String(e).slice(0, 120) }));
    }
    return true;
  } catch (e) {
    logEvent("alert_failed", { err: String(e).slice(0, 120) });
    return false;
  }
}

export async function stats(): Promise<Record<string, number>> {
  return state().stats();
}
