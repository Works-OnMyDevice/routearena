import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTargets } from "../src/targets/index.js";
import { addTokenTotals, cacheDiscountUsd, canonicalModel, computeCost, computeCostCacheNeutral, mapModel, normalizeForSuggestion, suggestMapping, tokenTotals, zeroTokens } from "../src/targets/mapping.js";
import { exactCompare, inSample } from "../src/report/judge.js";
import { assertPublishable } from "../src/report/publish.js";
import { quantiles } from "../src/report/aggregate.js";

test("canonicalModel strips OpenRouter variants and prefixes OpenAI ids", () => {
  assert.equal(canonicalModel("openrouter", "DeepSeek/deepseek-chat-v3-0324:free"), "deepseek/deepseek-chat-v3-0324");
  assert.equal(canonicalModel("openrouter", "openai/gpt-4o-mini:nitro"), "openai/gpt-4o-mini");
  assert.equal(canonicalModel("openai", "gpt-4o-mini"), "openai/gpt-4o-mini");
  assert.equal(canonicalModel("openai", "openai/gpt-4o-mini"), "openai/gpt-4o-mini");
});

test("normalizeForSuggestion collapses vendor and instruct suffixes", () => {
  assert.equal(normalizeForSuggestion("meta-llama/Llama-3.3-70B-Instruct-Turbo"), "llama-3-3-70b");
  assert.equal(normalizeForSuggestion("accounts/fireworks/models/llama-v3p3-70b-instruct"), "llama-v3p3-70b");
});

test("computeCost uses cached rate when provided", () => {
  const e = { id: "m", input_per_m: 1, output_per_m: 2, cached_input_per_m: 0.5 };
  const c = computeCost(e, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 500_000 } });
  assert.ok(Math.abs(c! - (0.5 + 0.25 + 2)) < 1e-9);
  assert.equal(computeCost(e, null), null);
});

test("every shipped target file is well formed and maps common models", () => {
  const targets = loadTargets();
  assert.ok(targets.length >= 6, "six targets shipped");
  for (const t of targets) {
    assert.ok(t.id && t.name && t.baseUrl.startsWith("https://") && t.keyEnv, t.id);
    assert.ok(Object.keys(t.models).length >= 5, `${t.id} has a price table`);
    for (const [k, v] of Object.entries(t.models)) {
      assert.equal(k, k.toLowerCase(), `${t.id}: ${k} lowercase`);
      assert.ok(k.includes("/"), `${t.id}: ${k} is an OpenRouter-style id`);
      assert.ok(typeof v.id === "string" && v.id.length > 0, `${t.id}: ${k} has target id`);
      assert.ok(v.input_per_m >= 0 && v.output_per_m >= 0, `${t.id}: ${k} prices`);
    }
    assert.ok(t.pricesCaptured, `${t.id} has a prices-captured date`);
  }
  const tr = targets.find((t) => t.id === "tokenrouter")!;
  assert.ok(tr.supportsFreeCredits);
  assert.ok(tr.judgeModel, "tokenrouter has a judge model");
  const oa = targets.find((t) => t.id === "openai")!;
  assert.ok(mapModel(oa, "openai/gpt-4o-mini"), "openai table has gpt-4o-mini for primary cost computation");
});

