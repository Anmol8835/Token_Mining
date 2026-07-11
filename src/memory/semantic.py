import time

from src.memory.embedder import EMBEDDING_DIM, create_embedder
from src.memory.store import VectorStore


class SemanticMemory:
    def __init__(
        self,
        db_path: str = "memory.db",
        use_sentence_transformer: bool = False,
        embedder=None,
    ):
        self.dim = EMBEDDING_DIM
        # allow injecting an already-loaded embedder so callers (e.g. tests)
        # can share one loaded model instead of paying the ~10s load cost
        # on every instantiation
        self._embedder = embedder or create_embedder(
            use_sentence_transformer=use_sentence_transformer
        )
        self._store = VectorStore(dim=self.dim, db_path=db_path)

    async def init_db(self):
        await self._store.init_db()

    async def store(self, key: str, text: str, metadata: dict = None):
        vector = self._embedder.embed(text)
        await self._store.add(key, vector, metadata=(metadata or {}) | {"text": text})

    async def retrieve(self, query: str, top_k: int = 5, threshold: float = 0.0) -> list[dict]:
        t0 = time.monotonic()
        query_vec = self._embedder.embed(query)
        results = await self._store.search(query_vec, top_k=top_k, threshold=threshold)
        elapsed = time.monotonic() - t0
        for r in results:
            r["retrieval_time_ms"] = round(elapsed * 1000, 2)
        return results

    async def remove(self, key: str):
        await self._store.remove(key)

    async def list_all(self) -> list[dict]:
        return await self._store.list_all()

    async def stats(self) -> dict:
        return await self._store.stats()

    async def clear(self):
        await self._store.clear()

    async def close(self):
        await self._embedder.close()
        await self._store.close()
