import json
import os
import tempfile

import pytest

from src.memory.semantic import SemanticMemory

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "bench", "fixtures")


@pytest.fixture
async def mem():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    m = SemanticMemory(db_path=db_path, use_sentence_transformer=False)
    await m.init_db()
    yield m
    await m.close()
    os.unlink(db_path)


class TestSemanticMemory:
    @pytest.mark.asyncio
    async def test_store_and_retrieve(self, mem):
        await mem.store("k1", "FastAPI is a web framework")
        results = await mem.retrieve("FastAPI framework", top_k=3)
        assert len(results) >= 1
        assert results[0]["key"] == "k1"

    @pytest.mark.asyncio
    async def test_empty_store_returns_empty(self, mem):
        results = await mem.retrieve("anything")
        assert results == []

    @pytest.mark.asyncio
    async def test_retrieval_latency_under_100ms(self, mem):
        await mem.store("k1", "a" * 500)
        await mem.store("k2", "b" * 500)
        await mem.store("k3", "c" * 500)
        results = await mem.retrieve("test query", top_k=5)
        for r in results:
            assert r["retrieval_time_ms"] < 100

    @pytest.mark.asyncio
    async def test_remove(self, mem):
        await mem.store("k1", "some text")
        await mem.remove("k1")
        results = await mem.retrieve("some text")
        assert results == []

    @pytest.mark.asyncio
    async def test_clear(self, mem):
        await mem.store("k1", "some text")
        await mem.clear()
        stats = await mem.stats()
        assert stats["entries"] == 0

    @pytest.mark.asyncio
    async def test_stats(self, mem):
        await mem.store("k1", "text a")
        await mem.store("k2", "text b")
        stats = await mem.stats()
        assert stats["entries"] == 2

    @pytest.mark.asyncio
    async def test_short_query_does_not_spuriously_match(self, mem):
        await mem.store(
            "k1",
            "a very long detailed memory about databases and SQL queries that spans many topics",
        )
        results = await mem.retrieve("hi", top_k=1, threshold=0.3)
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_near_duplicates_dont_break_ranking(self, mem):
        text = "The ACOS gateway uses FastAPI framework"
        await mem.store("orig", text)
        await mem.store("dup", text)
        results = await mem.retrieve("FastAPI gateway", top_k=3)
        assert len(results) >= 1

    @pytest.mark.asyncio
    async def test_concurrent_access_does_not_crash(self, mem):
        import asyncio

        async def writer():
            for i in range(5):
                await mem.store(f"w-{i}", f"writer data {i}")

        async def reader():
            for i in range(5):
                await mem.retrieve(f"reader query {i}")

        tasks = [writer() for _ in range(3)] + [reader() for _ in range(3)]
        await asyncio.gather(*tasks)
        stats = await mem.stats()
        assert stats["entries"] >= 1

    @pytest.mark.asyncio
    async def test_top1_accuracy_with_semantic_eval(self, real_embedder):
        fixture_path = os.path.join(FIXTURES_DIR, "semantic_eval.json")
        if not os.path.exists(fixture_path):
            pytest.skip("semantic_eval.json not found")

        with open(fixture_path) as f:
            fixture = json.load(f)

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name

        m = SemanticMemory(db_path=db_path, embedder=real_embedder)
        await m.init_db()

        for mem_entry in fixture["memories"]:
            await m.store(mem_entry["id"], mem_entry["text"])

        correct = 0
        total = 0
        for q in fixture["queries"]:
            results = await m.retrieve(q["query"], top_k=1)
            total += 1
            if results and results[0]["key"] == q["expected_id"]:
                correct += 1

        accuracy = correct / total * 100
        await m.close()
        os.unlink(db_path)
        assert accuracy >= 95, f"Top-1 accuracy {accuracy:.1f}% < 95% target"

    @pytest.mark.asyncio
    async def test_false_positive_rate_below_3_percent(self, real_embedder):
        fixture_path = os.path.join(FIXTURES_DIR, "semantic_eval.json")
        if not os.path.exists(fixture_path):
            pytest.skip("semantic_eval.json not found")

        with open(fixture_path) as f:
            fixture = json.load(f)

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name

        m = SemanticMemory(db_path=db_path, embedder=real_embedder)
        await m.init_db()

        for mem_entry in fixture["memories"]:
            await m.store(mem_entry["id"], mem_entry["text"])

        false_positives = 0
        total = 0
        for neg_query in fixture["negatives"]:
            results = await m.retrieve(neg_query, top_k=1, threshold=0.5)
            total += 1
            if results:
                false_positives += 1

        fp_rate = false_positives / max(total, 1) * 100
        await m.close()
        os.unlink(db_path)
        assert fp_rate < 3, f"False-positive rate {fp_rate:.1f}% >= 3% target"
