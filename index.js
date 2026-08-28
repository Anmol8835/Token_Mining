require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const ProviderRegistry = require("./lib/providers");
const HybridClassifier = require("./lib/classifier");
const { selectModel } = require("./lib/router");
const { toPublicShape } = require("./lib/classifier/taxonomy");
const { getLastUserMessage } = require("./lib/classifier/text-utils");
const metrics = require("./lib/metrics");

// ------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------

/**
 * Render a classification for API consumers.
 * - debug=false: the exact public shape (for /v1/classify body + header)
 * - debug=true : the exact public shape plus a `_classification`
 *   bookkeeping object (source/cache/metadata) — this is what gets
 *   merged into /v1/messages responses.
 */
function classificationPayload(classification, debug) {
  const payload = toPublicShape(classification);
  if (debug) {
    payload._classification = {
      source: classification.source,
      cached: !!classification.cached,
      metadata: classification.metadata,
    };
  }
  return payload;
}

/**
 * Attach the classification to a response. Header is always set;
 * returns the object to merge into a non-streaming JSON body.
 */
function attachClassification(res, classification, debug) {
  const payload = classificationPayload(classification, debug);
  try {
    res.setHeader("X-Classification", JSON.stringify(payload));
  } catch (err) {
    console.warn(`[classify] Could not set X-Classification header: ${err.message}`);
  }
  return payload;
}

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

// Dashboard — served from public/
app.use(express.static(path.join(__dirname, "public")));

// Load configs and initialize
const { modelsConfig, serverConfig } = loadConfig();
const registry = new ProviderRegistry(modelsConfig, serverConfig);

if (registry.getAllModels().length === 0) {
  console.error("ERROR: No models available. Check your API keys and config/models.json");
  process.exit(1);
}

const classifier = new HybridClassifier(serverConfig, registry);


// ------------------------------------------------------------
// Cost estimation from token usage and model pricing
// ------------------------------------------------------------
function costFor(model, usage) {
  if (!model?.cost || !usage) return null;
  const inputCost = (usage.input_tokens || 0) * (model.cost.inputPer1M / 1e6);
  const outputCost = (usage.output_tokens || 0) * (model.cost.outputPer1M / 1e6);
  return Math.round((inputCost + outputCost) * 1e6) / 1e6; // USD, 6 dp
}

// ============================================================
// Route handler helper: call a single provider
// ============================================================

async function callProvider(provider, nativePayload, stream, res, modelId, extraResponseFields) {
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
    return { streamed: true }; // stream handled, response sent
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

    const converted = provider.convertResponse(response.data, modelId);
    // Non-streaming responses can carry the classification in-band
    // when debug was requested.
    if (extraResponseFields) {
      converted._classification = extraResponseFields;
    }
    res.json(converted);
    return converted; // includes usage, used for cost accounting
  }
}

// ============================================================
// POST /v1/classify — pure classification endpoint
//
// Returns ONLY the classification JSON. Never answers the prompt.
// ============================================================

app.post("/v1/classify", async (req, res) => {
  const startTime = Date.now();
  try {
    const debug = req.query.debug === "1" || req.headers["x-debug"] === "1";

    // Strip system prompt during classification — classifiers should
    // judge user intent, not the system role.
    const classBody = { ...req.body, system: undefined };
    const classification = await classifier.classify(classBody);

    metrics.record({
      prompt: getLastUserMessage(req.body.messages),
      classification,
      classifierMs: Date.now() - startTime,
      route: null,
      providerResult: null,
    });

    res.setHeader("X-Classification", JSON.stringify(toPublicShape(classification)));
    res.json(classificationPayload(classification, debug));
  } catch (err) {
    console.error("Classify error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: "error",
        error: { type: "api_error", message: err.message },
      });
    }
  }
});

// ============================================================
// POST /v1/messages
// ============================================================

