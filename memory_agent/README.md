# Memory Agent

A standalone, multi-tenant prompt/response memory service. Give it a prompt (and
optionally its response) to remember; later, ask it whether a new prompt matches
something already stored, and get the cached response back instead of regenerating it.
No LLM calls anywhere in this service — matching is pure vector + keyword search.

## Why this exists

A semantic cache in front of an LLM avoids paying for (and waiting on) a fresh
generation when a user is effectively asking something already answered — including
when it's phrased completely differently. This project focuses purely on doing that
matching well: fast, tunable, auditable, and correct across many independent users on
one running server.

## How retrieval works

Two independent signals decide a hit, fused rather than picked one-or-the-other:

- **Semantic** — cosine similarity over sentence embeddings (`fastembed`,
  `BAAI/bge-small-en-v1.5`). Catches paraphrases: "which city is France's capital"
  matches a stored "What is the capital of France?" despite almost no shared words.
- **Lexical** — BM25 keyword overlap over a real inverted index. Catches the case
  embeddings alone under-score: a query that reuses the stored *answer's* wording
  rather than the stored *question's* wording (e.g. "which process uses sunlight,
  water, and CO2" against a stored Q "explain photosynthesis" / A "...uses sunlight,
  water, and CO2..." — the answer, not the question, is where the words actually match).

The two rankings are combined via **Reciprocal Rank Fusion** to pick the best
candidate; a **hit** is granted if *either* signal clears its own independently
tunable threshold (`similarity_threshold`, `lexical_threshold`) — not one opaque
combined score.

An entry stored with a response gets a second embedding vector (of the response text
itself), which is what makes the answer-reuse case above matchable on the semantic
side too, not just lexically.

## Multi-tenant by design

Every API call requires a `user_id`. Data is partitioned in Redis under
`user:{user_id}:...` keys — that key namespacing *is* the isolation boundary between
users, not an in-process filter. One server process serves any number of independent
users; nothing one user stores is ever visible to another's queries.

## Speed

Retrieval for a given user is served from an in-process, numpy-vectorized cache,
lazily loaded from Redis on first touch and kept warm:
- Cosine similarity against every stored vector is **one matrix multiply**, not a
  Python loop calling a similarity function per entry.
- BM25 uses a **real inverted index** (`term -> entry ids`), so a query only scores
  entries that actually share a term with it.

Measured: pure retrieval scoring over 500 entries for one user runs in ~3ms; end-to-end
HTTP latency (dominated by embedding-model inference, a fixed cost independent of
corpus size) only grew ~5ms across a 12.5x scale-up from 40 to 500 entries.

Redis is the durable source of truth — a crash or restart of this service loses
nothing; the in-process cache is a derived, fully rebuildable copy.

## API

All endpoints are under `/v1/`. Every request needs `user_id`.

| Endpoint | Purpose |
|---|---|
| `POST /v1/store` | Remember a `{user_id, prompt, response?}`. `response` is optional. |
| `POST /v1/query` | `{user_id, prompt}` → hit/miss + (on hit) the cached response. |
| `POST /v1/explain` | Debug/tuning: top-K candidates for a prompt with the full cosine/BM25/matched-terms breakdown. |
| `DELETE /v1/entries/<id>?user_id=...` | Remove a single bad/stale entry. |
| `GET/POST /v1/settings?user_id=...` | Per-user tunables — see below. |
| `GET /v1/list?user_id=...` | Every stored entry for a user. |
| `GET /v1/logs?user_id=...` | Full call history (store/query/delete), always logged with the complete truth regardless of `response_mode`. |
| `GET /v1/health` | Redis connectivity; `?user_id=` for that user's live stats. |

### Per-user settings

| Setting | Default | Meaning |
|---|---|---|
| `max_count` | 500 | Max stored entries before FIFO eviction (oldest first) |
| `max_memory_bytes` | 5 MB | Max total memory before FIFO eviction — whichever limit hits first wins |
| `similarity_threshold` | 0.85 | Cosine similarity needed for a semantic hit |
| `lexical_threshold` | 0.6 | BM25 coverage needed for a lexical hit |
| `response_mode` | `full` | `full` returns hit/scores/matched prompt+response; `answer_only` returns just `{hit, response}` |
| `focus_last_chars` | off | See below |

### `focus_last_chars` — for callers stuck sending a whole conversation transcript

If whatever's calling this service can only provide a full rolling conversation
(history + new question concatenated) rather than just the isolated new turn, the
embedding gets dominated by irrelevant prior context and two identical real questions
in different conversations will never match. Setting `focus_last_chars` (per-user
default, or per-request override) embeds/indexes only the trailing N characters of
`prompt` — trimmed to the next word boundary — while still storing and returning the
full original text untouched. The right fix is still to send just the new turn if you
can; this is the fallback for integrations that can't.

## Running locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
redis-server &          # needs a local Redis instance
python3 app.py           # dev server on :5090
```

Dashboard: `http://localhost:5090/dashboard` — live stats, per-user settings, a query
tester, an Explain panel, and the full stored-prompts/call-log tables with delete
buttons. Simple test page: `http://localhost:5090/`.

`populate_sample_data.py [user_id]` seeds ~40 varied prompt/response pairs across
topics (geography, science, coding, cooking, history, finance, casual chat, business)
for quick manual testing.

## Running as a self-contained server (Docker)

See [README_BUNDLE.md](README_BUNDLE.md) for a fully self-contained deployment (Docker
image with the embedding model pre-baked in, bundled Redis, zero internet needed at the
destination) — built for `linux/amd64`.

```bash
./run.sh   # loads pre-built images and starts everything via docker compose
```

## Known limitation

The Docker image runs a single gunicorn worker deliberately: each worker's in-process
cache is a lazily-loaded copy of Redis with no cross-worker invalidation today, so
running multiple workers would let a write on one worker go invisible to another until
it happens to reload. Fine for one server; needs a Redis pub/sub invalidation channel
before scaling to multiple workers/processes.
