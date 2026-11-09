# RouteArena

See how your LLM traffic behaves on alternative routers. Your keys stay on your machine.

RouteArena is a CLI and a local proxy. It takes your real OpenAI-compatible traffic (OpenRouter or OpenAI as the primary), mirrors a sample of it to alternative routers and providers, and writes a report from what each router itself returned: tokens, the cost each router reported or billed, latency, time to first token, empty answers, rejected models, and whether the two answers match. It ships no price list and no model list.

Add a key for any supported router, or claim $1 of free credits on some alternative routers inside the tool.

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

**Live.** Change one line, `baseURL: "http://localhost:4000/v1"`, and keep your key. Every request is forwarded to your primary unchanged and the response is returned unchanged, streamed or not. A sampled fraction (10% by default, `--sample`) is re-sent in the background to each configured alternative router. Both sides are logged to `.routearena/log.jsonl`. Requests with images, more than 32K input tokens, or `n > 1` are not mirrored. Mirrors never retry and never delay your response.

**Models.** The mirror sends the same model id your app used. If a router names a model differently, your agent (or you) sets a mapping once with `init --map`. A model a router rejects is reported as rejected, never guessed.

**Cost.** RouteArena computes no prices. A router that reports a cost on its responses has that cost shown. A router that does not has its token counts shown per model and side (prompt, completion, reasoning, cached), and the dollars are left to you; with free credits the billed amounts are filled in for you.

**Privacy.** Your primary key goes only to your primary. Router keys go only to their router. Mirrored prompts go to the alternative routers you chose (that is the point) and nowhere else. The log stays on your machine. `report --publish` uploads aggregates only; anything that looks like a prompt or completion is rejected before it leaves.

**Free credits.** `init --free-credits --email you@example.com` verifies your email and gives you $1 of mirror credits on some alternative routers, capped by the routers themselves. One claim per email. If none are available you can use your own key instead.

## What the report shows

- A one-screen terminal picture of the comparison (`ascii` in the JSON), for your agent to show you as is.
- Per router: reported cost per request on each side where both reported, token counts per side, latency p50/p95, time to first token when both sides were measured the same way, empty answers, errors and rejected models, agreement rate with the judge's reasons.
- Per model table across all routers, and a paired-comparison detail table.
- Method notes: where each number came from, the sampling rate, the judge model, and how time to first token was measured.

Agreement is scored on a 25% sample of mirrored pairs by default (`report --judge-sample 1` judges every pair): exact match for short answers, field-by-field comparison for JSON, otherwise a cheap model on your primary judges whether the two answers are equivalent and says why. A router asked the same prompt twice does not always agree with itself, so read agreement as a comparison between routers, not against 100%.

Monthly extrapolations are labelled rough until the log spans a day and 50 mirrored pairs. Nothing here is a quote.

## Commands

| Command | What it does |
|---|---|
| `check` | Node version, keys found, usable primaries and routers, credit balance, next step |
| `init` | Writes `.routearena/config.json`; `--free-credits --email` claims free credits; `--no-credits` skips; `--map` sets a model id for a router |
| `start` | Local proxy; `--daemon` detaches, `stop` kills it |
| `report` | Aggregates the log; `--publish` prints a shareable URL (aggregates only); `--judge-sample 1` judges every mirrored pair |
| `credits` | Remaining free-credit budget and expiry |
| `targets` | Supported routers, the key variable each needs, and whether one is set |

Keys are read from the environment or a `.env` in the current directory; `routearena targets` lists the variable for each router.

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

MIT. Independent project; not affiliated with any provider. With your own keys every router is treated identically, every number comes from the routers themselves, and the agreement judge runs on your primary provider.
