import { CliError, RELAY_URL, saveCredits, type Credits } from "../config.js";

export interface ClaimStart {
  id: string;
  status: "sent";
}

export async function startClaim(email: string, relayUrl = RELAY_URL): Promise<ClaimStart> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CliError(`"${email}" is not a valid email address.`, "Pass --email you@example.com");
  }
  let res: Response;
  try {
    res = await fetch(`${relayUrl}/api/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new CliError(`Could not reach the relay at ${relayUrl}: ${err instanceof Error ? err.message : String(err)}`, "Check your connection, or run init with --no-credits and set TOKENROUTER_API_KEY yourself.");
  }
  const j: any = await res.json().catch(() => ({}));
  if (res.status === 429) throw new CliError("Too many claims from this address or network.", j.fix ?? "Each email can claim once. Try again tomorrow or use --no-credits.");
  if (res.status === 503) throw new CliError("Free credits are paused right now.", j.fix ?? "Run init with --no-credits, or set TOKENROUTER_API_KEY with your own key.");
  if (!res.ok) throw new CliError(`Claim failed (HTTP ${res.status}): ${j.error ?? ""}`, j.fix ?? "Use --no-credits and try again later.");
  return { id: j.id, status: "sent" };
}

export interface ClaimStatus {
  status: "pending" | "verified" | "expired" | "unknown";
  token?: string;
  expires_at?: string;
  budget_usd?: number;
  mode?: "key" | "relay";
}

export async function pollClaim(id: string, relayUrl = RELAY_URL): Promise<ClaimStatus> {
  const res = await fetch(`${relayUrl}/api/claim/status?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return { status: "unknown" };
  return (await res.json()) as ClaimStatus;
}

/** Poll until verified or timeout. Stores the token on success. */
export async function waitForVerification(
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number; relayUrl?: string; cwd?: string; onTick?: (elapsedMs: number) => void } = {},
): Promise<Credits> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const interval = opts.intervalMs ?? 3_000;
  const start = Date.now();
  for (;;) {
    const s = await pollClaim(id, opts.relayUrl).catch(() => ({ status: "unknown" }) as ClaimStatus);
    if (s.status === "verified" && s.token) {
      const c: Credits = { token: s.token, claimId: id, expiresAt: s.expires_at ?? new Date(Date.now() + 7 * 86_400_000).toISOString(), budgetUsd: s.budget_usd ?? 1, mode: s.mode ?? (s.token.startsWith("sk-") ? "key" : "relay") };
      saveCredits(c, opts.cwd);
      return c;
    }
    if (s.status === "expired") throw new CliError("The verification link expired.", "Run init --free-credits again to get a new link.");
    const elapsed = Date.now() - start;
    if (elapsed > timeout) throw new CliError("Timed out waiting for the email link to be clicked.", `Click the link in the email sent to you, then within 15 minutes run: routearena init --resume ${id}`);
    opts.onTick?.(elapsed);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export interface Balance {
  remaining_usd: number;
  spent_usd: number;
  budget_usd: number;
  expires_at: string;
  requests: number;
}

export async function fetchBalance(credits: Credits, relayUrl = RELAY_URL): Promise<Balance> {
  const res = await fetch(`${relayUrl}/api/balance`, { headers: { authorization: `Bearer ${credits.token}` }, signal: AbortSignal.timeout(8_000) });
  if (res.status === 401) throw new CliError("The stored free-credit token was rejected.", "Run init --free-credits again.");
  if (!res.ok) throw new CliError(`Relay returned HTTP ${res.status} for balance.`, "Try again later.");
  return (await res.json()) as Balance;
}
