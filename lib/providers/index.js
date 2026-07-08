// ============================================================
// Provider registry — loads models, instantiates providers
// ============================================================

const DeepSeekProvider = require("./deepseek");
const OpenAIProvider = require("./openai");
const AnthropicProvider = require("./anthropic");
const GeminiProvider = require("./gemini");

const PROVIDER_CLASSES = {
  deepseek: DeepSeekProvider,
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  gemini: GeminiProvider,
};

class ProviderRegistry {
  constructor(modelsConfig, serverConfig) {
    this.models = new Map();        // modelId -> modelConfig
    this.providers = new Map();     // providerName -> BaseProvider instance
    this.serverConfig = serverConfig;

    for (const model of modelsConfig.models) {
      this.models.set(model.id, model);

      if (!this.providers.has(model.provider)) {
        const ProviderClass = PROVIDER_CLASSES[model.provider];
        if (!ProviderClass) {
          console.warn(`Unknown provider "${model.provider}" for model "${model.id}" — skipping`);
          continue;
        }
        const instance = new ProviderClass(model);
        try {
          instance.validate();
          this.providers.set(model.provider, instance);
          console.log(`Provider "${model.provider}" initialized (${model.id})`);
        } catch (err) {
          console.warn(`Provider "${model.provider}" skipped: ${err.message}`);
        }
      }
    }

    const available = [...this.providers.keys()];
    console.log(`Available providers: ${available.length > 0 ? available.join(", ") : "(none)"}`);
    console.log(`Available models: ${this.models.size}`);
  }

  getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  getProvider(modelId) {
    const model = this.models.get(modelId);
    if (!model) return null;
    return this.providers.get(model.provider) || null;
  }

  getProviderByName(providerName) {
    return this.providers.get(providerName) || null;
  }

  /**
   * Return all models that match the given predicate.
   */
  filterModels(predicate) {
    return Array.from(this.models.values()).filter((m) => {
      // Only include models whose provider is available
      if (!this.providers.has(m.provider)) return false;
      return predicate(m);
    });
  }

  /**
   * Get all available models (with active providers).
   */
  getAllModels() {
    return this.filterModels(() => true);
  }

  /**
   * Look up a model by ID or find by provider name match.
   */
  lookup(requestedModel) {
    if (!requestedModel) return null;
    const direct = this.models.get(requestedModel);
    if (direct) return direct;

    // Try matching known aliases/prefixes
    const lower = requestedModel.toLowerCase();
    for (const [id, model] of this.models) {
      if (lower.includes(id.toLowerCase()) || id.toLowerCase().includes(lower)) {
        return model;
      }
    }
    // Try matching by provider
    for (const [id, model] of this.models) {
      if (lower.includes(model.provider)) {
        return model;
      }
    }
    return null;
  }
}

module.exports = ProviderRegistry;
