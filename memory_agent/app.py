"""
Standalone, multi-tenant memory agent. Two core APIs, no LLM calls anywhere:

  POST /v1/store  — hand the agent a prompt (and optionally its response) to remember.
  POST /v1/query  — ask whether a prompt matches something already stored; a hit
                    returns the ORIGINAL RESPONSE too, not just the matched prompt.

Plus /v1/explain (see what actually scored and why) and DELETE /v1/entries/<id>
(remove a single bad/stale entry). Every one of these is scoped by a required
`user_id` — see the module docstring in redis_store.py for what that partitioning
actually guarantees and why Redis (not an in-process filter) is the isolation boundary.

Retrieval is HYBRID: semantic (cosine similarity over embeddings) AND lexical (BM25
keyword overlap), fused via Reciprocal Rank Fusion — see find_best_match()'s docstring
for why either signal alone misses cases the other catches. A HIT requires EITHER
signal to independently clear its own tunable threshold.

Speed: retrieval is a per-user, in-process, lazily-loaded, numpy-vectorized cache
(UserCache) — cosine similarity against every stored prompt/response vector is ONE
matrix multiply, not a Python loop calling cosine_sim() per entry; BM25 candidate
generation uses a real inverted index (term -> entry ids), so a query only scores
entries that actually share a term with it, not every entry in memory. Redis is the
durable source of truth and the ONLY thing app.py itself doesn't cache — mutations
(store/delete/evict) write through to Redis immediately, then rebuild the affected
user's in-process cache from the now-current entry list.
"""
import math
import os
import re
import threading
import time
from collections import Counter

import numpy as np
from fastembed import TextEmbedding
from flask import Flask, jsonify, request, send_from_directory

import redis_store

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "5090"))
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
MAX_PROMPT_CHARS = 20000
LOG_MAX = int(os.getenv("MEMORY_LOG_MAX", "2000"))
RESPONSE_MODES = ("full", "answer_only")

DEFAULT_SETTINGS = {
    "max_count": int(os.getenv("MEMORY_MAX_COUNT", "500")),
    "max_memory_bytes": int(os.getenv("MEMORY_MAX_BYTES", str(5 * 1024 * 1024))),  # 5 MB default
    "similarity_threshold": float(os.getenv("SIMILARITY_THRESHOLD", "0.85")),
    "lexical_threshold": float(os.getenv("LEXICAL_THRESHOLD", "0.6")),
    "response_mode": os.getenv("MEMORY_RESPONSE_MODE", "full"),
    # None/0 = disabled (default: embed/index the whole prompt, today's behavior).
    # A positive int narrows what gets EMBEDDED/INDEXED to just the trailing N
    # characters of the prompt — the full original text is still stored and returned
    # as-is. This exists for callers that must send a whole rolling conversation
    # transcript as `prompt` instead of just the new turn: without it, two identical
    # real questions asked in different conversations never match, since the embedding
    # is dominated by whatever unrelated history precedes them, not the actual ask.
    "focus_last_chars": (lambda v: int(v) if v else None)(os.getenv("FOCUS_LAST_CHARS")),
}

TOKEN_RE = re.compile(r"[a-z0-9]+")
# Standard suffix order matters: longest/most-specific suffix first, so e.g. "boxes"
# strips to "box" via "es" before the shorter "s" rule could wrongly leave it as "boxe".
STEM_SUFFIXES = ("edly", "edness", "ing", "ed", "es", "s")
STEM_MIN_LEN = 3  # never stem a word down to fewer than this many characters
BM25_K1 = 1.5
BM25_B = 0.75
RRF_K = 60  # standard constant from the original RRF paper (Cormack et al.)

app = Flask(__name__, static_folder="static")
embedder = TextEmbedding(model_name=EMBEDDING_MODEL)
_vector_bytes = None  # bytes per embedding vector, cached from the first one produced


def stem(token: str) -> str:
    for suf in STEM_SUFFIXES:
        if token.endswith(suf) and len(token) - len(suf) >= STEM_MIN_LEN:
            return token[: -len(suf)]
    return token


