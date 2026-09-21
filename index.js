require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const ProviderRegistry = require("./lib/providers");
const HybridClassifier = require("./lib/classifier");
const { selectModel } = require("./lib/router");
const { toPublicShape } = require("./lib/classifier/taxonomy");
const { getLastUserMessage, extractSystemText } = require("./lib/classifier/text-utils");
const metrics = require("./lib/metrics");
const prefs = require("./lib/prefs");
const { runEvalSet } = require("./lib/eval");
const { maybeCompact } = require("./lib/compaction");

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
  const pricingPath = path.join(__dirname, "config", "pricing.json");

  if (!fs.existsSync(modelsPath)) {
    console.error("ERROR: config/models.json not found");
    process.exit(1);
  }

  const modelsConfig = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  const serverConfig = fs.existsSync(serverPath)
    ? JSON.parse(fs.readFileSync(serverPath, "utf8"))
    : {};

  // Pricing is the single source of truth for cost math. Apply it
  // over the per-model `cost` fields; models.json only acts as a
  // fallback for models missing from pricing.json.
  let pricingConfig = null;
  if (fs.existsSync(pricingPath)) {
    pricingConfig = JSON.parse(fs.readFileSync(pricingPath, "utf8"));
    for (const model of modelsConfig.models || []) {
      const price = pricingConfig.models?.[model.id];
      if (price) {
        model.cost = {
          inputPer1M: price.inputPer1M,
          outputPer1M: price.outputPer1M,
          ...(price.peakMultiplier ? { peakMultiplier: price.peakMultiplier } : {}),
          // Cache pricing. OpenAI-style providers (DeepSeek/OpenAI):
          // cache HITS bill at a discounted input rate; misses at the
          // full input rate; no write premium. Anthropic: reads/writes
          // priced via multipliers on the base input rate.
          ...(price.cacheHitInputPer1M ? { cacheHitInputPer1M: price.cacheHitInputPer1M } : {}),
          ...(price.cacheReadMultiplier
            ? {
                cacheReadInputPer1M:
                  Math.round(price.inputPer1M * price.cacheReadMultiplier * 1e6) / 1e6,
                cacheWriteInputPer1M:
                  Math.round(price.inputPer1M * price.cacheWriteMultiplier * 1e6) / 1e6,
              }
            : {}),
        };
      }
    }
  }

  return { modelsConfig, serverConfig, pricingConfig };
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
const { modelsConfig, serverConfig, pricingConfig } = loadConfig();
const registry = new ProviderRegistry(modelsConfig, serverConfig);

// Metrics need pricing for the fixed-model baseline comparison.
if (pricingConfig) metrics.setPricing(pricingConfig);

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
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;

  // input_tokens is normalized to the FULL-rate remainder only
  // (see converter.normalizeUsage). Cache reads price at the
  // discounted rate; writes at the premium (Anthropic only —
  // OpenAI-style providers' "creation" = misses already billed
  // at full rate inside input_tokens, so their write price is 0).
  const inputCost = input * (model.cost.inputPer1M / 1e6);
  const outputCost = output * (model.cost.outputPer1M / 1e6);
  const readCost = read * (
    (model.cost.cacheReadInputPer1M ?? model.cost.cacheHitInputPer1M ?? model.cost.inputPer1M) / 1e6
  );
  const writeCost = write * ((model.cost.cacheWriteInputPer1M ?? 0) / 1e6);
  return Math.round((inputCost + outputCost + readCost + writeCost) * 1e6) / 1e6; // USD, 6 dp
}

/**
 * DEBUG breakdown — tokens and cost for one request, split into
 * user vs system input. The system prompt is re-injected before
 * the provider call, so its tokens ARE billed as input.
 *
 * NOTE: providers report ONE input-token total. The user/system
 * split here is estimated from character counts (~3.5 chars/token).
 */
