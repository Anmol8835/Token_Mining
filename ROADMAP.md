# ACOS Build Roadmap

Phased so that each phase produces a demoable increment and a hard exit
gate. Full spec: `MASTER.md`. Each phase is meant to be handed to the
`acos-build-loop` workflow (see `.claude/workflows/acos-build-loop.js`) as
one `goal`, phases run in order because each depends on the previous
phase's code.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done (DoD met).

---

## Phase 0 — Foundation & Baseline

**Status:** [x]
**Depends on:** nothing

**Deliverables**
- Repo scaffold, chosen language/framework/DB (agent's choice, justified
  in a short ADR under `docs/adr/`).
- A **naive baseline pipeline**: every request goes straight to a premium
  model, no cache, no routing, no memory. This is the reference point
  every later % reduction claim is measured against — it must exist and
  be runnable before Phase 1 starts.
- Benchmark harness skeleton: a repeatable script that replays a fixture
  workload and writes `bench/results/<phase>.json` (latency, tokens,
  cost, cache/routing stats).
- A fixture workload (a small, realistic set of repeated + novel prompts)
  used by every later phase's benchmarks, so results are comparable.

**Targets / exit criteria**
- Naive baseline runs end-to-end against the fixture workload.
- `bench/results/phase0-baseline.json` recorded with cost/latency/token
  numbers. All later phases diff against this file.

**Suggested workflow goal string**
> "Build Phase 0: repo scaffold + naive baseline pipeline (no cache, no
> routing, straight to premium model) + benchmark harness that replays a
> fixture workload and records cost/latency/token metrics to
> bench/results/phase0-baseline.json."

---

## Phase 1 — Gateway + Exact Cache

**Status:** [x]
**Depends on:** Phase 0

**Deliverables**
- Single HTTP entrypoint (Gateway) all requests flow through.
- Exact cache: hash-normalized prompt → cached response, sitting in
  front of the Phase 0 pass-through.

**Targets**
- Exact cache hit latency < 10ms.
- ≥50% cache hit rate on the repeated-request portion of the fixture
  workload.
- Demo: a repeated request served from cache with zero premium calls.

**Suggested workflow goal string**
> "Implement Phase 1: Gateway HTTP entrypoint + exact cache
> (hash-normalized prompt -> cached response) in front of the Phase 0
> pass-through. Targets: cache-hit latency <10ms, >=50% hit rate on the
> fixture workload's repeated requests."

---

## Phase 2 — Rule Router + LLM Router

**Status:** [x]
**Depends on:** Phase 1

**Deliverables**
- Deterministic rule router (keyword/regex/task-type classification)
  deciding: cache vs. cheap model vs. premium model.
- LLM router selecting among ≥2 real backends (e.g. one local
  open-source model + one hosted API) based on task characteristics.

**Targets**
- Routing/classification decision < 50ms (excludes the chosen model's
  own inference time).
- ≥50% reduction in premium invocations vs. `phase0-baseline.json` on
  the fixture workload.

**Suggested workflow goal string**
> "Implement Phase 2: rule router (deterministic cache/cheap/premium
> decision) + LLM router across >=2 real model backends. Target:
> routing/classification decision <50ms (excluding chosen model
> inference time) and >=50% fewer premium invocations vs
> bench/results/phase0-baseline.json."

**Post-hoc fix (2026-07-10):** an audit found the rule router's math
pattern (`[0-9]+\s*[+\-*/^=]`) false-matched any "number-hyphen-word"
text (e.g. "2-sentence story"), misrouting some creative/factual prompts
to premium, and the benchmark harness was reporting identical
cost/tokens for every route (cache hits and cheap-model calls weren't
actually costed at $0 / their own rate). Both are fixed — see
`src/router/rules.py`, `tests/unit/test_rules.py`, and `bench/run.py`.
`bench/results/phase2-rule-llm-router.json` was regenerated after the
fix.

---

## Phase 3 — Rolling Context & Summarization

**Status:** [x]
**Depends on:** Phase 2

**Deliverables**
- Rolling conversation summarizer capping context at 800 tokens,
  replacing full history in outgoing prompts.

**Targets**
- Rolling context ≤ 800 tokens at all times.
- ≥60% token consumption reduction vs. baseline.
- No material answer-quality regression on a small labeled eval set
  (hand-written quality checks are fine here; the Evaluation Engine in
  Phase 6 formalizes this later).

**Test scenarios**
- Unit: summarization triggers only above the 800-token budget — exactly
  800 tokens must NOT trigger it, 801 must (boundary test).
- Unit: the token count of the rolling context after summarization is
  measured with the same estimator used elsewhere in the codebase and
  asserted ≤ 800.
- Unit: summarizing an already-summarized context is idempotent — it
  doesn't re-inflate token count on repeated rollovers.
