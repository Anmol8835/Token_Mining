require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const ProviderRegistry = require("./lib/providers");
const HybridClassifier = require("./lib/classifier");
const { selectModel } = require("./lib/router");
const { toPublicShape } = require("./lib/classifier/taxonomy");
const { getLastUserMessage, extractSystemText } = require("./lib/classifier/text-utils");
const metrics = require("./lib/metrics");
const prefs = require("./lib/prefs");
const userPrefs = require("./lib/user-prefs");
const apiKeys = require("./lib/api-keys");
const plans = require("./lib/plans");
const webhooks = require("./lib/webhooks");
const authApi = require("./lib/auth-api");
const authGoogle = require("./lib/auth-google");
const {
  META_TOOL_NAME,
  buildPrunedBody,
  resolveToolSearch,
  buildToolResultBlock,
} = require("./lib/tool-pruning");
const toolsRegistry = require("./lib/tools-registry");
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

// ------------------------------------------------------------
// API key auth — gates /v1/messages and /v1/classify
// ------------------------------------------------------------

/**
 * Pull a client key out of the request: `Authorization: Bearer <key>`
 * first (OpenAI/Anthropic convention), then `x-api-key`. Scheme is
 * case-insensitive per RFC 7235.
 */
function extractRawKey(req) {
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
  if (bearer) return bearer[1].trim();
  const xKey = req.headers["x-api-key"];
  return typeof xKey === "string" && xKey ? xKey : null;
}

/**
 * Express middleware for the two /v1/* routes. While zero keys exist
 * the server stays open (bootstrap — the first key is created from
 * the dashboard); once one exists, every request must carry a valid
 * key or gets Anthropic's exact 401 authentication_error envelope.
 *
 * Runs after the global express.json body parser, so unauthenticated
 * payloads never reach the system.txt debug dump below.
 */
