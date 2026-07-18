// ============================================================
// Fusion Layer — weighted voting across multiple classifiers
//
// Combines N classifier outputs into a single classification
// with a fused confidence score. Handles categorical fields
// via weighted plurality voting, booleans via OR logic, and
// adds agreement bonuses when classifiers converge.
// ============================================================

/**
 * Default per-source weights. Configurable via server.json.
 *
 * Rationale:
 *   rule (0.25) — fast, deterministic, good for obvious patterns
 *   embedding (0.30) — best signal for taskType from content semantics
 *   profile (0.15) — structural signals, limited taskType insight
 *   llm (0.30) — most nuanced and context-aware, highest trust
 */
const DEFAULT_WEIGHTS = {
  rule: 0.25,
  embedding: 0.30,
  profile: 0.15,
  llm: 0.30,
};

/**
 * Map field names to their valid values for validation.
 */
const VALID_VALUES = {
  taskType: [
    "coding",
    "creative",
    "summarization",
    "analysis",
    "chat",
    "agentic",
    "extraction",
    "translation",
  ],
  complexity: ["low", "medium", "high"],
  costSensitivity: ["budget", "standard", "premium"],
};

/**
 * Fuse multiple classifier results into a single classification.
 *
 * @param {object[]} results - Array of classifier outputs, each with:
 *   { taskType, complexity, costSensitivity, requiredCapabilities,
 *     confidence, source, reason, metadata? }
 *   Null entries are silently skipped.
 * @param {object} weights - Per-source weight overrides (merged with defaults).
 *   e.g. { rule: 0.20, embedding: 0.35, profile: 0.15, llm: 0.30 }
 * @returns {object} Fused classification result
 */
function fuse(results, weights) {
  const effectiveWeights = { ...DEFAULT_WEIGHTS, ...weights };

  // Filter to valid, non-null results
  const valid = (results || []).filter(
    (r) => r !== null && r !== undefined && typeof r === "object"
  );

  // No classifiers produced output — return safe default
  if (valid.length === 0) {
    return {
      taskType: "chat",
      complexity: "medium",
      costSensitivity: "standard",
      requiredCapabilities: {},
      confidence: 0.1,
      source: "fusion",
      reason: "No classifiers available — using safe defaults",
      metadata: { signalsUsed: [], degraded: true },
    };
  }

  // Single signal — return it directly with source preserved
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

  // --- Weighted voting for categorical fields ---
  function weightedVote(field) {
    const votes = {};
    for (const r of valid) {
      const sourceWeight = effectiveWeights[r.source] ?? 0.1;
      const conf = typeof r.confidence === "number" ? r.confidence : 0.3;
      const w = sourceWeight * Math.max(conf, 0.05); // floor at 0.05 to avoid zero
      const val = r[field];
      if (val === undefined || val === null) continue;
      votes[val] = (votes[val] || 0) + w;
    }
    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    return { winner: sorted[0]?.[0], votes, sorted };
  }

  const taskVote = weightedVote("taskType");
  const complexityVote = weightedVote("complexity");
  const costVote = weightedVote("costSensitivity");

  const taskType = taskVote.winner || "chat";
  const complexity = complexityVote.winner || "medium";
  const costSensitivity = costVote.winner || "standard";

  // --- Capability OR logic ---
  // Include a capability if ANY classifier with confidence > 0.3 flags it
  const requiredCapabilities = {
    needsTools: valid.some(
      (r) => r.requiredCapabilities?.needsTools && r.confidence > 0.3
    ),
    needsVision: valid.some(
      (r) => r.requiredCapabilities?.needsVision && r.confidence > 0.3
    ),
    needsStreaming: valid.some(
      (r) => r.requiredCapabilities?.needsStreaming && r.confidence > 0.3
    ),
  };

  // --- Fused confidence ---
  let totalWeight = 0;
  let weightedConfSum = 0;
  for (const r of valid) {
    const w = effectiveWeights[r.source] ?? 0.1;
    totalWeight += w;
    weightedConfSum += w * (r.confidence || 0.1);
  }
  let fusedConfidence =
    totalWeight > 0 ? weightedConfSum / totalWeight : 0.1;

  // Agreement bonuses
  const allTaskTypes = valid.map((r) => r.taskType).filter(Boolean);
  const allComplexities = valid.map((r) => r.complexity).filter(Boolean);

  if (allTaskTypes.length >= 2) {
    const uniqueTasks = new Set(allTaskTypes);
    if (uniqueTasks.size === 1) {
      // All agree on taskType
      fusedConfidence = Math.min(fusedConfidence + 0.08, 0.95);
    } else if (
      allTaskTypes.filter((t) => t === taskType).length >= 2
    ) {
      // Majority agree
      fusedConfidence = Math.min(fusedConfidence + 0.05, 0.95);
    }
  }

  if (allComplexities.length >= 2) {
    const uniqueComps = new Set(allComplexities);
    if (uniqueComps.size === 1) {
      fusedConfidence = Math.min(fusedConfidence + 0.05, 0.95);
    }
  }

  // --- Ambiguity detection ---
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

  return {
    taskType,
    complexity,
    costSensitivity,
    requiredCapabilities,
    confidence: Math.round(fusedConfidence * 100) / 100,
    source: "fusion",
    reason: `Fused from [${valid.map((r) => r.source).join(", ")}]: ${taskType}/${complexity}/${costSensitivity}`,
    metadata: {
      signalsUsed: valid.map((r) => r.source),
      ambiguity,
      individualResults: valid.map((r) => ({
        source: r.source,
        taskType: r.taskType,
        complexity: r.complexity,
        costSensitivity: r.costSensitivity,
        confidence: r.confidence,
        reason: r.reason,
      })),
      votes: {
        taskType: taskVote.votes,
        complexity: complexityVote.votes,
        costSensitivity: costVote.votes,
      },
      // Pass through any per-signal metadata
      signalMetadata: Object.fromEntries(
        valid
          .filter((r) => r.metadata)
          .map((r) => [r.source, r.metadata])
      ),
    },
  };
}

module.exports = { fuse, DEFAULT_WEIGHTS };