test("suggestMapping offers a hint without mapping", () => {
  const t = { id: "x", name: "x", baseUrl: "https://x/v1", keyEnv: "X", models: { "meta-llama/llama-3.3-70b-instruct": { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", input_per_m: 1, output_per_m: 1 } } };
  assert.equal(mapModel(t, "meta-llama/llama-3.3-70b-instruct:free"), null, "variants are canonicalized before mapping, not here");
  assert.equal(suggestMapping(t, "meta/llama-3.3-70b"), "meta-llama/Llama-3.3-70B-Instruct-Turbo");
});

test("exactCompare: text, json, tool calls", () => {
  const side = (completion_text: string | null, tool_calls: any = null) => ({ provider: "p", model: "m", status: "ok" as const, completion_text, tool_calls });
  assert.equal(exactCompare(side("Paris."), side("paris")), "agree");
  assert.equal(exactCompare(side('{"a":1,"b":[1,2]}'), side('```json\n{"b":[1,2],"a":1}\n```')), "agree");
  assert.equal(exactCompare(side('{"a":1}'), side('{"a":2}')), "disagree", "single differing field is a disagreement");
  assert.equal(exactCompare(side('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7}'), side('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":8}')), "agree", "one field of seven differs -> field-level agreement");
  assert.equal(exactCompare(side('{"a":1,"b":2,"c":3}'), side('{"a":1,"b":9,"c":3}')), undefined, "two thirds alike goes to the judge");
  assert.equal(exactCompare(side("The answer is 42"), side("42")), "agree");
  assert.equal(exactCompare(side("long ".repeat(100)), side("other ".repeat(100))), undefined);
  assert.equal(exactCompare(side(null, [{ name: "f", arguments: '{"x":1}' }]), side(null, [{ name: "f", arguments: '{ "x": 1 }' }])), "agree");
  assert.equal(exactCompare(side(null, [{ name: "f", arguments: "{}" }]), side(null, [{ name: "g", arguments: "{}" }])), undefined);
  assert.equal(exactCompare(side(""), side("x")), "disagree");
});

test("inSample is deterministic and roughly 25%", () => {
  let n = 0;
  for (let i = 0; i < 4000; i++) if (inSample(`id-${i}-${i * 7919}`)) n++;
  assert.ok(n > 800 && n < 1200, `got ${n}`);
  assert.equal(inSample("abc"), inSample("abc"));
});

test("assertPublishable rejects prompt-like payloads", () => {
  assertPublishable({ a: { b: ["x".repeat(500)] } });
  assert.throws(() => assertPublishable({ messages: [] }));
  assert.throws(() => assertPublishable({ nested: { completion_text: "hi" } }));
  assert.throws(() => assertPublishable({ s: "x".repeat(501) }));
});

test("classifyError reads provider error bodies", async () => {
  const { classifyError } = await import("../src/proxy/openaiCall.js");
  assert.equal(classifyError(503, undefined, JSON.stringify({ error: { code: "model_not_found", message: "No available channel for model x under group default" } })), "model_not_found");
  assert.equal(classifyError(400, undefined, JSON.stringify({ error: { message: "`temperature` is deprecated for this model." } })), "unsupported_parameter");
  assert.equal(classifyError(429), "rate_limited");
  assert.equal(classifyError(503, undefined, "not json"), "upstream_error");
});

test("quantiles", () => {
  assert.deepEqual(quantiles([]), { p50: null, p95: null, n: 0 });
  const q = quantiles([5, 1, 3, 2, 4]);
  assert.equal(q.p50, 3);
  assert.equal(q.p95, 5);
});

test("tokenTotals, cacheDiscountUsd and computeCostCacheNeutral", () => {
  const e = { id: "m", input_per_m: 1, output_per_m: 2, cached_input_per_m: 0.5 };
  const u = { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 500_000 }, completion_tokens_details: { reasoning_tokens: 40_000 } };
  assert.deepEqual(tokenTotals(u), { prompt_tokens: 1_000_000, completion_tokens: 100_000, cached_tokens: 500_000, reasoning_tokens: 40_000 });
  assert.deepEqual(tokenTotals(undefined), zeroTokens());
  assert.equal(addTokenTotals(tokenTotals(u), tokenTotals(u)).cached_tokens, 1_000_000);
  // discount = cached x (full rate - cached rate) = 500k x 0.5 / 1e6
  assert.ok(Math.abs(cacheDiscountUsd(e, u) - 0.25) < 1e-12);
  assert.equal(cacheDiscountUsd({ id: "m", input_per_m: 1, output_per_m: 2 }, u), 0, "no cached price -> cached tokens were already billed at full rate");
  assert.equal(cacheDiscountUsd(e, null), 0);
  // computed + discount == cache-neutral
  assert.ok(Math.abs(computeCost(e, u)! + cacheDiscountUsd(e, u) - computeCostCacheNeutral(e, u)!) < 1e-12);
  assert.ok(Math.abs(computeCostCacheNeutral(e, u)! - 1.2) < 1e-12);
  assert.equal(computeCostCacheNeutral(e, null), null);
});
