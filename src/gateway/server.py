import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from src.cache.exact import ExactCache
from src.config import settings
from src.memory.confidence import ConfidenceEngine
from src.memory.context import RollingContextSummarizer, _count_messages_tokens
from src.memory.evaluation import EvaluationEngine
from src.memory.experience import ExperienceMemory
from src.memory.learning import LearningEngine
from src.memory.semantic import SemanticMemory
from src.metrics.aggregator import compute_summary
from src.models.client import cheap_client, premium_client
from src.models.schemas import ChatCompletionRequest
from src.redact import RedactionLayer
from src.router.router import LLMRouter
from src.router.rules import RuleRouter

redact_terms = (
    [t.strip() for t in settings.redact_terms.split(",") if t.strip()]
    if settings.redact_terms
    else []
)
redactor = RedactionLayer(redact_terms=redact_terms or None)

cache = ExactCache()
rule_router = RuleRouter()
summarizer = RollingContextSummarizer()
semantic_memory = SemanticMemory(db_path="memory.db", use_sentence_transformer=True)
llm_router = LLMRouter(premium_client=premium_client, cheap_client=cheap_client)
experience_memory = ExperienceMemory(db_path="experience.db")
learning = LearningEngine(
    semantic_memory=semantic_memory,
    experience_memory=experience_memory,
    exact_cache=cache,
)
confidence_engine = ConfidenceEngine()
evaluation_engine = EvaluationEngine()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await cache.init_db()
    await semantic_memory.init_db()
    await learning.init_db()
    yield
    await premium_client.close()
    await cheap_client.close()
    await cache.close()
    await semantic_memory.close()
    await learning.close()


