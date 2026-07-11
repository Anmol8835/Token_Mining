import os
import tempfile

import pytest

from src.memory.experience import ExperienceMemory


@pytest.fixture
async def exp():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    e = ExperienceMemory(db_path=db_path)
    await e.init_db()
    yield e
    await e.close()
    os.unlink(db_path)


class TestExperienceMemory:
    @pytest.mark.asyncio
    async def test_successful_execution_stored(self, exp):
        exp_id = await exp.record(
            goal="Sort a list in Python",
            resolution="Use sorted() or list.sort()",
            model_used="gpt-4",
            tokens_saved=0,
            cost_saved=0.0,
            success=True,
        )
        assert exp_id >= 1
        entries = await exp.list_all()
        assert len(entries) == 1
        entry = entries[0]
        assert entry["goal"] == "Sort a list in Python"
        assert entry["resolution"] == "Use sorted() or list.sort()"
        assert entry["model_used"] == "gpt-4"
        assert entry["success"] is True
        assert entry["is_shortcut"] is False
        assert entry["usage_count"] == 0
        assert entry["id"] == exp_id

    @pytest.mark.asyncio
    async def test_eviction_policy(self, exp):
        for i in range(105):
            await exp.record(
                goal=f"goal-{i}",
                resolution=f"resolution-{i}",
                success=True,
            )
        entries = await exp.list_all()
        assert len(entries) <= exp.max_entries

        all_ids = {e["id"] for e in entries}
        assert 1 not in all_ids
        assert 105 in all_ids

    @pytest.mark.asyncio
    async def test_shortcuts_preserved_during_eviction(self, exp):
        shortcut_id = await exp.record(
            goal="shortcut-goal",
            resolution="shortcut-resolution",
            success=True,
        )
        await exp.mark_shortcut(shortcut_id)

        for i in range(105):
            await exp.record(
                goal=f"filler-{i}",
                resolution=f"filler-resolution-{i}",
                success=True,
            )

        shortcuts = await exp.list_shortcuts()
        shortcut_ids = {s["id"] for s in shortcuts}
        assert shortcut_id in shortcut_ids

    @pytest.mark.asyncio
    async def test_shortcut_roundtrip(self, exp):
        exp_id = await exp.record(
            goal="What is FastAPI?",
            resolution="A Python web framework",
            success=True,
        )
        await exp.mark_shortcut(exp_id)

        shortcuts = await exp.list_shortcuts()
        assert len(shortcuts) == 1
        assert shortcuts[0]["id"] == exp_id
        assert shortcuts[0]["goal"] == "What is FastAPI?"

        all_entries = await exp.list_all()
        entry = next(e for e in all_entries if e["id"] == exp_id)
        assert entry["is_shortcut"] is True

    @pytest.mark.asyncio
    async def test_list_all_ordering(self, exp):
        id1 = await exp.record(goal="first", resolution="res1", success=True)
        id2 = await exp.record(goal="second", resolution="res2", success=True)
        entries = await exp.list_all()
        assert entries[0]["id"] == id2
        assert entries[1]["id"] == id1

    @pytest.mark.asyncio
    async def test_stats(self, exp):
        await exp.record(
            goal="g1", resolution="r1", tokens_saved=100, cost_saved=0.05, success=True
        )
        await exp.record(
            goal="g2", resolution="r2", tokens_saved=200, cost_saved=0.10, success=True
        )
        s = await exp.stats()
        assert s["total_experiences"] == 2
        assert s["shortcuts"] == 0
        assert s["total_tokens_saved"] == 300
        assert s["total_cost_saved"] == 0.15
        assert s["max_entries"] == 100

    @pytest.mark.asyncio
    async def test_stats_with_shortcut(self, exp):
        eid = await exp.record(goal="g1", resolution="r1", success=True)
        await exp.mark_shortcut(eid)
        s = await exp.stats()
        assert s["shortcuts"] == 1

    @pytest.mark.asyncio
    async def test_increment_usage(self, exp):
        eid = await exp.record(goal="g1", resolution="r1", success=True)
        await exp.mark_shortcut(eid)

        s1 = await exp.stats()
        assert s1["total_shortcut_uses"] == 0

        await exp.increment_usage(eid)
        s2 = await exp.stats()
        assert s2["total_shortcut_uses"] == 1

        await exp.increment_usage(eid)
        s3 = await exp.stats()
        assert s3["total_shortcut_uses"] == 2

    @pytest.mark.asyncio
    async def test_clear(self, exp):
        await exp.record(goal="g1", resolution="r1", success=True)
        await exp.clear()
        entries = await exp.list_all()
        assert len(entries) == 0
        s = await exp.stats()
        assert s["total_experiences"] == 0

    @pytest.mark.asyncio
    async def test_record_with_metadata(self, exp):
        exp_id = await exp.record(
            goal="test", resolution="test", metadata={"source": "integration", "tags": ["a", "b"]}
        )
        entries = await exp.list_all()
        entry = next(e for e in entries if e["id"] == exp_id)
        assert entry["success"] is True
