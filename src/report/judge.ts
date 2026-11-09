import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import type { LogRecord, SideResult } from "../proxy/logger.js";
import { chatCompletion } from "../proxy/openaiCall.js";

/**
 * How a verdict was reached. "exact": byte/normalized text equality (or one side empty). "json": field-by-field
 * comparison of parsed JSON or tool-call arguments. "numeric": short free text whose numbers match. "llm": the
 * model judge. "none": no verdict (skipped). aggregate.ts counts by these names; do not rename existing ones.
 */
export type JudgeMethod = "exact" | "json" | "numeric" | "llm" | "none";
export type AbOrder = "primary_first" | "target_first";

export interface JudgeResult {
  record_id: string;
  target: string;
  verdict: "agree" | "disagree" | "skipped";
  method: JudgeMethod;
  /** Why a pair was skipped: "truncated", "reasoning_leak", "no_judge_endpoint", or the judge call's error type. */
  note?: string;
  /** LLM verdicts only: which answer the judge saw first. Randomized per record to cancel position bias. */
  order?: AbOrder;
  /** LLM verdicts only: the judge's one-sentence reason naming the decisive fields, so a rate can be explained. */
  reason?: string;
}

/** A pair where either side stopped for `length` is a truncation, not a disagreement; it is counted separately. */
export function isTruncated(primary: SideResult, target: SideResult): boolean {
  return primary.finish_reason === "length" || target.finish_reason === "length";
}

export interface JudgeEndpoint {
  baseUrl: string;
  auth: string | null;
  model: string;
  headers?: Record<string, string>;
  label: string; // e.g. "openrouter/openai/gpt-4o-mini"
}

const SHORT = 200;

/** Wikipedia-style citation markers: "[1]", "[ 12 ]", "[citation needed]", "[note 3]", "[edit]". */
const CITATION_MARKER = /\[\s*(?:\d+|citation needed|clarification needed|note\s*\d+|edit)\s*\]/gi;

export function normalizeText(s: string): string {
  return s
    .replace(CITATION_MARKER, "")
    .replace(/\s+([,.;:!?)\]])/g, "$1") // "learning , the" -> "learning, the"
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/g, "");
}

function tryJson(s: string): any | undefined {
  const t = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

// ---------- reasoning leak ----------

const LEAK_KEYS = new Set(["analysis", "reasoning", "thinking", "thought", "thoughts"]);

/**
 * Some routes return the model's hidden reasoning as the content (seen from gpt-oss-120b: a JSON object whose only
 * key is "analysis", or harmony-format text starting with "analysis" / containing "<|channel|>"). That is a serving
 * defect, not an answer, so the pair is skipped with note "reasoning_leak" instead of being scored.
 */
export function isReasoningLeak(text: string | null | undefined): boolean {
  if (!text) return false;
  if (text.includes("<|channel|>")) return true;
  // lowercase "analysis" at the very start, followed by prose (harmony channel name leaking into content)
  if (/^\s*analysis(?:<\||[\s:,-]+[A-Za-z]|(?=[A-Z]))/.test(text)) return true;
  const j = tryJson(text);
  if (j && typeof j === "object" && !Array.isArray(j)) {
    const keys = Object.keys(j);
    if (keys.length === 1 && LEAK_KEYS.has(keys[0].toLowerCase())) return true;
  }
  return false;
}

// ---------- structural similarity ----------

/** null, undefined, "", [] and {} all mean "nothing here" and compare equal to each other. */
function isEmpty(v: any): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function isScalar(v: any): boolean {
  return v === null || typeof v !== "object";
}

function tokens(s: string): string[] {
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Partial credit for long strings that are mostly the same words (an excerpt reworded, a paragraph with a heading
 * inserted). Dice coefficient over word multisets; below 0.6 counts as different. Short strings get no partial credit
 * because a one-word difference there usually is the answer ("Reverse proxy" vs "Forward proxy").
 */
function longTextSim(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length < 8 || tb.length < 8) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      common++;
      counts.set(t, c - 1);
    }
  }
  const dice = (2 * common) / (ta.length + tb.length);
  return dice >= 0.6 ? dice : 0;
}

function leafSim(a: any, b: any): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea && eb) return 1;
  if (ea || eb) return 0;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 1 : 0;
  }
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b) ? 1 : 0;
  const sa = normalizeText(String(a));
  const sb = normalizeText(String(b));
  if (sa === sb) return 1;
  return longTextSim(sa, sb);
}

