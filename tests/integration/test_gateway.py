import json
import os

import pytest
from httpx import ASGITransport, AsyncClient

from src.gateway.server import (
    app,
    cache,
    experience_memory,
    learning,
    redactor,
    semantic_memory,
)
from src.memory.context import _count_messages_tokens

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "bench", "fixtures")


@pytest.fixture(autouse=True)
async def setup_stores():
    await cache.init_db()
    await semantic_memory.init_db()
    await learning.init_db()
    await cache.clear()
    await semantic_memory.clear()
    await experience_memory.clear()


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


class TestHealth:
    @pytest.mark.asyncio
    async def test_health_endpoint(self, client):
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["phase"] == "8-redaction"
        assert "routers" in data
        assert data["routers"]["rule"] == "active"
        assert "context" in data
        assert data["context"]["summarizer"] == "active"
        assert data["context"]["max_tokens"] == 800
        assert "semantic_memory" in data
        assert data["semantic_memory"]["active"] is True
        assert "experience_memory" in data
        assert data["experience_memory"]["active"] is True
        assert "learning_engine" in data
        assert data["learning_engine"]["active"] is True
        assert "confidence_engine" in data
        assert data["confidence_engine"]["active"] is True
        assert "evaluation_engine" in data
        assert data["evaluation_engine"]["active"] is True
        assert "redaction" in data
        assert data["redaction"]["active"] is True


