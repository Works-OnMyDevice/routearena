import fs from "node:fs";
import { CliError } from "../config.js";

/** One usage row after normalization: a model with token counts, cost, request count, and optional date. */
export interface UsageRow {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  requests: number;
  cost_usd: number | null;
  date?: string;
  provider?: string;
  byok?: boolean;
}

export interface ParsedUsage {
  rows: UsageRow[];
  columns: string[];
  detected: Record<string, string | null>;
  /** First date and last date seen, ISO (date only), if any. */
  dateRange: { from: string; to: string } | null;
  perModel: boolean;
  warnings: string[];
}

/** RFC4180-ish CSV parser (handles quotes, embedded commas/newlines, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Candidate header names, most specific first. Matching is on normalized header text. */
const COLUMN_CANDIDATES: Record<string, string[]> = {
  model: ["model", "model_permaslug", "model_id", "model_name", "model_slug"],
  prompt_tokens: ["prompt_tokens", "tokens_prompt", "input_tokens", "native_tokens_prompt", "prompt"],
  completion_tokens: ["completion_tokens", "tokens_completion", "output_tokens", "native_tokens_completion", "completion"],
  reasoning_tokens: ["reasoning_tokens", "tokens_reasoning"],
  total_tokens: ["total_tokens", "tokens", "token_count"],
  cost: ["cost", "usage", "spend", "total_cost", "cost_usd", "usd", "amount", "price"],
  byok_cost: ["byok_usage_inference", "byok_usage", "byok_cost"],
  requests: ["requests", "request_count", "count", "num_requests", "generations"],
  date: ["date", "day", "created_at", "timestamp", "time", "created"],
  provider: ["provider", "provider_name"],
  byok: ["byok", "is_byok"],
};

function detectColumns(headers: string[]): Record<string, string | null> {
  const normHeaders = headers.map(norm);
  const out: Record<string, string | null> = {};
  for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    out[field] = null;
    for (const cand of candidates) {
      const idx = normHeaders.indexOf(cand);
      if (idx >= 0) {
        out[field] = headers[idx];
        break;
      }
    }
    if (!out[field]) {
      // fuzzy: header contains the candidate token
      for (const cand of candidates) {
        const idx = normHeaders.findIndex((h) => h.includes(cand) && !(field !== "cost" && h.includes("cost")));
        if (idx >= 0) {
          out[field] = headers[idx];
          break;
        }
      }
    }
  }
  // Avoid "total_tokens" matching the same column as prompt/completion
  if (out.total_tokens && (out.total_tokens === out.prompt_tokens || out.total_tokens === out.completion_tokens)) out.total_tokens = null;
  return out;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.replace(/[$,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toIsoDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : undefined;
  }
  return d.toISOString().slice(0, 10);
}

export function parseUsageCsv(text: string): ParsedUsage {
  const table = parseCsv(text.replace(/^ /, ""));
  if (table.length < 2) {
    throw new CliError("The CSV has no data rows.", "Export your OpenRouter Activity (Activity page > click the Model card > Export) and pass that file.");
  }
  const headers = table[0].map((h) => h.trim());
  const detected = detectColumns(headers);
  const warnings: string[] = [];
  if (!detected.model) {
    const preview = table.slice(0, 3).map((r) => r.join(",")).join("\n");
    throw new CliError(
      `Could not find a model column in the CSV. Columns seen: ${headers.join(", ")}`,
      `This looks like a totals-only export. On openrouter.ai/activity, click the "Model" card so the table is broken down per model, then Export > CSV. First lines of your file:\n${preview}`,
    );
  }
  if (!detected.prompt_tokens && !detected.completion_tokens && !detected.total_tokens) {
    warnings.push("No token columns found; projected costs will be based on cost ratios only where possible.");
  }
  const idx = (name: string | null) => (name ? headers.indexOf(name) : -1);
  const iModel = idx(detected.model);
  const iP = idx(detected.prompt_tokens);
  const iC = idx(detected.completion_tokens);
  const iR = idx(detected.reasoning_tokens);
  const iT = idx(detected.total_tokens);
  const iCost = idx(detected.cost);
  const iByokCost = idx(detected.byok_cost);
  const iReq = idx(detected.requests);
  const iDate = idx(detected.date);
  const iProv = idx(detected.provider);
  const iByok = idx(detected.byok);

  const rows: UsageRow[] = [];
  for (const r of table.slice(1)) {
    const model = (r[iModel] ?? "").trim().toLowerCase();
    if (!model) continue;
    let p = iP >= 0 ? num(r[iP]) ?? 0 : 0;
    let c = iC >= 0 ? num(r[iC]) ?? 0 : 0;
    if (iR >= 0) c += num(r[iR]) ?? 0; // reasoning tokens are billed as output
    if (iP < 0 && iC < 0 && iT >= 0) {
      // Only totals: assume a 3:1 prompt:completion split and warn.
      const t = num(r[iT]) ?? 0;
      p = Math.round(t * 0.75);
      c = t - p;
      if (!warnings.includes("split")) warnings.push("split");
    }
    let cost = iCost >= 0 ? num(r[iCost]) : null;
    if (iByokCost >= 0) {
      const b = num(r[iByokCost]);
      if (b && (!cost || cost === 0)) cost = b;
    }
    const requests = iReq >= 0 ? num(r[iReq]) ?? 1 : 1;
    const byok = iByok >= 0 ? /^(true|1|yes)$/i.test((r[iByok] ?? "").trim()) : undefined;
    rows.push({
      model,
      prompt_tokens: p,
      completion_tokens: c,
      requests,
      cost_usd: cost,
      date: iDate >= 0 ? toIsoDate(r[iDate]) : undefined,
      provider: iProv >= 0 ? r[iProv]?.trim() : undefined,
      byok,
    });
  }
  const splitIdx = warnings.indexOf("split");
  if (splitIdx >= 0) warnings[splitIdx] = "Only total token counts were present; a 3:1 prompt:completion split was assumed for projections.";

  const dates = rows.map((r) => r.date).filter((d): d is string => !!d).sort();
  return {
    rows,
    columns: headers,
    detected,
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    perModel: true,
    warnings,
  };
}

export function readUsageCsvFile(file: string): ParsedUsage {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new CliError(`Cannot read ${file}.`, "Check the path. Export from openrouter.ai/activity (click the Model card, then Export > CSV).");
  }
  return parseUsageCsv(text);
}
