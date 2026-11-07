import fs from "node:fs";
import path from "node:path";
import { PRIMARIES, REPORT_DIR, loadConfig, loadCredits, logPath, pkgVersion, type Config } from "../config.js";
import { loadWorkload, type WorkloadItem } from "../demo/run.js";
import { readLog, type LogRecord } from "../proxy/logger.js";
import { loadTargets, resolveTargets } from "../targets/index.js";
import { suggestMapping } from "../targets/mapping.js";
import { aggregate, type ReportAggregates } from "./aggregate.js";
import { renderReportHtml } from "./html.js";
import { judgeAll, type JudgeEndpoint } from "./judge.js";

export interface BuildOptions {
  cwd?: string;
  byok?: boolean;
  judge?: boolean; // default true
  judgeSample?: number; // fraction of pairs to judge, default 0.25
  /** Override the judge endpoint (default: pickJudge). */
  judgeEndpoint?: JudgeEndpoint | null;
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
 * workload is matched to a record by model, then by page (the completion's url equals the item's source_url) or by
 * template (the completion's keys cover at least half of the template's "Fields:" line). Returns undefined for
 * records that are not from the demo workload, and the judge falls back to a one-line summary.
 */
export function demoRequestText(items: WorkloadItem[]): (rec: LogRecord) => string | undefined {
  const fieldsOf = (it: WorkloadItem): string[] => {
    const u = it.messages.find((m) => m.role === "user")?.content ?? "";
    const m = u.match(/^Fields:\s*(.+)$/m);
    return m ? m[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  };
  const text = (it: WorkloadItem, exactPage: boolean): string => {
    const sys = it.messages.find((m) => m.role === "system")?.content?.trim();
    const user = it.messages.find((m) => m.role === "user")?.content ?? "";
    return [sys ? `SYSTEM: ${sys}` : null, `USER: ${stripBulk(user, exactPage)}`].filter(Boolean).join("\n\n");
  };
  const memo = new Map<string, string | undefined>();
  return (rec) => {
    const cands = items.filter((it) => it.model.toLowerCase() === rec.canonical_model.toLowerCase());
    if (!cands.length) return undefined;
    const j = tryParse(rec.primary.completion_text);
    const obj = j && typeof j === "object" && !Array.isArray(j) ? j : undefined;
    const keys = obj ? Object.keys(obj).map((k) => k.toLowerCase()) : [];
    const url = obj ? [obj.url, obj.website, obj.source_url].find((v) => typeof v === "string") : undefined;
    const page = url ? cands.find((it) => it.source_url === url || it.source_url.replace(/\/$/, "") === String(url).replace(/\/$/, "")) : undefined;
    if (page) return text(page, true);
    if (!keys.length) return undefined;
    let best: WorkloadItem | undefined;
    let bestScore = 0;
    for (const it of cands) {
      const f = fieldsOf(it);
      if (!f.length) continue;
      const hit = f.filter((x) => keys.includes(x)).length / f.length;
      if (hit > bestScore) {
        bestScore = hit;
        best = it;
      }
    }
    if (!best || bestScore < 0.5) return undefined;
    const mk = `${best.model}|${best.template}`;
    if (!memo.has(mk)) memo.set(mk, text(best, false));
    return memo.get(mk);
  };
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
    const workload = await loadWorkload().catch(() => [] as WorkloadItem[]);
    const requestText = workload.length ? demoRequestText(workload) : undefined;
    judgements = await judgeAll(records, { cwd, endpoint: ep, fraction, requestText, onProgress: (d, t) => say(`judged ${d}/${t}`) });
  }

  const targets = loadTargets();
  const targetMeta: Record<string, { name: string; pricesCaptured?: string; pricesSource?: string }> = {};
  for (const t of targets) targetMeta[t.id] = { name: t.name, pricesCaptured: t.pricesCaptured, pricesSource: t.pricesSource };

  const aggregates = aggregate({
    records,
    judgements: judgements.results,
    version: pkgVersion(),
    sampleRate: cfg.sample,
    byok: !!(opts.byok ?? cfg.byok),
    judgeModel: judgeLabel,
    judgeFraction: fraction,
    targetMeta,
    suggestions: (target, model) => {
      const t = targets.find((x) => x.id === target);
      return t ? suggestMapping(t, model) : null;
    },
  });

  const dir = path.join(cwd, REPORT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, "index.html");
  const jsonPath = path.join(dir, "report.json");
  fs.writeFileSync(htmlPath, renderReportHtml(aggregates));
  fs.writeFileSync(jsonPath, JSON.stringify(aggregates, null, 2));
  return { aggregates, htmlPath, jsonPath, records: records.length, judged_now: judgements.judged_now };
}
