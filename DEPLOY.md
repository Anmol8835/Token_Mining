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
call needs the session cookie, and the admin token is only injected
server-side for signed-in requests. `/health` stays public
(healthchecks + model ids only).

**Open signup**: anyone can create an account at `https://<DOMAIN>/signup`
(status `pending`, no plan). `db/create-user.js` remains for
operator-created `active` accounts and password resets — but once
enforcement is on (step 10), an `active` account with `plan='none'` is
still blocked at the API: **subscribe your own account too**, or grant
a plan manually:

```sh
docker compose exec -T llm-proxy node -e "
  const db = require('./lib/db');
  db.prepare(\"UPDATE users SET status='active', plan='monthly', plan_expiry=? WHERE email=?\")
    .run(Date.now() + 30*24*3600*1000, 'you@example.com');"
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

Keys created before accounts existed have `user_id NULL`. Backfill them
(replace the id; check with `GET /config/api-keys`):

```sh
docker compose exec -T llm-proxy node -e "
  const db = require('./lib/db');
  db.prepare(\"UPDATE api_keys SET user_id=? WHERE user_id IS NULL\").run('<user-uuid>');"
```

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

# with key -> 200 (once PLAN_ENFORCEMENT=1 the key's account also needs an
# active subscription — otherwise 402; see step 10)
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
- **More keys**: repeat the step-6 curl with a different name; revoke with
  `curl -X DELETE https://api.example.com/config/api-keys/<id> -H "x-admin-token: …"`
  (ids come from `GET /config/api-keys` with the token).

## 10. Billing rollout (Dodo Payments)

Deploy the billing code with `PLAN_ENFORCEMENT` **unset** (default off —
every key keeps full access). Enforce only after the flow below is verified
in test mode.

1. **Create the product** in the [Dodo dashboard](https://app.dodopayments.com)
   in *test mode*: a **subscription** product, monthly, price ≥ $1. Copy its
   id (`pdt_…`).
2. **Paste it into the plan catalog** — both copies, per environment

   ```
   config/plans.json          products.test_mode / products.live_mode
   dashboard/lib/plans.json   (mirror — keep byte-identical plans array)
   ```

   Adjust `priceUsd` / `monthlyQuotaUsd` / `tiers` if you like
   (`tiers: ["cheap"]` limits the plan to cheap-tier models; `tiers:
   ["cheap","pro"]` = all models). `monthlyQuotaUsd: 0` = unlimited.
3. **Add the webhook endpoint** in Dodo: `https://<DOMAIN>/webhooks/dodo`,
   subscribed to `subscription.*` (at least `active`, `renewed`,
   `cancelled`, `expired`, `failed`). Copy the signing secret into
   `DODO_PAYMENTS_WEBHOOK_KEY`. Caddy routes `/webhooks*` to the proxy
   (committed Caddyfile) — after re-rsync run `docker compose restart caddy`,
   then `docker compose up -d --build` so the proxy + dashboard pick up the
   new plans.json copies.
4. **Test end-to-end (test mode)**: set `DODO_PAYMENTS_ENVIRONMENT=test_mode`
   + test API key, restart both containers. Sign up at `/signup`, hit
   `/billing`, Subscribe, pay with a Dodo test card. Within a few seconds the
   billing page flips to active. Verify the webhook side:

   ```sh
   docker compose exec -T llm-proxy node -e "
     console.table(require('./lib/db').prepare(
       'SELECT webhook_id,type,user_id,processed,error FROM payment_events ORDER BY created_at DESC LIMIT 10').all());"
   ```
5. **Go live**: create the live product + live API key, paste the live
   product id, set `DODO_PAYMENTS_ENVIRONMENT=live_mode`, `docker compose up
   -d`. Log in and **subscribe your own account** through the real checkout
   (or use the SQL grant in step 5b).
6. **Flip enforcement**: `PLAN_ENFORCEMENT=1` in `.env`, then `docker compose
   up -d` (llm-proxy restarts). Verify:

   ```sh
   # unsubscribed key -> 402 no_active_subscription
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.example.com/v1/messages \
     -H "Authorization: Bearer sk-relay-unsubscribed..." -H "Content-Type: application/json" \
     -d '{"model":"deepseek-flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'

   # subscribed key + cheap model -> 200; claude-opus-4-8 on a cheap-only plan -> 403 model_tier_denied
   # webhook without a valid signature -> 401 (no retry); with one -> 200
   ```

   **Rollback**: unset `PLAN_ENFORCEMENT`, `docker compose up -d` — every key
   immediately gets full access again (no data changes needed).
7. **Reconciliation**: events whose user couldn't be matched are stored
   `processed=0` for manual fixing (the payload has the Dodo customer email /
   subscription id):

   ```sh
   docker compose exec -T llm-proxy node -e "
     console.table(require('./lib/db').prepare(
       \"SELECT webhook_id,type,error FROM payment_events WHERE processed=0\").all());"
   ```

   Match the user by hand, then fix `subscriptions`/`users` with the same
   values the handler would have written (`plan`, `plan_expiry`,
   `status='active'`) and mark the event processed.
