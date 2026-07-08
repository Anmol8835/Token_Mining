// ============================================================
// Hybrid classifier — orchestrates rule-based + LLM fallback
// ============================================================

const crypto = require("crypto");
const rules = require("./rules");
const { classifyWithLLM } = require("./llm-classifier");

/**
 * Simple in-memory cache for classification results.
 * Keyed by hash of system prompt + first user message.
 */
class ClassificationCache {
  constructor(ttlMs = 3600000) {
    this.cache = new Map();
    this.ttlMs = ttlMs; // default 1 hour
  }

  _hash(requestBody) {
    const system = typeof requestBody.system === "string"
      ? requestBody.system
      : JSON.stringify(requestBody.system || "");
    const firstMsg = requestBody.messages?.[0]
      ? JSON.stringify(requestBody.messages[0])
      : "";
    return crypto.createHash("md5").update(system + firstMsg).digest("hex");
  }

  get(requestBody) {
    const key = this._hash(requestBody);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  set(requestBody, result) {
    const key = this._hash(requestBody);
    this.cache.set(key, { result, timestamp: Date.now() });

    // Prune old entries periodically
    if (this.cache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now - v.timestamp > this.ttlMs) this.cache.delete(k);
      }
    }
  }
}

// ----------------------------------------------------------
// Orchestrator
// ----------------------------------------------------------

class HybridClassifier {
  /**
   * @param {object} serverConfig - server.json config
   * @param {object} providerRegistry - ProviderRegistry instance
   */
  constructor(serverConfig, providerRegistry) {
    this.config = serverConfig;
    this.registry = providerRegistry;
    this.threshold = serverConfig.classifier?.ruleConfidenceThreshold ?? 0.7;
    this.cache = new ClassificationCache(
      (serverConfig.classifier?.cacheHours ?? 1) * 3600000
    );

    // Resolve the classifier model
    const classifierModelId = serverConfig.classifier?.llmClassifierModel || "deepseek-chat";
    this.classifierModel = providerRegistry.getModel(classifierModelId);
    this.classifierProvider = this.classifierModel
      ? providerRegistry.getProvider(classifierModelId)
      : null;
  }

  /**
   * Classify a request. Returns classification result.
   * @param {object} requestBody - Full Anthropic-format request body
   * @returns {Promise<object>} ClassificationResult
   */
  async classify(requestBody) {
    // Check cache first
    const cached = this.cache.get(requestBody);
    if (cached) {
      return { ...cached, cached: true };
    }

    // Stage 1: Rule-based (always runs, synchronous, free)
    const ruleResult = rules.classify(requestBody);

    if (ruleResult.confidence >= this.threshold) {
      this.cache.set(requestBody, ruleResult);
      return ruleResult;
    }

    // Stage 2: LLM fallback (runs only if rules were uncertain)
    if (this.classifierProvider && this.classifierModel) {
      try {
        // We need to call the classifier model via its provider
        // The doChat function handles the actual HTTP call
        const doChat = async (provider, nativePayload) => {
          const axios = require("axios");
          // Determine URL based on provider
          const url = provider.getNonStreamingUrl
            ? provider.getNonStreamingUrl()
            : provider.getApiUrl();
          const resp = await axios.post(url, nativePayload, {
            headers: provider.getHeaders(),
          });
          return resp.data;
        };

        const llmResult = await classifyWithLLM(
          requestBody,
          this.classifierProvider,
          this.classifierModel,
          doChat
        );

        this.cache.set(requestBody, llmResult);
        return llmResult;
      } catch (err) {
        console.warn(`LLM classifier failed (${err.message}), falling back to rule result`);
        this.cache.set(requestBody, ruleResult);
        return ruleResult;
      }
    }

    // No LLM classifier available — return rule result even if uncertain
    console.warn("LLM classifier not available — using rule-based result with low confidence");
    this.cache.set(requestBody, ruleResult);
    return ruleResult;
  }
}

module.exports = HybridClassifier;
