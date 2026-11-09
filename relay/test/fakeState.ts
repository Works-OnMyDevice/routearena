// In-memory stand-in for the RelayState Durable Object, exposing the subset of methods lib/* calls.
// Lets unit tests drive budget/hand-out/usage logic under Node without wrangler.
import { runWithState } from "../lib/store";
import type { ClaimRow } from "../src/state";

export class FakeState {
  claims = new Map<string, ClaimRow>();
  emails = new Map<string, { created: number; sealed: string | null }>();
  kv = new Map<string, { v: string; exp: number | null }>();
  pool: string[] = [];
  issued = 0;
  keyclaim = new Map<string, string>();
  expiring = new Map<string, number>();
  logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  rl = new Map<string, { n: number; exp: number }>();
  counters: Record<string, number> = {};

  private now() {
    return Math.floor(Date.now() / 1000);
  }
  async createClaim(id: string, email_hash: string, budget: number) {
    this.claims.set(id, { id, email_hash, status: "pending", created: this.now(), verified_at: null, expires: null, budget, mode: null, key_name: null });
    this.counters.claims = (this.counters.claims ?? 0) + 1;
  }
  async getClaim(id: string) {
    return this.claims.get(id) ?? null;
  }
  async emailClaimed(hash: string) {
    return this.emails.has(hash);
  }
  async markEmailClaimed(hash: string, sealed?: string) {
    if (!this.emails.has(hash)) this.emails.set(hash, { created: this.now(), sealed: sealed ?? null });
  }
  async markVerified(id: string, patch: { mode: "key"; key_name?: string; expires: number }) {
    const c = this.claims.get(id)!;
    Object.assign(c, { status: "verified", verified_at: this.now(), expires: patch.expires, mode: patch.mode, key_name: patch.key_name ?? null });
    this.counters.verified = (this.counters.verified ?? 0) + 1;
  }
  async pushPool(sealed: string[]) {
    this.pool.push(...sealed);
    return this.pool.length;
  }
  async popPool() {
    const s = this.pool.shift();
    if (s === undefined) return null;
    this.issued++;
    return s;
  }
  async returnPool(sealed: string) {
    this.pool.push(sealed);
    this.issued--;
  }
  async poolSize() {
    return this.pool.length;
  }
  async poolIssued() {
    return this.issued;
  }
  async linkKey(hash: string, claimId: string) {
    this.keyclaim.set(hash, claimId);
  }
  async claimIdForKey(hash: string) {
    return this.keyclaim.get(hash) ?? null;
  }
  async addExpiring(sealed: string, due: number) {
    this.expiring.set(sealed, due);
  }
  async kvGet(k: string) {
    const r = this.kv.get(k);
    if (!r) return null;
    if (r.exp !== null && r.exp < this.now()) {
      this.kv.delete(k);
      return null;
    }
    return r.v;
  }
  async kvSet(k: string, v: string, ttlSec?: number) {
    this.kv.set(k, { v, exp: ttlSec ? this.now() + ttlSec : null });
  }
  async kvSetNx(k: string, v: string, ttlSec?: number) {
    if ((await this.kvGet(k)) !== null) return false;
    await this.kvSet(k, v, ttlSec);
    return true;
  }
  async kvDel(k: string) {
    this.kv.delete(k);
  }
  async rateLimit(k: string, max: number, windowSec: number) {
    const now = this.now();
    const r = this.rl.get(k);
    if (!r || r.exp < now) {
      this.rl.set(k, { n: 1, exp: now + windowSec });
      return max >= 1;
    }
    r.n++;
    return r.n <= max;
  }
  async stats() {
    return { claims: this.counters.claims ?? 0, verified: this.counters.verified ?? 0, published: 0, pool_available: this.pool.length, pool_issued: this.issued };
  }
  async log(event: string, fields: Record<string, unknown>) {
    this.logs.push({ event, fields });
  }
}

/** Run `fn` with a fresh FakeState bound as the request's RelayState. */
export function withFakeState<T>(fn: (st: FakeState) => Promise<T>, st = new FakeState()): Promise<T> {
  return runWithState(st as any, undefined, () => fn(st));
}

/** Route fetch() by URL substring so tests can mock TokenRouter's management API (and Resend) without a network. */
export type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
export function mockFetch(routes: Array<[string, Route]>): Array<{ url: string; method: string; body: any }> {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    let body: any = null;
    try {
      body = init.body ? JSON.parse(init.body) : null;
    } catch {
      /* non-JSON */
    }
    calls.push({ url: url.toString(), method: init.method ?? "GET", body });
    for (const [needle, handler] of routes) if (url.toString().includes(needle)) return handler(url, init);
    return new Response(JSON.stringify({ error: `no mock route for ${url}` }), { status: 599 });
  }) as typeof fetch;
  return calls;
}
export const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
