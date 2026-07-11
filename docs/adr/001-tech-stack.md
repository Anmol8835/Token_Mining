# ADR-001: Technology Stack

**Date:** 2026-07-10

**Status:** Accepted

## Context

Phase 0 of ACOS requires choosing a language, framework, and database for the
entire prototype. The choice must be justified against the MASTER.md priority
order: latency > cost-per-value > quality > scalability > modularity >
extensibility > model independence.

Later phases add semantic memory (embeddings, vector search), LLM routing,
rolling summarization, and a learning engine — tasks that benefit heavily from
the ML/AI ecosystem.

## Decision

- **Language:** Python 3.9+
- **Web framework:** FastAPI
- **Database:** SQLite (via aiosqlite)
- **HTTP client:** httpx (async)
- **Configuration:** pydantic-settings

## Rationale (against priority order)

1. **Latency:** FastAPI is as fast as any Python web framework (on par with
   Node.js Express for typical API Gateway workloads) and the network hop to
   the LLM API dominates total latency anyway. The chosen async stack
   (uvicorn + httpx) keeps the event loop non-blocking.

2. **Cost-per-value:** Python is zero-cost, universally available, and has the
   richest open-source ML/AI ecosystem (sentence-transformers, numpy,
   scikit-learn, etc.). SQLite requires no separate server process.

3. **Quality:** FastAPI provides automatic OpenAPI docs, request validation via
   Pydantic, and type hints — reducing defects.

4. **Scalability:** FastAPI + uvicorn supports async workers. For a prototype
   targeting < $20/mo hosting, this is more than sufficient.

5. **Modularity / Extensibility:** Python's package system and the clean
   separation of FastAPI routers map well to ACOS's layered architecture
   (gateway → router → cache → memory).

6. **Model independence:** The OpenAI-compatible API interface (used by the
   baseline) is the de-facto standard — all major LLM providers support it.
   This makes swapping backends trivial without touching routing/memory code.

## Trade-offs

- Python's GIL limits true parallelism, but all I/O-bound work (HTTP calls,
  DB queries) is async and non-blocking, so this is irrelevant for an API
  gateway.
- TypeScript would have marginally faster JSON parsing, but the difference is
  negligible compared to LLM inference latency (seconds vs microseconds).
