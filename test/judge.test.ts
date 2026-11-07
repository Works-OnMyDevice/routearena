import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PRIMARIES } from "../src/config.js";
import { loadWorkload } from "../src/demo/run.js";
import type { LogRecord, SideResult } from "../src/proxy/logger.js";
import { demoRequestText, pickJudge, stripBulk } from "../src/report/build.js";
import { abOrder, compareSides, exactCompare, inSample, isReasoningLeak, judgeAll, jsonSimilarity, normalizeText } from "../src/report/judge.js";
import { startMockUpstream, tmpCwd } from "./helpers.js";

const side = (completion_text: string | null, extra: Partial<SideResult> = {}): SideResult => ({ provider: "p", model: "m", status: "ok", completion_text, tool_calls: null, finish_reason: "stop", ...extra });

const rec = (id: string, primaryText: string, targetText: string, model = "openai/gpt-4o-mini"): LogRecord => ({
  v: 1,
  id,
  ts: "2026-11-08T00:00:00.000Z",
  canonical_model: model,
  request: { stream: false, has_images: false, has_tools: false, est_input_tokens: 2000, response_format: "json_object" },
  primary: side(primaryText, { provider: "openrouter" }),
  mirrored: true,
  targets: [side(targetText, { provider: "tokenrouter" })],
});

const HEADINGS = ["Content delivery network", "Technology", "Security and privacy", "Content networking techniques", "CDN trends", "Providers", "See also", "References", "Further reading"];

test("jsonSimilarity: arrays are compared as multisets, not by index", () => {
  // one inserted heading no longer fails every later one
  const a = { headings: ["Uses", "Risks", "See also", "References"] };
  const b = { headings: ["Uses", "Basic theory", "Risks", "See also", "References"] };
  assert.equal(jsonSimilarity(a, b), 0.8);
  // mistral-like case: B lacks A's first heading (the page title repeated), everything else identical
  const sim = jsonSimilarity({ headings: HEADINGS }, { headings: HEADINGS.slice(1) });
  assert.ok(sim >= 0.7 && sim < 1, `expected >= 0.7, got ${sim}`);
  // order does not matter, duplicates are count-matched
  assert.equal(jsonSimilarity(["a", "b", "b"], ["b", "a", "b"]), 1);
  assert.equal(jsonSimilarity(["a", "b", "b"], ["b", "a", "a"]), 2 / 3);
  // arrays of objects pair by best match
  const va = [{ name: "128GB", price: 799 }, { name: "256GB", price: 899 }];
  const vb = [{ name: "256GB", price: 899 }, { name: "128GB", price: 799 }];
  assert.equal(jsonSimilarity(va, vb), 1);
  assert.ok(jsonSimilarity(va, [{ name: "256GB", price: 899 }]) === 0.5);
});

test("jsonSimilarity: null, [], \"\" and a missing field are the same thing", () => {
  assert.equal(jsonSimilarity({ tags: null }, { tags: [] }), 1);
  assert.equal(jsonSimilarity({ tags: "" }, {}), 1);
  assert.equal(jsonSimilarity({ a: 1, tags: null }, { a: 1 }), 1);
  assert.equal(jsonSimilarity({ a: 1, tags: {} }, { a: 1, tags: null }), 1);
  // but an empty value against real content is still a difference
  assert.equal(jsonSimilarity({ tags: null }, { tags: ["x"] }), 0);
  // each field weighs the same: a long array does not drown the others
  assert.equal(jsonSimilarity({ title: "A", headings: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] }, { title: "B", headings: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] }), 0.5);
});

test("normalizeText strips citation markers and spacing before punctuation", () => {
  assert.equal(normalizeText("In deep learning , the transformer is a family[1] of networks. [ 12 ] It works [ citation needed ] well."), "in deep learning, the transformer is a family of networks. it works well");
  assert.equal(jsonSimilarity({ text: "LLMs can analyze text.[1] They are the basis for chatbots.[2]" }, { text: "LLMs can analyze text. They are the basis for chatbots." }), 1);
});