function scalarKey(v: any): string {
  if (isEmpty(v)) return "";
  if (typeof v === "string") return normalizeText(v);
  return JSON.stringify(v);
}

/** Arrays are compared as sets, not by position: one inserted element must not fail every element after it. */
function arraySim(a: any[], b: any[]): number {
  const n = Math.max(a.length, b.length);
  if (n === 0) return 1;
  if (a.every(isScalar) && b.every(isScalar)) {
    // multiset of normalized scalars, count-matched
    const counts = new Map<string, number>();
    for (const x of a) counts.set(scalarKey(x), (counts.get(scalarKey(x)) ?? 0) + 1);
    let matched = 0;
    for (const y of b) {
      const k = scalarKey(y);
      const c = counts.get(k) ?? 0;
      if (c > 0) {
        matched++;
        counts.set(k, c - 1);
      }
    }
    return matched / n;
  }
  // arrays of objects (or mixed): greedy best pairing by similarity
  const pairs: Array<{ i: number; j: number; s: number }> = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) pairs.push({ i, j, s: jsonSimilarity(a[i], b[j]) });
  pairs.sort((x, y) => y.s - x.s);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let sum = 0;
  for (const p of pairs) {
    if (p.s <= 0) break;
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    sum += p.s;
  }
  return sum / n;
}

/**
 * Structural similarity of two parsed JSON values, 0..1. Objects: mean over the union of keys (each field weighs the
 * same, a 40-element headings list does not drown the title). Arrays: set/multiset matching. Leaves: normalized
 * equality, with null / [] / "" / missing treated as equal, and partial credit for long reworded strings.
 */
export function jsonSimilarity(a: any, b: any): number {
  if (isEmpty(a) && isEmpty(b)) return 1;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    const xa = aArr ? a : isEmpty(a) ? [] : [a];
    const xb = bArr ? b : isEmpty(b) ? [] : [b];
    return arraySim(xa, xb);
  }
  const aObj = a !== null && typeof a === "object";
  const bObj = b !== null && typeof b === "object";
  if (aObj || bObj) {
    if (!aObj || !bObj) return 0; // object vs non-empty scalar
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (keys.size === 0) return 1;
    let sum = 0;
    for (const k of keys) sum += jsonSimilarity(a[k], b[k]);
    return sum / keys.size;
  }
  return leafSim(a, b);
}

// ---------- deterministic comparison ----------

export interface Comparison {
  verdict: JudgeResult["verdict"];
  method: "exact" | "json" | "numeric";
  /** Set for the json path. */
  similarity?: number;
}

/** Deterministic comparison. Returns undefined when an LLM judge is needed. */
export function compareSides(primary: SideResult, target: SideResult): Comparison | undefined {
  const a = primary.completion_text ?? "";
  const b = target.completion_text ?? "";
  const pt = primary.tool_calls ?? [];
  const tt = target.tool_calls ?? [];
  if (pt.length || tt.length) {
    // Tool calls: equal set of names and deep-equal parsed arguments => agree. Otherwise needs a judge.
    if (pt.length !== tt.length) return undefined;
    const pa = pt.map((c) => ({ n: c.name, a: tryJson(c.arguments) })).sort((x, y) => x.n.localeCompare(y.n));
    const ta = tt.map((c) => ({ n: c.name, a: tryJson(c.arguments) })).sort((x, y) => x.n.localeCompare(y.n));
    if (pa.every((x, i) => x.n === ta[i].n && deepEqual(x.a, ta[i].a))) return { verdict: "agree", method: "json" };
    return undefined;
  }
  if (!a && !b) return { verdict: "agree", method: "exact" };
  if (!a || !b) return { verdict: "disagree", method: "exact" };
  if (normalizeText(a) === normalizeText(b)) return { verdict: "agree", method: "exact" };
  const ja = tryJson(a);
  const jb = tryJson(b);
  if (ja !== undefined && jb !== undefined) {
    if (deepEqual(ja, jb)) return { verdict: "agree", method: "json", similarity: 1 };
    // Structured outputs: compare field by field. Extraction tasks produce long JSON where a model judge is both
    // expensive and unreliable; field-level similarity is a better signal.
    const sim = jsonSimilarity(ja, jb);
    if (sim >= 0.85) return { verdict: "agree", method: "json", similarity: sim };
    if (sim < 0.5) return { verdict: "disagree", method: "json", similarity: sim };
    return undefined; // middle ground: ask the judge
  }
  if (a.length <= SHORT && b.length <= SHORT) {
    // short free text: numeric or yes/no answers compare exactly
    const na = a.match(/-?\d+(\.\d+)?/g);
    const nb = b.match(/-?\d+(\.\d+)?/g);
    if (na && nb && na.length === nb.length && na.every((x, i) => Number(x) === Number(nb[i])) && normalizeText(a).length < 40) return { verdict: "agree", method: "numeric" };
  }
  return undefined;
}

