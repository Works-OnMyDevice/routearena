import { logEvent } from "./env";
import { state } from "./store";
import { listUsages, MgmtError, type UsageItem } from "./tokenrouterMgmt";

/**
 * TokenRouter's own billed rows for one claim's key, read through the Management API. Nothing is computed here:
 * `cost_usd` is the `cost` TokenRouter reports per request.
 *
 * The API caps every query at a one-hour range, so a claim's history is walked in hour windows from its creation to
 * now. Progress is persisted per claim in the Durable Object kv (rows deduplicated by request_id, plus the timestamp
 * synced to), so each call only fetches what is new; at most MAX_WINDOWS_PER_CALL windows are fetched per call and
 * the response says `partial: true` while older history is still being caught up. The assembled response is cached
 * for 60 seconds per claim because the Management API is rate limited per minute.
 */
export interface UsageRow {
  request_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  created_at: string;
}
export interface UsageResult {
  rows: UsageRow[];
  from: string;
  to: string;
  fetched_at: string;
  source: "tokenrouter_billing";
  partial?: boolean;
}

export class UsageRateLimited extends Error {
  constructor() {
    super("TokenRouter management API rate limit");
  }
}

export const USAGE_CACHE_SEC = 60;
export const WINDOW_SEC = 3600;
/** Re-scan this much before the synced point so rows that were billed late are still picked up. */
export const OVERLAP_SEC = 120;
export const MAX_WINDOWS_PER_CALL = 6;
const MAX_ROWS = 5000;
const STORE_TTL_SEC = 45 * 86400;

const iso = (unix: number) => new Date(unix * 1000).toISOString();
function createdAtIso(v: number | string): string {
  if (typeof v === "number") return iso(v > 1e12 ? Math.floor(v / 1000) : v);
  const n = Number(v);
  if (Number.isFinite(n) && /^\d+$/.test(v)) return iso(n > 1e12 ? Math.floor(n / 1000) : n);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
export function toRow(it: UsageItem): UsageRow {
  return {
    request_id: String(it.request_id ?? ""),
    model: String(it.model_name ?? ""),
    prompt_tokens: Number(it.prompt_tokens ?? 0),
    completion_tokens: Number(it.completion_tokens ?? 0),
    cost_usd: Number(it.cost ?? 0),
    created_at: createdAtIso(it.created_at),
  };
}

interface Stored {
  rows: UsageRow[];
  synced: number;
}

export async function claimUsage(claim: { id: string; created: number; key_name: string }, nowSec = Math.floor(Date.now() / 1000)): Promise<UsageResult> {
  const st = state();
  const cacheKey = `usage:cache:${claim.id}`;
  const cached = await st.kvGet(cacheKey);
  if (cached) return JSON.parse(cached) as UsageResult;

  const storeKey = `usage:rows:${claim.id}`;
  const stored = JSON.parse((await st.kvGet(storeKey)) ?? "null") as Stored | null;
  const from = Math.max(0, Number(claim.created) - 60);
  const byId = new Map<string, UsageRow>((stored?.rows ?? []).map((r) => [r.request_id, r]));
  let cursor = Math.max(from, stored ? stored.synced - OVERLAP_SEC : from);
  let windows = 0;
  let rateLimited = false;
  while (cursor < nowSec && windows < MAX_WINDOWS_PER_CALL) {
    const end = Math.min(cursor + WINDOW_SEC, nowSec);
    let items: UsageItem[];
    try {
      items = await listUsages(cursor, end);
    } catch (e) {
      if (e instanceof MgmtError && e.status === 429) {
        rateLimited = true;
        break;
      }
      throw e;
    }
    for (const it of items) if (it.key_name === claim.key_name && it.request_id) byId.set(String(it.request_id), toRow(it));
    cursor = end;
    windows++;
  }
  const rows = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-MAX_ROWS);
  if (windows > 0) await st.kvSet(storeKey, JSON.stringify({ rows, synced: cursor } satisfies Stored), STORE_TTL_SEC);
  if (rateLimited) {
    logEvent("usage_rate_limited", { id: claim.id, key_name: claim.key_name, synced_to: iso(cursor) });
    throw new UsageRateLimited();
  }
  const result: UsageResult = { rows, from: iso(from), to: iso(cursor), fetched_at: iso(nowSec), source: "tokenrouter_billing", ...(cursor < nowSec ? { partial: true } : {}) };
  await st.kvSet(cacheKey, JSON.stringify(result), USAGE_CACHE_SEC);
  logEvent("usage_fetched", { id: claim.id, key_name: claim.key_name, rows: rows.length, windows, partial: cursor < nowSec });
  return result;
}
