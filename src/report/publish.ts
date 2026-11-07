import { CliError, RELAY_URL } from "../config.js";
import type { ReportAggregates } from "./aggregate.js";

const FORBIDDEN_KEYS = new Set(["messages", "content", "prompt", "completion", "completion_text", "tool_calls", "arguments", "text"]);
const MAX_STRING = 500;

/**
 * Client-side guard: refuse to upload anything that could carry prompt or completion text.
 * The relay enforces the same rules server-side.
 */
export function assertPublishable(obj: unknown, path = "$"): void {
  if (typeof obj === "string") {
    if (obj.length > MAX_STRING) throw new CliError(`Refusing to publish: ${path} is ${obj.length} chars (max ${MAX_STRING}).`, "This is a safety check; report it as a bug.");
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertPublishable(v, `${path}[${i}]`));
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_KEYS.has(k)) throw new CliError(`Refusing to publish: field "${k}" at ${path} is not allowed.`, "This is a safety check; report it as a bug.");
      assertPublishable(v, `${path}.${k}`);
    }
  }
}

export async function publishAggregates(agg: ReportAggregates, relayUrl = RELAY_URL): Promise<{ url: string; id: string }> {
  assertPublishable(agg);
  let res: Response;
  try {
    res = await fetch(`${relayUrl}/api/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `routearena/${agg.tool.version}` },
      body: JSON.stringify({ aggregates: agg }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new CliError(`Could not reach the relay at ${relayUrl}: ${err instanceof Error ? err.message : String(err)}`, "Check your connection, or share ./routearena-report/index.html directly.");
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new CliError(`Relay refused the publish (HTTP ${res.status}): ${t.slice(0, 200)}`, "Share ./routearena-report/index.html directly, or try again later.");
  }
  const j = (await res.json()) as { url: string; id: string };
  return j;
}
