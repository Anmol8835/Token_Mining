import os
import tempfile

import pytest

from src.cache.exact import ExactCache, hash_key, normalize_messages


@pytest.fixture
async def cache():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    c = ExactCache(db_path=db_path, ttl_seconds=3600)
    await c.init_db()
    yield c
    await c.close()
    os.unlink(db_path)


@pytest.mark.asyncio
async def test_normalize_messages_consistent():
    m1 = [{"role": "user", "content": "  Hello world  "}]
    m2 = [{"content": "Hello world", "role": "user"}]
    assert normalize_messages(m1) == normalize_messages(m2)


@pytest.mark.asyncio
async def test_hash_key_deterministic():
    n = normalize_messages([{"role": "user", "content": "hello"}])
    assert hash_key(n) == hash_key(n)


@pytest.mark.asyncio
async def test_set_and_get(cache):
    messages = [{"role": "user", "content": "What is 2+2?"}]
    response = {"content": "4", "prompt_tokens": 10, "completion_tokens": 5}
    await cache.set(messages, response)
    cached = await cache.get(messages)
    assert cached is not None
    assert cached["content"] == "4"
    assert cached["cache_hit"] is True


@pytest.mark.asyncio
async def test_miss_on_different_messages(cache):
    await cache.set(
        [{"role": "user", "content": "hello"}],
        {"content": "hi", "prompt_tokens": 1, "completion_tokens": 1},
    )
    cached = await cache.get([{"role": "user", "content": "world"}])
    assert cached is None


@pytest.mark.asyncio
async def test_normalize_strips_whitespace(cache):
    m1 = [{"role": "user", "content": "hello world"}]
    m2 = [{"role": "user", "content": "  hello world  "}]
    response = {"content": "hi", "prompt_tokens": 2, "completion_tokens": 1}
    await cache.set(m1, response)
    cached = await cache.get(m2)
    assert cached is not None


@pytest.mark.asyncio
async def test_stats(cache):
    await cache.set(
        [{"role": "user", "content": "a"}],
        {"content": "1", "prompt_tokens": 1, "completion_tokens": 1},
    )
    await cache.set(
        [{"role": "user", "content": "b"}],
        {"content": "2", "prompt_tokens": 2, "completion_tokens": 2},
    )
    stats = await cache.stats()
    assert stats["entries"] == 2


@pytest.mark.asyncio
async def test_clear(cache):
    await cache.set(
        [{"role": "user", "content": "a"}],
        {"content": "1", "prompt_tokens": 1, "completion_tokens": 1},
    )
    await cache.clear()
    stats = await cache.stats()
    assert stats["entries"] == 0


@pytest.mark.asyncio
async def test_ttl_expiry():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    c = ExactCache(db_path=db_path, ttl_seconds=-1)
    await c.init_db()
    await c.set(
        [{"role": "user", "content": "x"}],
        {"content": "y", "prompt_tokens": 1, "completion_tokens": 1},
    )
    cached = await c.get([{"role": "user", "content": "x"}])
    assert cached is None
    await c.close()
    os.unlink(db_path)
