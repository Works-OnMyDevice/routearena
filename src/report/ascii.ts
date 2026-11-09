/**
 * Terminal picture of the comparison, meant to be shown to the human verbatim by whatever agent ran the report.
 *
 * One box. The top is a flow diagram: the app, the router it already uses, and every router the traffic was mirrored
 * to, with the mascot watching. Below it a scoreboard, one block per mirrored router: cost per request, tokens, speed,
 * answers. Only numbers the routers themselves reported appear; a router that reported no cost says so and shows its
 * token counts instead of a dollar bar. Dependency-free so the relay can copy it. Unicode box drawing by default;
 * `ascii: true` falls back to +-| and #. Every line is exactly `width` columns.
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
  /** Total width in columns, 76 to 120. Default 80. */
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

/** The mascot: a hedgehog, 5 lines, 24 columns. It sits at the right of the flow diagram and never changes size. */
const HEDGEHOG = [
  "      ,;;;;;;;;;;,    ",
  "   .-';;;;;;;;;;;;'.  ",
  "  ( o ;;;;;;;;;;;;;; )",
  "   `-'`\"\"\"\"\"\"\"\"\"\"\"`-'",
  " mirrors your traffic ",
];
const HEDGEHOG_W = 22;

export function renderAsciiComparison(a: AsciiInput, opts: AsciiOptions = {}): string {
  const W = Math.max(76, Math.min(120, opts.width ?? 80));
  const plain = !!opts.ascii;
  const C = plain
    ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", lt: "+", rt: "+", full: "#", empty: ".", arrow: "->", dot: "*", bl2: "+", br2: "+", tl2: "+", tr2: "+", v2: "|", h2: "-", slash: "\\", hook: "`->" }
    : { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", lt: "├", rt: "┤", full: "█", empty: "░", arrow: "──▶", dot: "·", bl2: "└", br2: "┘", tl2: "┌", tr2: "┐", v2: "│", h2: "─", slash: "╲", hook: "╰─▶" };
  const inner = W - 4; // "│ " + content + " │"
  const out: string[] = [];
  const fit = (s: string) => (s.length > inner ? s.slice(0, inner - 1) + "…" : s.padEnd(inner));
  const line = (s = "") => out.push(`${C.v} ${fit(s)} ${C.v}`);
  const rule = (title?: string) => {
    if (!title) return out.push(`${C.lt}${C.h.repeat(W - 2)}${C.rt}`);
    const t = ` ${title} `;
    out.push(`${C.lt}${C.h.repeat(3)}${t}${C.h.repeat(Math.max(0, W - 2 - 3 - t.length))}${C.rt}`);
  };
  const center = (s: string) => {
    const pad = Math.max(0, inner - s.length);
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + s + " ".repeat(pad - left);
  };

  const primaryName = nameOf(a.primary.provider);
  const live = a.targets.filter((t) => (t.pairs ?? 0) > 0 || (t.requests_mirrored ?? 0) > 0);
  const shown = live.length ? live : a.targets.slice(0, 1);
  const mirrored = a.sampling?.mirrored ?? shown.reduce((s, t) => s + (t.requests_mirrored ?? t.pairs), 0);
  const when = a.period ? (a.period.from === a.period.to ? a.period.from : `${a.period.from} to ${a.period.to}`) : "";

  // ---- header
  out.push(`${C.tl}${C.h.repeat(W - 2)}${C.tr}`);
  line(center("R o u t e A r e n a"));
  line(center("same prompts, two routers, nothing estimated"));
  line(center(`${int(a.primary.requests)} requests through ${primaryName} ${C.dot} ${int(mirrored)} mirrored${when ? ` ${C.dot} ${when}` : ""}`));
  rule();

  // ---- flow diagram: boxed names, one branch per target, mascot on the right
  const box = (label: string): string[] => {
    const w = label.length + 4;
    return [`${C.tl2}${C.h2.repeat(w - 2)}${C.tr2}`, `${C.v2} ${label} ${C.v2}`, `${C.bl2}${C.h2.repeat(w - 2)}${C.br2}`];
  };
  const app = box("your app"), prim = box(primaryName);
  const flow: string[] = [];
  const sp = " ".repeat(C.arrow.length + 2);
  const mark = plain ? "<" : "◀";
  flow.push(`${app[0]}${sp}${prim[0]}`);
  flow.push(`${app[1]} ${C.arrow} ${prim[1]} ${mark} answers you`);
  flow.push(`${app[2]}   ${C.slash}${" ".repeat(sp.length - 4)}${prim[2]}`);
  const indent = app[0].length + 4;
  shown.forEach((t, i) => {
    const b = box(nameOf(t.target, t.name));
    const pad = " ".repeat(indent);
    flow.push(`${pad}${C.slash} mirror ${b[0]}`);
    flow.push(`${pad} ${C.hook}     ${b[1]} ${mark} ${int(t.pairs)} paired`);
    flow.push(`${pad}         ${b[2]}`);
    if (i < shown.length - 1) flow.push("");
  });
  const flowWidth = Math.max(...flow.map((s) => s.length));
  const beside = flowWidth + 2 + HEDGEHOG_W <= inner;
  if (beside) {
    const rows = Math.max(flow.length, HEDGEHOG.length);
    const gap = inner - flowWidth - HEDGEHOG_W;
    const top = Math.max(0, Math.floor((flow.length - HEDGEHOG.length) / 2));
    for (let i = 0; i < rows; i++) line((flow[i] ?? "").padEnd(flowWidth) + " ".repeat(gap) + (HEDGEHOG[i - top] ?? ""));
  } else {
    for (const f of flow) line(f);
    for (const h of HEDGEHOG) line(h);
  }

  // ---- scoreboard
  const label = (s: string) => s.padEnd(16);
  const side = (s: string) => s.padEnd(13);
  const barW = Math.max(10, Math.min(22, inner - 58));
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

    rule(shown.length > 1 ? `${primaryName} vs ${tName}` : "scoreboard");
    // cost
    if (tAvg !== null && pAvg !== null) {
      const max = Math.max(pAvg, tAvg);
      line(`${label("cost / request")}${side(primaryName)}${usd(pAvg).padStart(10)}  ${bar(pAvg, max)}`);
      line(`${label("")}${side(tName)}${usd(tAvg).padStart(10)}  ${bar(tAvg, max)}  ${pct(delta)}${t.cost_source === "billed" ? "  (billed)" : ""}`);
      line(`${label("")}${t.cost_source === "billed" ? `billed by ${tName} for your free-credit key` : "each side's own reported charge"}`);
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
    // speed
    const pl = a.primary.latency?.p50 ?? null, tl = t.latency?.p50 ?? null;
    const lmax = Math.max(pl ?? 0, tl ?? 0);
    line(`${label("latency p50")}${side(primaryName)}${ms(pl).padStart(10)}  ${bar(pl, lmax)}`);
    line(`${label("")}${side(tName)}${ms(tl).padStart(10)}  ${bar(tl, lmax)}`);
    if (t.ttft_method && t.ttft && t.ttft.n > 0 && t.primary_ttft) {
      const pt = t.primary_ttft.p50 ?? null, tt = t.ttft.p50 ?? null;
      const tmax = Math.max(pt ?? 0, tt ?? 0);
      line(`${label("first token p50")}${side(primaryName)}${ms(pt).padStart(10)}  ${bar(pt, tmax)}`);
      line(`${label("")}${side(tName)}${ms(tt).padStart(10)}  ${bar(tt, tmax)}`);
      line(`${label("")}(${t.ttft_method === "first-content" ? "first content token" : "first byte"} on both sides)`);
    } else {
      line(`${label("first token p50")}not comparable here (sides measured differently)`);
    }
    // answers
    const no = t.no_output ?? { primary: a.primary.no_output ?? 0, target: 0 };
    const err = t.error_rate === null || t.error_rate === undefined ? "–" : `${(t.error_rate * 100).toFixed(1)}%`;
    line(`${label("empty answers")}${primaryName} ${int(no.primary)} ${C.dot} ${tName} ${int(no.target)} ${C.dot} ${tName} errors ${err}`);
    if (t.rejected?.length) line(`${label("rejected models")}${t.rejected.map((r) => r.model).join(", ")}`);
    if (t.agreement_rate !== null && t.agreement_rate !== undefined && (t.agreement_judged ?? 0) > 0) {
      const agreed = Math.round(t.agreement_rate * (t.agreement_judged ?? 0));
      line(`${label("same answer?")}${agreed} of ${t.agreement_judged} judged pairs equivalent  ${bar(t.agreement_rate, 1)}`);
      line(`${label("")}(a router asked twice does not match itself 100% either)`);
    } else {
      line(`${label("same answer?")}not judged`);
    }
  }

  rule();
  line("costs are what each router reported or billed; no price list inside");
  line("full numbers: routearena-report/report.json");
  out.push(`${C.bl}${C.h.repeat(W - 2)}${C.br}`);
  return out.join("\n");
}