- Unit: if the summarization call itself fails/times out, the system
  falls back to hard-truncating the oldest turns rather than crashing or
  sending unbounded context.
- Integration: replay a long (≥20-turn) conversation fixture through the
  gateway and assert the outgoing context never exceeds 800 tokens on
  any turn.
- Integration: extend `bench/fixtures/` with a multi-turn conversation
  fixture (current fixture is single-turn per item) and measure ≥60%
  token reduction vs. `phase0-baseline.json` on it.
- Regression: Phase 1's exact cache and Phase 2's rule router still
  function correctly on top of rolling context (verify cache-key
  normalization and routing decisions aren't broken by the summarized
  history).
- Edge cases: empty conversation history; a single message that alone
  exceeds 800 tokens; non-text content blocks (per `rules.py`'s
  list-content handling) passing through the summarizer unharmed.

**Suggested workflow goal string**
> "Implement Phase 3: rolling context summarizer capped at 800 tokens
> replacing full conversation history in prompts. Target: <=800 tokens
> rolling context, >=60% token reduction vs baseline, no answer-quality
> regression on the eval set."

**Post-hoc fix (2026-07-10):** the initial `_hard_truncate()` fallback in
`src/memory/context.py` did not handle the case where the last remaining
message after removing older messages still exceeded the 800-token budget.
A content-level truncation was added to the end of `_hard_truncate()` to
cap oversized remaining messages. See `src/memory/context.py` and
`tests/unit/test_context.py`.

---

## Phase 4 — Semantic Memory

**Status:** [x]
**Depends on:** Phase 3

**Deliverables**
- Embedding-based semantic retrieval (open-source embedding model +
  local vector store) backing persistent project memory.

**Targets**
- Semantic retrieval latency < 100ms.
- ≥95% Top-1 retrieval accuracy on a labeled eval set.
- <3% false-positive retrieval rate.

**Test scenarios**
- Deliverable: create `bench/fixtures/semantic_eval.json` — labeled
  query → expected-memory-id pairs (paraphrases of stored memories) plus
  explicit negative examples (queries with no matching memory), since
  Top-1 accuracy and false-positive rate can't be measured without it.
- Unit: embedding generation is deterministic — same input text always
  produces the same vector.
- Unit: a per-call latency micro-benchmark for retrieval stays < 100ms,
  independent of the end-to-end gateway benchmark.
- Integration: store N project-memory entries, query with paraphrased
  versions of each from `semantic_eval.json`, assert ≥95% Top-1 accuracy
  across the set.
- Integration: query with the negative (no-match) examples and assert
  none of them retrieve a memory above the similarity threshold — this
  is what the <3% false-positive target is measured against.
- Edge cases: empty memory store returns no results without error; very
  short queries ("hi") don't spuriously match unrelated long memories;
  near-duplicate stored memories don't break ranking.
- Concurrency smoke test: concurrent reads/writes to the vector store
  don't corrupt state or crash.