def tokenize(text: str) -> list:
    return [stem(t) for t in TOKEN_RE.findall(text.lower())]


def embed(text: str) -> list:
    return next(embedder.embed([text])).tolist()


def apply_focus_window(text: str, focus_last_chars) -> str:
    """If focus_last_chars is set, returns only the trailing N characters of text,
    trimmed forward to the next whitespace so a word isn't cut in half. The caller
    still stores/returns the FULL original text — only what gets embedded and
    tokenized is narrowed. No-op (returns text unchanged) if focus_last_chars is
    falsy or already >= the text's length."""
    if not focus_last_chars or focus_last_chars <= 0 or focus_last_chars >= len(text):
        return text
    window = text[-focus_last_chars:]
    space_idx = window.find(" ")
    if 0 <= space_idx < len(window) - 1:
        window = window[space_idx + 1:]
    return window


def resolve_focus_last_chars(data: dict, cache: "UserCache"):
    """Per-request override (even explicit null, to force-disable for one call) if the
    caller includes focus_last_chars in the request body; otherwise this user's
    configured default. Returns (value, error_message) — error_message is None on
    success."""
    if "focus_last_chars" not in data:
        return cache.settings["focus_last_chars"], None
    v = data["focus_last_chars"]
    if v is None:
        return None, None
    try:
        v = int(v)
    except (TypeError, ValueError):
        return None, "focus_last_chars must be an integer or null"
    if v <= 0:
        return None, "focus_last_chars must be > 0 (or null to disable)"
    return v, None


def term_freq_bytes(term_freq: dict) -> int:
    return sum(len(t.encode("utf-8")) + 8 for t in term_freq)


def entry_size_bytes(prompt: str, response: str, num_vectors: int, vector: list, term_freq: dict) -> int:
    global _vector_bytes
    if _vector_bytes is None:
        _vector_bytes = len(vector) * 4  # float32
    return ((_vector_bytes * num_vectors) + len(prompt.encode("utf-8"))
             + len((response or "").encode("utf-8")) + term_freq_bytes(term_freq))


def get_user_id(source) -> str:
    """source is a dict-like (parsed JSON body, or request.args) — both support .get()."""
    return (source.get("user_id") or "").strip()


# ---------------------------------------------------------------------------------
# Per-user in-process fast cache. Redis (redis_store.py) is the source of truth; this
# is a derived, fully-rebuildable index kept warm for the actual retrieval hot path.
# ---------------------------------------------------------------------------------
class UserCache:
    def __init__(self, user_id: str):
        self.user_id = user_id
        self.lock = threading.Lock()
        self.entries = []  # FIFO order, list of entry dicts — the ground truth this cache derives from
        self.settings = dict(DEFAULT_SETTINGS)
        self._rebuild_index()

    def _rebuild_index(self):
        """Rebuilds every derived structure from self.entries. Called after any mutation
        (store, delete, eviction) — O(n), but mutations are far rarer than queries, and
        queries are what actually need to be fast (a single vectorized matmul, not this)."""
        self.by_id = {e["id"]: e for e in self.entries}
        self.total_bytes = sum(e["size_bytes"] for e in self.entries)

        if self.entries:
            self.prompt_matrix = np.array([e["vector"] for e in self.entries], dtype=np.float32)
            self.prompt_norms = np.linalg.norm(self.prompt_matrix, axis=1)
            self.prompt_row_ids = [e["id"] for e in self.entries]
        else:
            self.prompt_matrix = None
            self.prompt_norms = None
            self.prompt_row_ids = []

        resp_entries = [e for e in self.entries if e.get("response_vector") is not None]
        if resp_entries:
            self.response_matrix = np.array([e["response_vector"] for e in resp_entries], dtype=np.float32)
            self.response_norms = np.linalg.norm(self.response_matrix, axis=1)
            self.response_row_ids = [e["id"] for e in resp_entries]
        else:
            self.response_matrix = None
            self.response_norms = None
            self.response_row_ids = []

        self.doc_freq = {}
        self.total_doc_len = 0
        self.postings = {}  # term -> set(entry_id) — real inverted index for fast BM25 candidate generation
        for e in self.entries:
            for term in e["term_freq"]:
                self.doc_freq[term] = self.doc_freq.get(term, 0) + 1
                self.postings.setdefault(term, set()).add(e["id"])
            self.total_doc_len += e["doc_len"]


