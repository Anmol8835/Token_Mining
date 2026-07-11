import json
import sqlite3
from typing import Optional

import numpy as np


class VectorStore:
    def __init__(self, dim: int, db_path: str = "memory.db"):
        self.dim = dim
        self.db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        self._vectors: np.ndarray = np.empty((0, dim), dtype=np.float32)
        self._keys: list[str] = []
        self._metadatas: list[dict] = []

    async def init_db(self):
        self._conn = sqlite3.connect(self.db_path)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS vectors ("
            "  key TEXT PRIMARY KEY,"
            "  vector BLOB NOT NULL,"
            "  metadata TEXT DEFAULT '{}'"
            ")"
        )
        self._conn.commit()
        self._load_to_memory()

    def _load_to_memory(self):
        cursor = self._conn.execute("SELECT key, vector, metadata FROM vectors")
        rows = cursor.fetchall()
        self._keys = []
        self._metadatas = []
        vectors = []
        for key, blob, meta_json in rows:
            self._keys.append(key)
            self._metadatas.append(json.loads(meta_json))
            vectors.append(np.frombuffer(blob, dtype=np.float32))
        if vectors:
            self._vectors = np.array(vectors, dtype=np.float32)
        else:
            self._vectors = np.empty((0, self.dim), dtype=np.float32)

    async def add(self, key: str, vector: np.ndarray, metadata: dict = None):
        metadata = metadata or {}
        blob = vector.astype(np.float32).tobytes()
        self._conn.execute(
            "INSERT OR REPLACE INTO vectors (key, vector, metadata) VALUES (?, ?, ?)",
            (key, blob, json.dumps(metadata)),
        )
        self._conn.commit()
        idx = self._keys.index(key) if key in self._keys else -1
        if idx >= 0:
            self._vectors[idx] = vector.astype(np.float32)
            self._metadatas[idx] = metadata
        else:
            self._keys.append(key)
            self._metadatas.append(metadata)
            self._vectors = np.vstack([self._vectors, vector.astype(np.float32)])

    async def remove(self, key: str):
        self._conn.execute("DELETE FROM vectors WHERE key = ?", (key,))
        self._conn.commit()
        if key in self._keys:
            idx = self._keys.index(key)
            self._keys.pop(idx)
            self._metadatas.pop(idx)
            self._vectors = np.delete(self._vectors, idx, axis=0)

    async def search(
        self, query_vector: np.ndarray, top_k: int = 5, threshold: float = 0.0
    ) -> list[dict]:
        if len(self._vectors) == 0:
            return []
        sims = self._vectors @ query_vector.flatten()
        top_indices = np.argsort(sims)[::-1][:top_k]
        results = []
        for idx in top_indices:
            score = float(sims[idx])
            if score < threshold:
                break
            results.append(
                {
                    "key": self._keys[idx],
                    "score": round(score, 4),
                    "metadata": self._metadatas[idx],
                }
            )
        return results

    async def list_all(self) -> list[dict]:
        return [{"key": k, "metadata": m} for k, m in zip(self._keys, self._metadatas)]

    async def stats(self) -> dict:
        return {"entries": len(self._keys), "dimension": self.dim}

    async def clear(self):
        self._conn.execute("DELETE FROM vectors")
        self._conn.commit()
        self._vectors = np.empty((0, self.dim), dtype=np.float32)
        self._keys = []
        self._metadatas = []

    async def close(self):
        if self._conn:
            self._conn.close()