test("compareSides reports the method that produced the verdict", () => {
  assert.deepEqual(compareSides(side("Paris."), side("paris")), { verdict: "agree", method: "exact" });
  assert.deepEqual(compareSides(side(""), side("x")), { verdict: "disagree", method: "exact" });
  assert.equal(compareSides(side('{"a":1,"b":[1,2]}'), side('```json\n{"b":[1,2],"a":1}\n```'))?.method, "json");
  const seven = compareSides(side('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7}'), side('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":8}'));
  assert.equal(seven?.verdict, "agree");
  assert.equal(seven?.method, "json");
  assert.deepEqual(compareSides(side('{"a":1}'), side('{"a":2}')), { verdict: "disagree", method: "json", similarity: 0 });
  assert.equal(compareSides(side('{"a":1,"b":2,"c":3}'), side('{"a":1,"b":9,"c":3}')), undefined, "middle ground goes to the judge");
  assert.deepEqual(compareSides(side("The answer is 42"), side("42")), { verdict: "agree", method: "numeric" });
  assert.equal(compareSides(side(null, { tool_calls: [{ name: "f", arguments: '{"x":1}' }] }), side(null, { tool_calls: [{ name: "f", arguments: '{ "x": 1 }' }] }))?.method, "json");
  // exactCompare keeps returning the bare verdict
  assert.equal(exactCompare(side("Paris."), side("paris")), "agree");
});

test("reasoning leak detection", () => {
  assert.ok(isReasoningLeak('{"analysis": "We need to produce JSON with fields: url, title, authors, publishedAt, text. Extract from page."}'));
  assert.ok(isReasoningLeak('{\n  "analysis": "We need to produce JSON with fields: ..."\n}'));
  assert.ok(isReasoningLeak('{"reasoning":"first I will..."}'));
  assert.ok(isReasoningLeak("analysis<|channel|>We need to answer"));
  assert.ok(isReasoningLeak("analysis We need to produce JSON. Then output."));
  assert.ok(isReasoningLeak("analysisWe need to produce JSON."));
  assert.equal(isReasoningLeak('{"url":"https://x","title":"Reverse proxy","analysis":null}'), false, "a real field named analysis among others is fine");
  assert.equal(isReasoningLeak("Analysis: revenue grew 4% year over year."), false, "a capitalized heading is an answer, not a leak");
  assert.equal(isReasoningLeak(""), false);
  assert.equal(isReasoningLeak(null), false);
});

test("judgeAll: reasoning leak is skipped with a stable note, not scored as disagreement", async () => {
  const cwd = tmpCwd();
  const good = '{"url":"https://en.wikipedia.org/wiki/Reverse_proxy","title":"Reverse proxy","headings":["Uses","Risks"]}';
  const leak = '{"analysis": "We need to produce JSON with fields: url, title, headings. Extract from page."}';
  const r = await judgeAll([rec("leak-1", good, leak)], { cwd, endpoint: null, fraction: 1 });
  assert.deepEqual(r.results, [{ record_id: "leak-1", target: "tokenrouter", verdict: "skipped", method: "none", note: "reasoning_leak" }]);
  // not cached: nothing was judged
  assert.equal(fs.existsSync(path.join(cwd, ".routearena", "judgements.jsonl")), false);
  // truncation still wins and is still excluded
  const t = rec("trunc-1", good, good);
  t.targets[0].finish_reason = "length";
  const r2 = await judgeAll([t], { cwd, endpoint: null, fraction: 1 });
  assert.equal(r2.results[0].note, "truncated");
  // deterministic 25% sampling unchanged
  assert.equal(inSample("d9ba0b1d-31e1-4d70-b9d3-f0a3c9ea9072"), inSample("d9ba0b1d-31e1-4d70-b9d3-f0a3c9ea9072"));
});

test("judgeAll records exact vs json methods", async () => {
  const cwd = tmpCwd();
  const recs = [rec("m-exact", "Paris.", "paris"), rec("m-json", '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7}', '{"g":8,"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}'), rec("m-num", "The answer is 42", "42")];
  const r = await judgeAll(recs, { cwd, endpoint: null, fraction: 1 });
  const by = Object.fromEntries(r.results.map((x) => [x.record_id, x]));
  assert.equal(by["m-exact"].method, "exact");
  assert.equal(by["m-json"].method, "json");
  assert.equal(by["m-json"].verdict, "agree");
  assert.equal(by["m-num"].method, "numeric");
  const cached = fs.readFileSync(path.join(cwd, ".routearena", "judgements.jsonl"), "utf8");
  assert.ok(cached.includes('"method":"json"') && cached.includes('"method":"exact"'));
});

