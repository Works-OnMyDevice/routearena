/**
 * Terminal picture of the comparison, meant to be shown to the human verbatim by whatever agent ran the report.
 * One box, the traffic flow on top (your app, the primary, every mirrored target), then a scoreboard with bars.
 * Only reported numbers appear; a side with no reported cost shows its token counts instead of a dollar bar.
 * Dependency-free so the relay can copy it. Unicode box drawing by default; `ascii: true` falls back to +-| and #.
 */

interface Q {
  p50: number | null;
  p95?: number | null;
  n: number;
}
interface SideTokens {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
}
/** The slice of ReportAggregates this renderer reads. Kept loose so older report.json files still render. */
export interface AsciiInput {
  generated_at?: string;
  period?: { from: string; to: string } | null;
  sampling?: { mirrored: number };
  primary: {
    provider: string;
    requests: number;
    requests_ok?: number;
    cost_usd: number;
    cost_source?: string;
    avg_cost_per_request_usd?: number | null;
    latency: Q;
    ttft?: Q;
    ttft_method?: string | null;
    no_output?: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
  targets: Array<{
    target: string;
    name?: string;
    pairs: number;
    requests_mirrored?: number;
    headline?: { delta_pct: number | null; basis?: string; note?: string } | null;
    delta_pct?: number | null;
    measured?: { pairs: number; primary_cost_usd: number; target_cost_usd: number; delta_pct: number | null } | null;
    avg_cost_per_request_usd?: { primary: number | null; target: number | null } | null;
    cost_source?: string;
    cost_not_reported?: { primary: number; target: number } | null;
    tokens?: { primary: SideTokens; target: SideTokens } | null;
    latency: Q;
    ttft?: Q;
    primary_ttft?: Q;
    ttft_method?: string | null;
    no_output?: { primary: number; target: number } | null;
    error_rate?: number | null;
    errors?: number;
    agreement_rate?: number | null;
    agreement_judged?: number;
    rejected?: Array<{ model: string }>;
  }>;
}

export interface AsciiOptions {
  /** Total width in columns, 60 to 120. Default 78. */
  width?: number;
  /** Plain ASCII characters only (for terminals without box drawing). */
  ascii?: boolean;
}

const NAMES: Record<string, string> = { openrouter: "OpenRouter", openai: "OpenAI", tokenrouter: "TokenRouter", groq: "Groq", together: "Together", deepinfra: "DeepInfra", fireworks: "Fireworks" };
const nameOf = (id: string, name?: string) => name ?? NAMES[id] ?? id;

const usd = (n: number | null | undefined, d = 5): string => (n === null || n === undefined || !Number.isFinite(n) ? "–" : `$${n.toFixed(d)}`);
const ms = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "–" : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const int = (n: number | null | undefined): string => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString("en-US"));
const pct = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "" : `${n > 0 ? "+" : ""}${Math.abs(n) < 10 ? n.toFixed(1) : n.toFixed(0)}%`);

/** The mascot. Four lines, 20 columns. It sits beside the flow diagram and never grows. */
const HEDGEHOG = [
  "     ,;;;;;;;;;,    ",
  "  .-';;;;;;;;;;;'.  ",
  " ( o ;;;;;;;;;;;;; )",
  "  `-'`\"\"\"\"\"\"\"\"\"\"`-'",
];
const HEDGEHOG_W = 20;

