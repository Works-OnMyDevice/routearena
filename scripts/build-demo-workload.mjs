// Builds demo/workload.jsonl: real extraction prompts over real public pages.
//
// Templates come from a production web-scraping API's scraper definitions (the `outputFields` of its scraper definitions):
// each asks a model to extract exactly the `outputFields` that the corresponding scraper produces, as JSON,
// from the text of a page fetched at build time. No synthetic prompts.
//
// Usage: node scripts/build-demo-workload.mjs [--limit 120]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 120;
const MAX_PAGE_CHARS = 9000; // keeps each prompt roughly 2.5K tokens so 100 requests cost cents, not dollars

const templates = JSON.parse(fs.readFileSync(path.join(root, "demo", "templates", "templates.json"), "utf8"));
const sources = JSON.parse(fs.readFileSync(path.join(root, "demo", "templates", "sources.json"), "utf8"));

// Models rotate through a spread of what people actually route (OpenRouter rankings, 2026-11-05) that also exist on
// several targets. Each item names its OpenRouter id; the demo strips the vendor prefix for an OpenAI primary.
const MODELS = ["openai/gpt-4o-mini", "deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "openai/gpt-oss-120b", "qwen/qwen3.8-flash", "minimax/minimax-m3.1-flash", "xiaomi/mimo-v2.6-flash", "mistralai/mistral-small-2603"];
// Reasoning models think for thousands of tokens on this task (measured 2026-11-06: GLM-5.3 Flash 4.7K, MiniMax M3.1 3.7K,
// DeepSeek V4.1 Flash 1.3K before any JSON). They get a larger output budget and reasoning_effort: "low", which an
// extraction app would set too. Providers that ignore the hint still fit in 8000 tokens.
// Every model in MODELS was verified on 2026-11-06 to complete a minimal JSON request on both OpenRouter and TokenRouter.
const REASONING = new Set(["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "minimax/minimax-m3.1-flash", "qwen/qwen3.8-flash"]);

function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // keep JSON-LD: it is what the extractors read first
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).filter((x) => x.length < 4000);
  s = s.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  if (ld.length) s = `JSON-LD:\n${ld.join("\n")}\n\nPAGE TEXT:\n${s}`;
  return s;
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; routearena-demo-builder/0.1; +https://github.com/Works-OnMyDevice/routearena)", accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get("content-type") ?? "";
    const body = await r.text();
    return ct.includes("html") ? htmlToText(body) : body;
  } finally {
    clearTimeout(t);
  }
}

const items = [];
let n = 0;
let failed = 0;
for (const src of sources) {
  if (items.length >= LIMIT) break;
  const tpl = templates[src.template];
  if (!tpl) throw new Error(`unknown template ${src.template}`);
  let text;
  try {
    text = await fetchPage(src.url);
  } catch (e) {
    failed++;
    console.error(`skip ${src.url}: ${e.message}`);
    continue;
  }
  if (text.length < 400) {
    failed++;
    console.error(`skip ${src.url}: too little text (${text.length})`);
    continue;
  }
  const page = text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) + "\n[truncated]" : text;
  const model = MODELS[n % MODELS.length];
  n++;
  items.push({
    id: `demo-${String(n).padStart(3, "0")}`,
    template: src.template,
    source_url: src.url,
    fetched_at: new Date().toISOString().slice(0, 10),
    model,
    messages: [
      { role: "system", content: tpl.system },
      { role: "user", content: tpl.user.replace("{{url}}", src.url).replace("{{fields}}", tpl.fields.join(", ")).replace("{{page}}", page) },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: REASONING.has(model) ? 8000 : 2000,
    ...(REASONING.has(model) ? { reasoning_effort: "low" } : {}),
  });
  console.error(`ok   ${src.template.padEnd(22)} ${src.url}`);
}
fs.mkdirSync(path.join(root, "demo"), { recursive: true });
fs.writeFileSync(path.join(root, "demo", "workload.jsonl"), items.map((i) => JSON.stringify(i)).join("\n") + "\n");
console.error(`wrote demo/workload.jsonl: ${items.length} items (${failed} sources skipped)`);
