/**
 * Configuration. On Cloudflare the worker calls setEnv(env) per request so vars and secrets are read from the
 * binding object; under Node (tests, scripts) process.env is used.
 */
let vars: Record<string, string | undefined> = {};
export function setEnv(e: Record<string, unknown>): void {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(e)) if (typeof v === "string") out[k] = v;
  vars = out;
}
function get(name: string): string | undefined {
  return vars[name] ?? (typeof process !== "undefined" ? process.env?.[name] : undefined);
}
function num(name: string, dflt: number): number {
  const n = Number(get(name) ?? dflt);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export const env = {
  get trBase() {
    return (get("TOKENROUTER_BASE_URL") || "https://api.tokenrouter.com").replace(/\/$/, "");
  },
  get masterKey() {
    return get("TOKENROUTER_MASTER_KEY") || "";
  },
  get managementKey() {
    return get("TOKENROUTER_MANAGEMENT_KEY") || "";
  },
  get hmacSecret() {
    const s = get("HMAC_SECRET");
    if (!s) throw new Error("HMAC_SECRET not set");
    return s;
  },
  get adminSecret() {
    return get("ADMIN_SECRET") || "";
  },
  get publicBase() {
    return (get("PUBLIC_BASE_URL") || "http://localhost:8787").replace(/\/$/, "");
  },
  /** Hard per-person cap. Defaults to $1 and is clamped so a bad value cannot raise it above $5. */
  get perClaimUsd() {
    return Math.min(num("PER_CLAIM_USD", 1), 5);
  },
  /** Relay mode: max completion tokens forced onto every forwarded request. */
  get relayMaxTokens() {
    return Math.min(num("RELAY_MAX_TOKENS", 2048), 8192);
  },
  /** Relay mode: requests per minute per claim. */
  get relayRpm() {
    return num("RELAY_RPM", 60);
  },
  /** Relay mode: a request whose usage never arrives is charged its full estimate after this long. */
  get settleTimeoutMs() {
    return num("RELAY_SETTLE_TIMEOUT_MS", 125_000);
  },
  /** Reservations older than this are charged in full by the Durable Object regardless of the isolate. */
  get reservationMaxAgeSec() {
    return num("RESERVATION_MAX_AGE_SEC", 600);
  },
  get globalCapUsd() {
    return num("GLOBAL_CAP_USD", 300);
  },
  get claimDays() {
    return num("CLAIM_DAYS", 7);
  },
  get claimsEnabled() {
    return (get("CLAIMS_ENABLED") ?? "true") !== "false";
  },
  get relayEnabled() {
    return (get("RELAY_ENABLED") ?? "true") !== "false";
  },
  get resendKey() {
    return get("RESEND_API_KEY") || "";
  },
  get mailFrom() {
    return get("MAIL_FROM") || "RouteArena <onboarding@resend.dev>";
  },
  get alertEmail() {
    return get("ALERT_EMAIL") || "";
  },
  /** Local development only: return the magic link in the claim response instead of emailing it. Never set in production. */
  get devExposeLinks() {
    return get("DEV_EXPOSE_LINKS") === "true";
  },
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

export function clientIp(req: Request): string {
  // Cloudflare sets cf-connecting-ip to the real client; it cannot be spoofed through the edge.
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

/** Constant-time comparison for secrets. */
export function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Structured metadata log line. Never include bodies. */
export function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
