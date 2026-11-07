import { env, logEvent } from "./env";

/** Thin client for TokenRouter's Management API (see docs/tokenrouter-notes.md). */
async function mgmt(method: string, path: string, body?: unknown): Promise<any> {
  if (!env.managementKey) throw new Error("TOKENROUTER_MANAGEMENT_KEY not set");
  const res = await fetch(`${env.trBase}/api/management${path}`, {
    method,
    headers: { authorization: `Bearer ${env.managementKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j?.success === false) {
    logEvent("mgmt_error", { path, status: res.status, message: j?.message });
    throw new Error(`management ${path} -> ${res.status} ${j?.message ?? ""}`);
  }
  return j;
}

/** Cap a key at `usd` (integer dollars; the API takes an int). */
export async function setKeyQuota(key: string, usd: number): Promise<void> {
  await mgmt("PUT", "/api-keys/quota", { key, unlimited_quota: false, remain_quota: Math.max(0, Math.round(usd)) });
}

export async function disableKey(key: string): Promise<void> {
  await mgmt("PUT", "/api-keys/disable", { key });
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