function logCostBreakdown({ systemText, tools, messages, servingAttempt, classifierCost, stream, compaction }) {
  const usage = servingAttempt?.usage || null;

  if (!usage || (!usage.input_tokens && !usage.output_tokens)) {
    // No provider call (e.g. /v1/classify) — report the classifier cost alone.
    if (classifierCost?.costUsd) {
      console.log(
        `💰 classifier-only call: ${classifierCost.inputTokens} in / ${classifierCost.outputTokens} out = ` +
        `$${classifierCost.costUsd.toFixed(6)} (${classifierCost.model})`
      );
    } else if (stream) {
      console.log(`💰 tokens: streaming — usage unavailable from provider`);
    } else {
      console.log("💰 tokens: none reported");
    }
    return;
  }

  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  // The compacted summary sits inside the system prompt — keep the
  // debug user/system split honest by excluding it.
  const summaryChars = compaction?.summaryCharLen || 0;
  const estSysTokens = Math.max(0, Math.ceil(((systemText?.length || 0) - summaryChars) / 3.5));
  const estUserTokens = Math.max(0, input - estSysTokens);
  // Tool/message payload size — for tool-heavy clients this dwarfs the
  // system prompt and is otherwise invisible in this log.
  const toolsChars = tools ? JSON.stringify(tools).length : 0;
  const messagesChars = messages ? JSON.stringify(messages).length : 0;
  const estToolTokens = Math.ceil(toolsChars / 3.5);
  const estMsgTokens = Math.ceil(messagesChars / 3.5);

  const providerCost = servingAttempt?.costUsd || 0;
  const clsCost = classifierCost?.costUsd || 0;
  const compactionCostUsd = compaction?.costUsd || 0;
  const actual = providerCost + clsCost + compactionCostUsd;

  // Hypothetical: the SAME token bundle (plain + cache) priced on
  // each baseline model at its own cache rates (fair comparison).
  const hypo = (pricingConfig?.baselines || [])
    .map((b) => {
      const p = pricingConfig?.models?.[b.modelId];
      if (!p) return `${b.label}=?`;
      const cost = metrics.hypotheticalCost(p, usage);
      return `${b.label}=$${cost.toFixed(6)}`;
    })
    .join(", ");

  console.log(
    `💰 tokens: user≈${estUserTokens} + system≈${estSysTokens} (${systemText?.length || 0} chars)` +
    (estToolTokens ? ` + tools≈${estToolTokens} (${toolsChars} chars)` : "") +
    (estMsgTokens ? ` + history≈${estMsgTokens} (${messagesChars} chars)` : "") +
    ` in / ${output} out`
  );
  console.log(
    `   cost: providers $${providerCost.toFixed(6)} + classifier $${clsCost.toFixed(6)}` +
    (compactionCostUsd ? ` + compaction $${compactionCostUsd.toFixed(6)}` : "") +
    ` = $${actual.toFixed(6)}` +
    (hypo ? ` | hypothetical: ${hypo}` : "") +
    (clsCost ? ` | classifier: ${classifierCost.inputTokens} in / ${classifierCost.outputTokens} out` : "") +
    ` | cache: read=${usage.cache_read_input_tokens || 0} write=${usage.cache_creation_input_tokens || 0}`
  );
}

// ============================================================
// Route handler helper: call a single provider
// ============================================================

async function callProvider(provider, nativePayload, stream, res, modelId, extraResponseFields) {
  // NOTE: a TEMP DEBUG block here dumped every outgoing payload to
  // system.txt. Removed 2026-09-21 after it leaked API keys into a
  // commit (blocked by GitHub secret scanning).

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

    // Provider streamResponse resolves with { input_tokens, output_tokens }
    // when the provider exposes usage (Anthropic natively, DeepSeek/OpenAI
    // via include_usage, Gemini via usageMetadata).
    const usage = await provider.streamResponse(response.data, res, modelId);
    return { streamed: true, usage }; // stream handled, response sent
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
    // Non-streaming responses can carry bookkeeping in-band when
    // debug was requested (classification + compaction).
    if (extraResponseFields?.classification) {
      converted._classification = extraResponseFields.classification;
    }
    if (extraResponseFields?.compaction) {
      converted._compaction = extraResponseFields.compaction;
    }
    res.json(converted);
    return converted; // includes usage, used for cost accounting
  }
}

/**
 * Pull a readable error message out of a failed provider call.
 * Streaming requests use responseType "stream", so error bodies arrive
 * as a Node stream — read it rather than stringify the stream object
 * (which produced unreadable "_writeState" dumps in the logs).
 */
