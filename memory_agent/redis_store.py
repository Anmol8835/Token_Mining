"""
Redis-backed persistence AND multi-tenant partitioning for the memory agent — this
module is the single source of truth. Everything app.py keeps in-process (vector
matrices, BM25 postings, doc_freq) is a derived, rebuildable FAST CACHE per user,
lazy-loaded from here on first touch and kept warm, never the record of truth itself.

"Dividing the server to hold multiple user accounts" is implemented concretely as key
namespacing: every key lives under user:{user_id}:... . That namespacing IS the
isolation boundary — one user's data physically cannot appear in another user's read,
since there's no shared key a cross-user query could ever touch, unlike an in-process
filter (e.g. "if entry.user_id == requested_user_id") which is only as safe as the one
line of code that checks it.

Durability comes from Redis's own persistence (RDB/AOF, configured at the Redis server
level, not here) — a crash or restart of the memory-agent Flask process loses nothing,
since Redis is a separate long-running process holding the actual data.
"""
import json
import os

import redis

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
r = redis.from_url(REDIS_URL, decode_responses=True)


def _entries_key(user_id: str) -> str:
    return f"user:{user_id}:entries"


def _order_key(user_id: str) -> str:
    return f"user:{user_id}:order"


def _settings_key(user_id: str) -> str:
    return f"user:{user_id}:settings"


def _log_key(user_id: str) -> str:
    return f"user:{user_id}:logs"


def _id_counter_key(user_id: str) -> str:
    return f"user:{user_id}:next_id"


def _log_id_counter_key(user_id: str) -> str:
    return f"user:{user_id}:next_log_id"


def ping() -> bool:
    try:
        return bool(r.ping())
    except redis.exceptions.RedisError:
        return False


def next_entry_id(user_id: str) -> int:
    """Atomic per-user counter — safe even if this process ever runs as multiple
    gunicorn workers, since the counter lives in Redis, not in-process memory."""
    return r.incr(_id_counter_key(user_id))


def next_log_id(user_id: str) -> int:
    return r.incr(_log_id_counter_key(user_id))


def add_entry(user_id: str, entry: dict) -> None:
    r.hset(_entries_key(user_id), str(entry["id"]), json.dumps(entry))
    r.rpush(_order_key(user_id), entry["id"])


def get_all_entries(user_id: str) -> list:
    """Returns every stored entry for this user, in FIFO (oldest-first) order."""
    raw = r.hgetall(_entries_key(user_id))
    if not raw:
        return []
    order = [int(x) for x in r.lrange(_order_key(user_id), 0, -1)]
    by_id = {int(k): json.loads(v) for k, v in raw.items()}
    # Skip any id present in the order list but missing from the hash — shouldn't
    # happen in normal operation, but keeps a lazy-load robust against partial writes.
    return [by_id[i] for i in order if i in by_id]


def evict_oldest(user_id: str):
    """Pops and returns the oldest entry_id for this user, or None if empty."""
    popped = r.lpop(_order_key(user_id))
    if popped is None:
        return None
    entry_id = int(popped)
    r.hdel(_entries_key(user_id), str(entry_id))
    return entry_id


def delete_entry(user_id: str, entry_id: int) -> bool:
    removed = r.hdel(_entries_key(user_id), str(entry_id))
    r.lrem(_order_key(user_id), 0, entry_id)
    return bool(removed)


def get_settings(user_id: str, defaults: dict) -> dict:
    raw = r.hgetall(_settings_key(user_id))
    if not raw:
        return dict(defaults)
    out = dict(defaults)
    for k, v in raw.items():
        if k in ("max_count", "max_memory_bytes"):
            out[k] = int(v)
        elif k in ("similarity_threshold", "lexical_threshold"):
            out[k] = float(v)
        elif k == "focus_last_chars":
            out[k] = int(v) if v and v != "None" else None
        else:
            out[k] = v
    return out


def set_settings(user_id: str, settings: dict) -> None:
    # "" (not str(None)="None") for a null value -- get_settings treats both "" and
    # "None" as None on read, but writing "" avoids a Redis hash field that reads back
    # as the confusing literal string "None" if ever inspected directly (e.g. via
    # redis-cli HGETALL) rather than through this module.
    r.hset(_settings_key(user_id), mapping={k: ("" if v is None else str(v)) for k, v in settings.items()})


def append_log(user_id: str, entry: dict, max_len: int) -> None:
    key = _log_key(user_id)
    r.rpush(key, json.dumps(entry))
    r.ltrim(key, -max_len, -1)


def get_logs(user_id: str, limit: int) -> list:
    """Most-recent-first, matching the shape the dashboard already expects."""
    raw = r.lrange(_log_key(user_id), -limit, -1)
    return [json.loads(x) for x in reversed(raw)]


def total_logged(user_id: str) -> int:
    return r.llen(_log_key(user_id))


def list_user_ids() -> list:
    """Every user_id that has ever stored an entry — used only by the dashboard's
    user-picker convenience dropdown, not on any hot path."""
    ids = set()
    for key in r.scan_iter("user:*:entries"):
        ids.add(key.split(":", 2)[1])
    return sorted(ids)
