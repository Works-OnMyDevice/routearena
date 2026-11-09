import { DurableObject } from "cloudflare:workers";

/**
 * RelayState: one Durable Object instance ("global") holds every piece of relay state in SQLite.
 * A Durable Object runs single-threaded, so pool pops and counters are atomic without locks.
 *
 * No money is tracked here. Spend is enforced by TokenRouter through the per-key quota set via its Management
 * API; this object only knows which keys are still in the pool, which were issued, and to whom.
 *
 * Migration note: earlier deployments created a `reservations` table, `spent`/`reserved`/`requests` columns on
 * `claims`, and `global:spent` / `global:reserved` counters for the retired metered-relay mode. They are left
 * untouched (CREATE TABLE IF NOT EXISTS never alters an existing table) and are simply no longer read or written.
 * Every statement below names its columns explicitly, so it runs identically against the old and new `claims` shape.
 */
export interface ClaimRow {
  id: string;
  email_hash: string;
  status: "pending" | "verified" | "expired";
  created: number;
  verified_at: number | null;
  expires: number | null;
  budget: number;
  mode: "key" | null;
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
        budget REAL, mode TEXT, key_name TEXT
      );
      CREATE TABLE IF NOT EXISTS emails (hash TEXT PRIMARY KEY, created INTEGER, sealed TEXT);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value REAL);
      CREATE TABLE IF NOT EXISTS pool (seq INTEGER PRIMARY KEY AUTOINCREMENT, sealed TEXT);
      CREATE TABLE IF NOT EXISTS expiring (sealed TEXT PRIMARY KEY, due INTEGER);
      CREATE TABLE IF NOT EXISTS ratelimit (k TEXT PRIMARY KEY, n INTEGER, exp INTEGER);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, json TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS keyclaim (hash TEXT PRIMARY KEY, claim_id TEXT);
      CREATE TABLE IF NOT EXISTS log (ts INTEGER, event TEXT, fields TEXT);
    `);
    // The oldest deployments created `emails` without `sealed`; adding it is the only change ever applied to an existing table.
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
    const r = this.ctx.storage.sql.exec("SELECT id, email_hash, status, created, verified_at, expires, budget, mode, key_name FROM claims WHERE id = ?", id).toArray()[0];
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
  async markVerified(id: string, patch: { mode: "key"; key_name?: string; expires: number }): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE claims SET status = 'verified', verified_at = ?, expires = ?, mode = ?, key_name = ? WHERE id = ?", this.now(), patch.expires, patch.mode, patch.key_name ?? null, id);
    this.addCounter("global:verified", 1);
  }

  // ---------- pool ----------
  async pushPool(sealed: string[]): Promise<number> {
    for (const s of sealed) this.ctx.storage.sql.exec("INSERT INTO pool (sealed) VALUES (?)", s);
    return this.poolSize();
  }
  /** Take the oldest key out of the pool and count it as issued. */
  async popPool(): Promise<string | null> {
    const r = this.ctx.storage.sql.exec("SELECT seq, sealed FROM pool ORDER BY seq LIMIT 1").toArray()[0];
    if (!r) return null;
    this.ctx.storage.sql.exec("DELETE FROM pool WHERE seq = ?", r.seq);
    this.addCounter("pool:used", 1);
    return String(r.sealed);
  }
  /** Put a popped key back (hand-out aborted) and un-count it; it goes to the back of the queue. */
  async returnPool(sealed: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO pool (sealed) VALUES (?)", sealed);
    this.addCounter("pool:used", -1);
  }
  async poolSize(): Promise<number> {
    return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pool").toArray()[0].n);
  }
  /** Number of keys handed out so far (pops minus returns). */
  async poolIssued(): Promise<number> {
    return this.counter("pool:used");
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
  async stats(): Promise<Record<string, number>> {
    const c = (n: string) => this.counter(n);
    return {
      claims: c("global:claims"),
      verified: c("global:verified"),
      published: c("global:published"),
      pool_available: await this.poolSize(),
      pool_issued: c("pool:used"),
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
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?", now);
    this.ctx.storage.sql.exec("DELETE FROM ratelimit WHERE exp < ?", now);
    this.ctx.storage.sql.exec("DELETE FROM reports WHERE created < ?", now - 180 * 86400);
    this.ctx.storage.sql.exec("DELETE FROM log WHERE ts < ?", now - 60 * 86400);
  }
}