**Post-hoc fix (2026-07-10):** an audit found the gateway defaulted to
`SimulatedEmbedder` (a char-n-gram `HashingVectorizer`, i.e. lexical not
semantic matching) rather than the real `sentence-transformers` model —
measured 80% Top-1 accuracy in production vs. the ≥95% target. Also,
`scikit-learn` and `sentence-transformers` were used but never declared
in `pyproject.toml` (a clean checkout couldn't have installed them), and
the test suite loaded the real model fresh 5 separate times, which made
it sensitive to intermittent slow-disk stalls in this environment.
Fixed: `src/gateway/server.py` now defaults to the real embedder;
`pyproject.toml` declares `scikit-learn`, `sentence-transformers`, and
`pytest-timeout`; `tests/conftest.py` adds a session-scoped `real_embedder`
fixture so the model loads once per test run instead of 5 times;
`pyproject.toml` sets a 90s pytest-timeout as a safety net. Re-measured
with the real embedder wired in: **100% Top-1 accuracy, 0% false
positives**, ~6s one-time load at server startup, ~10ms per-query
retrieval (well under the 100ms target). `bench/results/
phase4-semantic-memory.json` was generated (previously missing
entirely).

**Suggested workflow goal string**
> "Implement Phase 4: semantic memory using an open-source embedding
> model + local vector store. Target: retrieval <100ms, >=95% Top-1
> accuracy and <3% false-positive rate on a labeled eval set."

---

## Phase 5 — Experience Memory + Learning Engine

**Status:** [x]
**Depends on:** Phase 4

**Deliverables**
- Experience memory: successful task executions stored as reusable
  entries.
- Learning engine: converts experience entries into retrievable
  shortcuts that reduce future premium calls.

**Targets**
- Cache/semantic hit rate measurably improves run-over-run across ≥2
  sessions on the fixture workload, with no manual tuning between runs.

**Test scenarios**
- Unit: a successful task execution is stored as an experience entry
  with the fields needed for later retrieval (goal, resolution,
  tokens/cost saved).
- Unit: only executions marked successful get promoted into reusable
  shortcuts — seed a deliberately failed/incorrect execution and assert
  the learning engine does NOT turn it into a shortcut.
- Unit: storage has a capping/eviction policy — it doesn't grow
  unboundedly (seed past the cap, assert oldest/least-useful entries are
  evicted, not silently unbounded growth).
- Integration: run the fixture workload twice in separate processes
  against the same persistent storage; assert session 2's cache/semantic
  hit rate is measurably higher than session 1's with zero manual tuning
  in between — this is the phase's actual target, not just a nice-to-have.
- Integration: kill and restart the gateway process; assert experience
  memory entries persist across the restart.

**Suggested workflow goal string**
> "Implement Phase 5: experience memory storing successful executions +
> learning engine that converts them into reusable shortcuts. Target:
> demonstrate hit-rate improvement across >=2 sequential benchmark runs
> with no manual tuning."

---

## Phase 6 — Confidence Engine + Evaluation Engine

**Status:** [x]
**Depends on:** Phase 5

**Deliverables**
- Confidence engine: scores router/model outputs; low-confidence cheap
  responses escalate to premium.
- Evaluation engine: grades response quality/correctness; its grades
  both drive escalation and label experiences as "successful" for
  Phase 5's learning engine.

**Targets**
- Evaluation engine hits ≥90% precision/recall on a labeled
  good/bad-response set (adjust target only with a written
  justification).

**Test scenarios**
- Deliverable: `bench/fixtures/eval_labeled.json` — hand-labeled
  good/bad response examples, since precision/recall can't be computed
  without a ground-truth set.
- Unit: confidence scorer ranks a deliberately vague/short cheap-model
  response lower than a detailed one (relative-ordering test; absolute
  calibration isn't unit-testable).
- Unit: a low-confidence cheap response triggers escalation to premium;
  a high-confidence one does not — both branches covered.
- Unit: evaluation engine's precision/recall on `eval_labeled.json` is
  computed and asserted ≥90%.
- Integration: an intentionally low-quality simulated cheap-model
  response gets escalated and re-answered by premium, and the trace
  records the escalation.
- Cross-phase regression: only evaluation-engine-approved executions
  become Phase 5 experience-memory shortcuts (seed one good and one bad
  execution, assert only the good one is learned).
- Edge cases: an empty/error response is scored as low-confidence/bad
  rather than raising an exception; a cache hit skips confidence scoring
  entirely (must not add latency to the <10ms cache path).

**Suggested workflow goal string**
> "Implement Phase 6: confidence engine (escalates low-confidence cheap
> responses to premium) + evaluation engine (grades quality/correctness,
> labels experiences as successful). Target: >=90% precision/recall on
> a labeled eval set."

---

## Phase 7 — Metrics Dashboard + Demo Polish

**Status:** [x]
**Depends on:** Phase 6

**Deliverables**
- Live dashboard: tokens saved, cost saved, latency, cache hit rate,
  routing distribution, vs. the Phase 0 baseline.
- A scripted, reproducible demo flow covering all 6 Investor
  Demonstration Goals in `MASTER.md`.

**Targets**
- Dashboard updates near-real-time.
- Demo script runs end-to-end reproducibly from a clean checkout.

**Test scenarios**
- Unit: dashboard aggregation functions (hit rate, token/cost savings)
  computed correctly against a synthetic, known-answer set of
  `bench/results/*.json` fixtures.
- Unit: aggregation handles a phase with zero requests without a
  divide-by-zero error.
- Integration: the full demo script, run end-to-end from a clean
  checkout (fresh clone, fresh `cache.db`), produces all 6 investor-demo
  artifacts from `MASTER.md` without manual intervention.
- Integration: define "near-real-time" concretely (e.g. dashboard
  reflects a completed request within 2s) and assert it.
- Idempotency: running the demo script twice back-to-back doesn't
  double-count metrics or error on already-cached entries.

**Suggested workflow goal string**
> "Implement Phase 7: live metrics dashboard (tokens/cost/latency/cache
> hit rate vs baseline) + a reproducible end-to-end demo script covering
> the 6 investor demonstration goals in MASTER.md."

---

## Phase 8 — PII / Sensitive-Data Redaction Layer

