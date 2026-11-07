#!/usr/bin/env node
// Live validation battery for RouteArena. Run from the repo root after `npm run build`, with OPENROUTER_API_KEY and
// TOKENROUTER_API_KEY in .env. Spends real money (guarded, default cap $0.40). Prints tables and writes a JSON record.
//
//   node scripts/validate.mjs [--skip-live] [--sections 1,2,3,4,5,6] [--cap 0.40] [--out path.json] [--s5-max-tokens 4000] [--baseline-items 6]
// 6. Same-route baseline: each prompt twice on the same router, scored like the report, so agreement rates have a floor to compare against.
//
// 1. Reproducibility: per-model cost deltas from every log in --runs-dir (plus the current log) must agree in sign.
// 2. Judge validity: known-identical pairs must score agree, known-mismatched pairs must score disagree.
// 3. Proxy overhead: direct vs through-proxy latency against a local mock upstream (no spend).
// 4. Billing truth: both providers' billing meters before/after a 16-request demo vs what the report claims.
// 5. Parameter handling: qwen3.8-flash with and without reasoning_effort on each router, two repetitions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const CAP = Number(opt("--cap", "0.40"));
const SECTIONS = String(opt("--sections", "1,2,3,4,5,6")).split(",");
const RUNS_DIR = opt("--runs-dir", path.resolve("..", "routearena-private", "runs"));
const OUT = opt("--out", path.join(fs.existsSync(RUNS_DIR) ? RUNS_DIR : ".", `validate-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const ROOT = process.cwd();
const { loadDotenv, PRIMARIES } = await import(path.join(ROOT, "dist/config.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
const { judgeAll } = await import(path.join(ROOT, "dist/report/judge.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
const { startProxy } = await import(path.join(ROOT, "dist/proxy/server.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
const { buildReport } = await import(path.join(ROOT, "dist/report/build.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
loadDotenv();
if (!process.env.TOKENROUTER_MANAGEMENT_KEY && fs.existsSync("relay/.env")) for (const line of fs.readFileSync("relay/.env", "utf8").split(/\r?\n/)) { const m = line.match(/^\s*TOKENROUTER_MANAGEMENT_KEY\s*=\s*(.*)\s*$/); if (m) process.env.TOKENROUTER_MANAGEMENT_KEY = m[1].replace(/^["']|["']$/g, ""); }
const OR = process.env.OPENROUTER_API_KEY, TR = process.env.TOKENROUTER_API_KEY;
const trPrices = JSON.parse(fs.readFileSync("targets/tokenrouter.json", "utf8")).models;
const out = { started: new Date().toISOString(), spend_usd: 0, sections: {} };
let spent = 0;
const guard = (label) => { if (spent > CAP) throw new Error(`spend guard: $${spent.toFixed(4)} > cap $${CAP} before ${label}`); };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : null; };
const readLog = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const trSide = (r) => r.targets.find((t) => t.provider === "tokenrouter");
const pairs = (L) => L.filter((r) => r.primary.status === "ok" && trSide(r)?.status === "ok");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (name) => console.log(`\n=== ${name} ===`);

// ---------- 1. Reproducibility across independent runs ----------
if (SECTIONS.includes("1")) {
section("1. Sign stability of per-model deltas across repeated runs of the same workload");
  const files = [];
  if (fs.existsSync(RUNS_DIR)) for (const f of fs.readdirSync(RUNS_DIR)) if (f.endsWith(".jsonl")) files.push(path.join(RUNS_DIR, f));
  const cur = path.join(ROOT, ".routearena", "log.jsonl");
  if (fs.existsSync(cur)) files.push(cur);
  // A log file can hold several sessions (the live log is appended to across days), so split on gaps > 30 min,
  // then drop any session whose record ids are contained in another (the live log repeats archived runs).
  const runs = [];
  for (const f of files) {
    const all = pairs(readLog(f)).sort((a, b) => a.ts.localeCompare(b.ts));
    let cur = [];
    const flush = () => { if (cur.length >= 10) { const ids = new Set(cur.map((r) => r.id)); runs.push({ file: path.basename(f), pairs: cur.length, start: cur[0].ts, end: cur[cur.length - 1].ts, ids, P: cur }); } cur = []; };
    for (const r of all) { if (cur.length && new Date(r.ts) - new Date(cur[cur.length - 1].ts) > 30 * 60 * 1000) flush(); cur.push(r); }
    flush();
  }
  const contained = (a, b) => a !== b && a.pairs <= b.pairs && [...a.ids].every((id) => b.ids.has(id));
  const uniq = runs.filter((a) => !runs.some((b) => contained(a, b) && (a.pairs < b.pairs || runs.indexOf(b) < runs.indexOf(a))));
  console.log("These are repeated runs of the same fixed workload on the same account (same-day), not independent samples; the test is whether each per-model delta keeps its sign.");
  uniq.sort((a, b) => a.start.localeCompare(b.start));
  const models = [...new Set(uniq.flatMap((r) => r.P.map((x) => x.canonical_model)))].sort();
  const table = [];
  for (const m of models) {
    const row = { model: m };
    const signs = [];
    for (const r of uniq) {
      const ps = r.P.filter((x) => x.canonical_model === m);
      if (!ps.length) { row[r.start.slice(5, 16)] = "–"; continue; }
      const pc = ps.reduce((s, x) => s + (x.primary.cost_usd ?? 0), 0), tc = ps.reduce((s, x) => s + (trSide(x).cost_usd ?? 0), 0);
      const d = pc > 0 ? ((tc - pc) / pc) * 100 : null;
      const lo = med(ps.map((x) => x.primary.latency_ms)), lt = med(ps.map((x) => trSide(x).latency_ms));
      row[r.start.slice(5, 16)] = `${d === null ? "?" : (d > 0 ? "+" : "") + d.toFixed(0) + "%"} (n=${ps.length}, lat ${(lo / 1000).toFixed(1)}s→${(lt / 1000).toFixed(1)}s)`;
      if (d !== null && Math.abs(d) > 10) signs.push(Math.sign(d));
    }
    const mags = Object.values(row).map((v) => (typeof v === "string" ? Number((v.match(/^([+-]?\d+)%/) || [])[1]) : NaN)).filter(Number.isFinite).map(Math.abs);
    row.magnitude_spread = mags.length > 1 ? `${Math.min(...mags)}% to ${Math.max(...mags)}%` : "-";
    row.verdict = signs.length < 2 ? "insufficient" : new Set(signs).size === 1 ? "same sign" : "SIGN FLIP";
    table.push(row);
  }
  console.table(table);
  out.sections.reproducibility = { runs: uniq.map((r) => ({ file: r.file, pairs: r.pairs, start: r.start })), table };
}

// ---------- 2. Judge validity against known ground truth ----------
if (SECTIONS.includes("2")) {
section("2. Scorer sanity on constructed pairs (identical text, and text from a different page). Exercises the exact and field-by-field paths only; the model judge is NOT validated here.");
  const L = pairs(readLog(path.join(ROOT, ".routearena", "log.jsonl"))).filter((r) => r.primary.finish_reason !== "length" && trSide(r).finish_reason !== "length");
  const ident = L.map((r, i) => ({ ...r, id: `ident-${i}`, targets: [{ ...trSide(r), completion_text: r.primary.completion_text }] }));
  const mism = [];
  for (const r of L) {
    const other = L.find((o) => o.id !== r.id && o.canonical_model === r.canonical_model && Math.abs(o.request.est_input_tokens - r.request.est_input_tokens) > 30);
    if (other) mism.push({ ...r, id: `mism-${mism.length}`, targets: [{ ...trSide(r), completion_text: trSide(other).completion_text }] });
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-validate-"));
  fs.mkdirSync(path.join(cwd, ".routearena"), { recursive: true });
  const endpoint = TR ? { baseUrl: "https://api.tokenrouter.com/v1", auth: TR, model: "openai/gpt-4o-mini", label: "tokenrouter/openai/gpt-4o-mini" } : undefined;
  const count = (res) => res.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), (a[`method:${r.method}`] = (a[`method:${r.method}`] ?? 0) + 1), a), {});
  const ri = await judgeAll(ident, { cwd, endpoint, fraction: 1 });
  const rm = await judgeAll(mism, { cwd, endpoint, fraction: 1 });
  spent += (ri.judge_cost_calls + rm.judge_cost_calls) * 0.0005;
  const ci = count(ri.results), cm = count(rm.results);
  const identOk = (ci.agree ?? 0) / ident.length, mismOk = (cm.disagree ?? 0) / mism.length;
  console.table([
    { set: "identical (expect agree)", n: ident.length, agree: ci.agree ?? 0, disagree: ci.disagree ?? 0, skipped: ci.skipped ?? 0, llm_calls: ri.judge_cost_calls, correct: (identOk * 100).toFixed(0) + "%" },
    { set: "mismatched (expect disagree)", n: mism.length, agree: cm.agree ?? 0, disagree: cm.disagree ?? 0, skipped: cm.skipped ?? 0, llm_calls: rm.judge_cost_calls, correct: (mismOk * 100).toFixed(0) + "%" },
  ]);
  out.sections.judge = { identical: { n: ident.length, ...ci, correct: identOk }, mismatched: { n: mism.length, ...cm, correct: mismOk } };
  fs.rmSync(cwd, { recursive: true, force: true });
}

// ---------- 3. Proxy overhead against a local mock ----------
if (SECTIONS.includes("3")) {
section("3. Proxy overhead with mirroring disabled (local mock upstream, 200 ms service time, loopback)");
  const DELAY = 200;
  const mock = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    await sleep(DELAY);
    const usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const w of ["alpha", " beta", " gamma"]) res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "alpha beta gamma" }, finish_reason: "stop" }], usage }));
    }
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  const saved = PRIMARIES.openrouter.baseUrl;
  PRIMARIES.openrouter.baseUrl = mockUrl;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-overhead-"));
  const proxy = await startProxy({ config: { primary: "openrouter", sample: 0, port: 4123, createdAt: new Date().toISOString() }, primaryKey: "sk-test", credits: null, cwd, targets: [] });
  const proxyUrl = `http://127.0.0.1:${proxy.port}/v1`;
  const time = async (base, stream) => {
    const t0 = performance.now();
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-test" }, body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream }) });
    let ttfb = null;
    const reader = res.body.getReader();
    for (;;) { const { done } = await reader.read(); if (ttfb === null) ttfb = performance.now() - t0; if (done) break; }
    return { total: performance.now() - t0, ttfb };
  };
  const rows = [];
  for (const stream of [false, true]) {
    const d = [], p = [];
    for (let i = 0; i < 30; i++) { d.push(await time(mockUrl, stream)); p.push(await time(proxyUrl, stream)); }
    rows.push({ mode: stream ? "stream" : "json", n: 30, direct_p50_ms: +med(d.map((x) => x.total)).toFixed(1), proxy_p50_ms: +med(p.map((x) => x.total)).toFixed(1), overhead_p50_ms: +(med(p.map((x) => x.total)) - med(d.map((x) => x.total))).toFixed(1), overhead_p95_ms: +(p95(p.map((x) => x.total)) - p95(d.map((x) => x.total))).toFixed(1), ttfb_overhead_p50_ms: stream ? +(med(p.map((x) => x.ttfb)) - med(d.map((x) => x.ttfb))).toFixed(1) : null, note: "mirroring disabled; loopback; same process" });
  }
  console.table(rows);
  out.sections.proxy_overhead = rows;
  await proxy.close();
  await new Promise((r) => mock.close(r));
  PRIMARIES.openrouter.baseUrl = saved;
  fs.rmSync(cwd, { recursive: true, force: true });
}

if (flag("--skip-live") || !OR || !TR) { console.log("\n(skipping live sections 4, 5 and 6)"); finish(); }

// ---------- meters ----------
async function meterTR() { const r = await fetch("https://api.tokenrouter.com/v1/dashboard/billing/usage", { headers: { authorization: `Bearer ${TR}` }, signal: AbortSignal.timeout(10000) }); return (await r.json()).total_usage / 100; }
async function meterOR() { const r = await fetch("https://openrouter.ai/api/v1/credits", { headers: { authorization: `Bearer ${OR}` }, signal: AbortSignal.timeout(10000) }); return (await r.json()).data.total_usage; }
async function settled(fn, prev) {
  // Account meters lag and land in batches (OpenRouter's /credits total settled in two steps on 2026-11-08), so wait
  // until the value has differed from prev and then stayed unchanged for 30 s, up to 4 minutes.
  let last = await fn(), stable = 0;
  for (let i = 0; i < 48; i++) {
    await sleep(5000);
    const v = await fn();
    stable = v === last ? stable + 1 : 0;
    last = v;
    if (v !== prev && stable >= 6) return v;
  }
  return last;
}

// ---------- 5a. Parameter handling, repetition 1 ----------
async function reasoningProbe(rep) {
  section(`5. Parameter handling: qwen3.8-flash reasoning controls, max_tokens ${Number(opt("--s5-max-tokens", "4000"))} (repetition ${rep})`);
  guard("reasoning probe");
  const W = fs.readFileSync("demo/workload.jsonl", "utf8").trim().split("\n").map(JSON.parse).filter((w) => w.model === "qwen/qwen3.8-flash").slice(0, 2);
  const rows = [];
  const S5_MAX = Number(opt("--s5-max-tokens", "4000"));
  // Three controls: the OpenAI-style top-level field (what the demo and most clients send), OpenRouter's native
  // `reasoning: {effort}` object (translated by the mirror to reasoning_effort for targets), and no control at all.
  for (const it of W) for (const control of ["reasoning_effort", "reasoning.effort", null]) for (const router of ["openrouter", "tokenrouter"]) {
    const effort = control ? "low" : null;
    const body = { model: it.model, messages: it.messages, temperature: 0, max_tokens: S5_MAX, stream: false, response_format: it.response_format, ...(control === "reasoning_effort" ? { reasoning_effort: "low" } : control === "reasoning.effort" ? (router === "openrouter" ? { reasoning: { effort: "low" } } : { reasoning_effort: "low" }) : {}) };
    if (router === "openrouter") body.usage = { include: true };
    const url = router === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.tokenrouter.com/v1/chat/completions";
    const t0 = Date.now();
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${router === "openrouter" ? OR : TR}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const j = await res.json();
    const u = j.usage ?? {};
    const p = trPrices[it.model];
    const cost = router === "openrouter" ? u.cost ?? 0 : ((u.prompt_tokens ?? 0) * p.input_per_m + (u.completion_tokens ?? 0) * p.output_per_m) / 1e6;
    spent += cost;
    const content = j.choices?.[0]?.message?.content ?? "";
    rows.push({ item: it.id, router, upstream: j.provider ?? "(not reported)", control: control ? `${control}=low` : "(omitted)", max_tokens: S5_MAX, status: res.status, finish: j.choices?.[0]?.finish_reason ?? j.error?.message?.slice(0, 60), completion_tokens: u.completion_tokens, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? "n/a", content_chars: content.length, ms: Date.now() - t0, cost_usd: +cost.toFixed(6) });
  }
  console.table(rows);
  (out.sections.reasoning ??= []).push({ rep, rows });
}
if (SECTIONS.includes("5")) await reasoningProbe(1);

// ---------- 4. Billing truth ----------
if (SECTIONS.includes("4")) {
section("4. Billing truth: meters vs report (16-request demo, concurrency 2)");
  guard("billing demo");
  const logFile = path.join(ROOT, ".routearena", "log.jsonl");
  const backup = fs.existsSync(logFile) ? fs.readFileSync(logFile) : Buffer.alloc(0);
  const or0 = await meterOR(), tr0 = await meterTR();
  fs.writeFileSync(logFile, "");
  let demo, claim;
  try {
    const r = spawnSync(process.execPath, ["dist/cli.js", "demo", "--requests", "16", "--concurrency", "2", "--no-report", "--json"], { encoding: "utf8", timeout: 900000 });
    const s = r.stdout ?? "";
    const jsonText = s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
    try {
      demo = JSON.parse(jsonText);
    } catch {
      throw new Error(`demo produced no JSON (exit ${r.status}): ${(r.stderr ?? "").slice(0, 400)}`);
    }
    const rep = await buildReport({ cwd: ROOT, judge: false });
    const tm = rep.aggregates.target_models.filter((x) => x.target === "tokenrouter");
    claim = { or_measured: rep.aggregates.primary.cost_usd, tr_computed: tm.reduce((s, x) => s + x.target_cost_usd, 0), pairs: tm.reduce((s, x) => s + x.pairs, 0) };
  } finally {
    const fresh = fs.existsSync(logFile) ? fs.readFileSync(logFile) : Buffer.alloc(0);
    fs.writeFileSync(logFile, Buffer.concat([backup, fresh]));
  }
  const or1 = await settled(meterOR, or0), tr1 = await settled(meterTR, tr0);
  spent += (or1 - or0) + (tr1 - tr0);
  const pct = (claimed, truth) => (truth ? (((claimed - truth) / truth) * 100).toFixed(2) + "%" : "n/a");
  const rows = [
    { provider: "openrouter (primary)", meter_delta_usd: +(or1 - or0).toFixed(6), report_claims_usd: +claim.or_measured.toFixed(6), error_pct: pct(claim.or_measured, or1 - or0), note: "report uses usage.cost returned per request" },
    { provider: "tokenrouter (target)", meter_delta_usd: +(tr1 - tr0).toFixed(6), report_claims_usd: +claim.tr_computed.toFixed(6), error_pct: pct(claim.tr_computed, tr1 - tr0), note: "account meter: includes anything else sent on this key in the window" },
  ];
  // Per-request truth: TokenRouter's Management API lists every billed request (model, tokens, cost). Match the demo's
  // mirrored requests by model and token counts, so other traffic on the same key cannot distort the comparison.
  let perRequest = null;
  if (process.env.TOKENROUTER_MANAGEMENT_KEY) {
    try {
      const fresh = readLog(logFile).slice(-demo.sent).filter((r) => trSide(r)?.status === "ok");
      const t0 = Math.floor(new Date(fresh[0].ts).getTime() / 1000) - 30, t1 = Math.floor(new Date(fresh[fresh.length - 1].ts).getTime() / 1000) + 180;
      const r = await fetch(`https://api.tokenrouter.com/api/management/hour/usages?start_timestamp=${t0}&end_timestamp=${t1}&page=1&page_size=100`, { headers: { authorization: `Bearer ${process.env.TOKENROUTER_MANAGEMENT_KEY}` }, signal: AbortSignal.timeout(15000) });
      const items = (await r.json()).data?.items ?? [];
      const unmatched = [];
      let billed = 0, computed = 0, matched = 0, maxDiff = 0;
      const used = new Set();
      for (const row of items) {
        const rec = fresh.find((x) => { const s = trSide(x), u = s.usage ?? {}; return !used.has(x.id) && s.model === row.model_name && u.prompt_tokens === row.prompt_tokens && u.completion_tokens === row.completion_tokens; });
        if (!rec) { unmatched.push({ model: row.model_name, cost_usd: row.cost }); continue; }
        used.add(rec.id); matched++; billed += row.cost; computed += trSide(rec).cost_usd ?? 0; maxDiff = Math.max(maxDiff, Math.abs(row.cost - (trSide(rec).cost_usd ?? 0)));
      }
      perRequest = { matched, of: fresh.length, tokenrouter_billed_usd: +billed.toFixed(6), report_claims_usd: +computed.toFixed(6), error_pct: pct(computed, billed), max_per_request_diff_usd: +maxDiff.toFixed(7), other_traffic_on_key: { requests: unmatched.length, cost_usd: +unmatched.reduce((s, x) => s + x.cost_usd, 0).toFixed(6), models: [...new Set(unmatched.map((x) => x.model))] } };
      rows.push({ provider: "tokenrouter (target, per-request billing rows)", meter_delta_usd: perRequest.tokenrouter_billed_usd, report_claims_usd: perRequest.report_claims_usd, error_pct: perRequest.error_pct, note: `${matched}/${fresh.length} requests matched by model+token counts; ${unmatched.length} unmatched billed rows ($${perRequest.other_traffic_on_key.cost_usd}) in the window: not attributable by this method (other traffic on the key, or a request billed with different token counts than it returned)` });
    } catch (e) {
      console.log(`(per-request billing match skipped: ${String(e).slice(0, 120)})`);
    }
  }
  // OpenRouter per request: GET /api/v1/generation?id= returns what OpenRouter actually charged for that generation.
  // Needs the proxy to log the response id (primary.response_id); older logs lack it and this block is skipped.
  let orPerRequest = null;
  try {
    const withIds = readLog(logFile).slice(-demo.sent).filter((r) => r.primary.status === "ok" && r.primary.response_id);
    if (withIds.length) {
      let billed = 0, claimed = 0, n = 0, maxDiff = 0;
      for (const r of withIds) {
        await sleep(600);
        const g = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(r.primary.response_id)}`, { headers: { authorization: `Bearer ${OR}` }, signal: AbortSignal.timeout(15000) });
        const j = await g.json().catch(() => ({}));
        const cost = Number(j?.data?.total_cost);
        if (!Number.isFinite(cost)) continue;
        n++; billed += cost; claimed += r.primary.cost_usd ?? 0; maxDiff = Math.max(maxDiff, Math.abs(cost - (r.primary.cost_usd ?? 0)));
      }
      orPerRequest = { matched: n, of: withIds.length, openrouter_billed_usd: +billed.toFixed(6), report_claims_usd: +claimed.toFixed(6), error_pct: pct(claimed, billed), max_per_request_diff_usd: +maxDiff.toFixed(7) };
      rows.push({ provider: "openrouter (primary, per-generation records)", meter_delta_usd: orPerRequest.openrouter_billed_usd, report_claims_usd: orPerRequest.report_claims_usd, error_pct: orPerRequest.error_pct, note: `${n}/${withIds.length} generations looked up by id; this is OpenRouter's own charge per generation, so it checks bookkeeping, not OpenRouter's pricing` });
    } else {
      console.log("(OpenRouter per-generation check skipped: no response ids in the log; the proxy logs them from this version on)");
    }
  } catch (e) {
    console.log(`(OpenRouter per-generation check skipped: ${String(e).slice(0, 120)})`);
  }
  console.table(rows);
  console.log(`demo: ${demo.primary_ok}/${demo.sent} ok, mirrors ok ${demo.mirrors?.target_ok}, errors ${demo.mirrors?.target_error}, pairs in report ${claim.pairs}${demo.stopped ? ", STOPPED: " + demo.stopped.message : ""}`);
  out.sections.billing = { demo: { sent: demo.sent, ok: demo.primary_ok, stopped: demo.stopped ?? null, mirrors: demo.mirrors }, rows, per_request: perRequest, openrouter_per_generation: orPerRequest };
}

// ---------- 5b. Parameter handling, repetition 2 ----------
if (SECTIONS.includes("5")) await reasoningProbe(2);

// ---------- 6. Same-route baseline for the agreement scorer ----------
// Sends each of N workload prompts twice to the SAME router (temperature 0) and scores run 1 vs run 2 with the report's
// own scorer. Without this, an OpenRouter-vs-TokenRouter agreement rate cannot be read: it may just be the scorer's
// (or the model's) own run-to-run noise.
if (SECTIONS.includes("6")) {
section("6. Same-route agreement baseline (each prompt twice on the same router, scored like the report)");
  guard("baseline");
  const N = Number(opt("--baseline-items", "6"));
  const W = fs.readFileSync("demo/workload.jsonl", "utf8").trim().split("\n").map(JSON.parse).slice(0, N);
  const call = async (router, it) => {
    const body = { model: it.model, messages: it.messages, temperature: it.temperature ?? 0, max_tokens: it.max_tokens, stream: false, response_format: it.response_format, ...(it.reasoning_effort ? { reasoning_effort: it.reasoning_effort } : {}) };
    const url = router === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.tokenrouter.com/v1/chat/completions";
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${router === "openrouter" ? OR : TR}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const j = await res.json();
    const u = j.usage ?? {}, p = trPrices[it.model] ?? { input_per_m: 0, output_per_m: 0 };
    const cost = router === "openrouter" ? u.cost ?? 0 : ((u.prompt_tokens ?? 0) * p.input_per_m + (u.completion_tokens ?? 0) * p.output_per_m) / 1e6;
    spent += cost;
    return { ok: res.status === 200 && !!j.choices?.[0], text: j.choices?.[0]?.message?.content ?? "", finish: j.choices?.[0]?.finish_reason ?? null, cost };
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-baseline-"));
  fs.mkdirSync(path.join(cwd, ".routearena"), { recursive: true });
  const endpoint = { baseUrl: "https://openrouter.ai/api/v1", auth: OR, model: "openai/gpt-4o-mini", label: "openrouter/openai/gpt-4o-mini" };
  const table = [];
  for (const router of ["openrouter", "tokenrouter"]) {
    const recs = [];
    for (const it of W) {
      const a = await call(router, it), b = await call(router, it);
      if (!a.ok || !b.ok) { table.push({ router, item: it.id, model: it.model, result: `request failed (${a.ok ? "" : "run1 "}${b.ok ? "" : "run2"})` }); continue; }
      recs.push({ v: 1, id: `${router}-${it.id}`, ts: new Date().toISOString(), canonical_model: it.model, request: { stream: false, has_images: false, has_tools: false, est_input_tokens: 0, response_format: "json_object" }, mirrored: true,
        primary: { provider: router, model: it.model, status: "ok", finish_reason: a.finish, completion_text: a.text, cost_usd: a.cost },
        targets: [{ provider: router, model: it.model, status: "ok", finish_reason: b.finish, completion_text: b.text, cost_usd: b.cost }] });
    }
    const jr = await judgeAll(recs, { cwd, endpoint, fraction: 1 });
    spent += jr.judge_cost_calls * 0.0005;
    for (const r of jr.results) { const rec = recs.find((x) => x.id === r.record_id); table.push({ router, item: rec.id.split("-").slice(1).join("-"), model: rec.canonical_model, verdict: r.verdict, method: r.method, note: r.note ?? "" }); }
    const judged = jr.results.filter((r) => r.verdict !== "skipped");
    table.push({ router, item: "ALL", model: "", verdict: `${judged.filter((r) => r.verdict === "agree").length}/${judged.length} agree with itself`, method: "", note: `${jr.results.length - judged.length} skipped` });
  }
  console.table(table);
  out.sections.same_route_baseline = table;
  fs.rmSync(cwd, { recursive: true, force: true });
}

finish();
function finish() {
  out.spend_usd = +spent.toFixed(4);
  out.finished = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\nspend this run ≈ $${spent.toFixed(4)} (cap $${CAP}); record: ${OUT}`);
  process.exit(0);
}
