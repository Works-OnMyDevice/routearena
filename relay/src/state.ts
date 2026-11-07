import { DurableObject } from "cloudflare:workers";

/**
 * RelayState: one Durable Object instance ("global") holds every piece of relay state in SQLite.
 * A Durable Object runs single-threaded, so reserve/settle are atomic without locks or Lua.
 *
 * Money rules live here and nowhere else:
 *  - reserve(): refuses when spent + reserved + estimate > budget, or when the global commitment
 *    (relay spent + relay reserved + issued keys × per-claim budget) + estimate > cap.
 *  - settle(): releases the reservation and charges the actual cost (never more than the reservation).
 */
export interface ClaimRow {
  id: string;
  email_hash: string;
  status: "pending" | "verified" | "expired";
  created: number;
  verified_at: number | null;
  expires: number | null;
  budget: number;
  spent: number;
  reserved: number;
  requests: number;
  mode: "key" | "relay" | null;
  key_name: string | null;
}

export class RelayState extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, email_hash TEXT, status TEXT, created INTEGER, verified_at INTEGER, expires INTEGER,
        budget REAL, spent REAL DEFAULT 0, reserved REAL DEFAULT 0, requests INTEGER DEFAULT 0, mode TEXT, key_name TEXT
      );
      CREATE TABLE IF NOT EXISTS emails (hash TEXT PRIMARY KEY, created INTEGER);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value REAL);
      CREATE TABLE IF NOT EXISTS pool (seq INTEGER PRIMARY KEY AUTOINCREMENT, sealed TEXT);
      CREATE TABLE IF NOT EXISTS expiring (sealed TEXT PRIMARY KEY, due INTEGER);
      CREATE TABLE IF NOT EXISTS ratelimit (k TEXT PRIMARY KEY, n INTEGER, exp INTEGER);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, json TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS keyclaim (hash TEXT PRIMARY KEY, claim_id TEXT);
      CREATE TABLE IF NOT EXISTS log (ts INTEGER, event TEXT, fields TEXT);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, claim_id TEXT, estimate REAL, created INTEGER);
    `);
    try {
      this.ctx.storage.sql.exec("ALTER TABLE emails ADD COLUMN sealed TEXT");
    } catch {
      /* column already exists */
    }
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }
  private counter(name: string): number {
    const r = this.ctx.storage.sql.exec("SELECT value FROM counters WHERE name = ?", name).toArray()[0];
    return r ? Number(r.value) : 0;
  }
  private addCounter(name: string, delta: number): number {
    this.ctx.storage.sql.exec("INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value", name, delta);
    return this.counter(name);
  }

  // ---------- claims ----------
  async createClaim(id: string, emailHash: string, budget: number): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO claims (id, email_hash, status, created, budget) VALUES (?, ?, 'pending', ?, ?)", id, emailHash, this.now(), budget);
    this.addCounter("global:claims", 1);
  }
  async getClaim(id: string): Promise<ClaimRow | null> {
    const r = this.ctx.storage.sql.exec("SELECT * FROM claims WHERE id = ?", id).toArray()[0];
    return (r as unknown as ClaimRow) ?? null;
  }
  async emailClaimed(hash: string): Promise<boolean> {
    return this.ctx.storage.sql.exec("SELECT 1 FROM emails WHERE hash = ?", hash).toArray().length > 0;
  }
  async markEmailClaimed(hash: string, sealed?: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO emails (hash, created, sealed) VALUES (?, ?, ?)", hash, this.now(), sealed ?? null);
    if (sealed) this.ctx.storage.sql.exec("UPDATE emails SET sealed = COALESCE(sealed, ?) WHERE hash = ?", sealed, hash);
  }
  /** Verified claimant emails, newest first, still sealed; the admin endpoint decrypts them. */
  async listEmails(limit: number, offset: number): Promise<Array<{ sealed: string; created: number }>> {
    return this.ctx.storage.sql.exec("SELECT sealed, created FROM emails WHERE sealed IS NOT NULL ORDER BY created DESC LIMIT ? OFFSET ?", limit, offset).toArray() as unknown as Array<{ sealed: string; created: number }>;
  }
  async countEmails(): Promise<number> {
    const r = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM emails WHERE sealed IS NOT NULL").toArray()[0] as any;
    return Number(r?.n ?? 0);
  }
  async markVerified(id: string, patch: { mode: "key" | "relay"; key_name?: string; expires: number }): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE claims SET status = 'verified', verified_at = ?, expires = ?, mode = ?, key_name = ? WHERE id = ?", this.now(), patch.expires, patch.mode, patch.key_name ?? null, id);
    this.addCounter("global:verified", 1);
  }

  // ---------- money ----------
  async committedUsd(perClaim: number): Promise<number> {
    return this.counter("global:spent") + this.counter("global:reserved") + this.counter("pool:used") * perClaim;
  }
  /** Reserve `estimate` for a claim. Stale reservations (older than maxAgeSec) are charged first so a dead
   *  isolate can never strand budget or let it leak. Returns a reservation id on success. */
  async reserve(claimId: string, estimate: number, perClaim: number, cap: number, maxAgeSec = 600): Promise<{ status: "ok" | "budget" | "global"; id?: string }> {
    await this.chargeStaleReservations(maxAgeSec);
    const c = await this.getClaim(claimId);
    if (!c) return { status: "budget" };
    const budget = Math.min(Number(c.budget), perClaim);
    if (Number(c.spent) + Number(c.reserved) + estimate > budget) return { status: "budget" };
    if ((await this.committedUsd(perClaim)) + estimate > cap) return { status: "global" };
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO reservations (id, claim_id, estimate, created) VALUES (?, ?, ?, ?)", id, claimId, estimate, this.now());
    this.ctx.storage.sql.exec("UPDATE claims SET reserved = reserved + ? WHERE id = ?", estimate, claimId);
    this.addCounter("global:reserved", estimate);
    return { status: "ok", id };
  }
  /** Settle a reservation: release it and charge `actual` (capped at the estimate). Idempotent per reservation id. */
  async settle(reservationId: string, actual: number): Promise<number> {
    const r = this.ctx.storage.sql.exec("SELECT claim_id, estimate FROM reservations WHERE id = ?", reservationId).toArray()[0];
    if (!r) return this.counter("global:spent"); // already settled
    const estimate = Number(r.estimate);
    const charge = Math.min(Math.max(0, actual), estimate);
    this.ctx.storage.sql.exec("DELETE FROM reservations WHERE id = ?", reservationId);
    this.ctx.storage.sql.exec("UPDATE claims SET reserved = MAX(0, reserved - ?), spent = spent + ?, requests = requests + 1 WHERE id = ?", estimate, charge, r.claim_id);
    this.addCounter("global:reserved", -estimate);
    return this.addCounter("global:spent", charge);
  }
  /** Any reservation older than maxAgeSec is charged in full: the request is long over and its usage was never reported. */
  async chargeStaleReservations(maxAgeSec: number): Promise<number> {
    const stale = this.ctx.storage.sql.exec("SELECT id, estimate FROM reservations WHERE created < ?", this.now() - maxAgeSec).toArray();
    for (const s of stale) await this.settle(String(s.id), Number(s.estimate));
    return stale.length;
  }

  // ---------- pool ----------
  async pushPool(sealed: string[]): Promise<number> {
    for (const s of sealed) this.ctx.storage.sql.exec("INSERT INTO pool (sealed) VALUES (?)", s);
    return this.poolSize();
  }
  async popPool(): Promise<string | null> {
    const r = this.ctx.storage.sql.exec("SELECT seq, sealed FROM pool ORDER BY seq LIMIT 1").toArray()[0];
    if (!r) return null;
    this.ctx.storage.sql.exec("DELETE FROM pool WHERE seq = ?", r.seq);
    this.addCounter("pool:used", 1);
    return String(r.sealed);
  }
  async returnPool(sealed: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO pool (sealed) VALUES (?)", sealed);
    this.addCounter("pool:used", -1);
  }
  async poolSize(): Promise<number> {
    return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pool").toArray()[0].n);
  }
  async linkKey(hash: string, claimId: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO keyclaim (hash, claim_id) VALUES (?, ?)", hash, claimId);
  }
  async claimIdForKey(hash: string): Promise<string | null> {
    const r = this.ctx.storage.sql.exec("SELECT claim_id FROM keyclaim WHERE hash = ?", hash).toArray()[0];
    return r ? String(r.claim_id) : null;
  }
  async addExpiring(sealed: string, due: number): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO expiring (sealed, due) VALUES (?, ?)", sealed, due);
  }
  async dueExpiring(now: number): Promise<string[]> {
    return this.ctx.storage.sql.exec("SELECT sealed FROM expiring WHERE due <= ?", now).toArray().map((r) => String(r.sealed));
  }
  async removeExpiring(sealed: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM expiring WHERE sealed = ?", sealed);
  }

  // ---------- generic kv with ttl ----------
  async kvGet(k: string): Promise<string | null> {
    const r = this.ctx.storage.sql.exec("SELECT v, exp FROM kv WHERE k = ?", k).toArray()[0];
    if (!r) return null;
    if (r.exp !== null && Number(r.exp) < this.now()) {
      this.ctx.storage.sql.exec("DELETE FROM kv WHERE k = ?", k);
      return null;
    }
    return String(r.v);
  }
  async kvSet(k: string, v: string, ttlSec?: number): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)", k, v, ttlSec ? this.now() + ttlSec : null);
  }
  /** Set only if absent. Returns true if set. */
  async kvSetNx(k: string, v: string, ttlSec?: number): Promise<boolean> {
    if ((await this.kvGet(k)) !== null) return false;
    await this.kvSet(k, v, ttlSec);
    return true;
  }
  async kvDel(k: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE k = ?", k);
  }

  // ---------- rate limit (fixed window) ----------
  async rateLimit(k: string, max: number, windowSec: number): Promise<boolean> {
    const now = this.now();
    const r = this.ctx.storage.sql.exec("SELECT n, exp FROM ratelimit WHERE k = ?", k).toArray()[0];
    if (!r || Number(r.exp) < now) {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO ratelimit (k, n, exp) VALUES (?, 1, ?)", k, now + windowSec);
      return max >= 1;
    }
    const n = Number(r.n) + 1;
    this.ctx.storage.sql.exec("UPDATE ratelimit SET n = ? WHERE k = ?", n, k);
    return n <= max;
  }

  // ---------- reports ----------
  async putReport(id: string, json: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO reports (id, json, created) VALUES (?, ?, ?)", id, json, this.now());
    this.addCounter("global:published", 1);
  }
  async getReport(id: string): Promise<string | null> {
    const r = this.ctx.storage.sql.exec("SELECT json, created FROM reports WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    if (Number(r.created) + 180 * 86400 < this.now()) return null;
    return String(r.json);
  }

  // ---------- housekeeping ----------
  async stats(perClaim: number): Promise<Record<string, number>> {
    const c = (n: string) => this.counter(n);
    const tidy = (n: number) => Math.round(n * 1e9) / 1e9;
    return {
      claims: c("global:claims"),
      verified: c("global:verified"),
      published: c("global:published"),
      relay_spent_usd: tidy(c("global:spent")),
      relay_reserved_usd: tidy(c("global:reserved")),
      pool_available: await this.poolSize(),
      pool_used: c("pool:used"),
      committed_usd: tidy(await this.committedUsd(perClaim)),
    };
  }
  async log(event: string, fields: Record<string, unknown>): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO log (ts, event, fields) VALUES (?, ?, ?)", this.now(), event, JSON.stringify(fields));
  }
  async recentLog(limit = 200): Promise<Array<{ ts: number; event: string; fields: string }>> {
    return this.ctx.storage.sql.exec("SELECT ts, event, fields FROM log ORDER BY ts DESC LIMIT ?", limit).toArray() as never;
  }
  async sweep(): Promise<void> {
    const now = this.now();
    await this.chargeStaleReservations(600);
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?", now);
    this.ctx.storage.sql.exec("DELETE FROM ratelimit WHERE exp < ?", now);
    this.ctx.storage.sql.exec("DELETE FROM reports WHERE created < ?", now - 180 * 86400);
    this.ctx.storage.sql.exec("DELETE FROM log WHERE ts < ?", now - 60 * 86400);
  }
}
