# Memory Agent — self-contained deployment bundle

A standalone, multi-tenant semantic + lexical prompt/response memory service. This
bundle is built to run on a machine with no internet access and no pre-installed
Python/Redis — the only prerequisite is Docker itself.

## What's inside

- `images.tar` — the memory-agent image (built for **linux/amd64**) and the official
  `redis:7-alpine` image, both pre-pulled/pre-built and saved together. The embedding
  model (`BAAI/bge-small-en-v1.5`) is baked into the memory-agent image at build time,
  so the running container never needs to reach the internet, not even on its first
  request.
- `docker-compose.yml` — starts both containers (memory-agent + Redis), wires them
  together, and gives Redis its own durable volume (`redis-data`) plus AOF persistence.
- `run.sh` — the only command you need: loads the images and starts everything.
- `app.py`, `redis_store.py`, `static/`, `requirements.txt`, `Dockerfile` — included
  for reference/audit (exactly what's inside the image), not required to actually run
  anything; `images.tar` already contains the built result of these.

## Prerequisites on the target machine

- **Docker Engine + the Compose plugin** (`docker compose`, not the older standalone
  `docker-compose`). That's the one thing this bundle can't include — everything else
  is self-contained.
- Built and tested for **x86_64/amd64 Ubuntu**. It will not run on an ARM machine
  (e.g. AWS Graviton, Raspberry Pi) without rebuilding the image for that platform.

## Running it

```bash
tar xzf memory-agent-bundle.tar.gz
cd memory-agent-bundle
./run.sh
```

That's it — `run.sh` loads `images.tar` into the local Docker image store and runs
`docker compose up -d`. First start takes a few seconds (Redis + the memory agent both
have to actually initialize); check readiness with:

```bash
curl http://localhost:5090/v1/health
# {"status":"ok","redis_connected":true,"known_users":[]}
```

## Using it

Every endpoint requires a `user_id` — see the module docstrings in `app.py` for the
full API (`/v1/store`, `/v1/query`, `/v1/explain`, `DELETE /v1/entries/<id>`,
`/v1/settings`). The dashboard is at `http://localhost:5090/dashboard`.

```bash
curl -X POST http://localhost:5090/v1/store -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "prompt": "What is the capital of France?", "response": "Paris."}'

curl -X POST http://localhost:5090/v1/query -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "prompt": "Which city is the capital of France?"}'
```

## Data durability

Redis's own AOF (append-only file) persistence is enabled, and its data directory is a
named Docker volume (`redis-data`) that survives `docker compose down` and container
restarts. It's only wiped if you explicitly run `docker compose down -v`.

## Known limitation: single-worker only

The memory-agent container runs a single gunicorn worker on purpose. Each request's
per-user data is served from an in-process cache that's lazily loaded from Redis (the
real source of truth) and kept warm for fast retrieval — but that cache lives inside
one process. Running multiple workers would give each its own independent,
un-synchronized copy of that cache, so a write handled by one worker wouldn't be
visible to another until it happened to reload — a real correctness gap, not a
performance knob. If you need more throughput than one worker provides, that
cross-worker cache invalidation needs to be built first (e.g. a Redis pub/sub channel
each worker subscribes to, invalidating its cached copy of a user on any write to that
user elsewhere).

## Rebuilding the image yourself (optional)

If you ever need to rebuild instead of using the pre-built `images.tar` (e.g. after
changing `app.py`), from a machine with Docker and buildx:

```bash
docker buildx build --platform linux/amd64 -t memory-agent:latest --load .
docker pull --platform linux/amd64 redis:7-alpine
docker save memory-agent:latest redis:7-alpine -o images.tar
```
