# Demo workload

`demo/workload.jsonl` is what `routearena demo` sends through the proxy. Every line is one chat completion:

- **Prompts** come from `templates/templates.json`. Each template is the extraction step of a production web-scraping API's scraper: it asks the model to return exactly the `outputFields` that scraper produces (article, e-commerce product, company enrichment, FAQ, contact details, GitHub repo, job posting, docs page) as JSON.
- **Pages** come from `templates/sources.json`: public documentation pages, product pages, company homepages, news fronts, and repos, fetched by `scripts/build-demo-workload.mjs` at build time. The page text (JSON-LD first, then visible text, truncated to about 9K characters) is embedded in the prompt. The `fetched_at` field records when.
- **Models** are not in the file. RouteArena ships no model list: the agent running the demo supplies the model ids to send with `--models` (comma-separated, as the primary expects them), and `assignModels` round-robins them over the items. Which ids a mirror target receives is also the agent's call, through `model_map` in `.routearena/config.json`; by default each target gets the same id the client sent.

Empty answers are not rare with reasoning models: one can spend its whole `max_tokens` thinking and return no JSON (`finish_reason: length`, billed in full). The report counts these as `no_output` per side, separately from errors. A target that does not know a model id answers with an error the report records as `model_not_found`; that is a signal to set `model_map`, not a RouteArena table to fix. Because the workload is fixed, a second run on the same key is served from warm prompt caches; the report shows cache share per side.

Nothing here is synthetic. Rebuild with:

```sh
node scripts/build-demo-workload.mjs --limit 130
```

Items built for reasoning models carry `max_tokens: 8000` and `reasoning_effort: "low"`, because measured on 2026-11-06 such models spend 1.3K to 4.7K tokens thinking before emitting any JSON; the others carry 2000. Pass reasoning-capable ids in `--models` if you want those budgets exercised. Cost: 100 requests at roughly 2.5K input tokens is a few cents to about thirty cents per provider. `response_format: json_object` and `temperature: 0` are set so exact-match agreement scoring has a fair chance.
