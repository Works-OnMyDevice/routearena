import table from "./tokenrouter-prices.json";

interface Entry {
  id: string;
  input_per_m: number;
  output_per_m: number;
  cached_input_per_m?: number;
}

const byTokenRouterId: Record<string, Entry> = {};
for (const e of Object.values((table as any).models as Record<string, Entry>)) byTokenRouterId[e.id.toLowerCase()] = e;

export function priceFor(model: string): Entry | null {
  return byTokenRouterId[model.toLowerCase()] ?? null;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Computed cost. Unknown models are charged at a conservative default so the budget cannot be bypassed. */
export function costFor(model: string, usage: Usage | null | undefined): { usd: number; known: boolean } {
  const e = priceFor(model);
  const p = usage?.prompt_tokens ?? 0;
  const c = usage?.completion_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  if (!e) return { usd: ((p + c) * 15) / 1e6, known: false }; // $15/M flat for unknown models
  const inRate = e.input_per_m / 1e6;
  const cachedRate = (e.cached_input_per_m ?? e.input_per_m) / 1e6;
  return { usd: Math.max(0, p - cached) * inRate + cached * cachedRate + c * (e.output_per_m / 1e6), known: true };
}
