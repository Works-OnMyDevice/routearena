import fs from "node:fs";
import path from "node:path";
import { PRIMARIES, RELAY_URL, REPORT_DIR, loadConfig, loadCredits, logPath, pkgVersion, type Config, type Credits } from "../config.js";
import { readLog } from "../proxy/logger.js";
import { loadTargets, resolveTargets } from "../targets/index.js";
import { aggregate, type AggregateInput, type ReportAggregates } from "./aggregate.js";
import { renderReportHtml } from "./html.js";
import { judgeAll, type JudgeEndpoint } from "./judge.js";

export interface BuildOptions {
  cwd?: string;
  judge?: boolean; // default true
  judgeSample?: number; // fraction of pairs to judge, default 0.25
  /** Override the judge endpoint (default: pickJudge). */
  judgeEndpoint?: JudgeEndpoint | null;
  /** Per-request bills by target. Omitted: fetched from the relay for a key-mode free-credit claim (see `fetchBilledCosts`). null: skip. */
  billed?: AggregateInput["billed"] | null;
  /** Network hooks; tests inject a fake fetch. */
  fetchImpl?: typeof fetch;
  relayUrl?: string;
  now?: () => Date;
  onProgress?: (msg: string) => void;
}

export interface BuildResult {
  aggregates: ReportAggregates;
  htmlPath: string;
  jsonPath: string;
  records: number;
  judged_now: number;
}

/**
 * Pick the judge endpoint. The judge runs on the primary (gpt-4o-mini via the user's own key) whenever the primary
 * key exists: the primary is never one of the compared targets, so the judge cannot favor its own provider, and the
 * key is one the user already pays with. Targets are used only when there is no primary key.
 */
export function pickJudge(cfg: Config, cwd: string): JudgeEndpoint | null {
  const p = PRIMARIES[cfg.primary];
  const key = process.env[p.keyEnv];
  if (key) {
    const model = cfg.primary === "openrouter" ? "openai/gpt-4o-mini" : "gpt-4o-mini";
    return { baseUrl: p.baseUrl, auth: key, model, label: `${cfg.primary}/${model}` };
  }
  const credits = loadCredits(cwd);
  const resolved = resolveTargets({ credits, excludePrimary: cfg.primary });
  const preferred = ["tokenrouter", "groq", "deepinfra", "together", "fireworks", "openai"];
  for (const id of preferred) {
    const rt = resolved.find((r) => r.target.id === id && r.status !== "no-key" && r.target.judgeModel);
    if (rt) return { baseUrl: rt.baseUrl, auth: rt.auth, model: rt.target.judgeModel!, headers: rt.target.headers, label: `${rt.target.id}/${rt.target.judgeModel}` };
  }
  return null;
}


// ---------------------------------------------------------------------------------------------
// Billed costs. TokenRouter does not put a cost on its responses. For a free-credit claim in key mode the relay
// issued the TokenRouter key, so it can read TokenRouter's own bill for each request and hand the rows back; the
// report joins them to pairs by request id. Nothing here computes a price.
// ---------------------------------------------------------------------------------------------

export interface ClaimUsageRow {
  request_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface ClaimUsage {
  rows: ClaimUsageRow[];
  from: string;
  to: string;
  fetched_at: string;
  source: "tokenrouter_billing";
}

/** Shown when TokenRouter pairs carry no cost. */
export const TOKENROUTER_COST_NOTE =
  "This router does not report a cost per response. With your own key the report shows token counts and leaves dollars to you (take the counts to the router's current pricing page); with free credits the relay fills in the billed amounts.";

/**
 * TokenRouter's bills for a key-mode free-credit claim, as the relay reports them: `GET {relay}/api/claim/usage` with
 * the claim token (same auth as /api/balance). Returns a map request_id -> USD, or undefined for a relay-mode or
 * missing claim, or on any network or shape failure (costs then stay not_reported). Never throws.
 */
export async function fetchBilledCosts(credits: Credits | null, opts: { fetchImpl?: typeof fetch; relayUrl?: string } = {}): Promise<Record<string, number> | undefined> {
  if (!credits || credits.mode !== "key" || !credits.token) return undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${opts.relayUrl ?? RELAY_URL}/api/claim/usage`, { headers: { authorization: `Bearer ${credits.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const j = (await res.json()) as Partial<ClaimUsage>;
    if (!Array.isArray(j?.rows)) return undefined;
    const out: Record<string, number> = {};
    for (const r of j.rows) {
      const id = r?.request_id;
      const usd = Number(r?.cost_usd);
      if (typeof id === "string" && id && Number.isFinite(usd)) out[id] = (out[id] ?? 0) + usd;
    }
    return out;
  } catch {
    return undefined;
  }
}

export async function buildReport(opts: BuildOptions = {}): Promise<BuildResult> {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = loadConfig(cwd) ?? ({ primary: "openrouter", sample: 0.1, port: 4000, createdAt: "" } as Config);
  const records = await readLog(logPath(cwd));
  const say = opts.onProgress ?? (() => {});

  let judgements: Awaited<ReturnType<typeof judgeAll>> = { results: [], judged_now: 0, judge_cost_calls: 0 };
  let judgeLabel: string | null = null;
  const fraction = Math.min(1, Math.max(0, opts.judgeSample ?? 0.25));
  if (opts.judge !== false) {
    const ep = opts.judgeEndpoint !== undefined ? opts.judgeEndpoint : pickJudge(cfg, cwd);
    judgeLabel = ep?.label ?? null;
    say(ep ? `judging a ${Math.round(fraction * 100)}% sample with ${ep.label}` : "no judge model available; exact-match only");
    judgements = await judgeAll(records, { cwd, endpoint: ep, fraction, onProgress: (d, t) => say(`judged ${d}/${t}`) });
  }

  const targets = loadTargets();
  const targetMeta: AggregateInput["targetMeta"] = {};
  for (const t of targets) targetMeta[t.id] = { name: t.name, reportsCost: t.reportsCost, ...(t.id === "tokenrouter" ? { costHint: TOKENROUTER_COST_NOTE } : {}) };

  let billed: AggregateInput["billed"] | undefined;
  if (opts.billed === null) billed = undefined;
  else if (opts.billed !== undefined) billed = opts.billed;
  else if (records.some((r) => r.targets.some((s) => s.provider === "tokenrouter"))) {
    const credits = loadCredits(cwd);
    if (credits?.mode === "key") {
      say("reading the billed amounts for the free-credit key from the relay");
      const rows = await fetchBilledCosts(credits, { fetchImpl: opts.fetchImpl, relayUrl: opts.relayUrl });
      if (rows) billed = { tokenrouter: rows };
      else say("relay returned no bills; that router's costs stay not reported");
    }
  }

  const aggregates = aggregate({
    records,
    judgements: judgements.results,
    version: pkgVersion(),
    sampleRate: cfg.sample,
    judgeModel: judgeLabel,
    judgeFraction: fraction,
    targetMeta,
    billed,
    now: opts.now,
  });

  const dir = path.join(cwd, REPORT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, "index.html");
  const jsonPath = path.join(dir, "report.json");
  fs.writeFileSync(htmlPath, renderReportHtml(aggregates));
  fs.writeFileSync(jsonPath, JSON.stringify(aggregates, null, 2));
  return { aggregates, htmlPath, jsonPath, records: records.length, judged_now: judgements.judged_now };
}