test("A/B order is stable per record id and both orders occur", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `rec-${i}-${i * 7919}`);
  let targetFirst = 0;
  for (const id of ids) {
    assert.equal(abOrder(id), abOrder(id));
    if (abOrder(id) === "target_first") targetFirst++;
  }
  assert.ok(targetFirst > 60 && targetFirst < 140, `roughly half target-first, got ${targetFirst}/200`);
});

test("judgeAll: LLM judge sees the request, the randomized order is recorded and the verdict maps back", async () => {
  const cwd = tmpCwd();
  // Prose on both sides so the deterministic path cannot decide. The mock judge agrees only when the PRIMARY is answer A,
  // which lets the test see which order the judge was shown.
  const primaryText = "PRIMARY " + "the report covers eight paired requests across two providers ".repeat(8);
  const targetText = "TARGET " + "eight paired requests were compared between the two providers in the report ".repeat(8);
  const judge = await startMockUpstream({
    reply: (b) => {
      const prompt: string = b.messages[0].content;
      const a = prompt.slice(prompt.indexOf("ANSWER A:"), prompt.indexOf("ANSWER B:"));
      return { text: a.includes("PRIMARY") ? "Same facts and fields.\nAGREE" : "The text field differs.\nDISAGREE" };
    },
  });
  try {
    const ids = Array.from({ length: 40 }, (_, i) => `ab-${i}`);
    const pf = ids.find((id) => abOrder(id) === "primary_first")!;
    const tf = ids.find((id) => abOrder(id) === "target_first")!;
    const recs = [rec(pf, primaryText, targetText), rec(tf, primaryText, targetText)];
    const r = await judgeAll(recs, {
      cwd,
      fraction: 1,
      endpoint: { baseUrl: judge.url, auth: "k", model: "judge-model", label: "mock/judge-model" },
      requestText: (x) => `SYSTEM: extract fields\n\nUSER: Fields: a, b (record ${x.id})`,
    });
    const by = Object.fromEntries(r.results.map((x) => [x.record_id, x]));
    assert.equal(by[pf].order, "primary_first");
    assert.equal(by[pf].verdict, "agree");
    assert.equal(by[pf].method, "llm");
    assert.equal(by[tf].order, "target_first");
    assert.equal(by[tf].verdict, "disagree", "target was shown first, so the mock judge saw TARGET as answer A");
    assert.equal(r.judge_cost_calls, 2);
    // the judge saw the reconstructed request, the new framing and the optional-field instruction
    for (const s of judge.seen) {
      const p: string = s.body.messages[0].content;
      assert.ok(p.includes("USER: Fields: a, b"), "request text reaches the judge");
      assert.ok(p.includes("same model served through two different providers"));
      assert.ok(p.includes("not decisive"));
      assert.equal(s.body.max_tokens, 160);
    }
    assert.equal(by[tf].reason, "The text field differs.", "the judge's reason line is kept with the verdict");
    assert.equal(by[pf].reason, "Same facts and fields.");
    const tfPrompt: string = judge.seen.find((s) => s.body.messages[0].content.includes(`record ${tf}`))!.body.messages[0].content;
    assert.ok(tfPrompt.indexOf("TARGET") < tfPrompt.indexOf("PRIMARY"), "target_first puts the target text first");
    // cached with the order
    const cached = fs.readFileSync(path.join(cwd, ".routearena", "judgements.jsonl"), "utf8");
    assert.ok(cached.includes('"order":"target_first"'));
  } finally {
    await judge.close();
  }
});

test("judgeAll falls back to the summary line when no request text is available", async () => {
  const cwd = tmpCwd();
  const judge = await startMockUpstream({ reply: () => ({ text: "AGREE" }) });
  try {
    const r = await judgeAll([rec("fb-1", "x ".repeat(300), "y ".repeat(300))], { cwd, fraction: 1, endpoint: { baseUrl: judge.url, auth: "k", model: "j", label: "mock/j" }, requestText: () => undefined });
    assert.equal(r.results[0].verdict, "agree");
    assert.ok(judge.seen[0].body.messages[0].content.includes("model=openai/gpt-4o-mini; tools=false; response_format=json_object"));
  } finally {
    await judge.close();
  }
});

