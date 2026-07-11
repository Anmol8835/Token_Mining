# ACOS — operating rules for this repo

Full spec: `MASTER.md`. Build order and per-phase targets: `ROADMAP.md`.
These instructions override default behavior for work in this repo.

- Priority order for every decision: latency > cost-per-value > quality >
  scalability > modularity > extensibility > model independence.
- Cost: optimize value-per-dollar against the Phase 0 naive baseline in
  `bench/results/phase0-baseline.json`, not absolute minimal spend.
- Open-source/self-hosted first; commercial APIs need a written,
  measurable justification.
- Never call a premium LLM when cache/semantic-memory/cheap-model would
  do — that ordering is the product.
- No configured sensitive term or detected PII may ever reach a
  third-party LLM API, cache, memory store, or logs in plaintext — see
  Phase 8 / "Data handling" in MASTER.md.
- You have full autonomy on language/framework/DB choices; justify
  non-trivial choices in `docs/adr/`.
- Never mark a feature done without meeting the Definition of Done in
  `MASTER.md` (tests pass, benchmarks meet targets, docs updated, no
  critical defects). Do not stop after first green run — see the
  self-improvement loop in `MASTER.md` and
  `.claude/workflows/acos-build-loop.js`.
- Out of scope unless it demonstrably helps the investor demo: enterprise
  auth, billing, user management, multi-region, mobile, compliance certs.
