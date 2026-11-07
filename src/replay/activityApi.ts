import { CliError } from "../config.js";
import type { ParsedUsage, UsageRow } from "./csv.js";

/**
 * OpenRouter Activity API: GET https://openrouter.ai/api/v1/activity
 * Requires a Management (provisioning) key. Returns daily per-model, per-endpoint rows for the last ~30 days.
 * Fields (documented at openrouter.ai/docs/api-reference/get-activity): date, model, model_permaslug, endpoint_id,
 * provider_name, usage, byok_usage_inference, requests, prompt_tokens, completion_tokens, reasoning_tokens.
 */
export async function fetchActivity(managementKey: string, opts: { date?: string; baseUrl?: string } = {}): Promise<ParsedUsage> {
  const base = opts.baseUrl ?? "https://openrouter.ai/api/v1";
  const url = new URL(`${base}/activity`);
  if (opts.date) url.searchParams.set("date", opts.date);
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${managementKey}` } });
  } catch (err) {
    throw new CliError(`Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}`, "Check your network connection and try again.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new CliError(
      "OpenRouter rejected the management key.",
      "The activity API needs a Management key, not a normal API key. Create one at openrouter.ai/settings/management-keys and set OPENROUTER_MANAGEMENT_KEY.",
    );
  }
  if (!res.ok) {
    throw new CliError(`OpenRouter activity API returned HTTP ${res.status}.`, "Try again in a minute; if it persists, export the CSV from openrouter.ai/activity instead.");
  }
  const json: any = await res.json();
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  const rows: UsageRow[] = data.map((d) => ({
    model: String(d.model_permaslug ?? d.model ?? "").toLowerCase(),
    prompt_tokens: Number(d.prompt_tokens ?? 0),
    completion_tokens: Number(d.completion_tokens ?? 0) + Number(d.reasoning_tokens ?? 0),
    requests: Number(d.requests ?? 0),
    cost_usd: Number(d.usage ?? 0) + Number(d.byok_usage_inference ?? 0),
    date: typeof d.date === "string" ? d.date.slice(0, 10) : undefined,
    provider: d.provider_name,
    byok: Number(d.byok_usage_inference ?? 0) > 0,
  }));
  const dates = rows.map((r) => r.date).filter((d): d is string => !!d).sort();
  return {
    rows,
    columns: Object.keys(data[0] ?? {}),
    detected: { model: "model_permaslug", prompt_tokens: "prompt_tokens", completion_tokens: "completion_tokens", cost: "usage", requests: "requests", date: "date" },
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    perModel: true,
    warnings: [],
  };
}
