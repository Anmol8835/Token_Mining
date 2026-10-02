# Deploying the proxy to a VPS

Runbook for hosting the LLM proxy on your own Ubuntu VPS with Docker + Caddy
(HTTPS via Let's Encrypt). When done, clients use your domain as the base URL
and an API key created in step 6.

Prerequisites: a VPS with a public IPv4, an SSH login, and a domain (or
subdomain) whose DNS you control.

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

## 3. Ship the code

From your laptop, in this repo (commit your work first so you ship a known
state):

```sh
rsync -av --delete \
  --exclude node_modules --exclude .env --exclude data \
  --exclude system.txt --exclude dashboard --exclude benchmark \
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
```

`DEBUG_DUMP=1` optionally enables the per-request `system.txt` payload dump
— leave it unset in production (it was unconditional until 2026-10-02 and
grew past 1GB locally).

## 5. Launch

```sh
cd /opt/llm-proxy
docker compose up -d --build
docker compose ps          # llm-proxy should report (healthy)
```

## 6. Create the first API key — do this immediately

While zero API keys exist, `/v1/messages` and `/v1/classify` accept
**unauthenticated** requests by design (bootstrap mode). Creating the first
key turns enforcement on at once:

```sh
curl -s -X POST https://api.example.com/config/api-keys \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"prod"}'
```

Save the returned `apiKey` (`sk-relay-…`) somewhere safe — **it is shown
exactly once**.

## 7. Verify

```sh
# health is public
curl -s https://api.example.com/health

# no key -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.example.com/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'

# with key -> 200
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
docker compose logs -f           # tail both services
docker compose restart llm-proxy # restart the app
free -h                          # watch RAM/swap on small VMs
docker stats                     # per-container RAM
docker builder prune -f          # reclaim build-cache disk after updates
```

- **Config changes** (`config/*.json`): re-rsync, then `docker compose up -d
  --build` — config is baked into the image.
- **Code updates**: commit locally, re-rsync (step 3), `docker compose up -d
  --build`.
- **Backups**: `sudo tar czf backup-$(date +%F).tar.gz data/` — the three
  JSONs in `data/` (api-keys.json, dashboard-prefs.json, usage-stats.json)
  are the only state. (`sudo` because the container runs as root and owns
  those files.)
- **Lockout escape hatch**: if you lose every key, SSH in and
  `sudo rm data/api-keys.json && docker compose restart llm-proxy` — the
  server reopens in bootstrap mode so you can create a fresh key (step 6).
- **Rotating ADMIN_TOKEN**: edit `.env`, `docker compose up -d` to apply.
- **More keys**: repeat the step-6 curl with a different name; revoke with
  `curl -X DELETE https://api.example.com/config/api-keys/<id> -H "x-admin-token: …"`
  (ids come from `GET /config/api-keys` with the token).
