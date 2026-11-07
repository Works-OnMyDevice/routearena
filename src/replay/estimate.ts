import type { Target } from "../targets/index.js";
import { canonicalModel, computeCost, mapModel, suggestMapping } from "../targets/mapping.js";
import type { ParsedUsage, UsageRow } from "./csv.js";

export const OPENROUTER_TOPUP_FEE = 0.055; // 5.5% on credit purchases (card). Checked 2026-11-05.

export interface ModelLine {
  model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  current_cost_usd: number | null;
}

export interface TargetModelLine {
  model: string;
  target_model: string | null;
  requests: number;
  tokens: number;
  current_cost_usd: number | null;
  projected_cost_usd: number | null;
  mapped: boolean;
  suggestion?: string | null;
}

export interface TargetEstimate {
  target: string;
  name: string;
  /** Sum over mapped models only. */
  projected_usd: number;
  /** Current cost of the same mapped models (for an apples-to-apples delta). */
  comparable_current_usd: number;
  delta_usd: number;
  delta_pct: number | null;
  coverage_requests_pct: number;
  coverage_cost_pct: number | null;
  mapped_models: number;
  unmapped_models: number;
  gaps: Array<{ model: string; requests: number; current_cost_usd: number | null; suggestion: string | null }>;
  lines: TargetModelLine[];
  cost_source: "computed";
  prices_captured?: string;
  prices_source?: string;
}

export interface ReplayEstimate {
  period: { from: string; to: string; days: number } | null;
  /** Scale factor from the observed period to 30 days (1 when no dates). */
  monthly_factor: number;
  current: {
    cost_usd: number;
    cost_source: "measured" | "unknown";
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    monthly_usd: number;
    topup_fee_usd: number | null;
    topup_fee_note: string;
  };
  models: ModelLine[];
  targets: TargetEstimate[];
  warnings: string[];
}

export function aggregateRows(rows: UsageRow[]): ModelLine[] {
  const by = new Map<string, ModelLine>();
  for (const r of rows) {
    const canonical = canonicalModel("openrouter", r.model);
    const line = by.get(canonical) ?? { model: canonical, requests: 0, prompt_tokens: 0, completion_tokens: 0, current_cost_usd: 0 };
    line.requests += r.requests;
    line.prompt_tokens += r.prompt_tokens;
    line.completion_tokens += r.completion_tokens;
    if (r.cost_usd !== null && line.current_cost_usd !== null) line.current_cost_usd += r.cost_usd;
    by.set(canonical, line);
  }
  return [...by.values()].sort((a, b) => (b.current_cost_usd ?? 0) - (a.current_cost_usd ?? 0) || b.requests - a.requests);
}

function daysBetween(from: string, to: string): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

export function estimateTargets(models: ModelLine[], targets: Target[], monthlyFactor: number): TargetEstimate[] {
  const totalReq = models.reduce((s, m) => s + m.requests, 0) || 1;
  const totalCost = models.reduce((s, m) => s + (m.current_cost_usd ?? 0), 0);
  return targets.map((t) => {
    let projected = 0;
    let comparable = 0;
    let mappedReq = 0;
    let mappedCost = 0;
    const lines: TargetModelLine[] = [];
    const gaps: TargetEstimate["gaps"] = [];
    for (const m of models) {
      const mapped = mapModel(t, m.model);
      if (!mapped) {
        gaps.push({ model: m.model, requests: m.requests, current_cost_usd: m.current_cost_usd, suggestion: suggestMapping(t, m.model) });
        lines.push({ model: m.model, target_model: null, requests: m.requests, tokens: m.prompt_tokens + m.completion_tokens, current_cost_usd: m.current_cost_usd, projected_cost_usd: null, mapped: false, suggestion: suggestMapping(t, m.model) });
        continue;
      }
      const cost = computeCost(mapped.entry, { prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens }) ?? 0;
      projected += cost;
      comparable += m.current_cost_usd ?? 0;
      mappedReq += m.requests;
      mappedCost += m.current_cost_usd ?? 0;
      lines.push({ model: m.model, target_model: mapped.entry.id, requests: m.requests, tokens: m.prompt_tokens + m.completion_tokens, current_cost_usd: m.current_cost_usd, projected_cost_usd: cost, mapped: true });
    }
    const delta = projected - comparable;
    return {
      target: t.id,
      name: t.name,
      projected_usd: projected * monthlyFactor,
      comparable_current_usd: comparable * monthlyFactor,
      delta_usd: delta * monthlyFactor,
      delta_pct: comparable > 0 ? (delta / comparable) * 100 : null,
      coverage_requests_pct: (mappedReq / totalReq) * 100,
      coverage_cost_pct: totalCost > 0 ? (mappedCost / totalCost) * 100 : null,
      mapped_models: lines.filter((l) => l.mapped).length,
      unmapped_models: gaps.length,
      gaps: gaps.sort((a, b) => b.requests - a.requests),
      lines: lines.map((l) => ({ ...l, projected_cost_usd: l.projected_cost_usd === null ? null : l.projected_cost_usd * monthlyFactor, current_cost_usd: l.current_cost_usd === null ? null : l.current_cost_usd * monthlyFactor })),
      cost_source: "computed",
      prices_captured: t.pricesCaptured,
      prices_source: t.pricesSource,
    };
  });
}

export function estimateReplay(usage: ParsedUsage, targets: Target[], opts: { byok?: boolean } = {}): ReplayEstimate {
  const models = aggregateRows(usage.rows);
  const period = usage.dateRange ? { ...usage.dateRange, days: daysBetween(usage.dateRange.from, usage.dateRange.to) } : null;
  const monthlyFactor = period ? 30 / period.days : 1;
  const cost = models.reduce((s, m) => s + (m.current_cost_usd ?? 0), 0);
  const anyCost = models.some((m) => m.current_cost_usd !== null && m.current_cost_usd > 0);
  const requests = models.reduce((s, m) => s + m.requests, 0);
  const warnings = [...usage.warnings];
  if (!period) warnings.push("No date column found; totals are reported as-is rather than scaled to 30 days.");
  const monthly = cost * monthlyFactor;
  return {
    period,
    monthly_factor: monthlyFactor,
    current: {
      cost_usd: cost,
      cost_source: anyCost ? "measured" : "unknown",
      requests,
      prompt_tokens: models.reduce((s, m) => s + m.prompt_tokens, 0),
      completion_tokens: models.reduce((s, m) => s + m.completion_tokens, 0),
      monthly_usd: monthly,
      topup_fee_usd: opts.byok ? null : monthly * OPENROUTER_TOPUP_FEE,
      topup_fee_note: opts.byok
        ? "BYOK: OpenRouter's 5.5% credit top-up fee not applied (OpenRouter charges 5% of upstream cost on BYOK requests instead; not modeled)."
        : "OpenRouter charges 5.5% (min $0.80) when you buy credits by card. Shown separately; use --byok to hide it.",
    },
    models,
    targets: estimateTargets(models, targets, monthlyFactor),
    warnings,
  };
}
