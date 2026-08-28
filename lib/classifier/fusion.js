// ============================================================
// Fusion Layer — weighted voting across multiple classifiers
//
// Combines N classifier outputs (all in the shared taxonomy
// shape) into a single classification with a fused confidence.
//
// Strategy per field kind:
//   - categorical scalars  → confidence-weighted plurality vote
//     (primary_task, domain, output_format, latency_preference)
//   - ordered enums        → most-severe value with meaningful
//     support (complexity, risk, freshness)
//   - lists                → thresholded union, deduped
//     (secondary_tasks, capabilities, input_modalities,
//      routing.tools)
//   - booleans             → OR logic (pipeline, human review)
//
// After voting, the deterministic routing rules are re-applied
// so the routing block is internally consistent no matter how
// the individual signals voted.
// ============================================================

const {
  normalize,
  applyRoutingRules,
  clampConfidence,
  maxComplexity,
  maxRisk,
  maxFreshness,
  COMPLEXITY_RANK,
  RISK_RANK,
  FRESHNESS_RANK,
} = require("./taxonomy");

/**
 * Default per-source weights. Configurable via server.json.
 *
 * Rationale:
 *   rule (0.25)      — fast, deterministic, good for obvious patterns
 *   embedding (0.30) — best signal for primary_task from content semantics
 *   profile (0.15)   — structural signals, no task insight
 *   llm (0.30)       — most nuanced and context-aware, highest trust
 */
const DEFAULT_WEIGHTS = {
  rule: 0.25,
  embedding: 0.30,
  profile: 0.15,
  llm: 0.30,
};

// ----------------------------------------------------------
// Vote bookkeeping
// ----------------------------------------------------------

function sourceWeight(results, source, effectiveWeights) {
  return effectiveWeights[source] ?? 0.1;
}

/**
 * Build a confidence-weighted tally: value -> total weight.
 * Weight = sourceWeight * max(confidence, 0.05), so a very
 * confident signal outweighs a shrug from a heavily-weighted
 * source.
 */
function tallyScalar(results, effectiveWeights, field) {
  const votes = {};
  for (const r of results) {
    const val = r[field];
    if (val === undefined || val === null || val === "") continue;
    const w =
      sourceWeight(results, r.source, effectiveWeights) *
      Math.max(typeof r.confidence === "number" ? r.confidence : 0.3, 0.05);
    votes[val] = (votes[val] || 0) + w;
  }
  return votes;
}

/** Plurality winner with its normalized share of the total. */
function pluralityWinner(votes) {
  const entries = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { winner: null, share: 0, sorted: [] };
  const total = entries.reduce((s, [, w]) => s + w, 0);
  return {
    winner: entries[0][0],
    share: total > 0 ? entries[0][1] / total : 0,
    sorted: entries,
  };
}

/**
 * Most-severe value that has meaningful support (not a lone
 * outlier): its weight must be at least a third of the leading
 * value's. Severity merges only escalate, never downgrade, so
 * a single strong "restricted" vote still wins outright.
 */
function severityWinner(votes, rank, floor, meaningfulRatio = 0.33) {
  const entries = Object.entries(votes);
  if (entries.length === 0) return floor;
  const maxW = Math.max(...entries.map(([, w]) => w));
  const supported = entries
    .filter(([, w]) => w >= maxW * meaningfulRatio)
    .map(([v]) => v);
  return supported.reduce((a, b) => (rank[a] >= rank[b] ? a : b));
}

/**
 * Union of list values across signals, each value weighted by the
 * max confidence of any signal that included it. Keeps a value if
 * its weight clears the support threshold — a value only one
 * low-confidence signal mentioned is dropped as noise.
 */
function unionLists(results, effectiveWeights, field, supportThreshold = 0.3) {
  const weights = {};
  for (const r of results) {
    const list = r[field];
    if (!Array.isArray(list)) continue;
    const w =
      sourceWeight(results, r.source, effectiveWeights) *
      Math.max(typeof r.confidence === "number" ? r.confidence : 0.3, 0.05);
    for (const val of list) {
      weights[val] = Math.max(weights[val] || 0, w);
    }
  }
  const maxW = Math.max(0, ...Object.values(weights));
  return Object.entries(weights)
    .filter(([, w]) => w >= maxW * supportThreshold)
    .map(([v]) => v);
}

// ----------------------------------------------------------
// Main fusion
// ----------------------------------------------------------