test("pickJudge prefers the primary when its key exists, else a target", () => {
  const saved = { ...process.env };
  const cwd = tmpCwd();
  try {
    for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    process.env.TOKENROUTER_API_KEY = "tr-test";
    const or = pickJudge({ primary: "openrouter", sample: 1, port: 0, createdAt: "" }, cwd);
    assert.equal(or?.label, "openrouter/openai/gpt-4o-mini");
    assert.equal(or?.baseUrl, PRIMARIES.openrouter.baseUrl);
    assert.equal(or?.auth, "sk-or-v1-test");
    process.env.OPENAI_API_KEY = "sk-test";
    const oa = pickJudge({ primary: "openai", sample: 1, port: 0, createdAt: "" }, cwd);
    assert.equal(oa?.label, "openai/gpt-4o-mini");
    assert.equal(oa?.baseUrl, PRIMARIES.openai.baseUrl);
    // no primary key: fall back to the target list
    delete process.env.OPENROUTER_API_KEY;
    const fb = pickJudge({ primary: "openrouter", sample: 1, port: 0, createdAt: "" }, cwd);
    assert.ok(fb?.label.startsWith("tokenrouter/"), `got ${fb?.label}`);
    delete process.env.TOKENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.equal(pickJudge({ primary: "openrouter", sample: 1, port: 0, createdAt: "" }, cwd), null);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("demo request text: system prompt plus instruction, bulk page content stripped", async () => {
  const items = await loadWorkload();
  const hook = demoRequestText(items);
  // exact page match by url -> keeps the Page URL line and JSON-LD, drops PAGE TEXT
  const exact = hook(rec("d-1", '{"url":"https://en.wikipedia.org/wiki/Web_scraping","title":"Web scraping","authors":[],"publishedAt":"2005-09-17T18:57:30Z","text":"...","excerpt":"...","wordCount":1,"readingTimeMinutes":1,"tags":null,"image":null,"headings":[]}', "{}"));
  assert.ok(exact, "matched");
  assert.ok(exact!.startsWith("SYSTEM: You are the extraction step"));
  assert.ok(exact!.includes("Page URL: https://en.wikipedia.org/wiki/Web_scraping"));
  assert.ok(exact!.includes("Fields: url, title, authors, publishedAt, text, excerpt, wordCount, readingTimeMinutes, tags, image, headings"));
  assert.ok(exact!.includes("JSON-LD:"));
  assert.ok(!exact!.includes("PAGE TEXT:") && !exact!.includes("Skip to content"));
  assert.ok(exact!.length < 3000, `short enough: ${exact!.length}`);
  // template match by field names (a different page of the same template) -> no page-specific lines
  const tmpl = hook(rec("d-2", '{"url":"https://example.org/other","title":"x","authors":[],"publishedAt":null,"text":"","excerpt":"","wordCount":null,"readingTimeMinutes":null,"tags":[],"image":null,"headings":[]}', "{}", "qwen/qwen3.8-flash"));
  assert.ok(tmpl, "matched by template");
  assert.ok(tmpl!.includes("Fields: url, title, authors") && tmpl!.includes("Extract the main article"));
  assert.ok(!tmpl!.includes("Page URL:") && !tmpl!.includes("JSON-LD:"));
  // not from the demo -> undefined, so the judge gets the summary line
  assert.equal(hook(rec("d-3", '{"a":1,"b":2}', "{}")), undefined);
  assert.equal(hook(rec("d-4", "plain prose answer", "other", "anthropic/claude-sonnet-5.5")), undefined);
  // items without markers keep only the first two paragraphs
  const noMarker = items.find((it) => !it.messages[1].content.includes("PAGE TEXT:"))!;
  const s = stripBulk(noMarker.messages[1].content, false);
  assert.ok(s.includes("Fields:") && s.split(/\n\s*\n/).length <= 2 && s.length < 1500, s);
});
