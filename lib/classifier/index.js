// ============================================================
// Parallel Multi-Model Classifier
//
// Architecture:
//   Phase 1: Run 3 free signals in parallel (rules + embedding + profile)
//   Phase 2: Fuse results via weighted voting
//   Phase 3: If confidence < threshold, call LLM with full context
//   Phase 4: Graceful degradation on any failure
//
// Every signal and the final result share the same taxonomy
// shape; the deterministic routing rules are re-applied by fusion
// and by each signal, so the routing block is always consistent.
// ============================================================

const path = require("path");
const rules = require("./rules");
const { classifyWithLLM, classifyWithLLMFallback } = require("./llm-classifier");
const EmbeddingClassifier = require("./embedding-classifier");
const ProfileClassifier = require("./profile-classifier");
const { fuse } = require("./fusion");
const ClassificationCache = require("./cache");

class HybridClassifier {
  /**
   * @param {object} serverConfig - server.json config
   * @param {object} providerRegistry - ProviderRegistry instance
   */
  constructor(serverConfig, providerRegistry) {
    this.config = serverConfig;
    this.registry = providerRegistry;

    // Fusion confidence threshold — below this, LLM fallback fires
    this.fusionThreshold =
      serverConfig.classifier?.fusionConfidenceThreshold ?? 0.65;

    // Cache
    this.cache = new ClassificationCache(
      (serverConfig.classifier?.cacheHours ?? 1) * 3600000,
      serverConfig.classifier?.cacheMaxEntries ?? 2000
    );

    // Initialize signal classifiers
    this.embeddingClassifier = new EmbeddingClassifier(
      path.join(__dirname, "reference-examples.json"),
      serverConfig.classifier?.embedding || {}
    );

    this.profileClassifier = new ProfileClassifier(
      serverConfig.classifier?.profile || {}
    );

    // Resolve the LLM classifier model (used in fallback phase)
    const modelId =
      serverConfig.classifier?.llmClassifierModel || "deepseek-chat";
    this.classifierModel = providerRegistry.getModel(modelId);
    this.classifierProvider = this.classifierModel
      ? providerRegistry.getProvider(modelId)
      : null;

    // Fusion weights (undefined = use defaults in fusion.js)
    this.fusionWeights = serverConfig.classifier?.fusionWeights || undefined;

    if (!this.classifierProvider) {
      console.warn(
        `[classifier] LLM fallback model "${modelId}" not available — ` +
        `will use fusion-only results when confidence is low`
      );
    }
  }

  /**
   * Classify a request using the parallel multi-model pipeline.
   * @param {object} requestBody - Full Anthropic-format request body
   * @returns {Promise<object>} Classification result (taxonomy shape)
   */
  async classify(requestBody) {
    // --- Cache check ---
    const cached = this.cache.get(requestBody);
    if (cached) {
      return { ...cached, cached: true };
    }

    // --- Phase 1: Parallel execution of 3 free classifiers ---
    const [ruleResult, embeddingResult, profileResult] = await Promise.all([
      Promise.resolve(rules.classify(requestBody)),
      Promise.resolve(this.embeddingClassifier.classify(requestBody)),
      Promise.resolve(this.profileClassifier.classify(requestBody)),
    ]);

    // --- Phase 2: Fusion ---
    const fused = fuse(
      [ruleResult, embeddingResult, profileResult],
      this.fusionWeights
    );

    // --- Phase 3: Threshold check ---
    if (fused.confidence >= this.fusionThreshold) {
      this.cache.set(requestBody, fused);
      return fused;
    }

    // --- Phase 3.5: High-confidence shortcut ---
    // If the fused result was dragged below threshold by weak or
    // no-signal inputs, but a single high-confidence signal already
    // dominates and agrees with the fusion, skip the LLM fallback.
    const highConfSignals = [ruleResult, embeddingResult, profileResult].filter(
      (r) => r.confidence >= 0.8
    );
    const fusionAgrees = highConfSignals.filter(
      (r) =>
        r.primary_task === fused.primary_task &&
        r.complexity === fused.complexity &&
        r.routing?.model_type === fused.routing?.model_type
    );
    if (highConfSignals.length > 0 && fusionAgrees.length > 0) {
      fused.confidence = Math.max(fused.confidence, this.fusionThreshold);
      fused.metadata = fused.metadata || {};
      fused.metadata.shortcut = true;
      fused.metadata.shortcutReason =
        `High-confidence ${fusionAgrees[0].source} signal agrees with fusion, ` +
        `skipping LLM fallback`;
      this.cache.set(requestBody, fused);
      return fused;
    }

    // --- Phase 4: LLM Fallback (only when free signals were uncertain) ---
    if (this.classifierProvider && this.classifierModel) {
      try {
        const fallbackResult = await classifyWithLLMFallback(
          requestBody,
          this.classifierProvider,
          this.classifierModel,
          this._doChat.bind(this)
        );

        // Re-fuse including the high-confidence LLM fallback result
        const refined = fuse(
          [ruleResult, embeddingResult, profileResult, fallbackResult],
          this.fusionWeights
        );

        this.cache.set(requestBody, refined);
        return refined;
      } catch (err) {
        console.warn(
          `[classifier] LLM fallback failed: ${err.message} — using fused result`
        );
        // Graceful degradation: use fused result with penalty
        fused.metadata = fused.metadata || {};
        fused.metadata.degraded = true;
        fused.metadata.degradedReason = `LLM fallback failed: ${err.message}`;
        this.cache.set(requestBody, fused);
        return fused;
      }
    }

    // No LLM available — return fused result with degraded marker
    console.warn(
      "[classifier] LLM fallback not available — using fusion-only result " +
      `(confidence: ${fused.confidence.toFixed(2)})`
    );
    fused.metadata = fused.metadata || {};
    fused.metadata.degraded = true;
    fused.metadata.degradedReason = "LLM classifier not available for fallback";
    this.cache.set(requestBody, fused);
    return fused;
  }

  /**
   * Shared HTTP helper — calls the classifier provider's API.
   */
  async _doChat(provider, nativePayload) {
    const axios = require("axios");
    const url = provider.getNonStreamingUrl
      ? provider.getNonStreamingUrl()
      : provider.getApiUrl();
    const resp = await axios.post(url, nativePayload, {
      headers: provider.getHeaders(),
    });
    return resp.data;
  }
}

module.exports = HybridClassifier;
