# Demo workload

`demo/workload.jsonl` is what `routearena demo` sends through the proxy. Every line is one chat completion:

- **Prompts** come from `templates/templates.json`. Each template is the extraction step of a production web-scraping API's scraper: it asks the model to return exactly the `outputFields` that scraper produces (article, e-commerce product, company enrichment, FAQ, contact details, GitHub repo, job posting, docs page) as JSON.
- **Pages** come from `templates/sources.json`: public documentation pages, product pages, company homepages, news fronts, and repos, fetched by `scripts/build-demo-workload.mjs` at build time. The page text (JSON-LD first, then visible text, truncated to about 9K characters) is embedded in the prompt. The `fetched_at` field records when.
- **Models** rotate through a spread that exists on several targets: `openai/gpt-4o-mini`, `deepseek/deepseek-v4.1-flash`, `z-ai/glm-5.3-flash`, `openai/gpt-oss-120b`, `qwen/qwen3.8-flash`, `minimax/minimax-m3.1-flash`, `xiaomi/mimo-v2.6-flash`, `mistralai/mistral-small-2603`. With an OpenAI primary only the `openai/*` items run.

Every model in the mix was checked on 2026-11-06 to complete a minimal JSON request on both OpenRouter and TokenRouter, so HTTP-level failures should be rare. Empty answers are not rare: a reasoning model can spend its whole `max_tokens` thinking and return no JSON (`finish_reason: length`, billed in full). Measured 2026-11-08, qwen3.8-flash on OpenRouter's Alibaba route did this in 5 of 11 demo requests; glm-5.3-flash on TokenRouter in 3 of 10. The report counts these as `no_output` per side, separately from errors. Because the workload is fixed, a second run on the same key is served from warm prompt caches; the report shows cache share per side and a cache-neutral cost for that reason.

Nothing here is synthetic. Rebuild with:

```sh
node scripts/build-demo-workload.mjs --limit 130
```

Reasoning models (DeepSeek V4.1 Flash, GLM-5.3 Flash, MiniMax M3.1 Flash, Qwen3.8 Flash) get `max_tokens: 8000` and `reasoning_effort: "low"`, because measured on 2026-11-06 they spend 1.3K to 4.7K tokens thinking before emitting any JSON; the others get 2000. Cost: 100 requests at roughly 2.5K input tokens is a few cents to about thirty cents per provider. `response_format: json_object` and `temperature: 0` are set so exact-match agreement scoring has a fair chance.
