import os
import tempfile

import numpy as np
import pytest

from src.memory.store import VectorStore


@pytest.fixture
async def store():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    s = VectorStore(dim=384, db_path=db_path)
    await s.init_db()
    yield s
    await s.close()
    os.unlink(db_path)


class TestVectorStore:
    @pytest.mark.asyncio
    async def test_empty_store_returns_no_results(self, store):
        results = await store.search(np.zeros(384))
        assert results == []

    @pytest.mark.asyncio
    async def test_add_and_search(self, store):
        vec = np.ones(384, dtype=np.float32)
        vec = vec / np.linalg.norm(vec)
        await store.add("key-1", vec, {"text": "hello"})
        results = await store.search(vec, top_k=5)
        assert len(results) == 1
        assert results[0]["key"] == "key-1"
        assert results[0]["score"] > 0.99

    @pytest.mark.asyncio
    async def test_search_returns_top_k(self, store):
        vec1 = np.zeros(384, dtype=np.float32)
        vec1[0] = 1.0
        vec2 = np.zeros(384, dtype=np.float32)
        vec2[1] = 1.0
        query = np.zeros(384, dtype=np.float32)
        query[0] = 1.0
        await store.add("key-1", vec1)
        await store.add("key-2", vec2)
        results = await store.search(query, top_k=2)
        assert len(results) == 2
        assert results[0]["key"] == "key-1"

    @pytest.mark.asyncio
    async def test_remove(self, store):
        vec = np.ones(384, dtype=np.float32) / np.sqrt(384)
        await store.add("key-1", vec)
        await store.remove("key-1")
        results = await store.search(vec)
        assert results == []

    @pytest.mark.asyncio
    async def test_clear(self, store):
        vec = np.ones(384, dtype=np.float32) / np.sqrt(384)
        await store.add("key-1", vec)
        await store.clear()
        stats = await store.stats()
        assert stats["entries"] == 0

    @pytest.mark.asyncio
    async def test_stats(self, store):
        vec = np.ones(384, dtype=np.float32) / np.sqrt(384)
        await store.add("key-1", vec)
        stats = await store.stats()
        assert stats["entries"] == 1
        assert stats["dimension"] == 384

    @pytest.mark.asyncio
    async def test_threshold_filters_low_scores(self, store):
        vec1 = np.ones(384, dtype=np.float32) / np.sqrt(384)
        vec2 = np.zeros(384, dtype=np.float32)
        vec2[0] = 1.0
        await store.add("key-1", vec1)
        results = await store.search(vec2, top_k=5, threshold=0.5)
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_persistence_across_reload(self, store):
        vec = np.ones(384, dtype=np.float32) / np.sqrt(384)
        await store.add("persist-key", vec, {"text": "hello"})
        db_path = store.db_path
        await store.close()

        s2 = VectorStore(dim=384, db_path=db_path)
        await s2.init_db()
        results = await s2.search(vec)
        assert len(results) == 1
        assert results[0]["key"] == "persist-key"
        await s2.close()

    @pytest.mark.asyncio
    async def test_list_all(self, store):
        vec = np.ones(384, dtype=np.float32) / np.sqrt(384)
        await store.add("key-a", vec, {"text": "a"})
        await store.add("key-b", vec, {"text": "b"})
        items = await store.list_all()
        assert len(items) == 2
        keys = [i["key"] for i in items]
        assert "key-a" in keys
        assert "key-b" in keys
