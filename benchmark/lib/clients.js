// ============================================================
// Benchmark clients
//
//   callTierDirect   — in-process provider calls (cheap/middle/
//                      flagship baselines). The proxy ignores an
//                      explicit model in auto mode, so baselines
//                      bypass it and reuse the proxy's own
//                      provider classes + converters.
//   callRouterViaProxy — HTTP to localhost:8002, X-Routing-Mode
//                      cheap, ?debug=1 for classifier cost.
// ============================================================

require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });

const axios = require("axios");
const path = require("path");
const ProviderRegistry = require("../../lib/providers");
const { costFor } = require("./cost");

const PROXY_URL = process.env.BENCHMARK_PROXY_URL || "http://localhost:8002";

let _registry = null;
function registry() {
  if (!_registry) {
    _registry = new ProviderRegistry(
      require("../../config/models.json"),
      require("../../config/server.json")
    );
  }
  return _registry;
}

/** Resolve tier model ids, with availability fallbacks. */
function resolveTiers(opts = {}) {
  const reg = registry();
  const active = new Set(reg.getAllModels().map((m) => m.id));
  const pick = (id, fallback) => (active.has(id) ? id : active.has(fallback) ? fallback : null);

  return {
    cheap: opts.cheap ?? pick("deepseek-flash"),
    middle: opts.middle ?? pick("deepseek-v4-pro"),
    flagship: opts.flagship ?? pick("claude-opus-4-8", "deepseek-v4-pro"),
  };
}

/** Extract text from a converted (Anthropic-format) response. */
function answerText(response) {
  if (!response?.content) return "";
  if (typeof response.content === "string") return response.content;
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function withRetry(fn, { retries = 2, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = status === 429 || status >= 500 || !status;
      if (!retryable || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Direct provider call, reusing the proxy's provider classes.
 * @returns {{modelId, answer, usage, latencyMs, costUsd}}
 */
async function callTierDirect(modelId, prompt, opts = {}) {
  const reg = registry();
  const model = reg.getModel(modelId);
  const provider = reg.getProvider(modelId);
  if (!model || !provider) {
    throw new Error(`model ${modelId} not available`);
  }

  const t0 = Date.now();
  const nativePayload = provider.buildRequest({
    model: model.apiModelId,
    messages: [{ role: "user", content: prompt }],
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0,
    stream: false,
    // Optional DeepSeek thinking-mode override; other providers ignore it.
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
  });

  const nativeResp = await withRetry(async () => {
    const resp = await axios.post(
      provider.getNonStreamingUrl ? provider.getNonStreamingUrl() : provider.getApiUrl(),
      nativePayload,
      { headers: provider.getHeaders(), timeout: 300000 }
    );
    return resp.data;
  });

  const converted = provider.convertResponse(nativeResp, model.id);
  return {
    modelId: model.id,
    answer: answerText(converted),
    usage: converted.usage || null,
    latencyMs: Date.now() - t0,
    costUsd: costFor(converted.usage, model.id),
  };
}

/**
 * Router path through the live proxy.
 * @returns {{modelId, answer, usage, latencyMs, costUsd, classification, classifierCostUsd}}
 */
async function callRouterViaProxy(prompt, opts = {}) {
  const t0 = Date.now();
  const resp = await axios.post(
    `${PROXY_URL}/v1/messages?debug=1`,
    {
      model: "auto",
      messages: [{ role: "user", content: prompt }],
      max_tokens: opts.maxTokens ?? 4096,
      temperature: 0,
      stream: false,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Routing-Mode": opts.mode ?? "cheap",
      },
      timeout: 300000,
    }
  );

  const body = resp.data;
  const classificationHeader = resp.headers["x-classification"];
  let classification = null;
  if (classificationHeader) {
    try {
      classification = JSON.parse(classificationHeader);
    } catch (_) {}
  }

  return {
    modelId: body.model || null,
    answer: answerText(body),
    usage: body.usage || null,
    latencyMs: Date.now() - t0,
    costUsd: costFor(body.usage, body.model),
    classification,
    classifierCostUsd:
      body._classification?.metadata?.classifierCost?.costUsd ?? null,
  };
}

module.exports = { registry, resolveTiers, answerText, callTierDirect, callRouterViaProxy, PROXY_URL };
