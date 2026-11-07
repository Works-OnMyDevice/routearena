import { env } from "./env";
import { costFor, priceFor } from "./prices";

/**
 * Conservative upper bound on what one relay-mode request can cost, computed BEFORE forwarding.
 * - input tokens: characters / 3 (real tokenizers average ~4 chars/token; /3 over-estimates)
 * - output tokens: max_tokens, which the relay forces to at most RELAY_MAX_TOKENS
 * - multiplied by a safety factor for price-table drift
 * Unknown models are refused, not guessed; the CLI only mirrors mapped models anyway.
 */
export const SAFETY = 1.25;

export interface Estimate {
  usd: number;
  input_tokens: number;
  output_tokens: number;
}

export function estimateRequest(model: string, body: any): Estimate | null {
  if (!priceFor(model)) return null;
  const text = JSON.stringify(body?.messages ?? "") + JSON.stringify(body?.tools ?? "") + JSON.stringify(body?.response_format ?? "");
  const input_tokens = Math.ceil(text.length / 3);
  const requested = Number(body?.max_tokens ?? body?.max_completion_tokens ?? env.relayMaxTokens);
  const output_tokens = Math.min(Number.isFinite(requested) && requested > 0 ? requested : env.relayMaxTokens, env.relayMaxTokens);
  const n = Number(body?.n ?? 1);
  const usd = costFor(model, { prompt_tokens: input_tokens, completion_tokens: output_tokens }).usd * SAFETY * (n > 1 ? n : 1);
  return { usd, input_tokens, output_tokens };
}

/** Apply the limits the estimate assumed, so the real request cannot exceed it. */
export function constrainBody(body: any, est: Estimate): any {
  const out = { ...body };
  out.max_tokens = est.output_tokens;
  delete out.max_completion_tokens;
  if (out.n !== undefined && out.n !== 1) out.n = 1;
  return out;
}
