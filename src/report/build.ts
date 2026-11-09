import fs from "node:fs";
import path from "node:path";
import { PRIMARIES, RELAY_URL, REPORT_DIR, loadConfig, loadCredits, logPath, pkgVersion, type Config, type Credits } from "../config.js";
import { loadWorkload, type WorkloadPrompt } from "../demo/run.js";
import { readLog, type LogRecord } from "../proxy/logger.js";
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

function tryParse(s: string | null | undefined): any | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, ""));
  } catch {
    return undefined;
  }
}

/**
 * The instruction part of a demo user message: everything before the page content. Items carry the bulk after a
 * "JSON-LD:" and/or "PAGE TEXT:" marker, or (pages without JSON-LD) directly after the instruction paragraph, so the
 * first two paragraphs (URL + Fields line, then the instruction) are the stable part. The JSON-LD block is kept only
 * for an exact page match; for a template-level match it and the page URL belong to a different page and are dropped.
 */
export function stripBulk(user: string, exactPage: boolean): string {
  let head = user;
  const pt = head.indexOf("PAGE TEXT:");
  if (pt >= 0) head = head.slice(0, pt);
  const jl = head.indexOf("JSON-LD:");
  if (jl >= 0 && !exactPage) head = head.slice(0, jl);
  if (jl < 0) head = head.split(/\n\s*\n/).slice(0, 2).join("\n\n");
  if (!exactPage)
    head = head
      .split("\n")
      .filter((l) => !/^Page URL:/i.test(l))
      .join("\n");
  return head.trim();
}

/**
 * Reconstruct the request for records produced by `routearena demo`. The proxy logs no prompt text by design, so the
 * workload is matched to a record by page (the completion's url equals the item's source_url) or by template (the
 * completion's keys cover at least half of the template's "Fields:" line). Workload items carry no model: the agent
 * assigns models at run time, so every item is a candidate for every record. Returns undefined for records that are
 * not from the demo workload, and the judge falls back to a one-line summary.
 */
export function demoRequestText(items: WorkloadPrompt[]): (rec: LogRecord) => string | undefined {
  const fieldsOf = (it: WorkloadPrompt): string[] => {
    const u = it.messages.find((m) => m.role === "user")?.content ?? "";
    const m = u.match(/^Fields:\s*(.+)$/m);
    return m ? m[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  };
  const text = (it: WorkloadPrompt, exactPage: boolean): string => {
    const sys = it.messages.find((m) => m.role === "system")?.content?.trim();
    const user = it.messages.find((m) => m.role === "user")?.content ?? "";
    return [sys ? `SYSTEM: ${sys}` : null, `USER: ${stripBulk(user, exactPage)}`].filter(Boolean).join("\n\n");
  };
  const memo = new Map<string, string | undefined>();
  return (rec) => {
    if (!items.length) return undefined;
    const j = tryParse(rec.primary.completion_text);
    const obj = j && typeof j === "object" && !Array.isArray(j) ? j : undefined;
    const keys = obj ? Object.keys(obj).map((k) => k.toLowerCase()) : [];
    const url = obj ? [obj.url, obj.website, obj.source_url].find((v) => typeof v === "string") : undefined;
    const page = url ? items.find((it) => it.source_url === url || it.source_url.replace(/\/$/, "") === String(url).replace(/\/$/, "")) : undefined;
    if (page) return text(page, true);
    if (!keys.length) return undefined;
    let best: WorkloadPrompt | undefined;
    let bestScore = 0;
    for (const it of items) {
      const f = fieldsOf(it);
      if (!f.length) continue;
      const hit = f.filter((x) => keys.includes(x)).length / f.length;
      if (hit > bestScore) {
        bestScore = hit;
        best = it;
      }
    }
    if (!best || bestScore < 0.5) return undefined;
    const mk = best.template;
    if (!memo.has(mk)) memo.set(mk, text(best, false));
    return memo.get(mk);
  };
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
  "TokenRouter does not report cost per response; with your own TokenRouter key RouteArena shows token counts and leaves dollars to you (take the counts to TokenRouter's current pricing page); with free credits the relay fills in TokenRouter's billed amounts.";

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
    const workload = await loadWorkload().catch(() => [] as WorkloadPrompt[]);
    const requestText = workload.length ? demoRequestText(workload) : undefined;
    judgements = await judgeAll(records, { cwd, endpoint: ep, fraction, requestText, onProgress: (d, t) => say(`judged ${d}/${t}`) });
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
      say("reading TokenRouter's bills for the free-credit key from the relay");
      const rows = await fetchBilledCosts(credits, { fetchImpl: opts.fetchImpl, relayUrl: opts.relayUrl });
      if (rows) billed = { tokenrouter: rows };
      else say("relay did not return TokenRouter bills; TokenRouter costs stay not reported");
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