app = FastAPI(
    title="ACOS Gateway",
    description="AI Context Operating System — Phase 8: PII Redaction Layer",
    version="0.8.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    configured = bool(settings.premium_api_key)
    cache_info = await cache.stats()
    mem_info = await semantic_memory.stats()
    exp_stats = await experience_memory.stats()
    learn_stats = learning.stats()
    return {
        "status": "ok",
        "phase": "8-redaction",
        "configured": configured,
        "cache": cache_info,
        "routers": {
            "rule": "active",
            "llm": "active",
            "backends": [
                {"name": "premium", "model": settings.premium_model},
                {"name": "cheap", "model": settings.cheap_model},
            ],
        },
        "context": {
            "summarizer": "active",
            "max_tokens": summarizer.MAX_TOKENS,
        },
        "semantic_memory": {
            "active": True,
            "entries": mem_info["entries"],
            "dimension": mem_info["dimension"],
        },
        "experience_memory": {
            "active": True,
            "total_experiences": exp_stats["total_experiences"],
            "shortcuts": exp_stats["shortcuts"],
            "total_tokens_saved": exp_stats["total_tokens_saved"],
            "max_entries": exp_stats["max_entries"],
        },
        "learning_engine": {
            "active": True,
            "shortcut_hits": learn_stats["shortcut_hits"],
            "shortcut_misses": learn_stats["shortcut_misses"],
            "shortcut_hit_rate_percent": learn_stats["shortcut_hit_rate_percent"],
            "threshold": learn_stats["threshold"],
        },
        "confidence_engine": {
            "active": True,
            "escalation_threshold": confidence_engine.escalation_threshold,
        },
        "evaluation_engine": {
            "active": True,
            "good_threshold": evaluation_engine.good_threshold,
        },
        "redaction": {
            "active": True,
            "terms_configured": len(redactor._terms),
            "ner_available": redactor._ner is not None,
        },
    }


@app.post("/v1/chat/completions")
async def chat_completion(body: ChatCompletionRequest):
    t_total = time.monotonic()

    # Step 0: Redact messages before anything else touches them
    redactor.clear_request_placeholders()
    redacted_messages = redactor.redact_messages(body.messages)

    last_user_msg = ""
    for m in body.messages[::-1]:
        if m.get("role") == "user":
            last_user_msg = m.get("content", "")
            break

    last_user_msg_redacted = ""
    for m in redacted_messages[::-1]:
        if m.get("role") == "user":
            last_user_msg_redacted = m.get("content", "")
            break

    # Cache lookup uses redacted messages (cache stores redacted content)
    cached = await cache.get(redacted_messages)
    if cached is not None:
        rehydrated_content = redactor.rehydrate_response(cached["content"])
        elapsed = time.monotonic() - t_total
        return JSONResponse(
            {
                "model": cached.get("model", "cache"),
                "choices": [{"message": {"content": rehydrated_content}}],
                "usage": {
                    "prompt_tokens": cached["prompt_tokens"],
                    "completion_tokens": cached["completion_tokens"],
                    "total_tokens": cached["total_tokens"],
                },
                "latency_ms": cached["latency_ms"],
                "acos_trace": {
                    "phase": "8-redaction",
                    "route": "cache",
                    "cache_hit": True,
                    "shortcut_hit": False,
                    "context_summarized": False,
                    "escalated": False,
                    "evaluation_score": None,
                    "evaluation_passed": None,
                    "total_time_ms": round(elapsed * 1000, 2),
                },
            }
        )

    # Shortcut lookup uses redacted message
    shortcut = await learning.find_shortcut(last_user_msg_redacted)
    if shortcut is not None:
        await learning._experience.increment_usage(shortcut["experience_id"])
        shortcut_content = shortcut["resolution"]
        await cache.set(
            redacted_messages,
            {
                "content": shortcut_content,
                "model": shortcut.get("model_used", "shortcut"),
                "prompt_tokens": 0,
                "completion_tokens": 0,
            },
        )
        rehydrated_content = redactor.rehydrate_response(shortcut_content)
        elapsed = time.monotonic() - t_total
        return JSONResponse(
            {
                "model": shortcut.get("model_used", "shortcut"),
                "choices": [{"message": {"content": rehydrated_content}}],
                "usage": {
                    "prompt_tokens": shortcut.get("tokens_saved", 0),
                    "completion_tokens": 0,
                    "total_tokens": shortcut.get("tokens_saved", 0),
                },
                "latency_ms": round(elapsed * 1000, 2),
                "acos_trace": {
                    "phase": "8-redaction",
                    "route": "shortcut",
                    "cache_hit": False,
                    "shortcut_hit": True,
                    "experience_id": shortcut.get("experience_id"),
                    "context_summarized": False,
                    "escalated": False,
                    "evaluation_score": None,
                    "evaluation_passed": None,
                    "total_time_ms": round(elapsed * 1000, 2),
                },
            }
        )

    context_tokens_before = _count_messages_tokens(redacted_messages)
    messages = await summarizer.summarize(redacted_messages)

    memories = await semantic_memory.retrieve(
        messages[-1]["content"] if messages else "",
        top_k=3,
        threshold=0.5,
    )
    if memories:
        mem_text = "\n".join(f"- [{m['key']}] {m['metadata'].get('text', '')}" for m in memories)
        messages.insert(
            0,
            {
                "role": "system",
                "content": f"Relevant memories:\n{mem_text}",
            },
        )

    context_tokens_after = _count_messages_tokens(messages)
    context_summarized = context_tokens_before != context_tokens_after

    decision, routing_time_ms = rule_router.classify(messages)
    t_after_route = time.monotonic()

    result = await llm_router.route(
        decision=decision,
        messages=messages,
        stream=body.stream,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
    )

    llm_elapsed = time.monotonic() - t_after_route

    eval_result = evaluation_engine.evaluate(result["content"])
    escalated = False

    if decision == "cheap":
        confidence = confidence_engine.score(result["content"], result["model"])
        if confidence_engine.should_escalate(confidence):
            escalated = True
            t_premium = time.monotonic()
            premium_result = await premium_client.chat_completion(
                messages=messages,
                stream=body.stream,
                temperature=body.temperature,
                max_tokens=body.max_tokens,
            )
            premium_elapsed = time.monotonic() - t_premium
            llm_elapsed += premium_elapsed
            result = premium_result
            eval_result = evaluation_engine.evaluate(result["content"])

    exp_id = await learning.record_execution(
        goal=last_user_msg_redacted,
        resolution=result["content"],
        model_used=result["model"],
        tokens_saved=0,
        cost_saved=0.0,
        success=eval_result["passed"],
    )
    if eval_result["passed"]:
        await learning.learn_from(exp_id)

    await cache.set(redacted_messages, result)

    rehydrated_content = redactor.rehydrate_response(result["content"])
    elapsed = time.monotonic() - t_total
    return JSONResponse(
        {
            "model": result["model"],
            "choices": [{"message": {"content": rehydrated_content}}],
            "usage": {
                "prompt_tokens": result["prompt_tokens"],
                "completion_tokens": result["completion_tokens"],
                "total_tokens": result["total_tokens"],
            },
            "latency_ms": result["latency_ms"],
            "acos_trace": {
                "phase": "8-redaction",
                "route": decision if not escalated else "premium",
                "cache_hit": False,
                "shortcut_hit": False,
                "experience_id": exp_id,
                "context_summarized": context_summarized,
                "context_tokens_before": context_tokens_before,
                "context_tokens_after": context_tokens_after,
                "routing_time_ms": routing_time_ms,
                "llm_time_ms": round(llm_elapsed * 1000, 2),
                "escalated": escalated,
                "evaluation_score": eval_result["score"],
                "evaluation_passed": eval_result["passed"],
                "total_time_ms": round(elapsed * 1000, 2),
            },
        }
    )


@app.get("/metrics")
async def metrics():
    return JSONResponse(compute_summary())


DASHBOARD_PATH = Path(__file__).resolve().parent / "dashboard.html"


@app.get("/dashboard")
async def dashboard():
    with open(DASHBOARD_PATH) as f:
        html = f.read()
    return HTMLResponse(html)


class MemoryIn(BaseModel):
    key: str
    text: str
    metadata: dict = {}


class ExperienceIn(BaseModel):
    goal: str
    resolution: str
    model_used: str = ""
    tokens_saved: int = 0
    cost_saved: float = 0.0
    success: bool = True
    metadata: dict = {}


@app.post("/v1/memories")
async def store_memory(body: MemoryIn):
    await semantic_memory.store(body.key, body.text, body.metadata)
    return {"key": body.key, "message": "Memory stored"}


@app.get("/v1/memories")
async def list_memories():
    items = await semantic_memory.list_all()
    return {"memories": items, "count": len(items)}


@app.delete("/v1/memories/{key}")
async def delete_memory(key: str):
    await semantic_memory.remove(key)
    return {"key": key, "message": "Memory deleted"}


@app.post("/v1/experiences")
async def store_experience(body: ExperienceIn):
    exp_id = await learning.record_execution(
        goal=body.goal,
        resolution=body.resolution,
        model_used=body.model_used,
        tokens_saved=body.tokens_saved,
        cost_saved=body.cost_saved,
        success=body.success,
        metadata=body.metadata,
    )
    return {"experience_id": exp_id, "message": "Experience recorded"}


@app.get("/v1/experiences")
async def list_experiences():
    items = await experience_memory.list_all()
    return {"experiences": items, "count": len(items)}


@app.get("/v1/experiences/shortcuts")
async def list_shortcuts():
    items = await experience_memory.list_shortcuts()
    return {"shortcuts": items, "count": len(items)}