_caches = {}
_caches_lock = threading.Lock()


def get_cache(user_id: str) -> UserCache:
    cache = _caches.get(user_id)
    if cache is not None:
        return cache
    with _caches_lock:
        cache = _caches.get(user_id)  # re-check: another thread may have built it first
        if cache is None:
            cache = UserCache(user_id)
            cache.entries = redis_store.get_all_entries(user_id)
            cache.settings = redis_store.get_settings(user_id, DEFAULT_SETTINGS)
            cache._rebuild_index()
            _caches[user_id] = cache
    return cache


def enforce_limits(cache: UserCache) -> list:
    """Evict oldest-first (both in-process and in Redis, kept in lockstep) until both
    configured limits are satisfied. Caller must hold cache.lock."""
    evicted_ids = []
    while cache.entries and (len(cache.entries) > cache.settings["max_count"]
                              or cache.total_bytes > cache.settings["max_memory_bytes"]):
        popped = cache.entries.pop(0)
        redis_store.evict_oldest(cache.user_id)
        evicted_ids.append(popped["id"])
    if evicted_ids:
        cache._rebuild_index()
    return evicted_ids


def log_event(user_id: str, event_type: str, **fields) -> None:
    entry = {"id": redis_store.next_log_id(user_id), "type": event_type,
             "timestamp": time.time(), **fields}
    redis_store.append_log(user_id, entry, LOG_MAX)


def batch_cosine(matrix, norms, query_vec: np.ndarray, query_norm: float) -> np.ndarray:
    if matrix is None:
        return np.array([])
    dots = matrix @ query_vec
    return dots / (norms * query_norm + 1e-9)


def score_all(cache: UserCache, query_vec: np.ndarray, query_tokens: set):
    """Returns (cos_by_id, bm25_by_id) — cosine covers every stored entry (embeddings
    don't need term overlap to mean something); BM25 only scores entries the inverted
    index says share at least one query term, which is the actual speed win over
    scoring every entry's term_freq dict against every query term unconditionally."""
    query_norm = float(np.linalg.norm(query_vec))
    cos_by_id = {}
    prompt_sims = batch_cosine(cache.prompt_matrix, cache.prompt_norms, query_vec, query_norm)
    for i, eid in enumerate(cache.prompt_row_ids):
        cos_by_id[eid] = float(prompt_sims[i])
    if cache.response_matrix is not None:
        resp_sims = batch_cosine(cache.response_matrix, cache.response_norms, query_vec, query_norm)
        for i, eid in enumerate(cache.response_row_ids):
            cos_by_id[eid] = max(cos_by_id[eid], float(resp_sims[i]))

    candidate_ids = set()
    for t in query_tokens:
        candidate_ids |= cache.postings.get(t, set())

    n = len(cache.entries)
    avg_dl = cache.total_doc_len / n if n else 0
    bm25_by_id = {}
    for eid in candidate_ids:
        entry = cache.by_id[eid]
        score = 0.0
        for t in query_tokens:
            tf = entry["term_freq"].get(t, 0)
            if tf == 0:
                continue
            df = cache.doc_freq.get(t, 0)
            idf = math.log((n - df + 0.5) / (df + 0.5) + 1)
            denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (entry["doc_len"] / avg_dl if avg_dl else 0))
            score += idf * (tf * (BM25_K1 + 1)) / denom
        bm25_by_id[eid] = score

    return cos_by_id, bm25_by_id


