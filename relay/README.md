# RouteArena relay

The hosted half of RouteArena, a Cloudflare Worker with one Durable Object (SQLite) for state. It does two small things:

1. **Free TokenRouter mirror credits.** `POST /api/claim` emails a magic link; `GET /api/verify` activates $1 for 7 days. Preferred mode hands the CLI a dedicated TokenRouter key that TokenRouter itself caps at $1 (Management API quota), so mirrored requests go straight to TokenRouter and never touch this relay. Fallback mode forwards `POST /v1/chat/completions` with a metered `ra_` token.
2. **Published reports.** `POST /api/publish` stores report aggregates (numbers only; anything that looks like a prompt or completion is rejected) and `GET /r/:id` renders them.

What is logged: claim id, model, token counts, cost, status, latency. Never prompts, completions, or other providers' keys.

## Budget enforcement

- Per person: `PER_CLAIM_USD` (default 1, clamped to at most 5 in code).
- Key mode: the cap is TokenRouter's own per-key quota, set and read back by `scripts/load-pool.mjs` before a key enters the pool, and set again at hand-out. An uncapped key is never handed out.
- Relay mode: every request reserves a conservative estimate inside the Durable Object before being forwarded (chars/3 input, forced `max_tokens`, 1.25× safety); refused if spent + reserved + estimate would exceed the budget or `GLOBAL_CAP_USD`. Missing usage or a cancelled stream charges the full estimate. Unknown models are refused.
- Global: relay spend + open reservations + issued keys × per-claim budget never exceeds `GLOBAL_CAP_USD`.
- `test/integration.mjs` proves all of this against the real Worker running locally with a mock TokenRouter.

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
npx wrangler secret put TOKENROUTER_MANAGEMENT_KEY   # key mode
npx wrangler secret put TOKENROUTER_MASTER_KEY       # relay mode fallback
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

Kill switches: `CLAIMS_ENABLED=false` stops new claims, `RELAY_ENABLED=false` stops forwarding (both in `wrangler.toml` vars; redeploy to apply). Counters for reporting: `GET /api/admin/stats` with the admin secret.

## Local test

```sh
npm test                    # unit tests
node test/integration.mjs   # wrangler dev + mock TokenRouter: budget, concurrency, key mode, global cap, publish
```
