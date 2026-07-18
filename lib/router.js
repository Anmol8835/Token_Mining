// ============================================================
// Model router — maps classification to best model
// ============================================================

/**
 * Select the best model for a given classification result.
 *
 * @param {object} classification - ClassificationResult from the classifier
 * @param {object} registry - ProviderRegistry instance
 * @param {object} routerConfig - Router settings from server.json
 * @param {string} explicitModel - User-requested model ID (if any), skip routing
 * @returns {object} { model, reason } - Selected model config and routing reason
 */
function selectModel(classification, registry, routerConfig, explicitModel) {
  const {
    costWeight = 0.3,
    qualityWeight = 0.7,
    fallbackModel = "deepseek-chat",
  } = routerConfig || {};

  // If user explicitly specified a real model, use it directly
  if (explicitModel && explicitModel !== "auto") {
    const model = registry.lookup(explicitModel);
    if (model) {
      return { model, reason: `User-specified model: ${explicitModel}` };
    }
    // Unknown model — fall through to auto-routing
    console.warn(`Unknown model "${explicitModel}", falling back to auto-routing`);
  }

  // Build required capabilities from the request classification
  const requiredCaps = classification.requiredCapabilities || {};

  // Log capability-based filtering for observability
  const activeCaps = Object.entries(requiredCaps)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (activeCaps.length > 0) {
    console.log(`[router] Required capabilities: ${activeCaps.join(", ")}`);
  }

  // Log signal sources from fusion metadata
  if (classification.metadata?.signalsUsed) {
    console.log(
      `[router] Classification signals: ${classification.metadata.signalsUsed.join(", ")} ` +
      `(confidence: ${classification.confidence?.toFixed(2) || "?"})`
    );
  }
  if (classification.metadata?.ambiguity) {
    console.log(
      `[router] Ambiguity: ${classification.metadata.ambiguity.primary} vs ` +
      `${classification.metadata.ambiguity.alternative} ` +
      `(ratio: ${classification.metadata.ambiguity.ratio})`
    );
  }

  // Filter available models — registry.filterModels already excludes
  // models whose provider hasn't been validated (missing API key etc.)
  const allModelCount = registry.getAllModels().length;
  let candidates = registry.filterModels((model) => {
    // Hard filter: must satisfy required capabilities
    if (requiredCaps.needsTools && !model.capabilities.toolUse) return false;
    if (requiredCaps.needsVision && !model.capabilities.vision) return false;
    if (requiredCaps.needsStreaming && !model.capabilities.streaming) return false;

    // Hard filter: budget tasks never use premium/standard models
    // (all of these have budget/low costTier models available)
    if (classification.costSensitivity === "budget"
        && model.profile.costTier !== "budget"
        && model.profile.costTier !== "low") return false;

    return true;
  });

  if (activeCaps.length > 0) {
    console.log(
      `[router] Capability filter: ${allModelCount} → ${candidates.length} models`
    );
  }

  if (candidates.length === 0) {
    // Degrade gracefully: if fallbackModel's provider is active, use it
    const fallback = registry.lookup(fallbackModel);
    if (fallback && registry.getProvider(fallback.id)) {
      return {
        model: fallback,
        reason: `No models satisfy requirements, using fallback: ${fallbackModel}`,
      };
    }
    // Desperate: pick any model from an active provider
    const all = registry.filterModels(() => true);
    if (all.length === 0) {
      throw new Error("No active models available");
    }
    return { model: all[0], reason: "No candidates, using first available model" };
  }

  // Score each candidate
  const scored = candidates.map((model) => {
    let score = 0;

    // Quality match score (0-1)
    const complexityMatch =
      model.profile.complexity === classification.complexity ? 1.0
      : model.profile.complexity === "high" && classification.complexity === "medium" ? 0.8
      : 0.4;

    const taskMatch = model.profile.taskTypes.includes(classification.taskType) ? 1.0 : 0.3;

    const qualityScore = complexityMatch * 0.4 + taskMatch * 0.6;

    // Cost match score (0-1)
    const costTierMap = {
      budget: { budget: 1.0, standard: 0.4, premium: 0.0 },
      standard: { budget: 0.5, standard: 1.0, premium: 0.3 },
      premium: { budget: 0.0, standard: 0.3, premium: 1.0 },
    };
    const costTierScore = costTierMap[classification.costSensitivity]?.[model.profile.costTier] ?? 0.5;

    // Total weighted score
    score = qualityWeight * qualityScore + costWeight * costTierScore;

    // Small cost boost: among same-tier models, prefer cheaper
    const totalCost = (model.cost.inputPer1M + model.cost.outputPer1M);
    const costBoost = totalCost > 0 ? (1 / (totalCost + 0.01)) * 0.05 : 0;

    return { model, score: score + costBoost };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  console.log(`Model routing candidates: ${scored.map(s => `${s.model.id} (score=${s.score.toFixed(3)})`).join(", ")}`);

  const winner = scored[0];
  return {
    model: winner.model,
    reason: `Routed: ${winner.model.id} (score=${winner.score.toFixed(3)}, ${classification.taskType}/${classification.complexity})`,
  };
}

module.exports = { selectModel };