def lexical_coverage(cache: UserCache, query_tokens: set, entry_id: int) -> float:
    """Fraction of the query's IDF-weighted term mass this entry contains. A term the
    corpus has NEVER seen (df=0) gets the formula's maximum possible IDF — it's the
    most distinctive term available and must count fully against the match. (An earlier
    version zeroed df=0 terms out instead, which let incidental overlap on filler words
    alone reach 1.0 coverage against completely unrelated entries — fixed; kept here as
    a comment since it's exactly the kind of regression a future edit could reintroduce.)"""
    n = len(cache.entries)
    if n == 0 or not query_tokens:
        return 0.0
    entry = cache.by_id[entry_id]
    total_idf = matched_idf = 0.0
    for t in query_tokens:
        df = cache.doc_freq.get(t, 0)
        idf = math.log((n - df + 0.5) / (df + 0.5) + 1)
        total_idf += idf
        if entry["term_freq"].get(t, 0) > 0:
            matched_idf += idf
    return matched_idf / total_idf if total_idf > 0 else 0.0


def find_best_match(cache: UserCache, prompt: str, query_vec: np.ndarray):
    """Hybrid retrieval: fuses the cosine ranking and the BM25 ranking via Reciprocal
    Rank Fusion to pick the single best candidate — the one a good embedding match OR a
    good keyword match agrees on, not just whichever scores highest in isolation.
    Returns (entry, cosine_score, lexical_coverage_score) for the chosen candidate."""
    if not cache.entries:
        return None, 0.0, 0.0
    query_tokens = set(tokenize(prompt))
    cos_by_id, bm25_by_id = score_all(cache, query_vec, query_tokens)
    ids = list(cos_by_id.keys())
    cos_rank = {eid: i for i, eid in enumerate(sorted(ids, key=lambda i: cos_by_id[i], reverse=True))}
    bm25_rank = {eid: i for i, eid in enumerate(sorted(ids, key=lambda i: bm25_by_id.get(i, 0.0), reverse=True))}

    def rrf(eid):
        return 1.0 / (RRF_K + cos_rank[eid] + 1) + 1.0 / (RRF_K + bm25_rank[eid] + 1)

    best_id = max(ids, key=rrf)
    lex = lexical_coverage(cache, query_tokens, best_id)
    return cache.by_id[best_id], cos_by_id[best_id], lex


# --------------------------------------------------------------------------- routes
@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/dashboard")
def dashboard():
    return send_from_directory("static", "dashboard.html")


@app.route("/v1/health")
def health():
    user_id = get_user_id(request.args)
    base = {"status": "ok" if redis_store.ping() else "degraded (redis unreachable)",
            "redis_connected": redis_store.ping()}
    if user_id:
        cache = get_cache(user_id)
        base.update({
            "count": len(cache.entries), "max_count": cache.settings["max_count"],
            "memory_bytes": cache.total_bytes, "max_memory_bytes": cache.settings["max_memory_bytes"],
            "similarity_threshold": cache.settings["similarity_threshold"],
            "lexical_threshold": cache.settings["lexical_threshold"],
        })
    else:
        base["known_users"] = redis_store.list_user_ids()
    return jsonify(base)


@app.route("/v1/list")
def list_memory():
    user_id = get_user_id(request.args)
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400
    cache = get_cache(user_id)
    include_vectors = request.args.get("include_vectors", "").lower() in ("1", "true", "yes")
    entries = [
        {"id": e["id"], "prompt": e["prompt"], "response": e.get("response"),
         "has_response_vector": e.get("response_vector") is not None,
         "timestamp": e["timestamp"], "size_bytes": e["size_bytes"],
         **({"vector": e["vector"], "response_vector": e.get("response_vector")} if include_vectors else {})}
        for e in cache.entries
    ]
    return jsonify({"entries": entries, "memory_size": len(cache.entries), "memory_bytes": cache.total_bytes})


@app.route("/v1/logs")
def list_logs():
    user_id = get_user_id(request.args)
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400
    try:
        limit = min(int(request.args.get("limit", 200)), LOG_MAX)
    except ValueError:
        return jsonify({"error": "limit must be an integer"}), 400
    return jsonify({"logs": redis_store.get_logs(user_id, limit),
                     "total_logged": redis_store.total_logged(user_id)})


