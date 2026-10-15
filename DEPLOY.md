# Deploying the proxy to a VPS

Runbook for hosting the LLM proxy + dashboard on your own Ubuntu VPS with
Docker + Caddy (HTTPS via Let's Encrypt). When done: clients use your domain
as the API base URL + an API key; you use the same domain in a browser for
the console.

Prerequisites: a VPS with a public IPv4 and an SSH login. A domain is
recommended but not required — see the nip.io note in step 2.

---

## 1. Provision the VPS

Any provider works (Hetzner/DigitalOcean/etc.). **Ubuntu 22.04/24.04 or
Debian 12/13.** Hardware: 2 vCPUs and 1 GB RAM is enough *with swap* (the
stack idles at ~400–550 MB: Docker daemon + Node app + Caddy). Expect
~1 GB of disk for images and build cache. If you have no swap yet, add a
2 GB swapfile first — request-body spikes (the API accepts up to 50 MB
JSON) can OOM the box without it:

```sh
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Then SSH in as root (or a sudo user):

```sh
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # skip if already in the docker group
```

Log out and back in (so the docker group applies), then:

```sh
docker compose version
```

Firewall: allow SSH (22), HTTP (80), HTTPS (443) — deny everything else.
The app itself (8002) is bound to localhost only and never exposed.

## 2. DNS

Create an **A record** for your domain pointing at the VPS's public IP, e.g.
`api.example.com A 203.0.113.10`. Verify propagation (can take a few minutes):

```sh
dig +short api.example.com
```

Caddy needs the record live before it can issue the certificate.

**No domain yet?** Use [nip.io](https://nip.io): the hostname
`<your-vps-ip>.nip.io` (e.g. `34.100.171.213.nip.io`) resolves to your VPS
automatically, and Caddy can still get a real Let's Encrypt certificate for
it. Set `DOMAIN=34.100.171.213.nip.io` in step 4. Switch to your real domain
later by editing `DOMAIN` and re-running `docker compose up -d`.

## 3. Ship the code

From your laptop, in this repo (commit your work first so you ship a known
state):

```sh
rsync -av --delete \
  --exclude node_modules --exclude '.next' --exclude '.env*' --exclude data \
  --exclude system.txt --exclude benchmark \
  --exclude .git --exclude .agents --exclude .claude \
  --exclude '*.md' --exclude skills-lock.json --exclude diagnose-routing.js \
  . user@VPS_IP:/opt/llm-proxy/
```

`--delete` never touches excluded paths, so the VPS `data/` (your keys) and
`.env` survive re-syncs.

## 4. Create the .env on the VPS

```sh
cd /opt/llm-proxy
vi .env && chmod 600 .env
```

Contents (include the providers you use; at least one is required or the
server exits at boot):

```env
ANTHROPIC_API_KEY=...       # or CLAUDE_API_KEY
DEEPSEEK_API_KEY=...        # routing default + compaction
OPENAI_API_KEY=...
GOOGLE_API_KEY=...          # optional (or GEMINI_API_KEY)
TYPESAFE_API_KEY=...        # REQUIRED: config/server.json classifier.mode is "jev"
ADMIN_TOKEN=<output of: openssl rand -hex 32>
OPERATOR_EMAIL=you@example.com       # the ONE account that gets the global console
DOMAIN=api.example.com

# --- Billing (Dodo Payments) — see "Billing rollout" below ---
DODO_PAYMENTS_API_KEY=...             # Dodo dashboard -> Developers -> API keys (env-specific)
DODO_PAYMENTS_WEBHOOK_KEY=...         # webhook signing secret (shown when creating the endpoint)
DODO_PAYMENTS_ENVIRONMENT=test_mode   # test_mode | live_mode — must match the key + product ids
DODO_PAYMENTS_RETURN_URL=https://api.example.com  # dashboard base URL for checkout redirects
# PLAN_ENFORCEMENT=1                  # SET LAST (step 10) — unset = every key gets full access
```

`DEBUG_DUMP=1` optionally enables the per-request `system.txt` payload dump
— leave it unset in production (it was unconditional until 2026-10-02 and
grew past 1GB locally).

## 5. Launch

```sh
cd /opt/llm-proxy
docker compose up -d --build
docker compose ps          # llm-proxy + dashboard should report (healthy)
```

On a small VM (≤2 GB RAM), build the dashboard image **on your laptop** and
ship it — the compose file pins `image: dashboard:prod`, so a loaded image is
used as-is:

```sh
# laptop
docker build -t dashboard:prod --build-arg BACKEND_URL=http://llm-proxy:8002 dashboard/
docker save dashboard:prod | gzip | ssh user@VPS_IP 'gunzip | docker load'
# then on the VM
docker compose up -d --no-build && docker compose restart caddy
```

(Alternatively let the VM compile it with a plain `docker compose up -d
--build` — expect several minutes on 1 GB RAM.)

## 5b. Create a dashboard account

The dashboard is login-gated (sessions in SQLite). Create the first
account on the VM:

```sh
cd /opt/llm-proxy
docker compose exec llm-proxy node db/create-user.js you@example.com "Your Name"
```

(Prompts for a password twice. To reset a lost password:
`… node db/create-user.js --reset you@example.com`.)

Then open `https://<DOMAIN>/` — you'll land on `/login`; after signing
in you get the console (overview, models, routing, activity, API keys,
billing). `proxy.ts` is the auth chokepoint: every page and `/api/*`
call needs the session cookie. Only the account matching
`OPERATOR_EMAIL` gets the admin token injected server-side and sees the
operator console (global metrics, demo/reset/eval, model + routing
toggles); every other account is strictly scoped — its own keys, its own
activity, its own usage_daily totals. If `OPERATOR_EMAIL` is unset no
token is injected for anyone (fail closed). `/health` stays public
(healthchecks + model ids only).

**Open signup**: anyone can create an account at `https://<DOMAIN>/signup`
(status `pending`, zero balance). `db/create-user.js` remains for
operator-created `active` accounts and password resets — but once
enforcement is on (step 10), a zero-balance account is still blocked at
the API: **top up your own account too**, or grant credit manually:

```sh
docker compose exec -T llm-proxy node -e "
  const db = require('./lib/db');
  db.prepare(\"UPDATE users SET status='active', balance_usd = balance_usd + 10 WHERE email = ?\")
    .run('you@example.com');"
```

## 6. Create the first API key — do this immediately

While zero API keys exist, `/v1/messages` and `/v1/classify` accept
**unauthenticated** requests by design (bootstrap mode). Creating the first
key turns enforcement on at once.

Keys must be linked to a user account (`user_id`): with plan enforcement
on, an unlinked key is rejected with `402 key_not_linked`. Dashboard-created
keys are linked automatically; for curl, pass the account's id:

```sh
UID=$(docker compose exec -T llm-proxy node -e \
  "console.log(require('./lib/db').prepare('SELECT id FROM users WHERE email=?').get('you@example.com').id)")

curl -s -X POST https://api.example.com/config/api-keys \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"prod\",\"userId\":\"$UID\"}"
```

Save the returned `apiKey` (`sk-relay-…`) somewhere safe — **it is shown
exactly once**.

Keys created before accounts existed have `user_id NULL` and don't show
up in any scoped account. Attach them with the backfill tool — dry-run
by default, `--apply` writes; only NULL-owned keys are ever touched
(never silently reassigned from another owner):

```sh
# list every unowned key (dry run)
docker compose exec -T llm-proxy node db/backfill.js claim-keys you@example.com

# attach the ones you mean to your account (id or email both work)
docker compose exec -T llm-proxy node db/backfill.js claim-keys you@example.com --apply
```

`claim-usage` does the same for `usage_daily` rows recorded as
`'anonymous'` (pre-account traffic), with `--merge` to sum a day into an
existing row instead of skipping it.

## 7. Verify

```sh
# dashboard responds (200 = console up)
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/

# health is public
curl -s https://api.example.com/health

# no key -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.example.com/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'

# with key -> 200 (once PLAN_ENFORCEMENT=1 the key's account also needs
# credit — balance above -$1.00, otherwise 402; see step 10)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.example.com/v1/messages \
  -H "Authorization: Bearer sk-relay-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'

# admin routes without the token -> 401
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/config/api-keys
```

## 8. Client usage

Give clients the URL + key. `Authorization: Bearer sk-relay-…` and
`x-api-key: sk-relay-…` both work. For Claude Code:

```sh
export ANTHROPIC_BASE_URL=https://api.example.com
export ANTHROPIC_AUTH_TOKEN=sk-relay-...
```

## 9. Day-to-day ops

```sh
docker compose logs -f           # tail all services
docker compose restart llm-proxy # restart the app
docker compose restart dashboard # restart the console
free -h                          # watch RAM/swap on small VMs
docker stats                     # per-container RAM
docker builder prune -f          # reclaim build-cache disk after updates
```

- **Config changes** (`config/*.json`): re-rsync, then `docker compose up -d
  --build` — config is baked into the image.
- **Code updates**: commit locally, re-rsync (step 3), `docker compose up -d
  --build`.
- **Caddyfile changes**: re-rsync, then `docker compose restart caddy` —
  bind-mounted file contents aren't tracked by compose, so `up -d` alone
  won't pick them up.
- **Backups**: `sudo tar czf backup-$(date +%F).tar.gz data/` — `data/app.db`
  is now the primary state (users, sessions, API keys, per-account usage
  totals, request history); the two JSONs (`dashboard-prefs.json`,
  `usage-stats.json`) remain. (`sudo` because the container runs as root and
  owns those files.)
- **Lockout escape hatch**: if you lose every key, SSH in and
  `docker compose exec llm-proxy node -e "require('./lib/db').prepare('DELETE FROM api_keys').run()"` then
  `docker compose restart llm-proxy` — the server reopens in bootstrap mode
  so you can create a fresh key (step 6). A forgotten dashboard password is
  recovered with `db/create-user.js --reset` (step 5b).
- **Rotating ADMIN_TOKEN**: edit `.env`, `docker compose up -d` to apply.
- **Operator account**: `OPERATOR_EMAIL` names the one account that gets the
  global console; everyone else is scoped to their own keys/usage. Change it
  in `.env` + `docker compose up -d` (recreates the containers with the new
  value). Unowned legacy keys/usage are attached with `db/backfill.js`
  (step 6).
- **Per-user model/routing prefs**: each account can toggle models and pick a
  routing mode from the dashboard without the admin token — stored per user in
  the `user_prefs` table of `data/app.db` (auto-created, no migration), while
  the operator's global prefs stay in `data/dashboard-prefs.json`. The router
  unions both exclusion lists and resolves the mode as
  header → user → global → `cheap`; explicit-model requests bypass prefs
  entirely. The classifier mode is server-wide and remains operator-only.
- **More keys**: repeat the step-6 curl with a different name; revoke with
  `curl -X DELETE https://api.example.com/config/api-keys/<id> -H "x-admin-token: …"`
  (ids come from `GET /config/api-keys` with the token).

## 10. Billing rollout (Dodo prepaid top-ups)

Billing is **prepaid credit**, not subscriptions: users buy one-time
top-ups ($5/$10/$20 presets), the balance is debited per request, and the
API blocks once the balance reaches -$1.00 (grace). Deploy the billing
code with `PLAN_ENFORCEMENT` **unset** (default off — every key keeps full
access). Enforce only after the flow below is verified in test mode.

**Never put test-mode Dodo config on production.** Signup is open, so
`DODO_PAYMENTS_ENVIRONMENT=test_mode` (or a test API key with test
`pdt_…` ids) on the public host lets anyone pay with a Dodo test card
and mint real credit. Keep test-mode keys/ids/ENVIRONMENT local only;
production ships with live-mode config — or, until the live products
exist, with no `DODO_*` variables at all (checkout then returns 503 and
the billing page shows the not-configured note).

1. **Create the products** in the [Dodo dashboard](https://app.dodopayments.com)
   in *test mode*: three **one-time payment** products (NOT subscription),
   prices **5 / 10 / 20 dollars** (Dodo takes cents — enter 500/1000/2000).
   Copy their ids (`pdt_…`).
2. **Paste them into the top-up catalog** — both copies, per environment

   ```
   config/plans.json          topups[].products.test_mode / products.live_mode
   dashboard/lib/plans.json   (mirror — keep the topups array in sync)
   ```

   `amountUsd` is the display amount (the credit itself is the pre-tax
   amount Dodo reports: total_amount minus tax — keep the two aligned).
   Adjust the presets and names freely — the shape is one entry per Dodo
   product.
3. **Add the webhook endpoint** in Dodo: `https://<DOMAIN>/webhooks/dodo`,
   subscribed to **`payment.*`** (at least `succeeded`; add `failed`,
   `processing`, `cancelled` for visibility). Copy the signing secret into
   `DODO_PAYMENTS_WEBHOOK_KEY`. Caddy routes `/webhooks*` to the proxy
   (committed Caddyfile) — after re-rsync run `docker compose restart caddy`,
   then `docker compose up -d --build` so the proxy + dashboard pick up the
   new plans.json copies.
4. **Test end-to-end (test mode)**: set `DODO_PAYMENTS_ENVIRONMENT=test_mode`
   + test API key, restart both containers. Sign up at `/signup`, hit
   `/billing`, **Add credit**, pay with a Dodo test card. Within a few seconds
   the balance updates (the account flips to `active` on the first payment).
   Verify the webhook side:

   ```sh
   docker compose exec -T llm-proxy node -e "
     console.table(require('./lib/db').prepare(
       'SELECT webhook_id,type,user_id,processed,error FROM payment_events ORDER BY created_at DESC LIMIT 10').all());"
   ```
5. **Go live**: create the live products + live API key, paste the live
   product ids, set `DODO_PAYMENTS_ENVIRONMENT=live_mode`, `docker compose up
   -d`. Log in and **top up your own account** through the real checkout
   (or use the SQL grant in step 5b).
6. **Flip enforcement**: `PLAN_ENFORCEMENT=1` in `.env`, then `docker compose
   up -d` (llm-proxy restarts). Verify:

   ```sh
   # zero-balance key -> 402 insufficient_balance (or account_inactive for pending)
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.example.com/v1/messages \
     -H "Authorization: Bearer sk-relay-unfunded..." -H "Content-Type: application/json" \
     -d '{"model":"deepseek-flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'

   # funded key -> 200. Balance is debited ~30s after traffic (the metrics
   # flush window) by provider + classifier + compaction spend of every
   # served request (auto-routed OR explicit model); the gate blocks at
   # balance <= -$1.00.
   # webhook without a valid signature -> 401 (no retry); with one -> 200
   ```

   **Rollback**: unset `PLAN_ENFORCEMENT`, `docker compose up -d` — every key
   immediately gets full access again (no data changes needed).
7. **Reconciliation**: events whose user couldn't be matched are stored
   `processed=0` for manual fixing (the payload has `metadata.user_id`, the
   checkout session id, and the Dodo customer email):

   ```sh
   docker compose exec -T llm-proxy node -e "
     console.table(require('./lib/db').prepare(
       \"SELECT webhook_id,type,error FROM payment_events WHERE processed=0\").all());"
   ```

   Match the user by hand, then apply what the handler would have written:
   `UPDATE users SET balance_usd = balance_usd + <amount>, status='active'
   WHERE id = '<user>'` and mark the event processed.
8. **Refunds** (out of scope in code): refunding in the Dodo dashboard does
   not decrement `users.balance_usd` — do it manually with the same UPDATE
   in reverse, and consider whether the user already spent the credit.

## 11. Marketing-site SSO (steerosai.com)

The marketing site (separate repo, deployed on Vercel) hosts signup/login
that write into this stack's SQLite through the proxy's public auth API —
so an account created at `steerosai.com` works immediately in the console
and at checkout, and one login covers both hosts.

- **Endpoints** (public, outside the actor gate; Caddy's `/auth*` handle
  routes them to llm-proxy): `POST /auth/signup`, `POST /auth/login`,
  `POST /auth/logout`, `GET /auth/me`. Same validation, statuses
  (`pending`/`none` on signup), session format and rate limiting as the
  dashboard's `/api/auth/*`.
- **`AUTH_COOKIE_DOMAIN=.steerosai.com` in `.env` is the SSO linchpin** —
  it widens the `steeros_session` cookie to the whole registrable domain.
  Set it on the VPS; leave it unset locally (host-only cookie for dev).
  If it's missing, site login still works but the dashboard never sees the
  session.
- The site calls these server-to-server through its own `/api/auth/*`
  routes (Vercel → `https://app.steerosai.com/auth/*`) and relays the
  `Set-Cookie` header back to the browser.
- After re-rsyncing the Caddyfile change: `docker compose restart caddy`
  (bind-mounted files aren't watched by compose).

Verify the cookie attributes are right (the canary — `Domain` **and**
`Secure` **and** `HttpOnly` must all appear):

```sh
curl -i -X POST https://app.steerosai.com/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"sso-check@example.com","password":"password123","name":"SSO Check"}' \
  | grep -i set-cookie
```

Then log in with that account at `https://steerosai.com/login` and open
`https://app.steerosai.com/` — the console must show it logged in without
a second login (and logout from either side must clear both).

## 12. Sign in with Google

"Continue with Google" on the site and dashboard. The whole OAuth dance
runs on this proxy — the VPS exchanges the code, upserts the user, mints
the same `steeros_session` cookie as email login, and 302s into the
dashboard. Buttons are plain links to `/auth/google/start`; the
`client_secret` never leaves the VPS, and Caddy's existing `/auth*` handle
already routes these (no Caddy restart needed).

### Google Cloud Console (one-time)

1. console.cloud.google.com → create/select a project → **APIs &
   Services → OAuth consent screen**: scopes `openid email profile`; add
   each test account under **Test users** (the app stays in "Testing"
   until published — only test users can sign in).
2. **Credentials → Create credentials → OAuth client ID → Web
   application**, with authorized redirect URIs:
   - `https://app.steerosai.com/auth/google/callback` (production)
   - `http://localhost:8002/auth/google/callback` (local dev)

### Env (VPS `.env`, chmod 600 — never commit)

```
GOOGLE_CLIENT_ID=….apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
# Optional — defaults to https://$DOMAIN/auth/google/callback:
# GOOGLE_REDIRECT_URI=
```

Then `docker compose up -d` (recreates llm-proxy with the new env).

### Canaries

```sh
# Before creds land: 503 (safe to ship first; email auth unaffected)
curl -s https://app.steerosai.com/auth/google/start

# After creds: 302 to Google + host-only, path-scoped state cookie
curl -si https://app.steerosai.com/auth/google/start | grep -Ei 'location|set-cookie'
#   Location: https://accounts.google.com/o/oauth2/v2/auth?...
#   Set-Cookie: steeros_oauth_state=…; Path=/auth/google; HttpOnly; SameSite=Lax

# Garbage code / bad state: bounced to the login banner, cookie cleared
curl -si "https://app.steerosai.com/auth/google/callback?code=garbage&state=x" \
  | grep -Ei 'location|set-cookie'
#   Location: https://app.steerosai.com/login?error=google
```

### Hand-test checklist

- Existing Google account → lands on the dashboard signed in.
- Brand-new Google account → `/billing`; DB row is `pending` with zero
  balance and a bcrypt hash (email/password login with any password → 401).
- Suspended user → `/login?error=suspended`, no session.
- Start at `https://www.steerosai.com/login` → same dance; the cookie
  covers site + dashboard (log out from either side clears both).
- `/login?error=google` shows the banner; refresh clears the query param.
