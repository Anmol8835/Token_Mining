import hashlib
import json
import time
from typing import Optional

import aiosqlite


def normalize_messages(messages: list[dict]) -> str:
    cleaned = []
    for m in messages:
        cleaned.append(
            {
                "role": m.get("role", "user"),
                "content": m.get("content", "").strip(),
            }
        )
    return json.dumps(cleaned, sort_keys=True, separators=(",", ":"))


def hash_key(normalized: str) -> str:
    return hashlib.sha256(normalized.encode()).hexdigest()


class ExactCache:
    def __init__(self, db_path: str = "cache.db", ttl_seconds: int = 86400):
        self.db_path = db_path
        self.ttl_seconds = ttl_seconds
        self._conn: Optional[aiosqlite.Connection] = None

    async def init_db(self):
        self._conn = await aiosqlite.connect(self.db_path)
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS exact_cache (
                key TEXT PRIMARY KEY,
                normalized TEXT NOT NULL,
                response TEXT NOT NULL,
                prompt_tokens INTEGER DEFAULT 0,
                completion_tokens INTEGER DEFAULT 0,
                created_at REAL NOT NULL,
                ttl INTEGER NOT NULL
            )
        """)
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_exact_cache_created ON exact_cache(created_at)"
        )
        await self._conn.commit()

    def _make_key(self, messages: list[dict]) -> str:
        return hash_key(normalize_messages(messages))

    async def get(self, messages: list[dict]) -> Optional[dict]:
        key = self._make_key(messages)
        t0 = time.monotonic()
        cursor = await self._conn.execute(
            "SELECT response, prompt_tokens, completion_tokens, created_at "
            "FROM exact_cache WHERE key = ? AND (? - created_at) < ttl",
            (key, time.time()),
        )
        row = await cursor.fetchone()
        if not row:
            return None
        response_json, pt, ct, created_at = row
        response = json.loads(response_json)
        elapsed = time.monotonic() - t0
        response["cache_hit"] = True
        response["prompt_tokens"] = pt
        response["completion_tokens"] = ct
        response["total_tokens"] = pt + ct
        response["latency_ms"] = round(elapsed * 1000, 2)
        return response

    async def set(
        self,
        messages: list[dict],
        response: dict,
    ) -> None:
        key = self._make_key(messages)
        normalized = normalize_messages(messages)
        response_json = json.dumps(response)
        pt = response.get("prompt_tokens", 0)
        ct = response.get("completion_tokens", 0)
        now = time.time()
        await self._conn.execute(
            "INSERT OR REPLACE INTO exact_cache "
            "(key, normalized, response, prompt_tokens, completion_tokens, created_at, ttl) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (key, normalized, response_json, pt, ct, now, self.ttl_seconds),
        )
        await self._conn.commit()

    async def stats(self) -> dict:
        cursor = await self._conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM exact_cache"
        )
        row = await cursor.fetchone()
        return {"entries": row[0], "total_tokens_stored": row[1]}

    async def clear(self):
        await self._conn.execute("DELETE FROM exact_cache")
        await self._conn.commit()

    async def close(self):
        if self._conn:
            await self._conn.close()