@app.route("/v1/settings", methods=["GET", "POST"])
def settings_route():
    """get_all (GET, ?user_id=...): this user's current config plus live usage. set
    (POST, body includes user_id): update any subset of max_count / max_memory_bytes /
    similarity_threshold / lexical_threshold / response_mode; a tightened limit evicts
    oldest entries immediately."""
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        user_id = get_user_id(data)
    else:
        data = {}
        user_id = get_user_id(request.args)
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400

    cache = get_cache(user_id)

    if request.method == "POST":
        with cache.lock:
            if "max_count" in data:
                try:
                    v = int(data["max_count"])
                except (TypeError, ValueError):
                    return jsonify({"error": "max_count must be an integer"}), 400
                if v < 1:
                    return jsonify({"error": "max_count must be >= 1"}), 400
                cache.settings["max_count"] = v
            if "max_memory_bytes" in data:
                try:
                    v = int(data["max_memory_bytes"])
                except (TypeError, ValueError):
                    return jsonify({"error": "max_memory_bytes must be an integer"}), 400
                if v < 1:
                    return jsonify({"error": "max_memory_bytes must be >= 1"}), 400
                cache.settings["max_memory_bytes"] = v
            if "similarity_threshold" in data:
                try:
                    v = float(data["similarity_threshold"])
                except (TypeError, ValueError):
                    return jsonify({"error": "similarity_threshold must be a number"}), 400
                if not (0.0 <= v <= 1.0):
                    return jsonify({"error": "similarity_threshold must be between 0 and 1"}), 400
                cache.settings["similarity_threshold"] = v
            if "lexical_threshold" in data:
                try:
                    v = float(data["lexical_threshold"])
                except (TypeError, ValueError):
                    return jsonify({"error": "lexical_threshold must be a number"}), 400
                if not (0.0 <= v <= 1.0):
                    return jsonify({"error": "lexical_threshold must be between 0 and 1"}), 400
                cache.settings["lexical_threshold"] = v
            if "response_mode" in data:
                v = data["response_mode"]
                if v not in RESPONSE_MODES:
                    return jsonify({"error": f"response_mode must be one of {list(RESPONSE_MODES)}"}), 400
                cache.settings["response_mode"] = v
            if "focus_last_chars" in data:
                v = data["focus_last_chars"]
                if v is None:
                    cache.settings["focus_last_chars"] = None
                else:
                    try:
                        v = int(v)
                    except (TypeError, ValueError):
                        return jsonify({"error": "focus_last_chars must be an integer or null"}), 400
                    if v <= 0:
                        return jsonify({"error": "focus_last_chars must be > 0 (or null to disable)"}), 400
                    cache.settings["focus_last_chars"] = v

            redis_store.set_settings(user_id, cache.settings)
            evicted_ids = enforce_limits(cache)

        return jsonify({**cache.settings, "evicted_ids": evicted_ids,
                         "memory_size": len(cache.entries), "memory_bytes": cache.total_bytes})

    return jsonify({
        **cache.settings,
        "memory_size": len(cache.entries),
        "memory_bytes": cache.total_bytes,
        "vector_bytes_per_entry": _vector_bytes,
        "unique_terms_indexed": len(cache.doc_freq),
    })


