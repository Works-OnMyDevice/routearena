// Live check against TokenRouter as a mirror target, with a mock primary so no second key is needed.
// Not part of `npm test`. Costs a few cents. Run: node --import tsx test/live-tokenrouter.ts [n]
// Requires TOKENROUTER_API_KEY in env or .env. Uses the first n demo workload items (default 8).
import fs from "node:fs";
import { loadDotenv, PRIMARIES, saveConfig } from "../src/config.js";
import { loadWorkload } from "../src/demo/run.js";
import { startProxy } from "../src/proxy/server.js";
import { chatCompletion } from "../src/proxy/openaiCall.js";
import { buildReport } from "../src/report/build.js";
import { resolveTargets } from "../src/targets/index.js";
import { startMockUpstream, tmpCwd } from "./helpers.js";

loadDotenv();
if (!process.env.TOKENROUTER_API_KEY) throw new Error("TOKENROUTER_API_KEY not set");
const n = Number(process.argv[2] ?? 8);
const cwd = tmpCwd();
const primary = await startMockUpstream({ reply: () => ({ text: '{"mock":"primary"}', usage: { prompt_tokens: 2000, completion_tokens: 50, cost: 0.0005 }, delayMs: 30 }) });
(PRIMARIES.openrouter as any).baseUrl = primary.url;
const targets = resolveTargets({ only: ["tokenrouter"] });
saveConfig({ primary: "openrouter", sample: 1, port: 0, createdAt: new Date().toISOString() }, cwd);
const proxy = await startProxy({ config: { primary: "openrouter", sample: 1, port: 0, createdAt: "" }, primaryKey: "mock", credits: null, cwd, targets, mirrorTimeoutMs: 120_000 });
const items = (await loadWorkload()).slice(0, n);
// Budget guard: refuse to run if the rough estimate exceeds 25 cents.
const est = items.reduce((s, it) => {
  const e = targets[0].target.models[it.model.toLowerCase()];
  const inTok = it.messages.reduce((a, m) => a + m.content.length, 0) / 3;
  return s + (e ? (inTok * e.input_per_m + (it.max_tokens ?? 2000) * e.output_per_m) / 1e6 : 0);
}, 0);
console.error(`sending ${items.length} items; worst-case TokenRouter cost ≈ $${est.toFixed(4)}`);
if (est > 0.25) throw new Error("estimate over 25 cents; lower n");
const t0 = Date.now();
for (const it of items) {
  const r = await chatCompletion({ baseUrl: `http://127.0.0.1:${proxy.port}/v1`, auth: "x", body: { model: it.model, messages: it.messages, temperature: 0, max_tokens: it.max_tokens ?? 2000, response_format: it.response_format, ...(it.reasoning_effort ? { reasoning_effort: it.reasoning_effort } : {}) }, streamForTtft: true, timeoutMs: 130_000 });
  console.error(`  ${it.id} ${it.model} primary=${r.status}`);
}
await proxy.engine.drain(120_000);
await proxy.close();
const { readLog } = await import("../src/proxy/logger.js");
const { logPath } = await import("../src/config.js");
const recs = await readLog(logPath(cwd));
let spent = 0;
for (const r of recs) {
  const s = r.targets[0];
  spent += s?.cost_usd ?? 0;
  console.log(JSON.stringify({ model: r.canonical_model, status: s?.status, http: s?.http_status, err: s?.error_type, msg: s?.error?.slice(0, 80), lat: s?.latency_ms, ttft: s?.ttft_ms, usage: s?.usage ? { p: s.usage.prompt_tokens, c: s.usage.completion_tokens, r: (s.usage as any).completion_tokens_details?.reasoning_tokens } : null, cost: s?.cost_usd?.toFixed(6), reported: s?.reported_cost_usd, finish: s?.finish_reason, text: (s?.completion_text ?? "").slice(0, 60).replace(/\n/g, " ") }));
}
console.error(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s; computed TokenRouter spend $${spent.toFixed(4)}`);
const rep = await buildReport({ cwd, judge: true, onProgress: (m) => console.error("  " + m) });
console.error(`report: ${rep.htmlPath}`);
console.log(JSON.stringify(rep.aggregates.targets[0], null, 1));
fs.copyFileSync(rep.htmlPath, process.env.ROUTEARENA_KEEP_HTML ? `${process.env.ROUTEARENA_KEEP_HTML}/live-report.html` : rep.htmlPath);
await primary.close();
