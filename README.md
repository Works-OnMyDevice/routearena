# RouteArena

See what your LLM traffic would cost on other providers. Your keys stay on your machine.

RouteArena is a CLI and a local proxy. It takes your real OpenAI-compatible traffic (OpenRouter or OpenAI as the primary), mirrors a sample of it to other routers and providers, and writes a report: projected monthly cost per provider, latency p50/p95, time to first token, error rate, output agreement, and the models each provider cannot serve.

Targets: **TokenRouter, Together AI, Groq, DeepInfra, Fireworks AI, OpenAI**. Add a key for any of them, or claim $1 of free TokenRouter mirror credits inside the tool.

```sh
npx routearena@latest check                 # finds keys in env / .env
npx routearena@latest replay activity.csv   # zero-setup: project an OpenRouter activity export onto every target
npx routearena@latest start                 # live: point your SDK's baseURL at http://localhost:4000/v1
npx routearena@latest report                # writes routearena-report/index.html and report.json
```

Node 20+. No account, no telemetry, no hosted dashboard.

## For AI agents

Paste this URL into Claude, Cursor, or ChatGPT and it will run the whole comparison for you:

```
https://github.com/Works-OnMyDevice/routearena/blob/main/AGENTS.md
```

Every command supports `--json`, errors carry a `fix` field, and nothing prompts for input when flags are given. The same text is in [`AGENTS.md`](AGENTS.md), [`llms.txt`](llms.txt), and `routearena --help`.

## How it works

**Replay** reads an OpenRouter activity CSV (Activity page → click the Model card → Export) or the activity API (`--from-api` with `OPENROUTER_MANAGEMENT_KEY`), maps each model to its equivalent on each target, and prints the projected bill, the delta, the coverage (how much of your traffic each target can serve), and fee lines. No requests are sent anywhere.

**Live** runs a proxy on localhost. Change one line, `baseURL: "http://localhost:4000/v1"`, and keep your key. Every request is forwarded to your primary unchanged and the response is returned unchanged, streamed or not. A sampled fraction (10% by default, `--sample`) is re-sent in the background to each configured target with the mapped model. Both sides are logged to `.routearena/log.jsonl`. Requests with images, more than 32K input tokens, or `n > 1` are not mirrored. Mirrors never retry and never delay your response.

**Privacy.** Your primary key goes only to your primary. Target keys go only to their target. Mirrored prompts go to the target provider (that is the point) and nowhere else. The log stays on your machine. `report --publish` uploads aggregates only; the relay rejects any field that looks like a prompt or completion, and so does the CLI before sending.

**Free TokenRouter credits.** `init --free-credits --email you@example.com` sends a magic link. On click, the relay hands the CLI a dedicated TokenRouter key capped at $1 for 7 days (TokenRouter's Management API supports per-key spend caps), so mirrors go straight from your machine to TokenRouter. If no capped key is available, the relay forwards mirrors with a metered token, reserving a conservative cost estimate before each request so the $1 cannot be exceeded even under concurrency, and never stores bodies. One claim per email, global cap on the pool. Relay source: [`relay/`](relay/).

## What the report shows

- Current spend (the `usage.cost` OpenRouter returns for each request, which is what it charges you, or computed from a checked-in price table for OpenAI). Shown as measured total and per-request average; the 30-day extrapolation is labelled rough until the log spans a day and 50 mirrored pairs.
- Per target: projected spend for the same traffic, delta in dollars and percent, coverage, latency p50/p95, TTFT p50/p95, error rate, agreement rate.
- Per model table across all targets, and a paired-comparison detail table.
- Coverage gaps: the models in your traffic each target does not serve, with request counts.
- Method notes: which numbers are measured and which are computed, the sampling rate, the judge model, how TTFT was measured on each side, and when each price table was captured.

Agreement is scored on a 25% sample of mirrored pairs by default (`report --judge-sample 1` judges every pair): exact match for short answers, field-by-field comparison for JSON, otherwise a cheap model judges whether the two answers are equivalent. The judge runs on the first reachable target (TokenRouter's gpt-4o-mini when you have a TokenRouter key or credits), so it spends a fraction of a cent there; the report names the judge model. It is labeled as sampled.

Target costs are always computed from public price lists (dates in `targets/*.json` and in the report). They are projections, not quotes.

## Commands

| Command | What it does |
|---|---|
| `check` | Node version, keys found, usable primaries and targets, credit balance, next step |
| `init` | Writes `.routearena/config.json`; `--free-credits --email` claims TokenRouter credits; `--no-credits` skips |
| `replay <csv>` / `replay --from-api` | Projected cost per target from your OpenRouter usage, with gaps and fee lines |
| `start` | Local proxy; `--daemon` detaches, `stop` kills it |
| `demo` | Sends 40 real web-extraction requests through the proxy with 100% mirroring, then builds the report |
| `report` | Aggregates the log; `--publish` prints a shareable URL (aggregates only); `--judge-sample 1` judges every mirrored pair |
| `credits` | Remaining free-credit budget and expiry |
| `targets` | Target status and model-map sizes |

Keys are read from the environment or a `.env` in the current directory: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `TOKENROUTER_API_KEY`, `TOGETHER_API_KEY`, `GROQ_API_KEY`, `DEEPINFRA_API_KEY`, `FIREWORKS_API_KEY`, `OPENROUTER_MANAGEMENT_KEY`.

## Model mapping

Each target is a JSON file in [`targets/`](targets/) keyed by OpenRouter model id with the target's own id and per-million prices. Only explicit mappings are used; nothing is guessed into a number. Unmapped models show up as coverage gaps, with a possible match shown as a hint. Pull requests that add or correct mappings are welcome; please include the source URL and date.

## Demo workload

`routearena demo` sends real extraction prompts built from the extraction schemas of a production web-scraping API (article, product, company, FAQ, contact, repo, job, docs) over real public pages fetched when the workload was built. Nothing synthetic. See [`demo/README.md`](demo/README.md).

## Development

```sh
npm install
npm run build && node dist/cli.js check --json
npm test
```

The relay in `relay/` is a Cloudflare Worker with one Durable Object for state (see [`relay/README.md`](relay/README.md)). `scripts/sync-relay.mjs` copies the shared report renderer, price table, and agent protocol into it.

## Status and limits

- Primaries: OpenRouter and OpenAI are tested. Any OpenAI-compatible base URL will probably work but is not documented.
- Only `POST /v1/chat/completions` is mirrored. `/v1/responses` passes through unmirrored. Embeddings, batch, and Anthropic-format requests are out of scope.
- TTFT on the primary is the time to the first streamed byte; on targets it is the time to the first content token. The report says so.

MIT. Independent project; not affiliated with any provider. Neutrality note: the only target with a free-credit path is TokenRouter (funded by the maintainer); with your own keys every target is treated identically, every number is computed the same way for every side, and the agreement judge runs on your primary provider.