export function renderAsciiComparison(a: AsciiInput, opts: AsciiOptions = {}): string {
  const W = Math.max(76, Math.min(120, opts.width ?? 80));
  const plain = !!opts.ascii;
  const C = plain
    ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", full: "#", empty: ".", arrow: "->", tee: "+", corner: "`", down: "|", dot: "*" }
    : { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", full: "█", empty: "░", arrow: "──▶", tee: "├", corner: "╰", down: "│", dot: "·" };
  const inner = W - 4; // "│ " + content + " │"
  const out: string[] = [];
  const fit = (s: string) => (s.length > inner ? s.slice(0, inner - 1) + "…" : s.padEnd(inner));
  const line = (s = "") => out.push(`${C.v} ${fit(s)} ${C.v}`);
  const rule = () => out.push(`${C.tee}${C.h.repeat(W - 2)}${plain ? "+" : "┤"}`);

  const primaryName = nameOf(a.primary.provider);
  const targets = a.targets.filter((t) => (t.pairs ?? 0) > 0 || (t.requests_mirrored ?? 0) > 0);
  const shown = targets.length ? targets : a.targets.slice(0, 1);

  // ---- header
  out.push(`${C.tl}${C.h.repeat(W - 2)}${C.tr}`);
  const when = a.period ? (a.period.from === a.period.to ? a.period.from : `${a.period.from} ${C.dot} ${a.period.to}`) : "";
  line(`RouteArena ${C.dot} ${int(a.primary.requests)} requests through ${primaryName}, ${int(a.sampling?.mirrored ?? shown.reduce((s, t) => s + (t.requests_mirrored ?? t.pairs), 0))} mirrored${when ? ` ${C.dot} ${when}` : ""}`);
  line();

  // ---- flow diagram with the hedgehog on the right
  const flow: string[] = [];
  flow.push(`your app ${C.arrow} ${primaryName} (primary)`);
  shown.forEach((t, i) => {
    const last = i === shown.length - 1;
    const joint = last ? C.corner : C.tee;
    flow.push(`   ${joint}${C.h} mirror ${C.arrow} ${nameOf(t.target, t.name)} (${int(t.pairs)} paired)`);
  });
  while (flow.length < HEDGEHOG.length) flow.push("");
  const flowWidth = Math.max(...flow.map((s) => s.length));
  const beside = flowWidth + 3 + HEDGEHOG_W <= inner;
  if (beside) {
    const gap = inner - flowWidth - HEDGEHOG_W;
    for (let i = 0; i < flow.length; i++) line(flow[i].padEnd(flowWidth) + " ".repeat(gap) + (HEDGEHOG[i] ?? ""));
    line("".padEnd(inner - 23) + "the hedgehog mirrors it");
  } else {
    for (const f of flow) if (f) line(f);
    for (const h of HEDGEHOG) line(h);
    line("the hedgehog mirrors it");
  }
  rule();

  // ---- scoreboard
  const label = (s: string) => s.padEnd(16);
  const side = (s: string) => s.padEnd(13);
  const barW = Math.max(10, Math.min(22, inner - 58)); // leaves room for "  +31%  (billed)" after the bar at 76 columns
  const bar = (v: number | null | undefined, max: number) => {
    if (v === null || v === undefined || !Number.isFinite(v) || max <= 0) return " ".repeat(barW);
    const n = Math.max(1, Math.round((v / max) * barW));
    return C.full.repeat(Math.min(barW, n)) + C.empty.repeat(Math.max(0, barW - n));
  };

  for (const t of shown) {
    const tName = nameOf(t.target, t.name);
    const m = t.measured;
    const pAvg = t.avg_cost_per_request_usd?.primary ?? (m && m.pairs ? m.primary_cost_usd / m.pairs : a.primary.avg_cost_per_request_usd ?? null);
    const tAvg = t.avg_cost_per_request_usd?.target ?? (m && m.pairs && m.target_cost_usd > 0 ? m.target_cost_usd / m.pairs : null);
    const delta = t.headline?.delta_pct ?? m?.delta_pct ?? t.delta_pct ?? null;
    const tok = t.tokens;

    if (shown.length > 1) {
      line(`${tName}`.toUpperCase());
    }
    // cost
    if (tAvg !== null && pAvg !== null) {
      const max = Math.max(pAvg, tAvg);
      line(`${label("cost / request")}${side(primaryName)}${usd(pAvg).padStart(10)}  ${bar(pAvg, max)}`);
      line(`${label("")}${side(tName)}${usd(tAvg).padStart(10)}  ${bar(tAvg, max)}  ${pct(delta)}${t.cost_source === "billed" ? "  (billed)" : ""}`);
    } else {
      line(`${label("cost / request")}${side(primaryName)}${usd(pAvg).padStart(10)}  ${pAvg === null ? "not reported" : "as reported by " + primaryName}`);
      line(`${label("")}${side(tName)}${"–".padStart(10)}  not reported by ${tName}`);
      line(`${label("")}(price the token counts below yourself; not estimated)`);
    }
    // tokens
    if (tok) {
      const pair = (x: number | undefined, y: number | undefined) => `${int(x ?? 0).padStart(9)} ${C.dot} ${int(y ?? 0).padStart(8)}`;
      line(`${label(`tokens in ${C.dot} out`)}${side(primaryName)}${pair(tok.primary.prompt_tokens, tok.primary.completion_tokens)}`);
      line(`${label("")}${side(tName)}${pair(tok.target.prompt_tokens, tok.target.completion_tokens)}`);
      line(`${label(`think ${C.dot} cached`)}${side(primaryName)}${pair(tok.primary.reasoning_tokens, tok.primary.cached_tokens)}  (reasoning, cached)`);
      line(`${label("")}${side(tName)}${pair(tok.target.reasoning_tokens, tok.target.cached_tokens)}`);
    }
    // latency
    const pl = a.primary.latency?.p50 ?? null, tl = t.latency?.p50 ?? null;
    const lmax = Math.max(pl ?? 0, tl ?? 0);
    line(`${label("latency p50")}${side(primaryName)}${ms(pl).padStart(10)}  ${bar(pl, lmax)}`);
    line(`${label("")}${side(tName)}${ms(tl).padStart(10)}  ${bar(tl, lmax)}`);
    // ttft
    if (t.ttft_method && t.ttft && t.ttft.n > 0 && t.primary_ttft) {
      const pt = t.primary_ttft.p50 ?? null, tt = t.ttft.p50 ?? null;
      const tmax = Math.max(pt ?? 0, tt ?? 0);
      line(`${label("first token p50")}${side(primaryName)}${ms(pt).padStart(10)}  ${bar(pt, tmax)}`);
      line(`${label("")}${side(tName)}${ms(tt).padStart(10)}  ${bar(tt, tmax)}`);
      line(`${label("")}(${t.ttft_method === "first-content" ? "first content token" : "first byte"} on both sides)`);
    } else {
      line(`${label("first token p50")}not comparable here (sides measured differently)`);
    }
    // outcomes
    const no = t.no_output ?? { primary: a.primary.no_output ?? 0, target: 0 };
    const err = t.error_rate === null || t.error_rate === undefined ? "–" : `${(t.error_rate * 100).toFixed(1)}%`;
    line(`${label("empty answers")}${primaryName} ${int(no.primary)} ${C.dot} ${tName} ${int(no.target)} ${C.dot} ${tName} errors ${err}`);
    if (t.rejected?.length) line(`${label("rejected models")}${t.rejected.map((r) => r.model).join(", ")}`);
    // agreement
    if (t.agreement_rate !== null && t.agreement_rate !== undefined && (t.agreement_judged ?? 0) > 0) {
      const agreed = Math.round(t.agreement_rate * (t.agreement_judged ?? 0));
      line(`${label("same answer?")}${agreed} of ${t.agreement_judged} judged pairs equivalent  ${bar(t.agreement_rate, 1)}`);
      line(`${label("")}(a router asked twice does not match itself 100% either)`);
    } else {
      line(`${label("same answer?")}not judged`);
    }
    if (t !== shown[shown.length - 1]) line();
  }

  rule();
  line(`costs are what each router reported or billed; no price list inside`);
  line(`full numbers: routearena-report/report.json`);
  out.push(`${C.bl}${C.h.repeat(W - 2)}${C.br}`);
  return out.join("\n");
}
