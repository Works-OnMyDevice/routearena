# RouteArena: instructions for AI agents

You are an AI agent helping a developer find out how their LLM traffic behaves and what it costs on another router. RouteArena mirrors the developer's real requests to a second router and reports what each router returned: tokens, the cost each router itself reported or billed, latency, time to first token, empty answers, rejected models, and whether the answers match. It ships no price list and no model list. Follow these steps exactly. Every command supports --json. Never print or transmit API keys anywhere except into the local .env file.

1. Run: npx routearena@latest check --json
   Read which keys were found. If no primary key (OPENROUTER_API_KEY or OPENAI_API_KEY) exists, ask the human for one, write it to .env in the current directory, and run check again.

2. Pick the models. RouteArena sends each mirrored request to the target with the same model id the human's app uses, unless you tell it otherwise. Look at the model ids the human actually uses (their code, or their OpenRouter activity page). If a target names a model differently, map it when you run init: `--map tokenrouter:openai/gpt-4o-mini=openai/gpt-4o-mini` (one --map per model; the target's own model list is at its /v1/models endpoint with the human's key). A model the target rejects is reported as rejected, never guessed.

3. Free TokenRouter mirror credits (optional; TokenRouter is the only target with a free-credit path, funded by the maintainer, so say so; targets with the human's own keys are compared identically):
   Ask the human for an email, then run: npx routearena@latest init --primary <openrouter|openai> --free-credits --email <email> --json  (add --map flags from step 2)
   Tell the human to click the link in their email. The command waits up to 10 minutes.
   If they decline, run: npx routearena@latest init --primary <...> --no-credits --json

4. Live comparison:
   - If you are operating inside the human's codebase AND it creates an OpenAI-compatible client (search for `new OpenAI(`, `baseURL`, `base_url`, `openai.OpenAI(`): set that client's baseURL to http://localhost:4000/v1 (keep their key), run npx routearena@latest start --daemon --json, and tell the human to use their app normally for a few hours or a day (the default mirrors 10% of requests; for a short test pass --sample 1 to start so every request is mirrored). Numbers from fewer than about 50 mirrored requests are rough; the report says so.
   - Otherwise (chat only, or the codebase has no OpenAI-compatible client): run npx routearena@latest start --daemon --sample 1 --json and have the human point any OpenAI-compatible script, notebook or app they already use at http://localhost:4000/v1 with their usual key, then use it as they normally would for a while. RouteArena sends nothing of its own; it only mirrors what the human's code sends.

5. Report: npx routearena@latest report --json   (add --judge-sample 1 to judge every pair instead of a 25% sample; a few cents more)
   First, show the human the `ascii` field of the JSON exactly as it is, inside a code block, without reflowing it. It is the one-screen picture of the comparison.
   Then read target_models in routearena-report/report.json and point out models where cost, latency, empty answers, or agreement diverge. On cost:
   - OpenRouter cost is what OpenRouter reported for each request (usage.cost).
   - TokenRouter cost is filled in only when the human used the free credits (the relay reads TokenRouter's own bill for that key). With the human's own TokenRouter key, TokenRouter reports no cost per response, so the report gives token counts per model and side (prompt, completion, reasoning, cached); if the human wants dollars, take those counts to TokenRouter's current pricing page yourself and show your arithmetic. RouteArena never computes or ships prices.
   - Report no_output and truncated counts next to error rate: a response that spent its whole budget reasoning and returned nothing is billed in full and is not an error in the HTTP sense. Reasoning tokens often explain cost differences more than price does.
   TTFT is only shown when both sides were measured the same way. Agreement is noisy: a router asked the same prompt twice does not always agree with itself, so quote the judge's reasons (disagreement_reasons) and compare routers with each other, not against 100%.
   Summarize for the human: per-request cost on each side where reported, tokens, latency p50/p95 and TTFT, empty answers and rejected models, agreement with reasons. Offer: npx routearena@latest report --publish --json for a shareable page (aggregates only, no prompts).

6. Cleanup: if you ran start --daemon, run npx routearena@latest stop and remind the human to revert baseURL. Add .routearena/ and routearena-report/ to the project's .gitignore: the log keeps full completions from both sides and must not be committed.

Rules: do not change any file other than .env, .gitignore, and the one baseURL line. Do not invent numbers; a number that is not in report.json does not exist. If a command fails, show its "fix" field to the human. The free-credits step needs a human to click an email link; if no human is available, use --no-credits.
