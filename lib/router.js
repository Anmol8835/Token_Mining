// ============================================================
// Model router — maps classification to best model
//
// KEY DESIGN PRINCIPLE (cost-reduction focus):
//   Use cheap models by default. Escalate to expensive models
//   ONLY when the task clearly requires it (routing.model_type,
//   high complexity, high risk, quality-first latency).
//   Context size gates capability requirements, NOT model tier.
//
// The classifier's routing block is the primary signal:
//   - routing.model_type → hard preference toward that model tier
//   - routing.human_review_recommended → prefer the most capable
//     model and log a loud review warning
//   - latency_preference → shifts cost/quality weights
//   - capabilities → hard filters (tools, vision, context window)
// ============================================================

/**
 * Select the best model for a given classification result.
 *
 * @param {object} classification - Taxonomy classification from the classifier
 * @param {object} registry - ProviderRegistry instance
 * @param {object} routerConfig - Router settings from server.json
 * @param {string} explicitModel - User-requested model ID (if any), skip routing
 * @param {string} routingMode - Optional mode override: "fast" | "cheap" | "quality"
 * @returns {object} { model, reason } - Selected model config and routing reason
 */
function selectModel(classification, registry, routerConfig, explicitModel, routingMode) {
  const {
    costWeight = 0.3,
    qualityWeight = 0.7,
    fallbackModel = "deepseek-v4-flash",
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

  const capabilities = classification.capabilities || [];
  const modalities = classification.input_modalities || [];
  const routing = classification.routing || {};

  // ---- Minimal observability: one line per request in index.js.
  // Nothing is logged here — the dashboard has the full picture. ----
  if (routing.human_review_recommended) {
    console.warn(
      "⚠ HUMAN REVIEW RECOMMENDED " +
      `(${classification.domain}, risk=${classification.risk})`
    );
  }

  // ----------------------------------------------------------
  // Mode-based weight adjustment (cost-reduction aware)
  //
  // Latency preference from the classifier shifts the same knobs:
  //   fast          → cost/speed bias
  //   normal        → as configured
  //   quality_first → quality bias, regardless of mode
  // ----------------------------------------------------------
  const MODE_WEIGHTS = {
    cheap:    { qualityWeight: 0.35, costWeight: 0.65 },
    fast:     { qualityWeight: 0.40, costWeight: 0.60 },
    balanced: { qualityWeight: 0.60, costWeight: 0.40 },
    quality:  { qualityWeight: 0.85, costWeight: 0.15 },
  };

  let mode = routingMode || "cheap"; // DEFAULT: cost-reduction mode
  if (classification.latency_preference === "fast") {
    mode = mode === "quality" ? "balanced" : "fast";
  } else if (
    classification.latency_preference === "quality_first" ||
    routing.human_review_recommended
  ) {
    mode = "quality";
  }

  const effectiveQualityWeight = MODE_WEIGHTS[mode]?.qualityWeight ?? qualityWeight;
  const effectiveCostWeight = MODE_WEIGHTS[mode]?.costWeight ?? costWeight;

  // ----------------------------------------------------------
  // Estimate request token count for context window filtering
  // Rough heuristic: ~3.5 chars/token for code, ~4 for prose
  // ----------------------------------------------------------
  const signalMetadata = classification.metadata?.signalMetadata || {};
  const profileSignals = signalMetadata.profile?.signals || {};
  const estimatedTokens = profileSignals.charCount
    ? Math.ceil(profileSignals.charCount / 3.5)
    : 8000; // conservative default

  // Hard capability requirements derived from the classification.
  // NOTE: web_search / calculator are proxy-side tools — the model
  // itself only needs tool-calling support for tools that require
  // the model to emit tool_use blocks (code_interpreter, database,
  // file_reader) or when the request itself defines tools.
  const needsTools =
    capabilities.includes("tool_use") ||
    capabilities.includes("code_execution") ||
    (routing.tools || []).some((t) =>
      ["code_interpreter", "database", "file_reader"].includes(t)
    );
  const needsVision =
    capabilities.includes("vision") || modalities.includes("image");
  const needsAudio = modalities.includes("audio");

  // The classifier's core routing signal — used in filters below.
  const requestedModelType = routing.model_type || "general_model";

  // Filter available models — registry.filterModels already excludes
  // models whose provider hasn't been validated (missing API key etc.)
  const allModelCount = registry.getAllModels().length;
  let candidates = registry.filterModels((model) => {
    // --- Hard capability filters ---
    if (needsTools && !model.capabilities.toolUse) return false;
    if (needsVision && !model.capabilities.vision) return false;
    if (needsAudio && !model.capabilities.vision) return false; // audio input unsupported broadly; keep vision-proxy note
    if (classification.risk === "restricted") {
      // Restricted content: only models with a safety orientation.
      if (!model.profile.modelTypes?.includes("safety_specialized_model")) {
        return false;
      }
    }

    // --- Reasoning-tier filter ---
    // A request classified as reasoning_model must never be served
    // by a fast-tier model, even in cheap mode — that would defeat
    // the classification. Capable-but-expensive models remain
    // candidates and lose only via the cost scoring.
    if (
      requestedModelType === "reasoning_model" &&
      !(model.profile.modelTypes || []).some((t) =>
        ["reasoning_model", "coding_model", "safety_specialized_model"].includes(t)
      )
    ) {
      return false;
    }

    // --- Context window filter ---
    // Don't route to a model that can't fit the request.
    // 90% threshold to leave room for the response.
    if (estimatedTokens > model.capabilities.maxInputTokens * 0.9) return false;

    return true;
  });

  if (candidates.length === 0) {
    // Restricted filtering left nothing — widen by dropping the
    // safety requirement (best-effort) rather than failing.
    candidates = registry.filterModels((model) => {
      if (needsTools && !model.capabilities.toolUse) return false;
      if (needsVision && !model.capabilities.vision) return false;
      return estimatedTokens <= model.capabilities.maxInputTokens * 0.9;
    });
  }

  if (candidates.length === 0) {
    // Degrade gracefully: first try fallbackModel
    const fallback = registry.lookup(fallbackModel);
    if (fallback && registry.getProvider(fallback.id)) {
      if (estimatedTokens <= fallback.capabilities.maxInputTokens * 0.9) {
        return {
          model: fallback,
          reason: `No models satisfy requirements (estTokens=${estimatedTokens}), using fallback: ${fallbackModel}`,
        };
      }
    }
    // Second fallback: find any model with enough context window
    const all = registry.filterModels((m) =>
      estimatedTokens <= m.capabilities.maxInputTokens * 0.9
    );
    if (all.length === 0) {
      // Desperate: use the model with the largest context window
      const largest = registry.filterModels(() => true)
        .sort((a, b) => b.capabilities.maxInputTokens - a.capabilities.maxInputTokens);
      if (largest.length === 0) {
        throw new Error("No active models available");
      }
      return {
        model: largest[0],
        reason: `Context overflow risk (estTokens=${estimatedTokens}), using largest-window model: ${largest[0].id}`,
      };
    }
    return { model: all[0], reason: "No candidates, using first context-capable model" };
  }

  // ----------------------------------------------------------
  // Score each candidate
  // ----------------------------------------------------------
  const scored = candidates.map((model) => {
    let score = 0;
    const profile = model.profile || {};
    const modelTypes = profile.modelTypes || [];

    // --- Model type match: the classifier's core routing signal ---
    const modelTypeMatch = modelTypes.includes(requestedModelType)
      ? 1.0
      : modelTypes.length === 0
        ? 0.5
        : 0.25;

    // --- Task affinity: does this model claim this task? ---
    const taskMatch = (profile.tasks || []).includes(classification.primary_task)
      ? 1.0
      : 0.4;

    // --- Complexity match ---
    const complexityMatch =
      profile.complexity === classification.complexity ? 1.0
      : profile.complexity === "high" && classification.complexity === "medium" ? 0.8
      : 0.4;

    // --- Quality score (0-1) ---
    const qualityScore =
      modelTypeMatch * 0.45 + taskMatch * 0.35 + complexityMatch * 0.20;

    // --- Cost match score (0-1) ---
    // Budget-sensitive classifications strongly prefer budget models.
    const costTierMap = {
      low:      { budget: 1.0, low: 0.9, standard: 0.2, premium: 0.0 },
      medium:   { budget: 0.6, low: 0.7, standard: 1.0, premium: 0.3 },
      high:     { budget: 0.1, low: 0.2, standard: 0.7, premium: 1.0 },
    };
    // Complexity is a rough proxy for cost sensitivity — kept from the
    // legacy cost-reduction philosophy: cheap by default.
    const costSensitivity =
      classification.complexity === "high" ? "medium" : "low";
    const costTierScore =
      costTierMap[costSensitivity]?.[profile.costTier] ?? 0.5;

    score = effectiveQualityWeight * qualityScore + effectiveCostWeight * costTierScore;

    // --- Latency bonus/penalty ---
    const latencyTier = profile.latencyTier || "normal";
    if (classification.latency_preference === "fast") {
      score += latencyTier === "fast" ? 0.1 : latencyTier === "normal" ? 0.02 : -0.08;
    } else if (classification.latency_preference === "quality_first") {
      score += latencyTier === "quality" ? 0.08 : latencyTier === "fast" ? -0.1 : 0;
    }

    // --- Cost efficiency boost: among same-tier models, prefer cheaper ---
    const totalCost = (model.cost.inputPer1M + model.cost.outputPer1M);
    const costBoostMultiplier = mode === "cheap" ? 0.12 : mode === "fast" ? 0.08 : 0.03;
    const costBoost = totalCost > 0 ? (1 / (totalCost + 0.01)) * costBoostMultiplier : 0;

    return { model, score: score + costBoost };
  });

  scored.sort((a, b) => b.score - a.score);

  // ---- Minimal console output: scores, then the selected model ----
  console.log(
    `  scores: ` +
    scored
      .map((s) => `${s.model.id}=${s.score.toFixed(3)}`)
      .join(", ")
  );

  const winner = scored[0];
  console.log(`  → selected: ${winner.model.id} (${winner.score.toFixed(3)})`);
  return {
    model: winner.model,
    reason:
      `Routed: ${winner.model.id} (score=${winner.score.toFixed(3)}, ` +
      `${classification.primary_task}/${classification.complexity}/${requestedModelType}, ` +
      `mode=${mode})`,
    // Structured detail for the metrics dashboard — same data the
    // console logs show, in a shape a consumer can chart.
    detail: {
      mode,
      requestedModelType,
      winnerScore: Math.round(winner.score * 1000) / 1000,
      scores: scored.map((s) => [
        s.model.id,
        Math.round(s.score * 1000) / 1000,
      ]),
      filtered: {
        total: allModelCount,
        candidates: candidates.length,
        estimatedTokens,
      },
    },
  };
}

module.exports = { selectModel };