app.post("/v1/messages", async (req, res) => {
  const startTime = Date.now();
  const promptText = getLastUserMessage(req.body.messages).replace(/\s+/g, " ").trim();
  console.log(`▶ prompt: ${promptText.slice(0, 160) || "(empty)"}`);
  try {
    const modelName = req.body.model || "auto";
    const mode = serverConfig.classifier?.mode || "auto";
    const stream = !!req.body.stream;
    const debug =
      req.query.debug === "1" ||
      req.headers["x-debug"] === "1" ||
      req.body.debug === true;

    let selectedModel;
    let classification = null;
    let classificationPayloadForResponse = null;
    let routeResult = null;
    let classifierMs = 0;

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
      // Strip system prompt during classification — classifiers should
      // judge user intent, not the system role. Re-injected at buildRequest.
      const classBody = { ...req.body, system: undefined };
      const classStart = Date.now();
      classification = await classifier.classify(classBody);
      classifierMs = Date.now() - classStart;

      // Parse routing mode from header (cost-reduction aware)
      // X-Routing-Mode: cheap | fast | balanced | quality
      const routingMode = (req.headers["x-routing-mode"] || "cheap").toLowerCase();
      const validModes = ["cheap", "fast", "balanced", "quality"];
      const effectiveMode = validModes.includes(routingMode) ? routingMode : "cheap";

      routeResult = selectModel(classification, registry, serverConfig.router, null, effectiveMode);
      selectedModel = routeResult.model;

      // Surface the classification: always as a header, and in the
      // response body when debug is requested (non-streaming only).
      classificationPayloadForResponse = attachClassification(
        res, classification, debug
      );
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

    // --- Step 4: Call provider with fallback ---
    const providerAttempts = [];
    const recordAttempt = (model, attemptStart, converted, ok) => {
      const latencyMs = Date.now() - attemptStart;
      providerAttempts.push({
        modelId: model.id,
        latencyMs,
        usage: converted?.usage || null,
        costUsd: costFor(model, converted?.usage),
        ok,
      });
      return latencyMs;
    };

    let fallbacksUsed = 0;
    let callStart = Date.now();
    try {
      const converted = await callProvider(provider, nativePayload, stream, res, selectedModel.id, classificationPayloadForResponse);
      recordAttempt(selectedModel, callStart, converted, true);
    } catch (providerErr) {
      recordAttempt(selectedModel, callStart, null, false);
      // Primary provider failed — try fallback chain
      const fallbackChain = serverConfig.router?.providerFallbackChain || [];
      const apiErrMsg =
        providerErr.response?.data?.error?.message ||
        providerErr.response?.data?.message ||
        providerErr.response?.data ||
        providerErr.message;
      console.warn(
        `Provider ${selectedModel.provider} failed: ${providerErr.message}` +
        (apiErrMsg && apiErrMsg !== providerErr.message
          ? ` — ${typeof apiErrMsg === "string" ? apiErrMsg : JSON.stringify(apiErrMsg).slice(0, 300)}`
          : "")
      );

      let fallbackSuccess = false;
      for (const fallbackModelId of fallbackChain) {
        if (fallbackModelId === selectedModel.id) continue; // skip the one that just failed
        if (res.headersSent) break;

        const fallbackModel = registry.getModel(fallbackModelId);
        const fallbackProvider = fallbackModel
          ? registry.getProvider(fallbackModelId)
          : null;

        if (!fallbackModel || !fallbackProvider) continue;

        fallbacksUsed++;
        callStart = Date.now();
        try {
          const fallbackPayload = fallbackProvider.buildRequest({
            ...req.body,
            model: fallbackModel.apiModelId,
          });

          const fbConverted = await callProvider(fallbackProvider, fallbackPayload, stream, res, fallbackModel.id, classificationPayloadForResponse);
          recordAttempt(fallbackModel, callStart, fbConverted, true);
          fallbackSuccess = true;
          break;
        } catch (fbErr) {
          recordAttempt(fallbackModel, callStart, null, false);
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

    // --- Metrics: one record per request ---
    if (classification) {
      const servingAttempt =
        providerAttempts.find((a) => a.ok) || providerAttempts[0] || null;
      metrics.record({
        prompt: getLastUserMessage(req.body.messages),
        classification,
        classifierMs,
        route: routeResult,
        providerFallbacks: fallbacksUsed,
        providerResult: servingAttempt,
      });
    }

    // Log timing
    const elapsed = Date.now() - startTime;
    console.log(`  ⏱ ${elapsed}ms total`);
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
// Metrics endpoints — consumed by the dashboard in public/
// ============================================================

app.get("/metrics", (req, res) => {
  res.json(metrics.snapshot());
});

app.post("/metrics/reset", (req, res) => {
  metrics.reset();
  res.json({ ok: true });
});

// Generate a burst of representative traffic through the REAL
// classifier + router (no provider calls) so the dashboard can be
// evaluated without hammering the APIs.
app.post("/metrics/demo", async (req, res) => {
  const DEMO_PROMPTS = [
    "hi",
    "What is the current stock price of NVDA right now?",
    "Debug this race condition in my Go worker pool, it deadlocks under load",
    "Solve the integral of x^2 sin(x) dx",
    "Summarize this article in 3 bullet points",
    "Act as a lawyer and explain whether my landlord can keep my security deposit",
    "Translate this to French: good morning",
    "Write a React component that renders a paginated table",
    "Research the latest approaches to RAG and write me a report with citations",
    "What dosage of ibuprofen should I take for my 6 year old?",
    "Review this Express middleware for security issues",
    "Brainstorm 15 name ideas for a coffee subscription box",
  ];

  try {
    const modes = ["cheap", "fast", "balanced", "quality"];
    let demoIdx = 0;
    for (const prompt of DEMO_PROMPTS) {
      const t0 = Date.now();
      const classification = await classifier.classify({
        messages: [{ role: "user", content: prompt }],
      });
      const classifierMs = Date.now() - t0;

      const route = selectModel(
        classification, registry, serverConfig.router, null,
        modes[demoIdx % modes.length]
      );
      demoIdx++;

      // Simulated provider result — realistic latency and token shapes
      const promptLen = prompt.length;
      const model = route.model;
      const usage = {
        input_tokens: 40 + promptLen * 3,
        output_tokens: 30 + promptLen * 4,
      };
      metrics.record({
        prompt,
        classification,
        classifierMs,
        route,
        providerFallbacks: 0,
        providerResult: {
          modelId: model.id,
          latencyMs: 200 + (promptLen % 9) * 120,
          usage,
          costUsd: costFor(model, usage),
          ok: true,
        },
      });
    }
    res.json({ ok: true, demoed: DEMO_PROMPTS.length });
  } catch (err) {
    console.error("Demo generation failed:", err.message);
    res.status(500).json({ type: "error", error: { type: "api_error", message: err.message } });
  }
});

// ============================================================
// Start
// ============================================================

app.listen(PORT, () => {
  console.log(`\n🚀 LLM Proxy Server running on http://localhost:${PORT}`);
  console.log(`   POST /v1/messages    — Anthropic-format API`);
  console.log(`   POST /v1/classify    — Prompt classification (JSON only)`);
  console.log(`   GET  /               — Routing metrics dashboard`);
  console.log(`   GET  /metrics        — Metrics JSON`);
  console.log(`   GET  /health         — Server status\n`);
});
