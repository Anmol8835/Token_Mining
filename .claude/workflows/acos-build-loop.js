export const meta = {
  name: 'acos-build-loop',
  description: 'Self-improving build loop: Plan -> Implement -> Test -> Benchmark -> Adversarial Review -> Repeat until Definition of Done, escalating to a narrower goal if the iteration budget runs out',
  whenToUse: 'Invoke with args = { goal, targets?, maxIterations?, maxEscalations? } from inside the acos repo to autonomously build or extend one component against MASTER.md / ROADMAP.md until the Definition of Done is met or all escalation attempts are exhausted.',
  phases: [
    { title: 'Plan' },
    { title: 'Implement' },
    { title: 'Test' },
    { title: 'Benchmark & Review' },
    { title: 'Escalate' },
  ],
}

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['passed', 'failures', 'summary'],
}

const BENCH_SCHEMA = {
  type: 'object',
  properties: {
    metrics: { type: 'object' },
    meetsTargets: { type: 'boolean' },
    details: { type: 'string' },
  },
  required: ['metrics', 'meetsTargets', 'details'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    doneDoD: { type: 'boolean' },
    meetsTargets: { type: 'boolean' },
    criticalDefects: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['doneDoD', 'meetsTargets', 'criticalDefects', 'weaknesses', 'summary'],
}

const ESCALATE_SCHEMA = {
  type: 'object',
  properties: {
    narrowedGoal: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['narrowedGoal', 'rationale'],
}

const originalGoal = args.goal
const targets = args.targets || {}
const maxIterations = args.maxIterations || 5
const maxEscalations = args.maxEscalations || 2

if (!originalGoal) {
  throw new Error('acos-build-loop requires args.goal (a description of what to build/extend this run)')
}

function slugify(text) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return slug || 'goal'
}

// each run gets its own plan file under docs/plans/ rather than a single
// PLAN_CURRENT.md that every run overwrites — otherwise every prior
// phase's plan is destroyed the moment the next phase runs
const planPath = `docs/plans/${slugify(originalGoal)}.md`

log(`Goal: ${originalGoal}`)
log(`Targets: ${JSON.stringify(targets)}`)
log(`Max iterations per attempt: ${maxIterations}, max escalations: ${maxEscalations}`)
log(`Plan file: ${planPath}`)

phase('Plan')
await agent(
  `Read MASTER.md and ROADMAP.md at the repo root (this is the ACOS project). ` +
  `Write an implementation plan for this goal: "${originalGoal}". ` +
  `Explicit targets to satisfy (if empty, derive them from ROADMAP.md/MASTER.md for the relevant phase): ${JSON.stringify(targets)}. ` +
  `Follow MASTER.md's priority order (latency > cost-per-value > quality > scalability > modularity > extensibility > model independence) and its open-source-first policy. ` +
  `Write the plan to ${planPath} at the repo root (create the docs/plans/ directory if needed; do not touch any other file already in docs/plans/ — each goal keeps its own permanent plan file): chosen approach with a one-line justification against the priority order, files to create/modify, unit + integration test strategy, and benchmark methodology (what fixture, what's measured, where results are written under bench/results/). ` +
  `Do not write implementation code yet.`,
  { agentType: 'general-purpose', label: 'plan' }
)

async function runAttempt(goal, attemptLabel) {
  let weaknesses = []
  let iteration = 0
  let done = false
  let finalVerdict = null

  while (iteration < maxIterations && !done) {
    iteration++
    log(`[${attemptLabel}] iteration ${iteration}/${maxIterations}`)

    phase('Implement')
    const weaknessNote = weaknesses.length
      ? `The previous iteration's tests/benchmark/review identified these problems — fix them, don't just re-implement from scratch: ${JSON.stringify(weaknesses)}.`
      : 'This is the first implementation pass for this goal.'
    await agent(
      `Read ${planPath} at the repo root and implement it for goal: "${goal}". ${weaknessNote} ` +
      `Write production-quality code plus unit tests and integration tests, matching MASTER.md's Definition of Done. ` +
      `Prefer open-source/self-hosted solutions per MASTER.md; justify any commercial API in docs/adr/. ` +
      `Run the test suite yourself at least once before finishing and fix anything trivially broken.`,
      { agentType: 'general-purpose', label: `implement-${attemptLabel}-${iteration}`, phase: 'Implement' }
    )

    phase('Test')
    const [unitResult, integrationResult] = await parallel([
      () => agent(
        `Run the unit test suite for the code just implemented for goal "${goal}". If a failure is trivial and safe to fix, fix it, then re-run. Report final results honestly — do not report passed:true if any test still fails.`,
        { agentType: 'general-purpose', label: `unit-test-${attemptLabel}-${iteration}`, phase: 'Test', schema: TEST_SCHEMA }
      ),
      () => agent(
        `Run the integration test suite (end-to-end paths through the component) for the code just implemented for goal "${goal}". If a failure is trivial and safe to fix, fix it, then re-run. Report final results honestly — do not report passed:true if any test still fails.`,
        { agentType: 'general-purpose', label: `integration-test-${attemptLabel}-${iteration}`, phase: 'Test', schema: TEST_SCHEMA }
      ),
    ])

    phase('Benchmark & Review')
    const [benchResult, reviewResult] = await parallel([
      () => agent(
        `Benchmark the code implemented for goal "${goal}" against these targets: ${JSON.stringify(targets)} (if empty, use the relevant targets from ROADMAP.md). ` +
        `Use or create a repeatable script under bench/ that replays the fixture workload, and write results to bench/results/. Report the actually measured metrics — never fabricate numbers — and whether targets are met.`,
        { agentType: 'general-purpose', label: `benchmark-${attemptLabel}-${iteration}`, phase: 'Benchmark & Review', schema: BENCH_SCHEMA }
      ),
      () => agent(
        `Adversarially self-review the code implemented for goal "${goal}" against the Definition of Done in MASTER.md: compiles/runs, tests pass, benchmarks meet targets, docs updated, public APIs documented, metrics recorded under bench/results/, no critical defects. ` +
        `Actively try to find what's broken, missing, or overstated rather than confirming success. Only set doneDoD:true if every checklist item genuinely holds. List every weakness found, however small, and separately list critical defects (correctness/security bugs, data loss, silent failures).`,
        { agentType: 'general-purpose', label: `review-${attemptLabel}-${iteration}`, phase: 'Benchmark & Review', schema: REVIEW_SCHEMA }
      ),
    ])

    const testsPassed = Boolean(unitResult && unitResult.passed) && Boolean(integrationResult && integrationResult.passed)
    const benchOk = Boolean(benchResult && benchResult.meetsTargets)
    const reviewOk = Boolean(
      reviewResult &&
      reviewResult.doneDoD &&
      reviewResult.meetsTargets &&
      (!reviewResult.criticalDefects || reviewResult.criticalDefects.length === 0)
    )

    finalVerdict = { iteration, testsPassed, benchOk, reviewOk, unitResult, integrationResult, benchResult, reviewResult }

    if (testsPassed && benchOk && reviewOk) {
      done = true
      log(`[${attemptLabel}] Definition of Done satisfied after iteration ${iteration}.`)
    } else {
      weaknesses = [
        ...((unitResult && unitResult.failures) || []),
        ...((integrationResult && integrationResult.failures) || []),
        ...(benchOk ? [] : [`Benchmark targets not met: ${(benchResult && benchResult.details) || 'no details reported'}`]),
        ...((reviewResult && reviewResult.weaknesses) || []),
        ...((reviewResult && reviewResult.criticalDefects) || []),
      ]
      log(`[${attemptLabel}] iteration ${iteration} incomplete. Carrying forward ${weaknesses.length} weakness(es) into the next iteration.`)
    }
  }

  return { goal, done, iterations: iteration, weaknesses, finalVerdict }
}

const history = []
let currentGoal = originalGoal
let escalation = 0
let done = false

while (true) {
  const attemptLabel = escalation === 0 ? 'attempt0' : `escalation${escalation}`
  const result = await runAttempt(currentGoal, attemptLabel)
  history.push(result)
  done = result.done

  if (done) break
  if (escalation >= maxEscalations) break

  phase('Escalate')
  escalation++
  const escalated = await agent(
    `A build-loop attempt for the ACOS project exhausted its iteration budget without meeting the Definition of Done. ` +
    `Original goal: "${originalGoal}". Most recent attempted goal: "${currentGoal}". ` +
    `Remaining unresolved weaknesses/failures from the last iteration: ${JSON.stringify(result.weaknesses)}. ` +
    `Propose a narrower, more achievable sub-goal that a fresh implementation attempt (with the same ${maxIterations}-iteration budget) is more likely to actually complete and pass Definition of Done for — e.g. drop a nice-to-have requirement, split off a smaller first slice of the goal, or relax a specific target that appears unrealistic for this budget (say which one and why). ` +
    `Do not narrow further than necessary to make it achievable — keep as much of the original goal as plausible. Read MASTER.md/ROADMAP.md if useful context.`,
    { agentType: 'general-purpose', label: `escalate-${escalation}`, phase: 'Escalate', schema: ESCALATE_SCHEMA }
  )
  currentGoal = escalated.narrowedGoal
  log(`Escalation ${escalation}/${maxEscalations}: narrowing goal to "${currentGoal}" — ${escalated.rationale}`)
}

if (!done) {
  log(`All ${maxEscalations + 1} attempt(s) exhausted without meeting the Definition of Done. Reporting the full attempt history rather than declaring success.`)
}

return {
  originalGoal,
  targets,
  done,
  escalations: escalation,
  attempts: history,
}