@app.route("/v1/store", methods=["POST"])
def store():
    """Give the agent a prompt (and optionally its response) to remember, for a given
    user_id. No hit/miss check happens here — that's /v1/query's job."""
    data = request.get_json(silent=True) or {}
    user_id = get_user_id(data)
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400
    prompt = (data.get("prompt") or "").strip()
    response = (data.get("response") or "").strip() or None
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400
    if len(prompt) > MAX_PROMPT_CHARS:
        return jsonify({"error": f"prompt exceeds maximum length of {MAX_PROMPT_CHARS} characters"}), 400
    if response and len(response) > MAX_PROMPT_CHARS:
        return jsonify({"error": f"response exceeds maximum length of {MAX_PROMPT_CHARS} characters"}), 400

    cache = get_cache(user_id)
    focus_last_chars, err = resolve_focus_last_chars(data, cache)
    if err:
        return jsonify({"error": err}), 400
    embed_text = apply_focus_window(prompt, focus_last_chars)

    vector = embed(embed_text)
    response_vector = embed(response) if response else None
    num_vectors = 2 if response_vector is not None else 1
    combined_text = embed_text + (" " + response if response else "")
    tokens = tokenize(combined_text)
    term_freq = dict(Counter(tokens))
    doc_len = len(tokens)
    size_bytes = entry_size_bytes(prompt, response, num_vectors, vector, term_freq)

    with cache.lock:
        entry_id = redis_store.next_entry_id(user_id)
        entry = {"id": entry_id, "prompt": prompt, "response": response, "vector": vector,
                  "response_vector": response_vector, "term_freq": term_freq, "doc_len": doc_len,
                  "timestamp": time.time(), "size_bytes": size_bytes}
        redis_store.add_entry(user_id, entry)
        cache.entries.append(entry)
        cache._rebuild_index()

        # A single prompt whose own size alone exceeds max_memory_bytes ends up evicting
        # itself here (it's the only entry left) — it genuinely can't be stored under that cap.
        evicted_ids = enforce_limits(cache)
        stored = entry_id not in evicted_ids

    log_event(user_id, "store", prompt=prompt, has_response=response is not None,
              stored=stored, stored_id=entry_id if stored else None, evicted_ids=evicted_ids,
              focus_applied=embed_text != prompt)

    return jsonify({
        "stored_id": entry_id if stored else None,
        "stored": stored,
        "evicted_ids": evicted_ids,
        "memory_size": len(cache.entries),
        "memory_bytes": cache.total_bytes,
    })


@app.route("/v1/entries/<int:entry_id>", methods=["DELETE"])
def delete_entry_route(entry_id):
    """Removes a single entry from this user's memory — for fixing a bad/stale cached
    answer without waiting for FIFO eviction to eventually reach it."""
    user_id = get_user_id(request.args)
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400
    cache = get_cache(user_id)
    with cache.lock:
        if entry_id not in cache.by_id:
            return jsonify({"error": f"no entry with id {entry_id} for this user"}), 404
        cache.entries = [e for e in cache.entries if e["id"] != entry_id]
        cache._rebuild_index()
        redis_store.delete_entry(user_id, entry_id)

    log_event(user_id, "delete", prompt=None, deleted_id=entry_id)
    return jsonify({"deleted_id": entry_id, "memory_size": len(cache.entries), "memory_bytes": cache.total_bytes})


@app.route("/v1/query", methods=["POST"])
def query():
    """Ask whether a prompt matches something already stored, via HYBRID retrieval —
    see find_best_match()'s docstring. A HIT is granted if EITHER signal independently
    clears its own threshold. matched_via says which signal(s) actually fired.

    Response shape depends on this user's response_mode setting:
      "full"        — {hit, similarity, lexical_score, matched_via, matched_prompt,
                        matched_response, matched_id, memory_size}
      "answer_only" — {hit, response, memory_size} — just the cached answer
    Every call is logged with the FULL truth regardless of response_mode."""
    data = request.get_json(silent=True) or {}
    user_id = get_user_id(data)
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400
    if len(prompt) > MAX_PROMPT_CHARS:
        return jsonify({"error": f"prompt exceeds maximum length of {MAX_PROMPT_CHARS} characters"}), 400

    cache = get_cache(user_id)
    mode = cache.settings["response_mode"]
    focus_last_chars, err = resolve_focus_last_chars(data, cache)
    if err:
        return jsonify({"error": err}), 400
    embed_text = apply_focus_window(prompt, focus_last_chars)

    query_vec = np.array(embed(embed_text), dtype=np.float32)  # outside the lock: model inference, not shared state
    with cache.lock:
        match, cos_score, lex_score = find_best_match(cache, embed_text, query_vec)

    cos_hit = cos_score >= cache.settings["similarity_threshold"]
    lex_hit = lex_score >= cache.settings["lexical_threshold"]
    hit = bool(match) and (cos_hit or lex_hit)
    matched_via = (["semantic"] if cos_hit else []) + (["lexical"] if lex_hit else []) if hit else None

    log_event(user_id, "query", prompt=prompt, hit=hit, similarity=round(cos_score, 4),
              lexical_score=round(lex_score, 4), matched_via=matched_via,
              matched_id=match["id"] if hit else None, response_mode=mode,
              focus_applied=embed_text != prompt)

    if mode == "answer_only":
        return jsonify({"hit": hit, "response": match.get("response") if hit else None,
                         "memory_size": len(cache.entries)})

    return jsonify({
        "hit": hit,
        "similarity": round(cos_score, 4),
        "lexical_score": round(lex_score, 4),
        "matched_via": matched_via,
        "matched_prompt": match["prompt"] if hit else None,
        "matched_response": match.get("response") if hit else None,
        "matched_id": match["id"] if hit else None,
        "memory_size": len(cache.entries),
    })


