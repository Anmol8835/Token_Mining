require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const ProviderRegistry = require("./lib/providers");
const HybridClassifier = require("./lib/classifier");
const { selectModel } = require("./lib/router");

// ============================================================
// Config loading
// ============================================================

function loadConfig() {
  const modelsPath = path.join(__dirname, "config", "models.json");
  const serverPath = path.join(__dirname, "config", "server.json");

  if (!fs.existsSync(modelsPath)) {
    console.error("ERROR: config/models.json not found");
    process.exit(1);
  }

  const modelsConfig = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  const serverConfig = fs.existsSync(serverPath)
    ? JSON.parse(fs.readFileSync(serverPath, "utf8"))
    : {};

  return { modelsConfig, serverConfig };
}

// ============================================================
// Server setup
// ============================================================

const app = express();
const PORT = process.env.PORT || 8002;

app.use(express.json({ limit: "50mb" }));

// Load configs and initialize
const { modelsConfig, serverConfig } = loadConfig();
const registry = new ProviderRegistry(modelsConfig, serverConfig);

if (registry.getAllModels().length === 0) {
  console.error("ERROR: No models available. Check your API keys and config/models.json");
  process.exit(1);
}

const classifier = new HybridClassifier(serverConfig, registry);

console.log(`Classifier mode: ${serverConfig.classifier?.mode || "auto"}`);
console.log(`Router fallback: ${serverConfig.router?.fallbackModel || "deepseek-chat"}`);

// ============================================================
// Route handler helper: call a single provider
// ============================================================

async function callProvider(provider, nativePayload, stream, res, modelId) {
  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Determine URL — Gemini uses stream-specific URL
    let url;
    if (provider.getStreamUrl) {
      url = provider.getStreamUrl();
    } else if (provider.getApiUrl) {
      url = provider.getApiUrl();
    } else {
      throw new Error("Provider has no getApiUrl or getStreamUrl method");
    }

    const response = await axios.post(url, nativePayload, {
      headers: provider.getHeaders(),
      responseType: "stream",
      timeout: 300000,
    });

    await provider.streamResponse(response.data, res, modelId);
    return true; // stream handled, response sent
  } else {
    let url;
    if (provider.getNonStreamingUrl) {
      url = provider.getNonStreamingUrl();
    } else {
      url = provider.getApiUrl();
    }

    const response = await axios.post(url, nativePayload, {
      headers: provider.getHeaders(),
      timeout: 300000,
    });

    res.json(provider.convertResponse(response.data, modelId));
    return true;
  }
}

// ============================================================
// POST /v1/messages
// ============================================================

app.post("/v1/messages", async (req, res) => {
  const startTime = Date.now();

  try {
    const modelName = req.body.model || "auto";
    const mode = serverConfig.classifier?.mode || "auto";
    const stream = !!req.body.stream;

    let selectedModel;
    let classification = null;

    // --- Step 1: Model selection ---
    const isExplicit = modelName && modelName !== "auto" && mode !== "auto";
    if (isExplicit) {
      // User specified a model — try to use it directly
      selectedModel = registry.lookup(modelName);
      if (!selectedModel) {
        console.warn(`Unknown model "${modelName}", falling back to auto-routing`);
      }
    }

    if (!selectedModel) {
      // Auto mode: classify + route
      classification = await classifier.classify(req.body);
      const result = selectModel(classification, registry, serverConfig.router, null);
      selectedModel = result.model;
      console.log(`[classify] ${result.reason} (source: ${classification.source}, confidence: ${classification.confidence.toFixed(2)})`);
    }

    // --- Step 2: Get provider ---
    const provider = registry.getProvider(selectedModel.id);
    if (!provider) {
      return res.status(500).json({
        type: "error",
        error: {
          type: "api_error",
          message: `Provider not available for model "${selectedModel.id}"`,
        },
      });
    }

    // --- Step 3: Build native request ---
    const nativePayload = provider.buildRequest({
      ...req.body,
      model: selectedModel.apiModelId,
    });

    console.log(
      `-> ${selectedModel.provider}/${selectedModel.id} stream=${stream}, ` +
      `${nativePayload.messages?.length || req.body.messages?.length || "?"} messages`
    );

    // --- Step 4: Call provider with fallback ---
    try {
      await callProvider(provider, nativePayload, stream, res, selectedModel.id);
    } catch (providerErr) {
      // Primary provider failed — try fallback chain
      const fallbackChain = serverConfig.router?.providerFallbackChain || [];
      console.warn(`Provider ${selectedModel.provider} failed: ${providerErr.message}`);

      let fallbackSuccess = false;
      for (const fallbackModelId of fallbackChain) {
        if (fallbackModelId === selectedModel.id) continue; // skip the one that just failed
        if (res.headersSent) break;

        const fallbackModel = registry.getModel(fallbackModelId);
        const fallbackProvider = fallbackModel
          ? registry.getProvider(fallbackModelId)
          : null;

        if (!fallbackModel || !fallbackProvider) continue;

        try {
          console.log(`  -> fallback: ${fallbackModel.provider}/${fallbackModel.id}`);

          const fallbackPayload = fallbackProvider.buildRequest({
            ...req.body,
            model: fallbackModel.apiModelId,
          });

          await callProvider(fallbackProvider, fallbackPayload, stream, res, fallbackModel.id);
          fallbackSuccess = true;
          break;
        } catch (fbErr) {
          console.warn(`  -> fallback ${fallbackModelId} also failed: ${fbErr.message}`);
        }
      }

      if (!fallbackSuccess && !res.headersSent) {
        const errStatus = providerErr.response?.status || 502;
        const errMsg = providerErr.response?.data?.error?.message
          || providerErr.response?.data
          || providerErr.message;

        res.status(errStatus).json({
          type: "error",
          error: {
            type: "api_error",
            message: `All providers failed. Last error: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)}`,
          },
        });
      }
    }

    // Log timing
    const elapsed = Date.now() - startTime;
    console.log(`<- ${selectedModel.id} [${elapsed}ms]`);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`Error [${elapsed}ms]:`, err.message);

    if (!res.headersSent) {
      res.status(500).json({
        type: "error",
        error: { type: "api_error", message: err.message },
      });
    } else {
      res.end();
    }
  }
});

// ============================================================
// Health check
// ============================================================

app.get("/health", (req, res) => {
  const models = registry.getAllModels();
  res.json({
    status: "ok",
    providers: [...new Set(models.map((m) => m.provider))],
    models: models.map((m) => ({ id: m.id, provider: m.provider })),
    classifierMode: serverConfig.classifier?.mode || "auto",
  });
});

// ============================================================
// Start
// ============================================================

app.listen(PORT, () => {
  console.log(`\n🚀 LLM Proxy Server running on http://localhost:${PORT}`);
  console.log(`   POST /v1/messages — Anthropic-format API`);
  console.log(`   GET  /health        — Server status\n`);
});
