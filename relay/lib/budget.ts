import { env, logEvent } from "./env";
import { sendMail } from "./mail";
import { state } from "./store";
import { openPoolItem, sealPoolItem, sha256, type PoolItem, sealText } from "./token";
import type { ClaimRow } from "../src/state";

/**
 * Budget model. Two enforcement layers, each sufficient on its own:
 *
 * Key mode (preferred): the user gets a TokenRouter key that TokenRouter itself caps at PER_CLAIM_USD via the
 * Management API quota. Keys are capped when loaded into the pool (scripts/load-pool.mjs verifies the cap by
 * reading it back) and re-capped at hand-out. Nothing the relay does can raise that cap.
 *
 * Relay mode (fallback): every request RESERVES a conservative cost estimate inside the Durable Object before it
 * is forwarded; the request is refused if spent + reserved + estimate would exceed the budget or the global cap.
 * After the response the reservation is settled against the real usage; if usage is missing or the stream is
 * cancelled, the full estimate is charged. The Durable Object is single-threaded, so concurrency cannot overshoot.
 */
export type Claim = ClaimRow;

export async function createClaim(id: string, email: string): Promise<void> {
  await state().createClaim(id, await sha256(normalizeEmail(email)), env.perClaimUsd);
}

export async function getClaim(id: string): Promise<Claim | null> {
  const c = await state().getClaim(id);
  if (!c) return null;
  const tidy = (n: unknown) => Math.round(Number(n ?? 0) * 1e9) / 1e9; // float noise from many settles must not read as a reservation
  return { ...c, budget: Math.min(Number(c.budget), env.perClaimUsd), spent: tidy(c.spent), reserved: tidy(c.reserved), requests: Number(c.requests ?? 0) };
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
export async function markVerified(id: string, patch: { mode: "key" | "relay"; key_name?: string; expires: number }): Promise<void> {
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

// ---------- global cap ----------
export async function globalCommittedUsd(): Promise<number> {
  return state().committedUsd(env.perClaimUsd);
}
/** True when handing out one more claim's budget would exceed GLOBAL_CAP_USD. */
export async function capReachedForNewClaim(): Promise<boolean> {
  return (await globalCommittedUsd()) + env.perClaimUsd > env.globalCapUsd;
}

// ---------- relay-mode reservation ----------
export async function reserve(claimId: string, estimate: number): Promise<{ status: "ok" | "budget" | "global"; id?: string }> {
  return state().reserve(claimId, estimate, env.perClaimUsd, env.globalCapUsd, env.reservationMaxAgeSec);
}
export type StateStub = ReturnType<typeof state>;
/** Settle through an explicitly captured stub: stream callbacks and timers run outside the request's async context. */
export async function settleWith(stub: StateStub, reservationId: string, actual: number): Promise<number> {
  const g = await stub.settle(reservationId, actual);
  void maybeAlert(g, stub);
  return g;
}

/** Pre-flight for relay mode that does not depend on money: status, expiry, kill switch. */
export function blockedReason(c: Claim): string | null {
  if (!env.relayEnabled) return "relay_disabled";
  if (c.status !== "verified") return "not_verified";
  if (c.expires && c.expires * 1000 < Date.now()) return "expired";
  if (c.spent >= c.budget) return "budget_exhausted";
  return null;
}

async function maybeAlert(global: number, stub: StateStub = state()): Promise<void> {
  for (const level of [150, 250]) {
    if (global >= level && (await stub.kvSetNx(`alert:${level}`, "1"))) {
      if (env.alertEmail) {
        await sendMail(env.alertEmail, `RouteArena relay: global spend passed $${level}`, `<p>Global relay-mode spend is now $${global.toFixed(2)} of the $${env.globalCapUsd} cap.</p><p>Set RELAY_ENABLED=false or CLAIMS_ENABLED=false to stop.</p>`, `global-alert/${level}/${new Date().toISOString().slice(0, 10)}`).catch(() => undefined);
      }
      logEvent("alert", { level, global });
    }
  }
}

export async function stats(): Promise<Record<string, number>> {
  return state().stats(env.perClaimUsd);
}