/**
 * Fuse multiple classifier results into a single classification.
 *
 * @param {object[]} results - Classifier outputs in taxonomy shape.
 *   Null entries are silently skipped.
 * @param {object} weights - Per-source weight overrides (merged with defaults).
 * @returns {object} Fused classification with source "fusion"
 */
function fuse(results, weights) {
  const effectiveWeights = { ...DEFAULT_WEIGHTS, ...weights };

  // Filter to valid, non-null results.
  const valid = (results || []).filter(
    (r) => r !== null && r !== undefined && typeof r === "object"
  );

  // No classifiers produced output — return a safe default.
  if (valid.length === 0) {
    return {
      ...normalize({
        confidence: 0.1,
        reason: "No classifiers available — using safe defaults",
      }),
      source: "fusion",
      metadata: { signalsUsed: [], degraded: true },
    };
  }

  // Single signal — return it directly with source preserved.
  if (valid.length === 1) {
    return {
      ...valid[0],
      metadata: {
        ...valid[0].metadata,
        signalsUsed: [valid[0].source],
        singleSignal: true,
      },
    };
  }

  // ---- Categorical scalars: plurality vote ----
  const taskVote = pluralityWinner(tallyScalar(valid, effectiveWeights, "primary_task"));
  const domainVote = pluralityWinner(tallyScalar(valid, effectiveWeights, "domain"));
  const formatVote = pluralityWinner(tallyScalar(valid, effectiveWeights, "output_format"));
  const latencyVote = pluralityWinner(tallyScalar(valid, effectiveWeights, "latency_preference"));

  // model_type is derived by each signal from its task opinion, so
  // it votes like any other categorical — EXCEPT the profile
  // classifier, whose default carries no task opinion at all.
  const modelVotes = {};
  for (const r of valid) {
    const mt = r.routing?.model_type;
    if (!mt || (r.source === "profile" && r.metadata?.noTaskOpinion)) continue;
    const w =
      sourceWeight(results, r.source, effectiveWeights) *
      Math.max(typeof r.confidence === "number" ? r.confidence : 0.3, 0.05);
    modelVotes[mt] = (modelVotes[mt] || 0) + w;
  }
  const modelVote = pluralityWinner(modelVotes);

  const primary_task = taskVote.winner || "other";
  const domain = domainVote.winner || "general";
  const output_format = formatVote.winner || "text";
  const latency_preference = latencyVote.winner || "normal";
  const voted_model_type = modelVote.winner; // may be null → derived

  // ---- Ordered enums: severity with support ----
  const complexity = severityWinner(
    tallyScalar(valid, effectiveWeights, "complexity"),
    COMPLEXITY_RANK,
    "medium"
  );
  const risk = severityWinner(
    tallyScalar(valid, effectiveWeights, "risk"),
    RISK_RANK,
    "low"
  );
  const freshness = severityWinner(
    tallyScalar(valid, effectiveWeights, "freshness"),
    FRESHNESS_RANK,
    "not_required"
  );

  // ---- Sparse fields (persona, subdomain) ----
  // Only rules and the LLM ever produce these. When they disagree,
  // the most confident signal wins; when nobody produced one, null.
  const pickSparseField = (field) => {
    let best = null;
    let bestConf = -1;
    for (const r of valid) {
      const val = r[field];
      if (val && (r.confidence ?? 0) > bestConf) {
        best = val;
        bestConf = r.confidence ?? 0;
      }
    }
    return best;
  };
  const persona = pickSparseField("persona");
  const subdomain = pickSparseField("subdomain");

  // ---- Lists: thresholded union ----
  const secondary_tasks = unionLists(valid, effectiveWeights, "secondary_tasks")
    .filter((t) => t !== primary_task)
    .slice(0, 5);
  const capabilities = unionLists(valid, effectiveWeights, "capabilities");
  const input_modalities =
    unionLists(valid, effectiveWeights, "input_modalities", 0.25) ||
    ["text"];
  const tools = unionLists(valid, effectiveWeights, "routing.tools");

  // ---- Booleans: OR logic (one clear signal is enough) ----
  const use_multi_step_pipeline = valid.some(
    (r) => r.routing?.use_multi_step_pipeline && r.confidence > 0.3
  );
  const human_review_recommended = valid.some(
    (r) => r.routing?.human_review_recommended && r.confidence > 0.3
  );

  // ---- Fused confidence ----
  // Weighted mean across sources, then agreement bonuses.
  // Sources below 0.2 confidence are treated as ABSTENTIONS: they
  // contribute votes with their small weight, but they must not
  // drag the fused confidence below what the signals that actually
  // had an opinion were sure about.
  let totalWeight = 0;
  let weightedConfSum = 0;
  for (const r of valid) {
    const conf = typeof r.confidence === "number" ? r.confidence : 0.3;
    if (conf < 0.2) continue; // abstention
    const w = sourceWeight(results, r.source, effectiveWeights);
    totalWeight += w;
    weightedConfSum += w * conf;
  }
  let fusedConfidence = totalWeight > 0 ? weightedConfSum / totalWeight : 0.1;

  const taskValues = valid.map((r) => r.primary_task).filter(Boolean);
  if (taskValues.length >= 2) {
    const unique = new Set(taskValues);
    if (unique.size === 1) {
      fusedConfidence = Math.min(fusedConfidence + 0.08, 0.95);
    } else if (taskValues.filter((t) => t === primary_task).length >= 2) {
      fusedConfidence = Math.min(fusedConfidence + 0.05, 0.95);
    }
  }

  // ---- Ambiguity detection ----
  let ambiguity = null;
  if (taskVote.sorted.length > 1) {
    const winnerWeight = taskVote.sorted[0][1];
    const runnerUpWeight = taskVote.sorted[1][1];
    if (winnerWeight > 0 && runnerUpWeight / winnerWeight > 0.85) {
      ambiguity = {
        primary: taskVote.sorted[0][0],
        alternative: taskVote.sorted[1][0],
        ratio: Math.round((runnerUpWeight / winnerWeight) * 100) / 100,
      };
    }
  }

  // ---- Assemble and re-apply deterministic routing rules ----
  const fused = normalize({
    primary_task,
    secondary_tasks,
    domain,
    subdomain,
    persona,
    capabilities,
    input_modalities,
    output_format,
    complexity,
    risk,
    freshness,
    latency_preference,
    routing: {
      model_type: voted_model_type, // null → derived by rules below
      tools,
      use_multi_step_pipeline,
      human_review_recommended,
    },
    confidence: fusedConfidence,
    reason:
      `Fused from [${valid.map((r) => r.source).join(", ")}]: ` +
      `${primary_task}/${domain}/${complexity}`,
  });

  // Tool-use capability only when the REQUEST genuinely defines tools or
  // shows tool history — web_search/calculator are proxy-side and must
  // not imply the model needs tool-calling support.
  const modelSideTools = ["code_interpreter", "database", "file_reader"];
  const routed = applyRoutingRules(fused, {
    hasLargeInput: valid.some((r) => r.metadata?.signals?.hasLargeInput),
    hasToolDefinitions: valid.some((r) => {
      const toolActivity = r.metadata?.signals?.toolActivity;
      if (toolActivity !== undefined) return toolActivity !== "none";
      return (r.routing?.tools || []).some((t) => modelSideTools.includes(t));
    }),
    safetySensitive: valid.some((r) => r.metadata?.safetySensitive),
  });

  return {
    ...routed,
    source: "fusion",
    metadata: {
      signalsUsed: valid.map((r) => r.source),
      ambiguity,
      fieldConfidence: {
        primary_task: Math.round(taskVote.share * 100) / 100,
        domain: Math.round(domainVote.share * 100) / 100,
      },
      individualResults: valid.map((r) => ({
        source: r.source,
        primary_task: r.primary_task,
        domain: r.domain,
        complexity: r.complexity,
        risk: r.risk,
        confidence: r.confidence,
        reason: r.reason,
      })),
      votes: {
        primary_task: taskVote.sorted.map(([k, w]) => [k, Math.round(w * 100) / 100]),
        domain: domainVote.sorted.map(([k, w]) => [k, Math.round(w * 100) / 100]),
        model_type: modelVote.sorted.map(([k, w]) => [k, Math.round(w * 100) / 100]),
        complexity: tallyScalar(valid, effectiveWeights, "complexity"),
        risk: tallyScalar(valid, effectiveWeights, "risk"),
      },
      signalMetadata: Object.fromEntries(
        valid.filter((r) => r.metadata).map((r) => [r.source, r.metadata])
      ),
    },
  };
}

module.exports = { fuse, DEFAULT_WEIGHTS };
