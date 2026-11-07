import { clientIp, env, json, logEvent } from "../lib/env";
import { state } from "../lib/store";
import { randomId } from "../lib/token";

const FORBIDDEN = new Set(["messages", "content", "prompt", "completion", "completion_text", "tool_calls", "arguments", "text", "input", "output"]);
const MAX_STRING = 500;
const MAX_BYTES = 400_000;

/** Reject anything that could carry prompt or completion text. Returns a reason or null. */
export function validateAggregates(obj: unknown, path = "$", depth = 0): string | null {
  if (depth > 12) return `${path}: too deep`;
  if (typeof obj === "string") return obj.length > MAX_STRING ? `${path}: string longer than ${MAX_STRING}` : null;
  if (Array.isArray(obj)) {
    if (obj.length > 2000) return `${path}: array too long`;
    for (let i = 0; i < obj.length; i++) {
      const r = validateAggregates(obj[i], `${path}[${i}]`, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN.has(k)) return `${path}.${k}: field not allowed`;
      const r = validateAggregates(v, `${path}.${k}`, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** POST /api/publish { aggregates } -> { id, url } */
export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  if (!(await state().rateLimit(`rl:publish:ip:${ip}`, 30, 86400))) return json({ error: "Too many publishes today from this network." }, 429);
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json({ error: `Payload over ${MAX_BYTES} bytes. Aggregates only, please.` }, 413);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Body is not JSON" }, 400);
  }
  const agg = body?.aggregates;
  if (!agg || agg.v !== 1 || !agg.primary || !Array.isArray(agg.targets)) return json({ error: "Missing or malformed aggregates (expected v:1 with primary and targets)" }, 400);
  const bad = validateAggregates(agg);
  if (bad) return json({ error: `Rejected: ${bad}` }, 400);
  const id = randomId(8);
  await state().putReport(id, JSON.stringify(agg));
  logEvent("published", { id, targets: agg.targets.length, requests: agg.primary.requests });
  return json({ id, url: `${env.publicBase}/r/${id}` });
}
