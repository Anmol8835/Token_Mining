import os
import tempfile

import pytest

from src.memory.embedder import SimulatedEmbedder
from src.memory.experience import ExperienceMemory
from src.memory.learning import LearningEngine
from src.memory.semantic import SemanticMemory


@pytest.fixture
async def engine():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        exp_path = f.name
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        mem_path = f.name

    embedder = SimulatedEmbedder()
    sem = SemanticMemory(db_path=mem_path, embedder=embedder)
    await sem.init_db()
    exp = ExperienceMemory(db_path=exp_path)
    learn = LearningEngine(
        semantic_memory=sem,
        experience_memory=exp,
        shortcut_threshold=0.3,
    )
    await learn.init_db()

    yield learn

    await learn.close()
    await sem.close()
    os.unlink(exp_path)
    os.unlink(mem_path)


class TestLearningEngine:
    @pytest.mark.asyncio
    async def test_record_and_learn_creates_shortcut(self, engine):
        exp_id = await engine.record_execution(
            goal="sort a list in python",
            resolution="use sorted() built-in function",
            success=True,
        )
        await engine.learn_from(exp_id)

        shortcuts = await engine._experience.list_shortcuts()
        assert len(shortcuts) == 1
        assert shortcuts[0]["id"] == exp_id

    @pytest.mark.asyncio
    async def test_failed_execution_not_promoted(self, engine):
        exp_id = await engine.record_execution(
            goal="solve math problem",
            resolution="wrong answer",
            success=False,
        )
        await engine.learn_from(exp_id)

        shortcuts = await engine._experience.list_shortcuts()
        assert len(shortcuts) == 0

    @pytest.mark.asyncio
    async def test_find_shortcut_matches_similar_goal(self, engine):
        exp_id = await engine.record_execution(
            goal="sort a list python code",
            resolution="use sorted() built-in function",
            success=True,
        )
        await engine.learn_from(exp_id)

        result = await engine.find_shortcut("sort list python code")
        assert result is not None
        assert result["experience_id"] == exp_id
        assert result["score"] >= 0.1

    @pytest.mark.asyncio
    async def test_find_shortcut_returns_none_on_no_match(self, engine):
        exp_id = await engine.record_execution(
            goal="sort a list python",
            resolution="use sorted()",
            success=True,
        )
        await engine.learn_from(exp_id)

        result = await engine.find_shortcut("completely unrelated weather topic")
        assert result is None

    @pytest.mark.asyncio
    async def test_auto_learn_promotes_frequent(self, engine):
        id_low = await engine.record_execution(
            goal="low usage goal",
            resolution="low res",
            success=True,
        )
        id_high = await engine.record_execution(
            goal="high usage goal",
            resolution="high res",
            success=True,
        )

        await engine._experience.increment_usage(id_high)
        await engine._experience.increment_usage(id_high)

        await engine.auto_learn(min_usage=2)

        shortcuts = await engine._experience.list_shortcuts()
        shortcut_ids = {s["id"] for s in shortcuts}
        assert id_high in shortcut_ids
        assert id_low not in shortcut_ids

    @pytest.mark.asyncio
    async def test_stats_tracking(self, engine):
        exp_id = await engine.record_execution(
            goal="sort list",
            resolution="use sorted()",
            success=True,
        )
        await engine.learn_from(exp_id)

        await engine.find_shortcut("sort list python")
        await engine.find_shortcut("sort list code")
        await engine.find_shortcut("unrelated weather topic")

        s = engine.stats()
        assert s["shortcut_hits"] == 2
        assert s["shortcut_misses"] == 1
        assert s["shortcut_hit_rate_percent"] == pytest.approx(66.7, abs=0.5)
        assert s["threshold"] == 0.3

    @pytest.mark.asyncio
    async def test_stats_initial_state(self, engine):
        s = engine.stats()
        assert s["shortcut_hits"] == 0
        assert s["shortcut_misses"] == 0
        assert s["shortcut_hit_rate_percent"] == 0.0

    @pytest.mark.asyncio
    async def test_learn_from_nonexistent_id(self, engine):
        await engine.learn_from(99999)
        shortcuts = await engine._experience.list_shortcuts()
        assert len(shortcuts) == 0

    @pytest.mark.asyncio
    async def test_learn_from_non_shortcut_marks_and_stores_in_semantic(self, engine):
        exp_id = await engine.record_execution(
            goal="write a function",
            resolution="def foo(): pass",
            success=True,
        )
        await engine.learn_from(exp_id)

        memories = await engine._semantic.list_all()
        shortcut_keys = [m["key"] for m in memories if m["key"].startswith("shortcut:")]
        assert len(shortcut_keys) == 1
        assert f"shortcut:{exp_id}" in shortcut_keys

        shortcut = memories[0]
        meta = shortcut["metadata"]
        assert meta["resolution"] == "def foo(): pass"
        assert meta["goal"] == "write a function"
