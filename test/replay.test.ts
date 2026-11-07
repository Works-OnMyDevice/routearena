import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "../src/config.js";
import { parseCsv, parseUsageCsv } from "../src/replay/csv.js";
import { estimateReplay } from "../src/replay/estimate.js";
import type { Target } from "../src/targets/index.js";

const target: Target = {
  id: "t",
  name: "T",
  baseUrl: "http://x/v1",
  keyEnv: "T_KEY",
  models: {
    "openai/gpt-4o-mini": { id: "gpt-4o-mini", input_per_m: 0.15, output_per_m: 0.6 },
    "deepseek/deepseek-chat-v3-0324": { id: "deepseek-v3", input_per_m: 0.2, output_per_m: 0.8 },
  },
};

test("parseCsv handles quotes, commas, CRLF", () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "x, y", 'he said "hi"']]);
});

test("parses an activity-style export with per-model rows and dates", () => {
  const csv = [
    "date,model,provider,prompt_tokens,completion_tokens,requests,usage",
    "2026-10-01,openai/gpt-4o-mini,OpenAI,1000000,200000,500,0.27",
    "2026-10-02,openai/gpt-4o-mini,OpenAI,1000000,200000,500,0.27",
    "2026-10-02,deepseek/deepseek-chat-v3-0324:free,Chutes,500000,100000,100,0",
    "2026-10-03,anthropic/claude-sonnet-4.5,Anthropic,100000,20000,10,0.6",
  ].join("\n");
  const u = parseUsageCsv(csv);
  assert.equal(u.rows.length, 4);
  assert.equal(u.detected.model, "model");
  assert.equal(u.detected.cost, "usage");
  assert.deepEqual(u.dateRange, { from: "2026-10-01", to: "2026-10-03" });

  const est = estimateReplay(u, [target]);
  assert.equal(est.period?.days, 3);
  assert.ok(Math.abs(est.monthly_factor - 10) < 1e-9);
  assert.ok(Math.abs(est.current.cost_usd - 1.14) < 1e-9);
  assert.equal(est.current.cost_source, "measured");
  assert.ok(Math.abs(est.current.topup_fee_usd! - 11.4 * 0.055) < 1e-9);
  const t = est.targets[0];
  assert.equal(t.mapped_models, 2);
  assert.equal(t.unmapped_models, 1);
  assert.equal(t.gaps[0].model, "anthropic/claude-sonnet-4.5");
  // gpt-4o-mini: 2M prompt * 0.15/M + 0.4M completion * 0.6/M = 0.30 + 0.24 = 0.54 ; deepseek: 0.5M*0.2/M + 0.1M*0.8/M = 0.1+0.08 = 0.18 ; total 0.72 /3 days *30 = 7.2
  assert.ok(Math.abs(t.projected_usd - 7.2) < 1e-9);
  // comparable current = (0.54 openrouter cost for 4o-mini) + 0 for free deepseek = 0.54 *10 = 5.4
  assert.ok(Math.abs(t.comparable_current_usd - 5.4) < 1e-9);
  assert.ok(Math.abs(t.coverage_requests_pct - (1100 / 1110) * 100) < 1e-9);
});

test("byok hides the top-up fee", () => {
  const u = parseUsageCsv("model,tokens_prompt,tokens_completion,cost\nopenai/gpt-4o-mini,100,100,0.01\n");
  const est = estimateReplay(u, [target], { byok: true });
  assert.equal(est.current.topup_fee_usd, null);
  assert.equal(est.period, null);
  assert.equal(est.monthly_factor, 1);
});

test("tolerates alternative headers (Model / Tokens / Spend)", () => {
  const u = parseUsageCsv("Model,Tokens,Spend,Requests\nopenai/gpt-4o-mini,4000,0.002,3\n");
  assert.equal(u.rows[0].prompt_tokens, 3000);
  assert.equal(u.rows[0].completion_tokens, 1000);
  assert.equal(u.rows[0].cost_usd, 0.002);
  assert.ok(u.warnings.some((w) => /3:1/.test(w)));
});

test("totals-only export fails with an actionable fix", () => {
  assert.throws(
    () => parseUsageCsv("date,spend,tokens,requests\n2026-10-01,1.0,1000,10\n"),
    (e: unknown) => e instanceof CliError && /Model/.test(e.fix) && /2026-10-01/.test(e.fix),
  );
});
