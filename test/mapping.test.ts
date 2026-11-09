import assert from "node:assert/strict";
import { test } from "node:test";
import { TARGETS, getTarget, loadTargets, resolveTargets, type Target } from "../src/targets/index.js";
import { addTokenTotals, canonicalModel, mapModel, reportedCost, tokenTotals, zeroTokens } from "../src/targets/mapping.js";
import { exactCompare, inSample } from "../src/report/judge.js";
import { assertPublishable } from "../src/report/publish.js";
import { quantiles } from "../src/report/aggregate.js";

const tgt = (id = "tgt"): Target => ({ id, name: id, baseUrl: "https://x/v1", keyEnv: "X", reportsCost: false });

test("canonicalModel strips OpenRouter variants and prefixes OpenAI ids", () => {
  assert.equal(canonicalModel("openrouter", "DeepSeek/deepseek-chat-v3-0324:free"), "deepseek/deepseek-chat-v3-0324");
  assert.equal(canonicalModel("openrouter", "openai/gpt-4o-mini:nitro"), "openai/gpt-4o-mini");
  assert.equal(canonicalModel("openai", "gpt-4o-mini"), "openai/gpt-4o-mini");
  assert.equal(canonicalModel("openai", "openai/gpt-4o-mini"), "openai/gpt-4o-mini");
});

test("mapModel is identity by default: the target gets the id the client sent", () => {
  assert.equal(mapModel(tgt(), "openai/gpt-4o-mini", undefined), "openai/gpt-4o-mini");
  assert.equal(mapModel(tgt(), "openai/gpt-4o-mini", {}), "openai/gpt-4o-mini");
  assert.equal(mapModel(tgt(), "openai/gpt-4o-mini", { other: { "openai/gpt-4o-mini": "x" } }), "openai/gpt-4o-mini", "another target's override does not apply");
  // Case is preserved: the client's spelling is what the target receives.
  assert.equal(mapModel(tgt(), "deepseek/deepseek-chat", undefined, "DeepSeek/DeepSeek-Chat"), "DeepSeek/DeepSeek-Chat");
});

test("mapModel applies the agent's model_map override, by canonical id or by the id as sent", () => {
  const overrides = { tgt: { "meta-llama/llama-3.3-70b-instruct": "llama-3.3-70b-versatile", "openai/gpt-4o-mini:nitro": "gpt-4o-mini-fast" } };
  assert.equal(mapModel(tgt(), "meta-llama/llama-3.3-70b-instruct", overrides), "llama-3.3-70b-versatile");
  assert.equal(mapModel(tgt(), "meta-llama/llama-3.3-70b-instruct", overrides, "meta-llama/llama-3.3-70b-instruct:free"), "llama-3.3-70b-versatile", "canonical key wins over the variant the client sent");
  assert.equal(mapModel(tgt(), "openai/gpt-4o-mini", overrides, "openai/gpt-4o-mini:nitro"), "gpt-4o-mini-fast", "override keyed by the exact id the client sent");
  assert.equal(mapModel(tgt(), "x/y", overrides), "x/y", "no entry -> identity");
  assert.equal(mapModel(tgt(), "x/y", { tgt: { "x/y": "" } }), "x/y", "empty override is ignored");
});

test("mapModel strips only OpenRouter variant suffixes, nothing else", () => {
  assert.equal(mapModel(tgt(), "openai/gpt-4o-mini", undefined, "openai/gpt-4o-mini:nitro"), "openai/gpt-4o-mini");
  assert.equal(mapModel(tgt(), "openai/gpt-4o-mini", undefined, "openai/gpt-4o-mini:floor"), "openai/gpt-4o-mini");
  assert.equal(mapModel(tgt(), "x/y", undefined, "x/y:free"), "x/y");
  assert.equal(mapModel(tgt(), "accounts/fireworks/models/llama-v3p3-70b-instruct", undefined), "accounts/fireworks/models/llama-v3p3-70b-instruct", "vendor paths are kept");
  assert.equal(mapModel(tgt(), "meta-llama/llama-3.3-70b-instruct-turbo", undefined, "meta-llama/Llama-3.3-70B-Instruct-Turbo"), "meta-llama/Llama-3.3-70B-Instruct-Turbo", "no shape normalization");
});

