# Router Benchmark Harness

Evaluates and tunes the proxy's routing: three categories (chat / math / mcq /
code), a "cheapest acceptable tier" label per prompt, and a cost-vs-flagship
report on a held-out eval split.

## Tiers

- **cheap** — `deepseek-flash`
- **middle** — `deepseek-v4-pro`
- **flagship** — `claude-opus-4-8`
- **judge** — `deepseek-v4-pro` (pairwise A/B for chat; falls back to `deepseek-flash` with thinking disabled on empty verdicts)

## Pipeline

```
prep (Python)          datasets → data/prompts/*.jsonl (2:1 train/eval split)
run.js  <category>     router path (via proxy :8002) + 3 direct tier baselines
                        → data/responses/<category>.jsonl
judge.js               chat pairs (cheap/middle vs flagship, blind A/B)
                        → data/judgments/judgments.jsonl
grade.js <category>    math/mcq exact-match, code subprocess tests
                        → data/grades/<category>.jsonl
label.js               judgments → cheap_ok / middle_ok per chat prompt
fit-policy.js          TRAIN split → config/router-policy.json
report.js              EVAL split → console table + data/report/report.json
                        (--after-policy re-runs selectModel with the fitted policy)
```

One-shot: `./run-all.sh` (stages: serve / judge / grade / fit / all).
Every stage supports `--resume`, `--limit N`, `--dry-run`.

## Prerequisites

- Proxy running on `:8002` (router path only; tier baselines call providers directly)
- Python prep: `benchmark/.venv` (`python3 -m venv .venv && .venv/bin/pip install datasets numpy scipy scikit-learn faker`)
- API keys in `.env`: `DEEPSEEK_API_KEY` and `CLAUDE_API_KEY`
- `POST /metrics/reset?global=1` before a run to isolate benchmark traffic from production metrics (otherwise the proxy's global cost counter includes it)

## Flags

- `run.js`: `--limit N --split train|eval --offset N --dry-run --resume --mode cheap --concurrency 2 --source bigcodebench|humanevalplus`
- `judge.js`: `--limit N --split ... --resume --dry-run --judge-model deepseek-v4-pro`
- `grade.js`: `--canonical-check` (gold solutions through the harness — validates the runner at zero LLM cost)
- `fit-policy.js`: `--min-n 8 --cheap-thresh 0.75 --middle-thresh 0.75`
- `report.js`: `--after-policy`

## Policy mechanics

`fit-policy.js` buckets train prompts by `(primary_task × complexity)` (from the
router records' stored classifications) and emits `config/router-policy.json`:

```json
{ "if": { "primary_task": "mathematics", "complexity": "high" }, "minCostTier": "standard" }
```

`lib/router.js` applies matching rules as a candidate filter (drop models below
the min cost tier; never fail routing; missing file = no behavior change).
Delete the file to revert to unconstrained routing.

## Cost notes

- Every prompt is served 4× (router + 3 tiers) so policy changes can be
  re-scored from stored artifacts — no new LLM calls.
- Pilot (200 chat / 60 math / 40 mcq / 120 code) ≈ $8–12, dominated by opus output.
- Responses JSONL is append-only: interrupted runs resume with `--resume`.

## Gotchas (learned the hard way)

- `deepseek-v4-pro` (judge) is thinking-mode: needs `max_tokens ≥ 1024` for a verdict, and occasionally returns empty — the judge falls back to `deepseek-flash` with thinking disabled.
- Claude 4.6+ rejects `temperature` (400 "deprecated") — the Anthropic provider omits it except for Haiku.
- BigCodeBench `canonical_solution` is the function BODY only — `complete_prompt` carries the signature; the canonical harness check reconstructs the full function.
- BigCodeBench tests import libs beyond the task's `libs` field (numpy/scipy/faker are in the venv); ~650/1140 tasks run locally.
