# RouteArena relay

The hosted half of RouteArena, a Cloudflare Worker with one Durable Object (SQLite) for state. It does two small things:

1. **Free TokenRouter mirror credits (key mode, the only mode).** `POST /api/claim` emails a magic link; `GET /api/verify` hands the CLI a dedicated TokenRouter key that TokenRouter itself caps at $1 (Management API quota) for 7 days. Mirrored requests go straight to TokenRouter and never touch this relay. There is no forwarding path, no metering, no price table and no cost estimation anywhere in this service.
2. **Published reports.** `POST /api/publish` stores report aggregates (numbers only; anything that looks like a prompt or completion is rejected) and `GET /r/:id` renders them.

What is logged: claim id, pool key name, status, timestamps. Never prompts, completions, request bodies, key values, or other providers' keys. Mirrored traffic does not pass through here at all.

## How credits are enforced

- Per person: `PER_CLAIM_USD` (default 1, clamped to at most 5 in code) is the quota the relay asks TokenRouter to put on the key. TokenRouter enforces it; the relay never counts spend.
- Keys are capped and read back by `scripts/load-pool.mjs` before they enter the pool, and capped again at hand-out. A key is issued only if TokenRouter's own response to the quota call confirms `unlimited_quota: false` with `remain_quota` at or under the budget; otherwise it goes back to the pool, nothing is issued, and the claimant is told to open the link again in a minute.
- `MAX_ISSUED_KEYS` (default 300) is a ceiling on how many pool keys may ever be handed out. It is a count, not a dollar figure.
- When the pool is empty or the ceiling is reached, `POST /api/claim` answers `503 { error: "Free credits are temporarily exhausted.", fix: "Use --no-credits, or set TOKENROUTER_API_KEY with your own key." }`. If the pool empties between a claim and its verification, `GET /api/verify` shows the same message with a 503 and leaves the claim pending; `GET /api/claim/status` keeps reporting `pending` with that `error`/`fix`, and opening the same link again after keys are loaded activates the credits. There is no fallback mode.
- The owner (`ALERT_EMAIL`) is emailed once per day when fewer than 3 keys remain.
- Keys are disabled through the Management API by the daily cron once their claim expires.

### Endpoints for the CLI

- `POST /api/claim { email }` -> `{ status: "sent", id }`
- `GET /api/claim/status?id=` -> `{ status, token?, expires_at?, budget_usd?, mode: "key" }` (the key is available for 15 minutes after verification)
- `GET /api/balance` with `Authorization: Bearer <issued key>` -> the key's remaining and used quota as TokenRouter reports them
- `GET /api/claim/usage` with `Authorization: Bearer <issued key>` -> `{ rows: [{ request_id, model, prompt_tokens, completion_tokens, cost_usd, created_at }], from, to, fetched_at, source: "tokenrouter_billing" }`: TokenRouter's own billed rows for that key, read with the relay's management key (walked in one-hour windows as the API requires, cached 60 s per claim, `partial: true` while older history is still being caught up, 429 with a fix when TokenRouter's management rate limit is hit)

## Deploy

```sh
cd relay
npm install
npx wrangler login                       # opens a browser; approve once
npx wrangler deploy                      # creates routearena-api on your workers.dev subdomain
# secrets (prompted on stdin, never stored in files):
npx wrangler secret put HMAC_SECRET      # 32 random bytes hex: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put RESEND_API_KEY   # a sending-only key from resend.com/api-keys is enough
npx wrangler secret put TOKENROUTER_MANAGEMENT_KEY   # caps, lists, disables pool keys and reads their billing rows
npx wrangler secret put ALERT_EMAIL
npx wrangler secret put MAIL_FROM        # sender on your verified Resend domain
```

Then set `PUBLIC_BASE_URL` in `wrangler.toml` to the deployed URL, redeploy, and point the CLI's default relay (`RELAY_URL` in `src/config.ts`) at it.

Email: `MAIL_FROM` defaults to Resend's test sender `onboarding@resend.dev`, which Resend delivers only to the account owner's own address. Before opening claims to the public, verify a domain at resend.com/domains, then set the sender as a secret, `npx wrangler secret put MAIL_FROM` (for example `RouteArena <hello@mail.yourdomain>`), and redeploy.

Load the key pool (keys created in the TokenRouter console, named `ra-pool-001`…):

```sh
node relay/scripts/verify-quota.mjs sk-<a spare key>     # proves TokenRouter enforces quotas; costs < 1 cent
node relay/scripts/load-pool.mjs relay/pool.local.json   # caps, verifies, loads; then delete the file
```

Kill switch: `CLAIMS_ENABLED=false` stops new claims (in `wrangler.toml` vars; redeploy to apply). Counters for reporting: `GET /api/admin/stats` with the admin secret (`claims`, `verified`, `published`, `pool_available`, `pool_issued`).

## Local test

```sh
npm test                    # unit tests: hand-out and cap verification, exhausted pool, MAX_ISSUED_KEYS, owner alert, usage windows, publish validation, sealing
node test/integration.mjs   # wrangler dev + mock TokenRouter Management API: pool hand-out, cap verification, exhausted -> 503 + fix and retry, ceiling, usage, email rules, stats, publish
```

The mock has no `/v1` endpoints; the integration run asserts that the Worker has none either.