@app.route("/v1/explain", methods=["POST"])
def explain():
    """Debug/tuning tool: shows the top-K candidates for a prompt with a full per-
    candidate score breakdown (cosine, raw BM25, lexical coverage, rank in each
    modality, and exactly which query terms matched vs. didn't) — this is what earlier
    false-positive/false-negative debugging this session had to hand-write ad hoc
    scripts for; now it's a real, repeatable endpoint. Does not affect memory or log."""
    data = request.get_json(silent=True) or {}
    user_id = get_user_id(data)
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400
    if len(prompt) > MAX_PROMPT_CHARS:
        return jsonify({"error": f"prompt exceeds maximum length of {MAX_PROMPT_CHARS} characters"}), 400
    try:
        top_k = min(max(int(data.get("top_k", 5)), 1), 50)
    except (TypeError, ValueError):
        return jsonify({"error": "top_k must be an integer"}), 400

    cache = get_cache(user_id)
    focus_last_chars, err = resolve_focus_last_chars(data, cache)
    if err:
        return jsonify({"error": err}), 400
    embed_text = apply_focus_window(prompt, focus_last_chars)
    query_tokens = set(tokenize(embed_text))
    if not cache.entries:
        return jsonify({"query_tokens": sorted(query_tokens), "candidates": []})

    query_vec = np.array(embed(embed_text), dtype=np.float32)
    with cache.lock:
        cos_by_id, bm25_by_id = score_all(cache, query_vec, query_tokens)
        ids = list(cos_by_id.keys())
        cos_rank = {eid: i for i, eid in enumerate(sorted(ids, key=lambda i: cos_by_id[i], reverse=True))}
        bm25_rank = {eid: i for i, eid in enumerate(sorted(ids, key=lambda i: bm25_by_id.get(i, 0.0), reverse=True))}

        def rrf(eid):
            return 1.0 / (RRF_K + cos_rank[eid] + 1) + 1.0 / (RRF_K + bm25_rank[eid] + 1)

        ranked = sorted(ids, key=rrf, reverse=True)[:top_k]
        candidates = []
        for eid in ranked:
            entry = cache.by_id[eid]
            matched_terms = sorted(t for t in query_tokens if entry["term_freq"].get(t, 0) > 0)
            unmatched_terms = sorted(t for t in query_tokens if entry["term_freq"].get(t, 0) == 0)
            candidates.append({
                "id": eid, "prompt": entry["prompt"], "response": entry.get("response"),
                "cosine": round(cos_by_id[eid], 4),
                "bm25_raw": round(bm25_by_id.get(eid, 0.0), 4),
                "lexical_coverage": round(lexical_coverage(cache, query_tokens, eid), 4),
                "cosine_rank": cos_rank[eid], "bm25_rank": bm25_rank[eid],
                "matched_terms": matched_terms, "unmatched_terms": unmatched_terms,
            })

    return jsonify({
        "query_tokens": sorted(query_tokens),
        "candidates": candidates,
        "embedded_text": embed_text if embed_text != prompt else None,
    })


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
