import pytest

from src.models.client import ModelClient
from src.router.router import LLMRouter


@pytest.fixture
def router():
    premium = ModelClient(model="gpt-4o", label="premium")
    cheap = ModelClient(model="gpt-4o-mini", label="cheap")
    return LLMRouter(premium_client=premium, cheap_client=cheap)


@pytest.mark.asyncio
async def test_route_premium(router):
    result = await router.route("premium", [{"role": "user", "content": "Write code"}])
    assert "model" in result
    assert "content" in result
    assert "(simulated)" in result["model"]
    assert "_llm_router_time_ms" in result


@pytest.mark.asyncio
async def test_route_cheap(router):
    result = await router.route("cheap", [{"role": "user", "content": "Hello"}])
    assert "model" in result
    assert "content" in result
    assert "gpt-4o-mini" in result["model"]
    assert "_llm_router_time_ms" in result
