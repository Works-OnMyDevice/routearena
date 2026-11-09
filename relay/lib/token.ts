import { env } from "./env";

// WebCrypto only, so the same code runs on Cloudflare Workers and Node 20+.
const te = new TextEncoder();
const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64u = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", te.encode(s)));
}

export const randomId = (bytes = 12): string => hex(crypto.getRandomValues(new Uint8Array(bytes)));

// ---------- sealing (AES-256-GCM, key derived from HMAC_SECRET) ----------
async function sealKey(): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", te.encode(`pool:${env.hmacSecret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
export interface PoolItem {
  key: string;
  name: string;
  capped: boolean;
}
export async function sealPoolItem(item: PoolItem): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(), te.encode(JSON.stringify(item)));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
async function contextKey(context: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", te.encode(`${context}:${env.hmacSecret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
/** Seal a short string (e.g. a verified claimant email) so a raw storage dump does not expose it. */
export async function sealText(context: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await contextKey(context), te.encode(text));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
export async function openText(context: string, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("bad sealed text");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await contextKey(context), unb64u(ct));
  return new TextDecoder().decode(pt);
}
export async function openPoolItem(sealed: string): Promise<PoolItem> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("bad pool item");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await sealKey(), unb64u(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
