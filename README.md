# RouteArena

See how your LLM traffic behaves on another router. Your keys stay on your machine.

RouteArena is a CLI and a local proxy. It takes your real OpenAI-compatible traffic (OpenRouter or OpenAI as the primary), mirrors a sample of it to another router, and writes a report from what each router itself returned: tokens, the cost each router reported or billed, latency, time to first token, empty answers, rejected models, and whether the two answers match. It ships no price list and no model list.

Targets: **TokenRouter, Together AI, Groq, DeepInfra, Fireworks AI, OpenAI**. Add a key for any of them, or claim $1 of free TokenRouter mirror credits inside the tool.

```sh
npx routearena@latest check                 # finds keys in env / .env
npx routearena@latest start                 # live: point your SDK's baseURL at http://localhost:4000/v1
npx routearena@latest report                # writes routearena-report/index.html and report.json
```

Node 20+. No account, no telemetry, no hosted dashboard.

## For AI agents

Paste this URL into Claude, Cursor, or ChatGPT and it will run the whole comparison for you and show you the result as a one-screen picture:

```
https://github.com/Works-OnMyDevice/routearena/blob/main/AGENTS.md
```

Every command supports `--json`, errors carry a `fix` field, and nothing prompts for input when flags are given. The same text is in [`AGENTS.md`](AGENTS.md) and `routearena --help`.

## How it works

**Live** runs a proxy on localhost. Change one line, `baseURL: "http://localhost:4000/v1"`, and keep your key. Every request is forwarded to your primary unchanged and the response is returned unchanged, streamed or not. A sampled fraction (10% by default, `--sample`) is re-sent in the background to each configured target. Both sides are logged to `.routearena/log.jsonl`. Requests with images, more than 32K input tokens, or `n > 1` are not mirrored. Mirrors never retry and never delay your response.

**Models.** The mirror sends the same model id your app used. If a target names a model differently, your agent (or you) sets a mapping once: `init --map tokenrouter:<your id>=<target id>`. A model the target rejects is reported as rejected, never guessed.

**Cost.** RouteArena computes no prices. OpenRouter reports a cost on every response and that is what the report shows. TokenRouter does not report a cost per response: with free credits the relay reads TokenRouter's own bill for your credit key and fills it in; with your own TokenRouter key the report gives token counts per model and side (prompt, completion, reasoning, cached) and leaves the dollars to you. Other targets report no cost and are shown the same way.

**Privacy.** Your primary key goes only to your primary. Target keys go only to their target. Mirrored prompts go to the target provider (that is the point) and nowhere else. The log stays on your machine. `report --publish` uploads aggregates only; the relay rejects any field that looks like a prompt or completion, and so does the CLI before sending.

**Free TokenRouter credits.** `init --free-credits --email you@example.com` sends a magic link. On click, the relay hands the CLI a dedicated TokenRouter key capped at $1 for 7 days (TokenRouter's Management API supports per-key spend caps), so mirrors go straight from your machine to TokenRouter. One claim per email; when the pool is empty the claim fails with a clear message and you can use your own key. Relay source: [`relay/`](relay/).

## What the report shows

- A one-screen terminal picture of the comparison (`ascii` in the JSON), for your agent to show you as is.
- Per target: reported cost per request on each side where both reported, token counts per side, latency p50/p95, time to first token when both sides were measured the same way, empty answers, errors and rejected models, agreement rate with the judge's reasons.
- Per model table across all targets, and a paired-comparison detail table.
- Method notes: where each number came from, the sampling rate, the judge model, and how time to first token was measured.

Agreement is scored on a 25% sample of mirrored pairs by default (`report --judge-sample 1` judges every pair): exact match for short answers, field-by-field comparison for JSON, otherwise a cheap model on your primary judges whether the two answers are equivalent and says why. A router asked the same prompt twice does not always agree with itself, so read agreement as a comparison between routers, not against 100%.

Monthly extrapolations are labelled rough until the log spans a day and 50 mirrored pairs. Nothing here is a quote.

## Commands

| Command | What it does |
|---|---|
| `check` | Node version, keys found, usable primaries and targets, credit balance, next step |
| `init` | Writes `.routearena/config.json`; `--free-credits --email` claims TokenRouter credits; `--no-credits` skips; `--map` sets a model id for a target |
| `start` | Local proxy; `--daemon` detaches, `stop` kills it |
| `report` | Aggregates the log; `--publish` prints a shareable URL (aggregates only); `--judge-sample 1` judges every mirrored pair |
| `credits` | Remaining free-credit budget and expiry |
| `targets` | Target list, the key variable each needs, and whether one is set |

Keys are read from the environment or a `.env` in the current directory: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `TOKENROUTER_API_KEY`, `TOGETHER_API_KEY`, `GROQ_API_KEY`, `DEEPINFRA_API_KEY`, `FIREWORKS_API_KEY`.

## Development

```sh
npm install
npm run build && node dist/cli.js check --json
npm test
```

The relay in `relay/` is a Cloudflare Worker with one Durable Object for state (see [`relay/README.md`](relay/README.md)). `scripts/sync-relay.mjs` copies the shared report renderer and agent protocol into it.

## Status and limits

- Primaries: OpenRouter and OpenAI are tested. Any OpenAI-compatible base URL will probably work but is not documented.
- Only `POST /v1/chat/completions` is mirrored. `/v1/responses` passes through unmirrored. Embeddings, batch, and Anthropic-format requests are out of scope.
- Time to first token is recorded two ways on both sides (first byte, first content token) and only compared like for like.

MIT. Independent project; not affiliated with any provider. Neutrality note: the only target with a free-credit path is TokenRouter (funded by the maintainer); with your own keys every target is treated identically, every number comes from the routers themselves, and the agreement judge runs on your primary provider.