/** Verdict only; see compareSides for the method. */
export function exactCompare(primary: SideResult, target: SideResult): JudgeResult["verdict"] | undefined {
  return compareSides(primary, target)?.verdict;
}

// ---------- LLM judge ----------

export function judgePrompt(task: string, a: string, b: string): string {
  const clip = (s: string) => (s.length > 6000 ? s.slice(0, 6000) + "\n[truncated]" : s);
  return [
    "You compare two answers to the same request, produced by the same model served through two different providers.",
    "Decide whether they are equivalent for the user's purpose: same facts, same decisions, same structure where structure was requested.",
    "Wording differences do not matter. Missing or contradictory information in something the request requires does.",
    "Fields the request leaves optional or unspecified are not decisive: null, an empty list and an omitted field mean the same thing; estimated values such as word counts or reading times may differ; more or fewer optional items (tags, sub-headings) are fine when the required extracted content matches.",
    "Reply with one sentence naming the fields that decide it and how they differ (for example: tags is a list in one and null in the other; text stops at 900 characters in one), then on the last line exactly one word: AGREE or DISAGREE.",
    "",
    "REQUEST (bulk content removed, may be truncated):",
    clip(task),
    "",
    "ANSWER A:",
    clip(a),
    "",
    "ANSWER B:",
    clip(b),
  ].join("\n");
}

/** Fallback when the prompt itself is not available: the log stores no prompt text by design. */
export function requestSummary(rec: LogRecord): string {
  return `model=${rec.canonical_model}; tools=${rec.request.has_tools}; response_format=${rec.request.response_format ?? "text"}`;
}

/** FNV-1a 32-bit. Used for deterministic sampling and A/B ordering by record id. */
export function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Deterministic 25% sample by record id so repeated `report` runs judge the same pairs. */
export function inSample(recordId: string, fraction = 0.25): boolean {
  return (fnv1a(recordId) % 10_000) / 10_000 < fraction;
}

/** Which answer the judge sees first. Stable per record id, independent of the sampling hash. */
export function abOrder(recordId: string): AbOrder {
  return fnv1a(`${recordId}|ab`) & 1 ? "target_first" : "primary_first";
}

function cachePath(cwd: string): string {
  return path.join(configDir(cwd), "judgements.jsonl");
}

