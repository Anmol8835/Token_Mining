# Phase 8 Implementation Plan — PII / Sensitive-Data Redaction Layer

## Goal
Redaction module at the front of the gateway request path, applied before cache lookup, rule-router classification, the LLM call, and any memory write. Three detection layers: deterministic dictionary, structured-PII regex, and open-source NER fallback.

## Approach
- `src/redact/__init__.py`: `RedactionLayer` class with three layers + reversible placeholder rehydration.
- `src/redact/ner.py`: NER fallback using spaCy `en_core_web_sm`, lazy-loaded with auto-download.
- `src/config.py`: Added `ACOS_REDACT_TERMS` env var for configurable dictionary terms.
- `src/gateway/server.py`: Redaction wired into cache lookup, shortcut lookup, and LLM payload paths; rehydration on cache hit, shortcut hit, and final response.
- `tests/unit/test_redact.py`: 28 unit tests covering dictionary redaction, PII regex, rehydration, edge cases, and NER fallback.
- `tests/integration/test_gateway.py`: Added `TestRedaction` class + health endpoint phase and redaction field assertions.

## Targets met
| Target | Result | Verdict |
|--------|--------|---------|
| Redaction overhead <20ms per request | ✅ | ✅ |
| Dictionary terms redacted case-insensitively | ✅ Unit tests | ✅ |
| Structured-PII regex flags valid PII, avoids false positives | ✅ Negative pattern guards for version numbers / dates | ✅ |
| Redacting same input twice produces same placeholders | ✅ Stability test | ✅ |
| Cache stores redacted content, returns rehydrated | ✅ Integration test | ✅ |
| Shortcut stores redacted content, returns rehydrated | ✅ Integration test | ✅ |
| Final response rehydrated for caller | ✅ Integration test | ✅ |
| Health endpoint reports phase 8 and redaction status | ✅ | ✅ |

## Files created
- `src/redact/ner.py` — NER redactor (spaCy, lazy-loaded)
- `tests/unit/test_redact.py` — 28 unit tests

## Files modified
- `src/config.py` — ADDED: `redact_terms` field
- `src/gateway/server.py` — ADDED: redaction import, wired into request/response path
- `tests/integration/test_gateway.py` — ADDED: `TestRedaction` class, health phase→8
- `ROADMAP.md` — Phase 8 marked [x]
- `PLAN_CURRENT.md` — Phase 7 → Phase 8