async function extractErrorDetail(err) {
  try {
    const data = err?.response?.data;
    if (data && typeof data.on === "function") {
      let chunks = "";
      for await (const chunk of data) chunks += chunk;
      try {
        const parsed = JSON.parse(chunks);
        return parsed?.error?.message || parsed?.message || chunks.slice(0, 300);
      } catch (_) {
        return chunks.slice(0, 300);
      }
    }
    if (data?.error?.message) return data.error.message;
    if (data?.message) return data.message;
    if (typeof data === "string") return data.slice(0, 300);
    if (data) return JSON.stringify(data).slice(0, 300);
  } catch (_) {
    /* fall through to err.message */
  }
  return err?.message || "unknown error";
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
      classifierCost: classification.metadata?.classifierCost || null,
      route: null,
      providerResult: null,
    });

    // DEBUG: classifier-only cost breakdown.
    logCostBreakdown({
      systemText: extractSystemText(req.body.system),
      tools: req.body.tools,
      messages: req.body.messages,
      servingAttempt: null,
      classifierCost: classification.metadata?.classifierCost || null,
      stream: false,
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
      // Header wins; otherwise the dashboard-configured default.
      const routingMode = (
        req.headers["x-routing-mode"] || prefs.getRoutingMode() || "cheap"
      ).toLowerCase();
      const validModes = ["cheap", "fast", "balanced", "quality"];
      const effectiveMode = validModes.includes(routingMode) ? routingMode : "cheap";

      routeResult = selectModel(
        classification, registry, serverConfig.router, null,
        effectiveMode, prefs.getDisabledModels()
      );
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

    // --- Step 2.5: Rolling prompt compaction (context-budget guard) ---
    // Runs before the native payload is built so the fallback chain
    // (which spreads req.body) reuses the compacted body, and so an
    // injected cache breakpoint lands on the final system block (the
    // frozen summary when present). On failure the request proceeds
    // uncompacted.
    let compactionResult = null;
    let compactionCost = null;
    if (serverConfig.compaction?.enabled !== false) {
      try {
        compactionResult = await maybeCompact(req.body, { serverConfig, registry, selectedModel });
        if (compactionResult) {
          compactionCost = compactionResult.costUsd != null
            ? {
                model: serverConfig.compaction?.model || "deepseek-flash",
                costUsd: compactionResult.costUsd,
              }
            : null;
          console.log(
            `  ✂️ compaction: dropped ${compactionResult.droppedCount} msgs, ` +
            `${compactionResult.tokensBefore}→${compactionResult.tokensAfter} tokens est. ` +
            `(${compactionResult.reused ? "reused summary" : "new summary"}` +
            (compactionCost ? `, $${compactionCost.costUsd.toFixed(6)}` : "") + `)`
          );
          metrics.recordCompaction(compactionResult, compactionCost);
        }
      } catch (err) {
        console.warn(`[compaction] skipped: ${err.message}`);
      }
    }

    // --- Step 3: Build native request ---
    const extraResponseFields = {
      classification: classificationPayloadForResponse,
      compaction: debug && compactionResult ? compactionResult : null,
    };
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
      const converted = await callProvider(provider, nativePayload, stream, res, selectedModel.id, extraResponseFields);
      recordAttempt(selectedModel, callStart, converted, true);
    } catch (providerErr) {
      recordAttempt(selectedModel, callStart, null, false);
      // Primary provider failed — try fallback chain
      const fallbackChain = serverConfig.router?.providerFallbackChain || [];
      const apiErrMsg = await extractErrorDetail(providerErr);
      console.warn(
        `Provider ${selectedModel.provider} failed: ${providerErr.message}` +
        (apiErrMsg && apiErrMsg !== providerErr.message ? ` — ${apiErrMsg}` : "")
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

          const fbConverted = await callProvider(fallbackProvider, fallbackPayload, stream, res, fallbackModel.id, extraResponseFields);
          recordAttempt(fallbackModel, callStart, fbConverted, true);
          fallbackSuccess = true;
          break;
        } catch (fbErr) {
          recordAttempt(fallbackModel, callStart, null, false);
        }
      }

      if (!fallbackSuccess && !res.headersSent) {
        const errStatus = providerErr.response?.status || 502;
        const errMsg = await extractErrorDetail(providerErr);

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
        classifierCost: classification.metadata?.classifierCost || null,
        route: routeResult,
        providerFallbacks: fallbacksUsed,
        providerResult: servingAttempt,
        compaction: compactionResult,
      });

      // DEBUG: token + cost breakdown for this request.
      logCostBreakdown({
        systemText: extractSystemText(req.body.system),
        tools: req.body.tools,
        messages: req.body.messages,
        servingAttempt,
        classifierCost: classification.metadata?.classifierCost || null,
        stream,
        compaction: compactionResult,
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
  // ?global=1 also wipes the persisted all-time counter.
  if (req.query.global === "1") metrics.resetGlobal();
  res.json({ ok: true });
});

