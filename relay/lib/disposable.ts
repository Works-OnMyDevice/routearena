import { state } from "./store";

const LIST_URL = "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf";
const FALLBACK = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "sharklasers.com", "trashmail.com", "getnada.com", "dispostable.com", "maildrop.cc", "fakeinbox.com", "mohmal.com", "throwawaymail.com", "tempr.email", "emailondeck.com"]);

let memo: { at: number; set: Set<string> } | null = null;

/** Maintained blocklist, cached 24h in the Durable Object and in-isolate. Falls back to a short inline list. */
export async function isDisposable(email: string): Promise<boolean> {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return true;
  const set = await loadList();
  return set.has(domain) || FALLBACK.has(domain);
}

async function loadList(): Promise<Set<string>> {
  if (memo && Date.now() - memo.at < 3600_000) return memo.set;
  try {
    const cached = await state().kvGet("disposable:list");
    if (cached) {
      memo = { at: Date.now(), set: new Set(cached.split("\n")) };
      return memo.set;
    }
  } catch {
    /* no state */
  }
  try {
    const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const text = (await res.text()).trim();
      memo = { at: Date.now(), set: new Set(text.split("\n").map((s) => s.trim()).filter(Boolean)) };
      try {
        await state().kvSet("disposable:list", text, 86400);
      } catch {
        /* ignore */
      }
      return memo.set;
    }
  } catch {
    /* offline */
  }
  return FALLBACK;
}
