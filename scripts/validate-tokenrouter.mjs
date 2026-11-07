#!/usr/bin/env node
// TokenRouter-only validation (runs when the OpenRouter balance is empty). Spend-guarded, default cap $0.10.
//   node scripts/validate-tokenrouter.mjs [--cap 0.10]
// A. Batch billing truth: billing meter before/after 12 requests vs computeCost(price table, reported usage).
// B. qwen3.8-flash reasoning_effort honored? (low vs omitted, two prompts) — repetition for scripts/validate.mjs §5.
import fs from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
const imp = (p) => import(path.join(ROOT, p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
const { loadDotenv } = await imp("dist/config.js");
const { computeCost } = await imp("dist/targets/mapping.js");
loadDotenv();
const TR = process.env.TOKENROUTER_API_KEY;
if (!TR) throw new Error("TOKENROUTER_API_KEY missing");
const args = process.argv.slice(2);
const CAP = Number(args.includes("--cap") ? args[args.indexOf("--cap") + 1] : "0.10");
const prices = JSON.parse(fs.readFileSync("targets/tokenrouter.json", "utf8")).models;
const W = fs.readFileSync("demo/workload.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let spent = 0;
async function meter() {
  const r = await fetch("https://api.tokenrouter.com/v1/dashboard/billing/usage", { headers: { authorization: `Bearer ${TR}` }, signal: AbortSignal.timeout(10000) });
  return (await r.json()).total_usage / 100; // reported in cents
}
async function settled(prev) {
  let last = await meter();
  for (let i = 0; i < 12; i++) { await sleep(4000); const v = await meter(); if (v === last && v !== prev) return v; last = v; }
  return last;
}
async function call(body) {
  const t0 = Date.now();
  const res = await fetch("https://api.tokenrouter.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${TR}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const j = await res.json();
  return { status: res.status, ms: Date.now() - t0, j };
}

console.log("=== A. Batch billing truth (TokenRouter): meter vs computeCost over 12 requests ===");
{
  // Two items per model, mixed streaming and not, the same shape the proxy mirrors.
  const models = ["openai/gpt-4o-mini", "mistralai/mistral-small-2603", "openai/gpt-oss-120b", "xiaomi/mimo-v2.6-flash", "minimax/minimax-m3.1-flash", "deepseek/deepseek-v4.1-flash"];
  const items = models.flatMap((m) => W.filter((w) => w.model === m).slice(2, 4));
  const m0 = await meter();
  let computed = 0, ok = 0;
  const rows = [];
  for (const [i, it] of items.entries()) {
    if (spent > CAP) { console.log("spend guard hit"); break; }
    const stream = i % 2 === 1;
    const body = { model: it.model, messages: it.messages, temperature: 0, max_tokens: Math.min(it.max_tokens ?? 2000, 2000), stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...(it.response_format ? { response_format: it.response_format } : {}), ...(it.reasoning_effort ? { reasoning_effort: it.reasoning_effort } : {}) };
    let usage = null, status;
    if (stream) {
      const t0 = Date.now();
      const res = await fetch("https://api.tokenrouter.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${TR}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      status = res.status;
      let buf = "";
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
          for (const line of ev.split("\n")) if (line.startsWith("data: ") && line !== "data: [DONE]") { try { const o = JSON.parse(line.slice(6)); if (o.usage) usage = o.usage; } catch {} }
        }
      }
      rows.push({ model: it.model, mode: "stream", status, ms: Date.now() - t0 });
    } else {
      const r = await call(body);
      status = r.status; usage = r.j?.usage ?? null;
      rows.push({ model: it.model, mode: "json", status, ms: r.ms });
    }
    const c = status === 200 ? computeCost(prices[it.model], usage) ?? 0 : 0;
    rows.at(-1).computed_usd = +c.toFixed(6);
    rows.at(-1).cached_tokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    computed += c; spent += c; if (status === 200) ok++;
  }
  const m1 = await settled(m0);
  const delta = m1 - m0;
  console.table(rows);
  console.log(JSON.stringify({ requests_ok: ok, meter_delta_usd: +delta.toFixed(6), computed_usd: +computed.toFixed(6), error_pct: +(((computed - delta) / delta) * 100).toFixed(3) }));
}

console.log("\n=== B. qwen3.8-flash reasoning_effort on TokenRouter (repetition 2) ===");
{
  const items = W.filter((w) => w.model === "qwen/qwen3.8-flash").slice(0, 2);
  const rows = [];
  for (const it of items) for (const effort of ["low", null]) {
    if (spent > CAP) { console.log("spend guard hit"); break; }
    const r = await call({ model: it.model, messages: it.messages, temperature: 0, max_tokens: 4000, stream: false, response_format: it.response_format, ...(effort ? { reasoning_effort: effort } : {}) });
    const u = r.j?.usage ?? {};
    const c = r.status === 200 ? computeCost(prices[it.model], u) ?? 0 : 0;
    spent += c;
    rows.push({ item: it.id, reasoning_effort: effort ?? "(omitted)", status: r.status, finish: r.j?.choices?.[0]?.finish_reason ?? r.j?.error?.message?.slice(0, 60), completion_tokens: u.completion_tokens, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? "n/a", ms: r.ms, cost_usd: +c.toFixed(6) });
  }
  console.table(rows);
}
console.log(`\nspend ≈ $${spent.toFixed(4)} (cap $${CAP})`);