function requireApiKey(req, res, next) {
  if (apiKeys.count() === 0) {
    console.warn(
      "[api-keys] no keys configured — allowing unauthenticated request " +
      "(bootstrap; create a key in the dashboard)"
    );
    return next();
  }
  const raw = extractRawKey(req);
  const entry = raw ? apiKeys.verify(raw, req.path) : null;
  if (!entry) {
    return res.status(401).json({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
  }
  // Verified key rides along — metrics.record() attributes the
  // request to entry.userId for the per-account usage_daily store.
  req.apiKey = entry;
  next();
}

/**
 * Prepaid-balance enforcement for the two /v1/* routes — runs
 * AFTER requireApiKey (needs req.apiKey.userId), so mount it
 * second:
 *   app.post("/v1/messages", requireApiKey, requireActivePlan, ...)
 *
 * Off by default: PLAN_ENFORCEMENT=1 turns on balance gating.
 * The rollout deploys this dormant, the operator tops up, then
 * the flag flips (and it doubles as the rollback switch).
 *
 * Skipped in bootstrap mode (zero keys => unauthenticated traffic
 * has no account to enforce). Requests keep working into a small
 * negative balance (plans.GRACE_USD) so a request in flight or a
 * brief usage spike never gets hard-cut; at or below -GRACE_USD
 * the gate blocks with 402. On success sets req.plan for the
 * (dormant) tier gates downstream: { allowedTiers: null }.
 */
function requireActivePlan(req, res, next) {
  if (process.env.PLAN_ENFORCEMENT !== "1" || !req.apiKey) {
    req.plan = { allowedTiers: null };
    return next();
  }
  const userId = req.apiKey.userId;
  if (!userId) {
    return res.status(402).json({
      type: "error",
      error: {
        type: "key_not_linked",
        code: "key_not_linked",
        message:
          "This API key isn't linked to an account. Recreate it from the dashboard (API Keys page), then add credit on the Billing page.",
      },
    });
  }
  const state = plans.getUserBalance(userId);
  if (state.userStatus === "suspended") {
    return res.status(403).json({
      type: "error",
      error: {
        type: "account_suspended",
        code: "account_suspended",
        message: "Account suspended.",
      },
    });
  }
  if (state.userStatus !== "active") {
    // 'pending' accounts (signed up, never topped up) are blocked
    // here; the first top-up payment flips them to 'active'.
    return res.status(402).json({
      type: "error",
      error: {
        type: "account_inactive",
        code: "account_inactive",
        message:
          "This account isn't active yet. Add credit on the dashboard's Billing page to activate it.",
      },
    });
  }
  if (state.balanceUsd <= -plans.GRACE_USD) {
    return res.status(402).json({
      type: "error",
      error: {
        type: "insufficient_balance",
        code: "insufficient_balance",
        message: `Credit balance exhausted ($${state.balanceUsd.toFixed(2)}). Add credit on the dashboard's Billing page to keep using the API.`,
        balanceUsd: state.balanceUsd,
      },
    });
  }
  req.plan = { allowedTiers: null }; // balance-based billing: all tiers
  next();
}

/**
 * 403 for a model outside the caller's plan tiers. Dormant while
 * billing is balance-based (allowedTiers is always null) — kept
 * for a future tiered catalog.
 */
function tierDenial(res, model) {
  return res.status(403).json({
    type: "error",
    error: {
      type: "model_tier_denied",
      code: "model_tier_denied",
      model: model.id,
      tier: plans.modelTier(model),
      message: `Model "${model.id}" isn't available on your plan (${plans.modelTier(model)} tier). Upgrade to reach it.`,
    },
  });
}

/**
 * Actor resolution for the /config/* and /metrics* surface.
 *
 * Historically one shared ADMIN_TOKEN gated these routes and the
 * dashboard injected it for EVERY signed-in user — so every account
 * was effectively an operator and saw every other account's keys,
 * prompts and usage. Instead, resolve WHO is calling:
 *
 *   - valid x-admin-token          -> operator (full console; the
 *     token comparison is timing-safe and always wins)
 *   - valid steeros_session cookie -> user (scoped to its own keys,
 *     usage and activity)
 *   - no ADMIN_TOKEN configured    -> operator (local dev: the old
 *     gate was a no-op there)
 *   - anything else                -> 401 (fail closed)
 *
 * /health and /v1/* are deliberately NOT gated (health checks + API
 * keys respectively); /auth/* sits above this mount too.
 */
function attachActor(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  const given = req.headers["x-admin-token"];
  if (token && typeof given === "string") {
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      req.actor = { role: "operator", user: authApi.getSessionUserFromRequest(req) };
      return next();
    }
  }

  const user = authApi.getSessionUserFromRequest(req);
  if (user) {
    req.actor = { role: "user", user };
    return next();
  }

  if (!token) {
    req.actor = { role: "operator", user: null };
    return next();
  }

  return res.status(401).json({ ok: false, error: "authentication required" });
}

/**
 * Operator-only guard for global mutations (metrics reset/eval/demo,
 * model + routing toggles). Anonymous callers never get past
 * attachActor; a signed-in plain user lands here as a 403 — except
 * in local dev with no ADMIN_TOKEN, where the gate is off entirely
 * (attachActor already treats anonymous callers as operators there,
 * so this adds no new exposure; it keeps the pre-scoping dev
 * workflow where every mutation just worked).
 */
function requireOperator(req, res, next) {
  if (req.actor?.role === "operator") return next();
  if (!process.env.ADMIN_TOKEN) return next(); // dev: gate off
  return res.status(403).json({ ok: false, error: "admin token required" });
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

app.use(
  express.json({
    limit: "50mb",
    // Standard Webhooks signatures cover the raw request bytes —
    // preserve them for the Dodo webhook route only (re-serializing
    // the parsed body would change the bytes and break verification).
    verify: (req, _res, buf) => {
      if (req.path === "/webhooks/dodo") req.rawBody = buf;
    },
  })
);

// Dashboard — served from public/
app.use(express.static(path.join(__dirname, "public")));

// Load configs and initialize
const { modelsConfig, serverConfig, pricingConfig } = loadConfig();

// A classifier mode chosen in the dashboard (data/dashboard-prefs.json)
// overrides config/server.json at boot. Changes apply live: classify()
// reads the mode on every request, so the dashboard picker swaps
// classifiers without a restart.
const prefClassifierMode = prefs.getClassifierMode();
if (prefClassifierMode && serverConfig.classifier) {
  if (serverConfig.classifier.mode !== prefClassifierMode) {
    console.log(
      `[classifier] mode ${serverConfig.classifier.mode} → ${prefClassifierMode} (dashboard prefs)`
    );
  }
  serverConfig.classifier.mode = prefClassifierMode;
}

const registry = new ProviderRegistry(modelsConfig, serverConfig);

// Metrics need pricing for the fixed-model baseline comparison.
if (pricingConfig) metrics.setPricing(pricingConfig);

if (registry.getAllModels().length === 0) {
  console.error("ERROR: No models available. Check your API keys and config/models.json");
  process.exit(1);
}

const classifier = new HybridClassifier(serverConfig, registry);

const apiKeyCount = apiKeys.count();
console.log(
  `[api-keys] ${apiKeyCount} key(s) loaded — /v1/messages + /v1/classify enforcement ` +
  (apiKeyCount > 0 ? "ON" : "OFF (no keys yet)")
);


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

/**
 * Response stub that swallows everything — used for internal
 * non-streaming rounds of the ToolSearch loop so the provider's
 * response doesn't get written to the client mid-exchange.
 */
const swallowRes = {
  setHeader: () => {},
  flushHeaders: () => {},
  json: () => {},
  status: () => swallowRes,
};

/**
 * Re-stream a converted (non-streaming) response to the client as
 * Anthropic SSE. Used when the ToolSearch loop buffered the exchange
 * internally: the client asked for stream:true and still receives one
 * clean stream of the final response.
 */
function emitConvertedAsSSE(res, converted, modelId) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const usage = converted.usage || {};
  send("message_start", {
    type: "message_start",
    message: {
      id: converted.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: modelId,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

  const blocks = converted.content || [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    send("content_block_start", {
      type: "content_block_start",
      index: i,
      content_block: block,
    });
    if (block.type === "text") {
      send("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "text_delta", text: block.text || "" },
      });
    } else if (block.type === "tool_use") {
      send("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input || {}),
        },
      });
    }
    send("content_block_stop", { type: "content_block_stop", index: i });
  }

  send("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: converted.stop_reason || "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: usage.output_tokens || 0 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

// ============================================================
// POST /v1/classify — pure classification endpoint
//
// Returns ONLY the classification JSON. Never answers the prompt.
// ============================================================

app.post("/v1/classify", requireApiKey, requireActivePlan, async (req, res) => {
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
      userId: req.apiKey?.userId || null,
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

app.post("/v1/messages", requireApiKey, requireActivePlan, async (req, res) => {
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

    // DEBUG dump: the COMPLETE request as received, before any
    // classification, compaction or provider conversion. This is the
    // router's whole input, byte for byte. system.txt is gitignored —
    // raw payloads must never enter the repo (see the 2026-09-21
    // secret-scan incident).
    // Off by default (was unconditional until 2026-10-02 — grew past
    // 1GB of raw payloads on disk); enable per-process with
    // DEBUG_DUMP=1 for routing debugging only.
    if (process.env.DEBUG_DUMP === "1") {
      fs.appendFileSync(
        path.join(__dirname, "system.txt"),
        `\n=== IN ${new Date().toISOString()} model=${modelName} ${stream ? "stream" : "non-stream"}` +
          ` mode=${(req.headers["x-routing-mode"] || "default").toLowerCase()} ===\n` +
          JSON.stringify(req.body, null, 2) + "\n"
      );
    }

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

    // Plan tier gate — explicit model requests are denied before
    // any classifier or provider work happens.
    if (
      selectedModel &&
      req.plan?.allowedTiers &&
      !req.plan.allowedTiers.includes(plans.modelTier(selectedModel))
    ) {
      return tierDenial(res, selectedModel);
    }

    if (!selectedModel) {
      // Auto mode: classify + route
      // Strip system prompt during classification — classifiers should
      // judge user intent, not the system role. Re-injected at buildRequest.
      const classBody = { ...req.body, system: undefined };
      const classStart = Date.now();
      classification = await classifier.classify(classBody);
      classifierMs = Date.now() - classStart;

      // Routing mode resolution (auto-routing only):
      //   X-Routing-Mode header -> the caller's own saved mode ->
      //   the operator's global default -> "cheap".
      // The header always wins; a key without a user (bootstrap)
      // gets global prefs only.
      const userPrefRow = req.apiKey?.userId ? userPrefs.get(req.apiKey.userId) : null;
      const routingMode = (
        req.headers["x-routing-mode"] ||
        userPrefRow?.routingMode ||
        prefs.getRoutingMode() ||
        "cheap"
      ).toLowerCase();
      const validModes = ["cheap", "fast", "balanced", "quality"];
      const effectiveMode = validModes.includes(routingMode) ? routingMode : "cheap";

      // Exclusions: the operator's global list always applies; the
      // user's own list unions on top. Explicit model requests
      // (handled above) bypass both.
      const excludedIds = prefs.getDisabledModels();
      if (userPrefRow) {
        for (const id of userPrefRow.disabledModels) {
          if (!excludedIds.includes(id)) excludedIds.push(id);
        }
      }

      try {
        routeResult = selectModel(
          classification, registry, serverConfig.router, null,
          effectiveMode, excludedIds, req.plan?.allowedTiers ?? null
        );
      } catch (err) {
        // Plan tiers emptied the candidate pool — a plan denial,
        // not a server fault.
        if (err.code === "TIER_EXHAUSTED") {
          return res.status(403).json({
            type: "error",
            error: {
              type: "model_tier_denied",
              code: "model_tier_denied",
              message: "No model in your plan's tiers can serve this request.",
            },
          });
        }
        throw err;
      }
      selectedModel = routeResult.model;
      console.log(
        `  → routed: ${selectedModel.id} (mode=${effectiveMode}, ${routeResult.reason || "no reason"})`
      );

      // Definitive post-check — covers every router escape hatch
      // (widen blocks, policy filter, fallback branches).
      if (
        req.plan?.allowedTiers &&
        !req.plan.allowedTiers.includes(plans.modelTier(selectedModel))
      ) {
        return tierDenial(res, selectedModel);
      }

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
    // Plan tier gate for the internal compaction model: if the
    // caller's plan excludes its tier, skip compaction (the request
    // proceeds uncompacted) rather than spend outside the plan.
    const compactionModelId = serverConfig.compaction?.model || "deepseek-flash";
    const compactionModel = registry.getModel(compactionModelId);
    const compactionAllowed =
      !req.plan?.allowedTiers ||
      !compactionModel ||
      req.plan.allowedTiers.includes(plans.modelTier(compactionModel));
    if (!compactionAllowed && serverConfig.compaction?.enabled !== false) {
      console.log(`[plan] compaction skipped (${compactionModelId} tier not in plan)`);
    }
    if (serverConfig.compaction?.enabled !== false && compactionAllowed) {
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

    // --- Step 3+4: Build native request and call provider ---
    // When the serving provider caps the tools list (router.maxTools),
    // the proxy prunes inline tools, defers the rest to a system-text
    // catalog, and closes ToolSearch round-trips internally — the
    // client only ever sees the final response.
    const extraResponseFields = {
      classification: classificationPayloadForResponse,
      compaction: debug && compactionResult ? compactionResult : null,
    };

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

    const maxToolsCaps = serverConfig.router?.maxTools || {};
    const discoveredTools = toolsRegistry.get(req.body);

    /**
     * Serve one model, re-driving internally while the model calls the
     * injected ToolSearch meta-tool. Attempts are recorded per round;
     * provider errors rethrow for the fallback chain.
     */
    const serveModel = async (model, modelProvider, baseBody) => {
      const pruned = buildPrunedBody(baseBody, maxToolsCaps, model.provider, discoveredTools);
      let attemptBody = pruned ? pruned.prunedBody : baseBody;
      let lastConverted = null;
      const rounds = pruned ? 3 : 1;

      for (let round = 0; round < rounds; round++) {
        const attemptStart = Date.now();
        // Internal rounds run non-streaming so the ToolSearch exchange
        // never leaks to the client; the final response is re-delivered.
        const attemptStream = pruned ? false : stream;
        const nativePayload = modelProvider.buildRequest({
          ...attemptBody,
          model: model.apiModelId,
          stream: attemptStream,
        });

        let converted;
        try {
          converted = await callProvider(
            modelProvider, nativePayload, attemptStream,
            pruned ? swallowRes : res, model.id, extraResponseFields
          );
        } catch (err) {
          recordAttempt(model, attemptStart, null, false);
          throw err;
        }
        recordAttempt(model, attemptStart, converted, true);
        lastConverted = converted;

        if (!pruned) return converted; // callProvider already responded

        const searchCalls = (converted?.content || []).filter(
          (b) => b.type === "tool_use" && b.name === META_TOOL_NAME
        );
        if (searchCalls.length === 0) {
          // Final response — deliver in the client's requested shape.
          if (stream) emitConvertedAsSSE(res, converted, model.id);
          else res.json(converted);
          return converted;
        }

        // Resolve every ToolSearch call, append the exchange, re-drive.
        const resultBlocks = [];
        for (const call of searchCalls) {
          const toolDef = resolveToolSearch(baseBody, call);
          if (toolDef) {
            toolsRegistry.record(req.body, toolDef.name);
            console.log(
              `  🔎 ToolSearch: "${call.input?.query || ""}" → ${toolDef.name}`
            );
            resultBlocks.push(buildToolResultBlock(call, toolDef));
          } else {
            resultBlocks.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: [
                {
                  type: "text",
                  text: "No matching tool found for query: " + (call.input?.query || ""),
                },
              ],
            });
          }
        }
        attemptBody = {
          ...attemptBody,
          messages: [
            ...(attemptBody.messages || []),
            { role: "assistant", content: converted.content },
            { role: "user", content: resultBlocks },
          ],
        };
        // Discovery may have grown the inline set — re-prune.
        const rePruned = buildPrunedBody(attemptBody, maxToolsCaps, model.provider, discoveredTools);
        attemptBody = rePruned ? rePruned.prunedBody : attemptBody;
      }

      // Rounds exhausted — deliver whatever the model last said.
      if (lastConverted) {
        if (stream) emitConvertedAsSSE(res, lastConverted, model.id);
        else res.json(lastConverted);
      }
      return lastConverted;
    };

    let fallbacksUsed = 0;
    // gpt-6 models cannot serve function tools via /v1/chat/completions
    // (tools require /v1/responses there, and reasoning_effort has no
    // "none" value). Fail over to the fallback chain up front instead
    // of burning an API call on a guaranteed 400.
    const toolsIncompatible =
      /^gpt-6/.test(selectedModel.id) &&
      Array.isArray(req.body.tools) &&
      req.body.tools.length > 0;
    try {
      if (toolsIncompatible) {
        throw new Error(
          "gpt-6 cannot serve tools via chat/completions (needs /v1/responses); using fallback chain"
        );
      }
      await serveModel(selectedModel, provider, req.body);
    } catch (providerErr) {
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

        // Plan tier gate — never fail over into a disallowed tier.
        if (
          req.plan?.allowedTiers &&
          !req.plan.allowedTiers.includes(plans.modelTier(fallbackModel))
        ) {
          console.warn(`[plan] fallback ${fallbackModel.id} skipped (tier not in plan)`);
          continue;
        }

        fallbacksUsed++;
        try {
          await serveModel(fallbackModel, fallbackProvider, req.body);
          fallbackSuccess = true;
          break;
        } catch (fbErr) {
          // attempt already recorded inside serveModel
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
    // Unconditional: explicit-model requests never run the
    // classifier (classification stays null) but still bill —
    // usage_daily drives the prepaid balance debit, so recording
    // only classified requests would let a caller dodge the meter
    // by pinning a model name.
    const servingAttempt =
      providerAttempts.find((a) => a.ok) || providerAttempts[0] || null;
    metrics.record({
      prompt: getLastUserMessage(req.body.messages),
      classification,
      classifierMs,
      classifierCost: classification?.metadata?.classifierCost || null,
      route: routeResult,
      providerFallbacks: fallbacksUsed,
      providerResult: servingAttempt,
      compaction: compactionResult,
      userId: req.apiKey?.userId || null,
    });

    if (classification) {
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

// ------------------------------------------------------------
// Dodo Payments webhook — authenticated by Dodo's Standard
// Webhooks signature (DODO_PAYMENTS_WEBHOOK_KEY), NOT by the
// admin token, so it must stay OUTSIDE the /config,/metrics
// actor gate below. Caddy routes /webhooks/* here publicly.
// 200 = processed (or duplicate); 500 = DB failure (Dodo
// retries); 401 = bad signature (no retry — payload is garbage).
// ------------------------------------------------------------
app.post("/webhooks/dodo", (req, res) => {
  if (!process.env.DODO_PAYMENTS_WEBHOOK_KEY) {
    console.warn("[webhooks] DODO_PAYMENTS_WEBHOOK_KEY unset — refusing (Dodo will retry)");
    return res.status(503).json({ ok: false, error: "webhooks not configured" });
  }
  let event;
  try {
    event = webhooks.verify(req.rawBody, req.headers);
  } catch (err) {
    console.warn("[webhooks] signature verification failed:", err.message);
    return res.status(401).json({ ok: false, error: "invalid signature" });
  }
  // processEvent is synchronous (better-sqlite3); a throw here is
  // a DB failure — 500 so Dodo retries.
  try {
    const result = webhooks.processEvent(event, req.headers["webhook-id"]);
    console.log(`[webhooks] ${event.type} -> ${result.status}${result.error ? ` (${result.error})` : ""}`);
    res.json({ ok: true, status: result.status });
  } catch (err) {
    console.error("[webhooks] processing failed:", err.message);
    res.status(500).json({ ok: false });
  }
});

// ------------------------------------------------------------
// Public auth API — signup/login/logout/me for the marketing
// site (steerosai.com). SSO with the dashboard: same
// users/sessions tables, shared steeros_session cookie
// (Domain=.steerosai.com via AUTH_COOKIE_DOMAIN). Open signup by
// design — must stay OUTSIDE the /config,/metrics actor gate
// below. Caddy routes /auth/* here publicly.
// ------------------------------------------------------------
app.post("/auth/signup", authApi.signup);
app.post("/auth/login", authApi.login);
app.post("/auth/logout", authApi.logout);
app.get("/auth/me", authApi.me);

// "Sign in with Google" — the whole OAuth dance runs here (start ->
// Google -> callback), then 302s into the dashboard with the shared
// steeros_session cookie. Also outside the actor gate.
app.get("/auth/google/start", authGoogle.start);
app.get("/auth/google/callback", authGoogle.callback);

// Authenticated zone (see attachActor above). Mounted before the
// route declarations so every /config/* and /metrics* route below
// resolves its actor (operator | user | 401). /health, /v1/*,
// /webhooks/* and /auth/* are declared above and stay ungated; the
// static middleware is unaffected.
app.use(["/config", "/metrics"], attachActor);

// ============================================================
// Metrics endpoints — consumed by the dashboard in public/
// ============================================================

app.get("/metrics", (req, res) => {
  // Operator: the whole process. Anyone else: scoped to their own
  // account — session aggregates, their ring-buffer records and
  // usage_daily-backed all-time totals.
  const actor = req.actor;
  const snapshot = metrics.snapshot(
    actor.role === "operator" ? null : actor.user.id
  );
  snapshot.viewer = { role: actor.role, userId: actor.user?.id ?? null };
  res.json(snapshot);
});

app.post("/metrics/reset", requireOperator, (req, res) => {
  metrics.reset();
  // ?global=1 also wipes the persisted all-time counter.
  if (req.query.global === "1") metrics.resetGlobal();
  res.json({ ok: true });
});

// Run the labeled eval set (config/eval-prompts.json) through the
// real classifier and store the accuracy summary for the dashboard.
app.post("/metrics/eval", requireOperator, async (req, res) => {
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
app.post("/metrics/demo", requireOperator, async (req, res) => {
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

function dashboardCatalog(actor) {
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

  // Scoped users see THEIR selection on top of the operator's global
  // one: a model reads enabled only if the operator hasn't disabled
  // it AND the user hasn't. Operators (and any caller without an
  // actor) get the global view, byte-identical to before.
  const user = actor?.role === "user" ? actor.user : null;
  const globalDisabled = prefs.getDisabledModels();
  const userRow = user ? userPrefs.get(user.id) : null;

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
    enabled:
      !!registry.getProvider(m.id) &&
      prefs.isModelEnabled(m.id) &&
      !(userRow ? userRow.disabledModels.includes(m.id) : false),
  }));

  return {
    models,
    prefs: {
      // Effective mode for users (their own, else inherited global)
      // so the routing page highlights what auto-routing will use;
      // null only when nothing is saved anywhere.
      routingMode: user
        ? userRow.routingMode ?? prefs.getRoutingMode()
        : prefs.getRoutingMode(),
      disabledModels: user ? userRow.disabledModels : globalDisabled,
    },
    // Models the operator locked globally. Always empty for the
    // operator's own view (their toggles edit that very list); for
    // users it drives the locked "admin off" rows in the UI.
    adminDisabledModels: user ? globalDisabled : [],
    routingModes: prefs.VALID_MODES,
    classifier: {
      mode: serverConfig.classifier?.mode || "auto",
      modes: prefs.VALID_CLASSIFIER_MODES,
    },
    policy,
    benchmark,
  };
}

app.get("/config/dashboard", (req, res) => {
  res.json(dashboardCatalog(req.actor));
});

// Toggle a model in/out of the auto-routing candidate pool.
// Operators edit the global list; signed-in users edit their own
// (union semantics — the global list always still applies).
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
  const globalDisabled = prefs.getDisabledModels();
  const result =
    req.actor?.role === "operator"
      ? prefs.setModelEnabled(id, enabled, availableIds)
      : userPrefs.setModelEnabled(
          req.actor.user.id,
          id,
          enabled,
          // Models the operator disabled are not part of this user's
          // pool, so they don't count toward "the last one".
          availableIds.filter((mid) => !globalDisabled.includes(mid))
        );
  if (!result.ok) {
    return res.status(400).json(result);
  }
  res.json({ ok: true, catalog: dashboardCatalog(req.actor) });
});

// Set the default routing mode (cheap | fast | balanced | quality).
// Operators set the global default; users set their own, which wins
// over the global one (but not over an X-Routing-Mode header).
app.post("/config/routing", (req, res) => {
  const { mode } = req.body || {};
  const updated =
    req.actor?.role === "operator"
      ? prefs.setRoutingMode(mode)
      : userPrefs.setRoutingMode(req.actor.user.id, mode);
  if (updated === null) {
    return res.status(400).json({
      ok: false,
      error: `mode must be one of: ${prefs.VALID_MODES.join(", ")}`,
    });
  }
  res.json({ ok: true, routingMode: updated });
});

// Switch the active classifier (auto | llm | jev). Applies live —
// classify() reads the mode per request — and persists across
// restarts via dashboard prefs.
app.post("/config/classifier", requireOperator, (req, res) => {
  const { mode } = req.body || {};
  const updated = prefs.setClassifierMode(mode);
  if (updated === null) {
    return res.status(400).json({
      ok: false,
      error: `mode must be one of: ${prefs.VALID_CLASSIFIER_MODES.join(", ")}`,
    });
  }
  if (serverConfig.classifier) serverConfig.classifier.mode = updated;
  res.json({ ok: true, classifierMode: updated });
});

// ------------------------------------------------------------
// API key management — consumed by the dashboard's API Keys page.
// NOTE: once the first key exists, /v1/messages and /v1/classify
// require a valid key (see requireApiKey above); these endpoints
// are gated by attachActor (operator sees all keys, a signed-in
// user only theirs) so keys can always be managed.
// ------------------------------------------------------------

/** The key list as the current actor should see it. */
function keysForActor(actor) {
  return actor.role === "operator"
    ? apiKeys.listKeys()
    : apiKeys.listKeysForUser(actor.user.id);
}

app.get("/config/api-keys", (req, res) => {
  res.json({ keys: keysForActor(req.actor) });
});

app.post("/config/api-keys", (req, res) => {
  // The key is attributed from the ACTOR, never from client input:
  // a signed-in user always gets their own id (an unlinked key is
  // rejected 402 key_not_linked once plan enforcement is on), and
  // only an operator may attribute a key to another account.
  const actor = req.actor;
  const userId =
    actor.role === "operator"
      ? (typeof req.body?.userId === "string" ? req.body.userId : actor.user?.id ?? null)
      : actor.user.id;
  const created = apiKeys.createKey(req.body?.name, userId);
  if (!created) {
    return res.status(400).json({
      ok: false,
      error: "name must be a non-empty string (max 60 chars)",
    });
  }
  // apiKey is the plaintext — returned exactly once, never stored.
  res.json({ ok: true, key: created.entry, apiKey: created.secret });
});

app.delete("/config/api-keys/:id", (req, res) => {
  const actor = req.actor;
  // Ownership is part of the UPDATE for users, so another account's
  // key behaves exactly like an unknown id: 404, key stays live.
  const revoked =
    actor.role === "operator"
      ? apiKeys.revokeKey(req.params.id)
      : apiKeys.revokeKeyForUser(req.params.id, actor.user.id);
  if (!revoked) {
    return res.status(404).json({
      ok: false,
      error: `Unknown key id "${req.params.id}"`,
    });
  }
  res.json({ ok: true, keys: keysForActor(actor) });
});

// ============================================================
// Start
// ============================================================

app.listen(PORT, () => {
  console.log(`\n🚀 LLM Proxy Server running on http://localhost:${PORT}`);
  console.log(`   POST /v1/messages    — Anthropic-format API (API key required)`);
  console.log(`   POST /v1/classify    — Prompt classification (API key required)`);
  console.log(`   GET  /               — Routing metrics dashboard`);
  console.log(`   GET  /metrics        — Metrics JSON`);
  console.log(`   GET  /config/dashboard — Model catalog + routing prefs`);
  console.log(`   POST /config/models  — Enable/disable a model`);
  console.log(`   POST /config/routing — Set default routing mode`);
  console.log(`   GET  /config/api-keys  — List API keys`);
  console.log(`   POST /config/api-keys  — Create an API key`);
  console.log(`   DELETE /config/api-keys/:id — Revoke an API key`);
  console.log(`   POST /metrics/eval   — Run classifier eval set`);
  console.log(`   GET  /health         — Server status`);
  console.log(
    `   debug dump  : ${process.env.DEBUG_DUMP === "1" ? "ON (system.txt)" : "off"}`
  );
  console.log(
    `   billing     : ${
      process.env.PLAN_ENFORCEMENT === "1"
        ? `ENFORCING prepaid balance (grace $${plans.GRACE_USD.toFixed(2)}, env=${plans.environment})`
        : "off (PLAN_ENFORCEMENT unset)"
    }`
  );
  console.log(
    `   actor gate  : ${
      process.env.ADMIN_TOKEN
        ? "active (x-admin-token = operator, session = scoped user, else 401)"
        : "off (no ADMIN_TOKEN set — every /config, /metrics caller is operator)"
    }\n`
  );
});
