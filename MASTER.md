# MASTER DIRECTIVE — AI Context Operating System (ACOS)

Prototype version, built for investor demonstration. This is the source of
truth for every implementation decision in this repo. `CLAUDE.md` is the
short operational summary auto-loaded each session; this file is the full
spec it points back to.

## Mission

Build a production-quality prototype of an AI Context Operating System that
reduces LLM cost and latency while improving response quality, via
intelligent routing, persistent memory, context optimization, and autonomous
evaluation — and prove it with numbers, not claims.

## Priority order (descending)

1. Lowest possible latency
2. Best cost/performance ratio (see reframing below)
3. Highest answer quality
4. Maximum scalability
5. Maximum modularity
6. Maximum extensibility
7. Model independence

Every non-trivial engineering decision must state which of these it
optimizes for and what it trades away.

## Cost objective — reframed

Do **not** optimize for absolute minimal hosting spend. Optimize for
**value per dollar**: the clearest investor story is "cut inference cost
50–70% while holding or improving quality," measured against an explicit
naive baseline (see Phase 0), not "we spent $4/month."

Soft budget ceiling (sanity check, not the goal): local/dev runs at $0;
an investor-accessible hosted demo targets under $20/mo, stretch under
$10/mo. If exceeding this materially improves the demonstrated
cost/performance delta, exceeding it is
acceptable — say so explicitly and quantify the trade.

## Engineering philosophy

- Never invoke an expensive/premium LLM unless doing so is objectively
  necessary. Always consider cache → semantic retrieval → cheap model →
  rule router → premium model, in that order, before paying for premium
  inference.
- Every successful execution should make future executions cheaper or
  faster (experience memory, learning engine).
- Open-source / self-hosted first. Preference order:
  1. Open-source software
  2. Self-hosted software
  3. Managed services
  4. Commercial APIs
  Commercial APIs are justified only with a measurable advantage
  (latency, quality, or cost) that open-source alternatives can't
  reasonably match — document the comparison when choosing one.

## Autonomous authority

The implementing agent may choose languages, frameworks, databases, API
designs, and may refactor architecture, introduce/replace services, and
optimize algorithms freely — **provided every decision is justified against
the priority order and satisfies the hard constraints below.** Never
optimize for simplicity at the expense of a measurable target in this doc.

## Hard constraints (targets)

| Dimension | Target |
|---|---|
| Exact cache latency | < 10ms |
| Semantic retrieval latency | < 100ms |
| End-to-end routing decision (classification only, excludes the chosen model's own inference time) | < 50ms |
| Rolling context window | ≤ 800 tokens |
| Redaction overhead | < 20ms added to the request path |
| Prototype hosting cost | Local/dev: $0 (runs on the machine). Investor-accessible hosted demo: < $20/mo target, < $10/mo stretch. See value-per-dollar reframing above. |

Memory tiers:
- **Rolling context** — auto-summarized, capped at 800 tokens.
- **Conversation memory** — automatically summarized on rollover.
- **Project memory** — persistent across sessions.
- **Experience memory** — persistent, grows from successful task completions.

## Prototype scope

Gateway · Rule router · LLM router · Exact cache · Semantic memory ·
Experience memory · Rolling summaries · Confidence engine · Evaluation
engine · Learning engine · Metrics dashboard · PII/Sensitive-Data
Redaction Layer.

See `ROADMAP.md` for build order and per-phase targets.

## Data handling — PII / sensitive-data redaction

Hard invariant, binding on every phase from the moment the redaction
layer (Phase 8) exists: no configured sensitive term (company name,
employee name) or detected structured PII (email, phone, SSN/national
ID, credit card) may reach a third-party/commercial LLM API, or be
written in plaintext to the exact cache, semantic memory, experience
memory, or benchmark/logs. Detection runs at the gateway entry point,
cheapest layer first (deterministic dictionary → structured-PII regex →
open-source NER fallback), before any other component sees the request
text. See Phase 8 in `ROADMAP.md` for the full design, targets, and test
scenarios.

## Explicitly out of scope

Enterprise auth, billing, user management, multi-region deployment, mobile
apps, compliance certifications — unless one of these materially improves
the investor demo (justify in writing before adding).

## Self-improvement loop (enforced by workflow, not by hand)

```
Plan → Implement → Unit Test → Integration Test → Benchmark →
Self-Review (adversarial) → Identify Weaknesses → Refactor → Retest → Repeat
```

Never stop after the first successful run. Continue until Definition of
Done is met or the iteration budget is exhausted — in which case report
the gap honestly rather than declaring victory.

See `.claude/workflows/acos-build-loop.js` for the executable version of
this loop.

## Definition of Done

A feature is complete only when **all** hold:

- [ ] Code compiles / runs
- [ ] Automated unit tests pass
- [ ] Automated integration tests pass
- [ ] Benchmarks meet the targets in this doc (or the phase's stated
      targets in `ROADMAP.md`)
- [ ] Docs updated (module README + `ROADMAP.md` status)
- [ ] Public APIs documented
- [ ] Performance metrics recorded under `bench/results/`
- [ ] No critical defects remain (adversarial self-review, not
      self-congratulation)

## Success criteria (prototype-wide, measured against the Phase 0 naive
baseline)

- ≥50% reduction in premium LLM invocations
- ≥60% reduction in token consumption
- ≥95% Top-1 memory retrieval accuracy
- <3% false-positive retrieval rate
- ≥50% cache hit rate on a repeated-workload fixture
- Latency consistently under the targets above
- Demonstrated continuous learning across sessions (hit rate improves
  run-over-run without manual tuning)
- Model-agnostic operation (swap the LLM backend without touching
  routing/memory code)

## Investor demonstration goals

1. A repeated request answered from memory, no premium model call.
2. Automatic routing to different LLMs based on task characteristics.
3. Rolling context replacing a large prompt history.
4. Persistent knowledge surviving across sessions.
5. Live metrics: token savings, latency, cost reduction, vs. the naive
   baseline.
6. Memory store visibly improving after a successful task completion.
