import { env, logEvent } from "./env";

/** Error from TokenRouter's Management API, carrying the HTTP status so callers can tell a rate limit (429) apart. */
export class MgmtError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(`management ${path} -> ${status} ${message}`);
  }
}

/** Thin client for TokenRouter's Management API (see docs/tokenrouter-notes.md). Never logs key values. */
async function mgmt(method: string, path: string, body?: unknown): Promise<any> {
  if (!env.managementKey) throw new Error("TOKENROUTER_MANAGEMENT_KEY not set");
  const res = await fetch(`${env.trBase}/api/management${path}`, {
    method,
    headers: { authorization: `Bearer ${env.managementKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j?.success === false) {
    const logical = path.split("?")[0];
    logEvent("mgmt_error", { path: logical, status: res.status, message: j?.message });
    throw new MgmtError(res.status, logical, String(j?.message ?? ""));
  }
  return j;
}

export interface KeyInfo {
  name: string;
  key: string; // masked
  status: number;
  unlimited_quota: boolean;
  remain_quota: number;
  used_quota: number;
  expired_time: number;
}

/** Cap a key at `usd` (integer dollars; the API takes an int). Returns what TokenRouter reports back so the caller can verify. */
export async function setKeyQuota(key: string, usd: number): Promise<Partial<KeyInfo>> {
  const j = await mgmt("PUT", "/api-keys/quota", { key, unlimited_quota: false, remain_quota: Math.max(0, Math.round(usd)) });
  return (j?.data ?? {}) as Partial<KeyInfo>;
}

/** True only when TokenRouter's own response says the key is limited and its remaining quota is at or under `usd`. */
export function quotaApplied(info: Partial<KeyInfo> | null | undefined, usd: number): boolean {
  if (!info) return false;
  const remain = Number(info.remain_quota);
  return info.unlimited_quota === false && Number.isFinite(remain) && remain <= Math.max(0, Math.round(usd));
}

export async function disableKey(key: string): Promise<void> {
  await mgmt("PUT", "/api-keys/disable", { key });
}

/** List keys (masked). Rate limited to 10/min upstream; callers must cache. */
export async function listKeys(): Promise<KeyInfo[]> {
  const out: KeyInfo[] = [];
  for (let page = 1; page <= 10; page++) {
    const j = await mgmt("GET", `/api-keys?page=${page}&page_size=100`);
    const items: KeyInfo[] = j?.data?.items ?? [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

/** One billed request as TokenRouter reports it (GET /api/management/hour/usages). */
export interface UsageItem {
  request_id: string;
  key_name: string;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number; // USD, as billed by TokenRouter
  created_at: number | string;
}

/**
 * All billed rows in [start, end] (Unix seconds). The API rejects ranges wider than one hour, so callers window.
 * Pages until a short page; `maxPages` bounds the number of upstream calls.
 */
export async function listUsages(start: number, end: number, maxPages = 20): Promise<UsageItem[]> {
  if (end - start > 3600) throw new Error("usage window must not exceed one hour");
  const out: UsageItem[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = await mgmt("GET", `/hour/usages?start_timestamp=${start}&end_timestamp=${end}&page=${page}&page_size=100`);
    const items: UsageItem[] = j?.data?.items ?? [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}