export function loadJudgeCache(cwd = process.cwd()): Map<string, JudgeResult> {
  const m = new Map<string, JudgeResult>();
  try {
    for (const line of fs.readFileSync(cachePath(cwd), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const j = JSON.parse(line) as JudgeResult;
      m.set(`${j.record_id}|${j.target}`, j);
    }
  } catch {
    /* none */
  }
  return m;
}

export interface JudgeOptions {
  cwd?: string;
  fraction?: number;
  endpoint: JudgeEndpoint | null;
  /**
   * The request as the judge should see it (system prompt + instruction, bulk content stripped). The log does not
   * store prompts, so a caller that still has the prompt can supply it. Return undefined to fall back to
   * a one-line summary.
   */
  requestText?: (rec: LogRecord) => string | undefined;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Judge agreement for sampled pairs. Results are cached in .routearena/judgements.jsonl so re-running
 * `report` does not re-spend. Completions never leave the machine except to the judge endpoint.
 */
export async function judgeAll(records: LogRecord[], opts: JudgeOptions): Promise<{ results: JudgeResult[]; judged_now: number; judge_cost_calls: number }> {
  const cwd = opts.cwd ?? process.cwd();
  const cache = loadJudgeCache(cwd);
  const fraction = opts.fraction ?? 0.25;
  const todo: Array<{ rec: LogRecord; side: SideResult }> = [];
  const results: JudgeResult[] = [];
  for (const rec of records) {
    if (rec.primary.status !== "ok") continue;
    for (const side of rec.targets) {
      if (side.status !== "ok") continue;
      const key = `${rec.id}|${side.provider}`;
      const cached = cache.get(key);
      if (cached) {
        results.push(cached);
        continue;
      }
      if (!inSample(rec.id, fraction)) continue;
      if (isTruncated(rec.primary, side)) {
        results.push({ record_id: rec.id, target: side.provider, verdict: "skipped", method: "none", note: "truncated" });
        continue;
      }
      if (isReasoningLeak(rec.primary.completion_text) || isReasoningLeak(side.completion_text)) {
        results.push({ record_id: rec.id, target: side.provider, verdict: "skipped", method: "none", note: "reasoning_leak" });
        continue;
      }
      const cmp = compareSides(rec.primary, side);
      if (cmp) {
        const r: JudgeResult = { record_id: rec.id, target: side.provider, verdict: cmp.verdict, method: cmp.method };
        results.push(r);
        appendCache(cwd, r);
        continue;
      }
      todo.push({ rec, side });
    }
  }
  let judgedNow = results.length;
  let calls = 0;
  if (todo.length && opts.endpoint) {
    const ep = opts.endpoint;
    const conc = opts.concurrency ?? 4;
    let i = 0;
    let done = 0;
    const worker = async () => {
      while (i < todo.length) {
        const item = todo[i++];
        const order = abOrder(item.rec.id);
        const primaryText = item.rec.primary.completion_text ?? JSON.stringify(item.rec.primary.tool_calls ?? "");
        const targetText = item.side.completion_text ?? JSON.stringify(item.side.tool_calls ?? "");
        const [first, second] = order === "primary_first" ? [primaryText, targetText] : [targetText, primaryText];
        const prompt = judgePrompt(opts.requestText?.(item.rec) ?? requestSummary(item.rec), first, second);
        calls++;
        const r = await chatCompletion({
          baseUrl: ep.baseUrl,
          auth: ep.auth,
          headers: ep.headers,
          body: { model: ep.model, messages: [{ role: "user", content: prompt }], max_tokens: 160, temperature: 0 },
          timeoutMs: 45_000,
        });
        let res: JudgeResult;
        if (r.status !== "ok" || !r.completion_text) {
          res = { record_id: item.rec.id, target: item.side.provider, verdict: "skipped", method: "none", note: r.error_type ?? "judge_failed", order };
        } else {
          // AGREE/DISAGREE is symmetric in A and B, so the verdict maps back unchanged; the order is recorded so a
          // position bias in the judge would show up as a split between the two orders rather than as a skewed rate.
          const lines = r.completion_text.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const last = (lines[lines.length - 1] ?? "").toUpperCase().replace(/[^A-Z]/g, "");
          const verdictWord = last.startsWith("AGREE") ? "agree" : last.startsWith("DISAGREE") ? "disagree" : null;
          // Fallback for a judge that answers with the single word first and nothing else.
          const first = (lines[0] ?? "").toUpperCase().replace(/[^A-Z]/g, "");
          const verdict = verdictWord ?? (first === "AGREE" ? "agree" : first === "DISAGREE" ? "disagree" : "skipped");
          const reason = lines.slice(0, verdictWord ? -1 : undefined).join(" ").replace(/\s+/g, " ").slice(0, 300) || undefined;
          res = {
            record_id: item.rec.id,
            target: item.side.provider,
            verdict,
            method: "llm",
            order,
            ...(reason && verdict !== "skipped" ? { reason } : {}),
          };
        }
        results.push(res);
        if (res.verdict !== "skipped") appendCache(cwd, res);
        done++;
        judgedNow++;
        opts.onProgress?.(done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, todo.length) }, worker));
  } else {
    for (const item of todo) results.push({ record_id: item.rec.id, target: item.side.provider, verdict: "skipped", method: "none", note: "no_judge_endpoint" });
  }
  return { results, judged_now: judgedNow, judge_cost_calls: calls };
}

function appendCache(cwd: string, r: JudgeResult): void {
  fs.mkdirSync(configDir(cwd), { recursive: true });
  fs.appendFileSync(cachePath(cwd), JSON.stringify(r) + "\n");
}