class TestRouting:
    @pytest.mark.asyncio
    async def test_greeting_routes_to_cheap(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Hello! How are you?"}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["acos_trace"]["route"] == "cheap"
        assert data["acos_trace"]["cache_hit"] is False

    @pytest.mark.asyncio
    async def test_code_routes_to_premium(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [
                    {"role": "user", "content": "Write a Python function to sort a list."}
                ],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["acos_trace"]["route"] == "premium"

    @pytest.mark.asyncio
    async def test_analysis_routes_to_premium(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Analyze the sentiment of this review."}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["acos_trace"]["route"] == "premium"

    @pytest.mark.asyncio
    async def test_creative_routes_to_cheap(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Write a haiku about the moon."}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["acos_trace"]["route"] == "cheap"

    @pytest.mark.asyncio
    async def test_routing_time_under_50ms(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Write code to sort an array."}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["acos_trace"]["routing_time_ms"] < 50


class TestCache:
    @pytest.mark.asyncio
    async def test_repeat_call_is_cache_hit(self, client):
        payload = {
            "messages": [{"role": "user", "content": "What is 2+2?"}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        r1 = await client.post("/v1/chat/completions", json=payload)
        assert r1.json()["acos_trace"]["cache_hit"] is False

        r2 = await client.post("/v1/chat/completions", json=payload)
        assert r2.json()["acos_trace"]["cache_hit"] is True
        assert r2.json()["acos_trace"]["route"] == "cache"

    @pytest.mark.asyncio
    async def test_cache_hit_latency_under_10ms(self, client):
        payload = {
            "messages": [{"role": "user", "content": "Count from 1 to 5."}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        await client.post("/v1/chat/completions", json=payload)
        r2 = await client.post("/v1/chat/completions", json=payload)
        assert r2.json()["latency_ms"] < 10

    @pytest.mark.asyncio
    async def test_cache_hit_returns_same_content(self, client):
        payload = {
            "messages": [{"role": "user", "content": "Name a color."}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        r1 = await client.post("/v1/chat/completions", json=payload)
        r2 = await client.post("/v1/chat/completions", json=payload)
        d1, d2 = r1.json(), r2.json()
        assert d1["choices"][0]["message"]["content"] == d2["choices"][0]["message"]["content"]

    @pytest.mark.asyncio
    async def test_chat_completion_validation(self, client):
        resp = await client.post("/v1/chat/completions", json={})
        assert resp.status_code == 422


class TestRollingContext:
    @pytest.mark.asyncio
    async def test_context_tokens_tracked_in_trace(self, client):
        payload = {
            "messages": [{"role": "user", "content": "Tell me a short story about a robot."}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        resp = await client.post("/v1/chat/completions", json=payload)
        data = resp.json()
        trace = data["acos_trace"]
        assert "context_tokens_before" in trace
        assert "context_tokens_after" in trace
        assert "context_summarized" in trace
        assert trace["context_summarized"] is False

    @pytest.mark.asyncio
    async def test_short_context_not_summarized(self, client):
        payload = {
            "messages": [{"role": "user", "content": "Hello!"}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        resp = await client.post("/v1/chat/completions", json=payload)
        trace = resp.json()["acos_trace"]
        assert trace["context_summarized"] is False
        assert trace["context_tokens_before"] == trace["context_tokens_after"]

    @pytest.mark.asyncio
    async def test_long_context_is_summarized(self, client):
        long_content = "a" * 4000
        payload = {
            "messages": [{"role": "user", "content": long_content}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        resp = await client.post("/v1/chat/completions", json=payload)
        trace = resp.json()["acos_trace"]
        assert trace["context_summarized"] is True
        assert trace["context_tokens_after"] <= 800

    @pytest.mark.asyncio
    async def test_multi_turn_fixture_outgoing_context_under_800(self, client):
        fixture_path = os.path.join(FIXTURES_DIR, "multi_turn.json")
        if not os.path.exists(fixture_path):
            pytest.skip("multi_turn.json fixture not found")
        with open(fixture_path) as f:
            fixture = json.load(f)

        for item in fixture:
            messages = item["messages"]
            resp = await client.post(
                "/v1/chat/completions",
                json={"messages": messages, "temperature": 0.0, "max_tokens": 64},
            )
            assert resp.status_code == 200
            trace = resp.json()["acos_trace"]
            assert trace["context_tokens_after"] <= 800, (
                f"{item['id']}: {trace['context_tokens_after']} tokens > 800"
            )

    @pytest.mark.asyncio
    async def test_multi_turn_token_reduction_over_60_percent(self, client):
        long_turn = {"role": "user", "content": "a" * 8000}
        short_turn = {"role": "assistant", "content": "OK"}
        before_tokens = _count_messages_tokens([long_turn, short_turn])
        assert before_tokens > 2000, f"Need >2000 tokens for 60% reduction, got {before_tokens}"

        resp = await client.post(
            "/v1/chat/completions",
            json={"messages": [long_turn, short_turn], "temperature": 0.0, "max_tokens": 64},
        )
        data = resp.json()
        trace = data["acos_trace"]
        after_tokens = trace["context_tokens_after"]
        reduction = (1 - after_tokens / before_tokens) * 100
        assert reduction >= 60, (
            f"Token reduction {reduction:.1f}% < 60% target "
            f"(before={before_tokens}, after={after_tokens})"
        )

    @pytest.mark.asyncio
    async def test_cache_still_hits_after_summarization(self, client):
        payload = {
            "messages": [{"role": "user", "content": "Name a color."}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        r1 = await client.post("/v1/chat/completions", json=payload)
        assert r1.json()["acos_trace"]["cache_hit"] is False
        r2 = await client.post("/v1/chat/completions", json=payload)
        assert r2.json()["acos_trace"]["cache_hit"] is True
        assert r2.json()["acos_trace"]["route"] == "cache"

    @pytest.mark.asyncio
    async def test_rule_router_still_routes_correctly(self, client):
        cheap_resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [
                    {"role": "user", "content": "Hello! Are you having a good day today?"}
                ],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert cheap_resp.status_code == 200
        trace = cheap_resp.json()["acos_trace"]
        assert trace["route"] == "cheap"
        assert trace["cache_hit"] is False

        premium_resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Write code to sort an array."}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        trace = premium_resp.json()["acos_trace"]
        assert trace["route"] == "premium"
        assert trace["cache_hit"] is False


class TestExperienceAPI:
    @pytest.mark.asyncio
    async def test_post_and_list_experiences(self, client):
        resp = await client.post(
            "/v1/experiences",
            json={
                "goal": "test goal",
                "resolution": "test resolution",
                "model_used": "gpt-4",
                "tokens_saved": 100,
                "cost_saved": 0.05,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "experience_id" in data
        assert data["message"] == "Experience recorded"

        list_resp = await client.get("/v1/experiences")
        assert list_resp.status_code == 200
        list_data = list_resp.json()
        assert list_data["count"] == 1
        assert list_data["experiences"][0]["goal"] == "test goal"

    @pytest.mark.asyncio
    async def test_list_experiences_empty(self, client):
        resp = await client.get("/v1/experiences")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 0
        assert data["experiences"] == []

    @pytest.mark.asyncio
    async def test_list_shortcuts_endpoint(self, client):
        await client.post(
            "/v1/experiences",
            json={"goal": "g1", "resolution": "r1", "success": True},
        )
        resp = await client.get("/v1/experiences/shortcuts")
        assert resp.status_code == 200
        data = resp.json()
        assert "shortcuts" in data
        assert "count" in data


class TestLearning:
    @pytest.mark.asyncio
    async def test_chat_completion_records_experience(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Say hello world"}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["acos_trace"]["shortcut_hit"] is False
        assert "experience_id" in data["acos_trace"]
        assert data["acos_trace"]["experience_id"] is not None

        exp_resp = await client.get("/v1/experiences")
        assert exp_resp.json()["count"] >= 1

    @pytest.mark.asyncio
    async def test_two_session_improvement(self, client):
        session1_prompts = [
            "Explain what FastAPI is and what it's used for",
            "How to sort a list in Python programming",
        ]

        for prompt in session1_prompts:
            resp = await client.post(
                "/v1/chat/completions",
                json={
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0,
                    "max_tokens": 64,
                },
            )
            assert resp.status_code == 200
            trace = resp.json()["acos_trace"]
            assert trace["shortcut_hit"] is False

        shortcuts_resp = await client.get("/v1/experiences/shortcuts")
        assert shortcuts_resp.json()["count"] >= 1

        session2_prompts = [
            "What is the FastAPI web framework used for?",
            "Sort a Python list",
        ]

        shortcut_hits = 0
        for prompt in session2_prompts:
            resp = await client.post(
                "/v1/chat/completions",
                json={
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0,
                    "max_tokens": 64,
                },
            )
            assert resp.status_code == 200
            trace = resp.json()["acos_trace"]
            if trace.get("shortcut_hit"):
                shortcut_hits += 1

        assert shortcut_hits >= 1, (
            f"Expected at least 1 shortcut hit in session 2, got {shortcut_hits}"
        )

    @pytest.mark.asyncio
    async def test_persistence_across_restart(self, client):
        await client.post(
            "/v1/experiences",
            json={"goal": "persist goal", "resolution": "persist resolution", "success": True},
        )
        resp1 = await client.get("/v1/experiences")
        assert resp1.json()["count"] == 1

        await experience_memory.close()
        await learning.init_db()

        resp2 = await client.get("/v1/experiences")
        assert resp2.status_code == 200
        data = resp2.json()
        assert data["count"] == 1
        assert data["experiences"][0]["goal"] == "persist goal"

    @pytest.mark.asyncio
    async def test_shortcut_trace_fields_in_response(self, client):
        first_resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Tell me about FastAPI framework"}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert first_resp.status_code == 200

        second_resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "What is FastAPI framework used for"}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert second_resp.status_code == 200
        trace = second_resp.json()["acos_trace"]
        assert "shortcut_hit" in trace
        assert "experience_id" in trace


class TestConfidenceEvaluation:
    @pytest.mark.asyncio
    async def test_evaluation_fields_in_llm_response(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Explain what FastAPI is"}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        trace = resp.json()["acos_trace"]
        assert "escalated" in trace
        assert "evaluation_score" in trace
        assert "evaluation_passed" in trace
        assert trace["escalated"] is False
        assert trace["evaluation_score"] is not None
        assert trace["evaluation_passed"] is True

    @pytest.mark.asyncio
    async def test_cache_hit_skips_evaluation(self, client):
        payload = {
            "messages": [{"role": "user", "content": "Name a primary color."}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        r1 = await client.post("/v1/chat/completions", json=payload)
        assert r1.status_code == 200
        assert r1.json()["acos_trace"]["cache_hit"] is False

        r2 = await client.post("/v1/chat/completions", json=payload)
        assert r2.status_code == 200
        trace = r2.json()["acos_trace"]
        assert trace["cache_hit"] is True
        assert trace["escalated"] is False
        assert trace["evaluation_score"] is None
        assert trace["evaluation_passed"] is None

    @pytest.mark.asyncio
    async def test_shortcut_skips_evaluation(self, client):
        first_resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Tell me about FastAPI framework"}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert first_resp.status_code == 200

        second_resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "What is FastAPI framework used for"}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert second_resp.status_code == 200
        trace = second_resp.json()["acos_trace"]
        if trace.get("shortcut_hit"):
            assert trace["escalated"] is False
            assert trace["evaluation_score"] is None
            assert trace["evaluation_passed"] is None


class TestLearningRegression:
    @pytest.mark.asyncio
    async def test_only_successful_experiences_become_shortcuts(self, client):
        good_resp = await client.post(
            "/v1/experiences",
            json={
                "goal": "write a sorting function in python",
                "resolution": (
                    "Use sorted() for a new list or list.sort() "
                    "for in-place sorting. Both accept a key parameter."
                ),
                "success": True,
            },
        )
        assert good_resp.status_code == 200
        good_id = good_resp.json()["experience_id"]

        bad_resp = await client.post(
            "/v1/experiences",
            json={
                "goal": "write a sorting function in python",
                "resolution": "I don't know how to sort",
                "success": False,
            },
        )
        assert bad_resp.status_code == 200
        bad_id = bad_resp.json()["experience_id"]

        await learning.learn_from(good_id)
        await learning.learn_from(bad_id)

        shortcuts_resp = await client.get("/v1/experiences/shortcuts")
        assert shortcuts_resp.status_code == 200
        shortcuts = shortcuts_resp.json()["shortcuts"]

        assert good_id in [s["id"] for s in shortcuts], "Good experience should be a shortcut"
        assert bad_id not in [s["id"] for s in shortcuts], (
            "Failed experience should not be a shortcut"
        )


class TestEscalation:
    @pytest.mark.asyncio
    async def test_short_prompt_triggers_escalation(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Hi"}],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        trace = resp.json()["acos_trace"]
        assert trace["escalated"] is True, (
            f"Expected escalated=True for short cheap response, got {trace}"
        )
        assert trace["route"] == "premium"
        assert trace["evaluation_score"] is not None
        assert trace["evaluation_passed"] is not None


class TestDashboard:
    @pytest.mark.asyncio
    async def test_metrics_endpoint_returns_json(self, client):
        resp = await client.get("/metrics")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)

    @pytest.mark.asyncio
    async def test_dashboard_endpoint_returns_html(self, client):
        resp = await client.get("/dashboard")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert "ACOS Metrics Dashboard" in resp.text


class TestRedaction:
    @pytest.mark.asyncio
    async def test_redaction_in_health_endpoint(self, client):
        resp = await client.get("/health")
        data = resp.json()
        assert data["phase"] == "8-redaction"
        assert data["redaction"]["active"] is True
        assert data["redaction"]["terms_configured"] == 0

    @pytest.mark.asyncio
    async def test_redacted_content_in_llm_payload(self, client):
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [
                    {
                        "role": "user",
                        "content": "Hello from ACME Corp, contact john.smith@example.com",
                    }
                ],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["acos_trace"]["phase"] == "8-redaction"

    @pytest.mark.asyncio
    async def test_cache_hit_rehydrates_response(self, client):
        redactor_instance = redactor
        payload = {
            "messages": [{"role": "user", "content": "ACME Corp test for cache rehydration"}],
            "temperature": 0.0,
            "max_tokens": 64,
        }
        r1 = await client.post("/v1/chat/completions", json=payload)
        assert r1.status_code == 200
        content_1 = r1.json()["choices"][0]["message"]["content"]

        r2 = await client.post("/v1/chat/completions", json=payload)
        assert r2.status_code == 200
        data2 = r2.json()
        assert data2["acos_trace"]["cache_hit"] is True
        content_2 = data2["choices"][0]["message"]["content"]
        assert content_2 == content_1
