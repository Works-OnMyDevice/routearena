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

// Items carry no model: the agent running the demo supplies model ids (demo --models), and every item gets the same
// output budget (8000 tokens) so a reasoning model assigned to any item has room to think before it answers.

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
  n++;
  items.push({
    id: `demo-${String(n).padStart(3, "0")}`,
    template: src.template,
    source_url: src.url,
    fetched_at: new Date().toISOString().slice(0, 10),
    messages: [
      { role: "system", content: tpl.system },
      { role: "user", content: tpl.user.replace("{{url}}", src.url).replace("{{fields}}", tpl.fields.join(", ")).replace("{{page}}", page) },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 8000,
  });
  console.error(`ok   ${src.template.padEnd(22)} ${src.url}`);
}
fs.mkdirSync(path.join(root, "demo"), { recursive: true });
fs.writeFileSync(path.join(root, "demo", "workload.jsonl"), items.map((i) => JSON.stringify(i)).join("\n") + "\n");
console.error(`wrote demo/workload.jsonl: ${items.length} items (${failed} sources skipped)`);