// Run the labeled eval set (config/eval-prompts.json) through the
// real classifier and store the accuracy summary for the dashboard.
app.post("/metrics/eval", async (req, res) => {
  try {
    const summary = await runEvalSet(
      classifier,
      path.join(__dirname, "config", "eval-prompts.json")
    );
    metrics.recordEvalRun(summary);
    res.json(summary);
  } catch (err) {
    console.error("Eval run failed:", err.message);
    res.status(500).json({ type: "error", error: { type: "api_error", message: err.message } });
  }
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
        modes[demoIdx % modes.length], prefs.getDisabledModels()
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
        demo: true, // simulated — excluded from the persisted global counter
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
// Dashboard config endpoints — model selection + routing mode
// Consumed by the Next.js dashboard; prefs persist in data/.
// ============================================================

function dashboardCatalog() {
  // Static display data: router policy + benchmark report (may not exist).
  let policy = null;
  let benchmark = null;
  try {
    policy = JSON.parse(
      fs.readFileSync(path.join(__dirname, "config", "router-policy.json"), "utf8")
    );
  } catch (_) {}
  try {
    benchmark = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "benchmark", "data", "report", "report.json"),
        "utf8"
      )
    );
  } catch (_) {}

  // All configured models, with provider availability. Unavailable
  // providers (missing API key) can't serve traffic, so they read as
  // disabled in the UI even though they aren't in the prefs file.
  const models = Array.from(registry.models.values()).map((m) => ({
    id: m.id,
    provider: m.provider,
    apiModelId: m.apiModelId,
    cost: m.cost,
    capabilities: m.capabilities,
    profile: m.profile,
    available: !!registry.getProvider(m.id),
    enabled: !!registry.getProvider(m.id) && prefs.isModelEnabled(m.id),
  }));

  return {
    models,
    prefs: {
      routingMode: prefs.getRoutingMode(),
      disabledModels: prefs.getDisabledModels(),
    },
    routingModes: prefs.VALID_MODES,
    policy,
    benchmark,
  };
}

app.get("/config/dashboard", (req, res) => {
  res.json(dashboardCatalog());
});

// Toggle a model in/out of the auto-routing candidate pool.
app.post("/config/models", (req, res) => {
  const { id, enabled } = req.body || {};
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return res
      .status(400)
      .json({ ok: false, error: "Body needs { id: string, enabled: boolean }" });
  }
  if (!registry.getModel(id)) {
    return res.status(404).json({ ok: false, error: `Unknown model "${id}"` });
  }
  const availableIds = registry
    .getAllModels()
    .map((m) => m.id);
  const result = prefs.setModelEnabled(id, enabled, availableIds);
  if (!result.ok) {
    return res.status(400).json(result);
  }
  res.json({ ok: true, catalog: dashboardCatalog() });
});

// Set the default routing mode (cheap | fast | balanced | quality).
app.post("/config/routing", (req, res) => {
  const { mode } = req.body || {};
  const updated = prefs.setRoutingMode(mode);
  if (updated === null) {
    return res.status(400).json({
      ok: false,
      error: `mode must be one of: ${prefs.VALID_MODES.join(", ")}`,
    });
  }
  res.json({ ok: true, routingMode: updated });
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
  console.log(`   GET  /config/dashboard — Model catalog + routing prefs`);
  console.log(`   POST /config/models  — Enable/disable a model`);
  console.log(`   POST /config/routing — Set default routing mode`);
  console.log(`   POST /metrics/eval   — Run classifier eval set`);
  console.log(`   GET  /health         — Server status\n`);
});