test("targets are defined in code with no model tables or prices", () => {
  const targets = loadTargets();
  assert.deepEqual(targets.map((t) => t.id), ["deepinfra", "fireworks", "groq", "openai", "together", "tokenrouter"]);
  assert.equal(targets.length, TARGETS.length);
  for (const t of targets) {
    assert.ok(t.id && t.name && t.baseUrl.startsWith("https://") && t.keyEnv, t.id);
    assert.equal(typeof t.reportsCost, "boolean", `${t.id} declares reportsCost`);
    assert.equal(t.reportsCost, false, `${t.id}: no shipped target reports a per-request cost today`);
    for (const k of ["models", "pricesSource", "pricesCaptured", "prices"]) assert.ok(!(k in t), `${t.id} ships no ${k}`);
  }
  const tr = getTarget("tokenrouter")!;
  assert.ok(tr.supportsFreeCredits);
  assert.ok(tr.judgeModel, "tokenrouter has a judge model");
  assert.equal(tr.requestIdHeader, "x-tokenrouter-request-id");
  assert.equal(getTarget("groq")!.requestIdHeader, undefined);
  assert.equal(getTarget("nope"), undefined);
  // loadTargets() returns a copy; callers cannot mutate the shipped constant.
  targets.pop();
  assert.equal(loadTargets().length, TARGETS.length);
});

test("resolveTargets: key, free credits (relay vs capped key), no key", () => {
  const env = { GROQ_API_KEY: "gsk_test_key_value_1234567890" } as NodeJS.ProcessEnv;
  const future = new Date(Date.now() + 3600_000).toISOString();
  const relay = resolveTargets({ env, credits: { token: "ra_token", claimId: "c", expiresAt: future, budgetUsd: 1, mode: "relay" } });
  const byId = Object.fromEntries(relay.map((r) => [r.target.id, r]));
  assert.equal(byId.groq.status, "key");
  assert.equal(byId.groq.auth, env.GROQ_API_KEY);
  assert.equal(byId.tokenrouter.status, "free-credits");
  assert.notEqual(byId.tokenrouter.baseUrl, byId.tokenrouter.target.baseUrl, "relay mode goes through the relay");
  assert.equal(byId.together.status, "no-key");
  assert.equal(byId.together.auth, null);
  const direct = resolveTargets({ env: {}, credits: { token: "sk-capped", claimId: "c", expiresAt: future, budgetUsd: 1, mode: "key" }, only: ["tokenrouter"] });
  assert.equal(direct.length, 1);
  assert.equal(direct[0].baseUrl, direct[0].target.baseUrl, "key mode goes straight to the target");
  assert.equal(resolveTargets({ env: {}, credits: null, excludePrimary: "openai" }).some((r) => r.target.id === "openai"), false);
});

test("reportedCost reads only what the provider sent", () => {
  assert.equal(reportedCost({ prompt_tokens: 1, completion_tokens: 1, cost: 0.00042 }), 0.00042);
  assert.equal(reportedCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), null, "tokens alone are not a cost");
  assert.equal(reportedCost({ cost: Number.NaN }), null);
  assert.equal(reportedCost(null), null);
  assert.equal(reportedCost(undefined), null);
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

test("tokenTotals reads tokens only; missing fields are 0", () => {
  const u = { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 500_000 }, completion_tokens_details: { reasoning_tokens: 40_000 } };
  assert.deepEqual(tokenTotals(u), { prompt_tokens: 1_000_000, completion_tokens: 100_000, cached_tokens: 500_000, reasoning_tokens: 40_000 });
  assert.deepEqual(tokenTotals(undefined), zeroTokens());
  assert.deepEqual(tokenTotals({ prompt_tokens: Number.NaN }), zeroTokens());
  assert.equal(addTokenTotals(tokenTotals(u), tokenTotals(u)).cached_tokens, 1_000_000);
});