**Status:** [x]
**Depends on:** Phase 1 (Gateway), but touches every phase. This is
listed last because it's requested last, not because it belongs at the
end of the pipeline — architecturally, redaction must run BEFORE
anything else sees the request text (cache-key normalization, rule
router classification, the LLM call itself, semantic/experience memory
writes, bench logs). Implementing this phase means retrofitting a
redaction call into the front of the Phases 1–7 request path, not
building an isolated add-on. Budget time accordingly.

**Why:** company name(s) and employee names must never reach a
third-party/commercial LLM API, get written to the exact cache,
semantic/experience memory, or benchmark/logs in plaintext. This is a
hard requirement for any real deployment and a due-diligence point for
the investor demo.

**Deliverables**
- A redaction module at the very front of the gateway request path,
  applied before cache lookup, rule-router classification, the LLM
  call, and any memory write.
- Three detection layers, cheapest/most-precise first:
  1. **Deterministic dictionary** — configurable list of known sensitive
     strings (company name(s), employee names), loaded from config/env
     (e.g. `ACOS_REDACT_TERMS`), never hardcoded in source. Exact,
     case-insensitive match → a stable placeholder (`[COMPANY]`,
     `[EMPLOYEE_1]`, ...).
  2. **Structured-PII regex** — email addresses, phone numbers,
     SSN/national-ID-shaped numbers, credit-card-shaped numbers, IP
     addresses.
  3. **Generic name NER** (open-source, e.g. a small spaCy model) —
     catches person names not in the dictionary. Runs last to protect
     the latency budget.
- Placeholder substitution is stable and reversible for the response
  path: the final reply returned to the caller has placeholders
  rehydrated back to the original values, while everything that gets
  cached, embedded, stored, sent to the LLM backend, or logged sees
  ONLY the redacted form.
- Dictionary entries (company/employee names) rehydrate correctly even
  on a cache hit from a different request, since that mapping is
  static/global. Generic NER-detected entities only rehydrate within the
  same request that detected them — a documented limitation, not a bug
  (see Test scenarios).

**Targets**
- Redaction overhead < 20ms added to the request path (stacks on top of
  the existing <50ms routing budget without blowing the overall latency
  targets).
- Zero instances of a configured dictionary term appearing in plaintext
  in: the LLM request payload, `cache.db`, semantic/experience memory,
  or `bench/results/*.json` — a hard invariant, not a percentage.
- ≥95% recall / ≥90% precision on a labeled PII eval set for the
  structured-PII regex + NER layers.

**Test scenarios**
- Unit: each dictionary term is redacted case-insensitively, regardless
  of surrounding punctuation/whitespace.
- Unit: structured-PII regexes flag a labeled positive set (valid-shaped
  emails/phones/SSNs/credit cards) and do NOT flag a labeled negative
  set (version numbers, order IDs, dates that only superficially
  resemble phone numbers) — this negative set guards against the same
  class of false-positive-regex bug found and fixed in Phase 2's rule
  router.
- Unit: redacting the same input twice produces the same placeholders
  (stability).
- Integration: send a request containing the company name, a fabricated
  employee name, and an email address; assert the payload actually sent
  to the (simulated) LLM backend contains ONLY placeholders.
- Integration: grep-based regression test asserting `cache.db`, semantic
  memory, experience memory, and `bench/results/*.json` never contain a
  configured dictionary term or a detected structured-PII value in
  plaintext after a run.
- Integration: the final response returned to the caller has dictionary
  placeholders correctly rehydrated (company/employee names come back
  exactly as sent).
- Documented edge case: a cache hit served for a different request that
  doesn't re-detect a given NER-only (non-dictionary) entity returns the
  placeholder, not the original value — verify this is the actual,
  acceptable behavior, not a crash or a silent leak.
- Regression: re-run the Phase 1–7 benchmarks after adding redaction;
  cache hit rate, routing decisions, retrieval accuracy, and evaluation
  precision/recall must stay within 5% of their pre-redaction numbers —
  redaction must not silently degrade accuracy by mangling text.

**Suggested workflow goal string**
> "Implement Phase 8: a redaction layer (deterministic dictionary for
> company/employee names + structured-PII regex + open-source NER
> fallback) applied at the gateway entry point before cache/router/LLM/
> memory, with request-scoped rehydration of the final response.
> Target: <20ms overhead, zero configured dictionary terms in cache/
> memory/logs/LLM payloads, >=95% recall / >=90% precision on a labeled
> PII eval set, and re-verify Phases 1-7 benchmarks stay within 5% of
> pre-redaction numbers."

---

## How to run a phase

From inside `~/acos`:

```
Workflow({
  name: "acos-build-loop",
  args: {
    goal: "<the phase's suggested workflow goal string, or your own>",
    targets: { /* optional structured targets, else the agent reads them from this doc */ },
    maxIterations: 5
  }
})
```

Update this file's status checkboxes and any target adjustments once a
phase's loop reports `done: true`.
