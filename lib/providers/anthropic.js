// ============================================================
// Anthropic provider (native pass-through)
// ============================================================

const BaseProvider = require("./base");
const { extractSystemText } = require("../classifier/text-utils");

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * True when the client already marked cache_control anywhere
 * (top-level, system blocks, or message content blocks). Respect
 * client intent — never duplicate or override their markers.
 */
function hasClientCacheControl(body) {
  if (body.cache_control) return true;
  if (Array.isArray(body.system) && body.system.some((b) => b?.cache_control)) return true;
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    if (m.content.some((b) => b?.cache_control)) return true;
  }
  return false;
}

/**
 * Copy system, attaching cache_control to its LAST text block.
 * The marker caches tools + everything before it in the system.
 *
 * TTL note: 1h entries cost 2x input on WRITE (5m costs 1.25x) and
 * pay off only with 3+ reads per entry — chosen for bursty traffic
 * with 5-60 minute gaps. Anthropic supports only 5m (default) and 1h.
 */
function markLastSystemBlock(system) {
  if (typeof system === "string") {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }];
  }
  const blocks = [...system];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === "text") {
      blocks[i] = { ...blocks[i], cache_control: { type: "ephemeral", ttl: "1h" } };
      break;
    }
  }
  return blocks;
}

// Mid-conversation `role:"system"` messages are supported only on the
// Opus 4.8+ / Fable / Mythos family; Haiku 4.5 and Sonnet 5 reject
// them with a 400.
const SUPPORTS_SYSTEM_ROLE = /opus-4-8|opus-5|fable|mythos/i;

// Per-message `output_config` (mid-conversation effort control) is
// supported only on the Opus 5 / Fable / Mythos family. Older models
// reject the field with 400 "Extra inputs are not permitted".
const SUPPORTS_MSG_OUTPUT_CONFIG = /opus-5|fable|mythos/i;

/**
 * The router swaps models per request, but the client replays history
 * produced by whatever model served earlier turns. Constructs bound to
 * the producing model (or to the client's own model choice) 400 on a
 * different serving model:
 *   - `thinking` blocks: signatures are validated against the serving
 *     model ("Invalid signature in thinking block"). Strip them — the
 *     API treats dropped thinking as unbilled, and the serving model
 *     re-derives its own.
 *   - mid-conversation `role:"system"` messages on models that don't
 *     support them (see SUPPORTS_SYSTEM_ROLE). Demote to `user` so the
 *     operator instruction still reaches the model.
 *   - per-message `output_config` on models that don't support it
 *     (see SUPPORTS_MSG_OUTPUT_CONFIG). Stripped; the serving model
 *     runs at its own default effort.
 * Messages left with no content after stripping are dropped — empty
 * messages also 400.
 */
function sanitizeMessages(messages, modelId) {
  const supportsSystem = SUPPORTS_SYSTEM_ROLE.test(modelId);
  const supportsMsgOutputConfig = SUPPORTS_MSG_OUTPUT_CONFIG.test(modelId);
  const out = [];
  for (const original of messages || []) {
    let m = original;

    if (!supportsMsgOutputConfig && m.output_config !== undefined) {
      console.log(
        "  ✂️ stripped message output_config (model doesn't support per-message output_config)"
      );
      const { output_config, ...rest } = m;
      m = rest;
    }

    if (Array.isArray(m.content) && m.content.length === 0) {
      console.log("  ✂️ dropped empty message (content was only output_config)");
      continue;
    }

    if (m.role === "system" && !supportsSystem) {
      console.log("  ✂️ system message → user (model doesn't support role system)");
      out.push({ ...m, role: "user" });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const kept = m.content.filter(
        (b) => b?.type !== "thinking" && b?.type !== "redacted_thinking"
      );
      if (kept.length !== m.content.length) {
        console.log(
          `  ✂️ stripped ${m.content.length - kept.length} thinking block(s) (signatures bound to another model)`
        );
      }
      if (kept.length === 0) {
        // Assistant turn that was only thinking — nothing to replay.
        continue;
      }
      out.push({ ...m, content: kept });
      continue;
    }
    out.push(m);
  }
  return out;
}

class AnthropicProvider extends BaseProvider {
  constructor(modelConfig, serverConfig) {
    super(modelConfig, serverConfig);
    // Accept either variable name — "CLAUDE_API_KEY" is a common alias.
    this.apiKey =
      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
  }

  validate() {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is not set");
    }
  }

  buildRequest(anthropicBody) {
    // Anthropic format is already native — just set the model and api key implicitly
    const { system, messages, tools, tool_choice, max_tokens, temperature, cache_control } = anthropicBody;

    // The client's max_tokens can exceed what the routed model accepts
    // (e.g. Claude Code sending 32k to Haiku 4.5, whose cap is 8k).
    // Clamp to the model's documented output limit instead of 400ing.
    const cap = this.config.capabilities?.maxOutputTokens;
    const mt = cap ? Math.min(max_tokens || 4096, cap) : max_tokens || 4096;
    if (mt !== (max_tokens || 4096)) {
      console.log(`  ✂️ max_tokens ${max_tokens} > ${cap} (model cap), clamped`);
    }

    const payload = {
      model: anthropicBody.model || this.config.apiModelId,
      messages,
      max_tokens: mt,
      stream: !!anthropicBody.stream,
    };

    // History the client replays may contain constructs bound to the
    // model that produced them — sanitize for the actual target.
    payload.messages = sanitizeMessages(payload.messages, payload.model);

    // Sampling params were removed on the 4.6+ model family — sending
    // `temperature` at all returns 400 ("temperature is deprecated").
    // Only pass it through for models that still accept it (Haiku 4.5).
    if (temperature !== undefined && /haiku/i.test(payload.model)) {
      payload.temperature = temperature;
    }

    if (system) payload.system = system;
    if (tools) payload.tools = tools;
    if (tool_choice) payload.tool_choice = tool_choice;
    // Client-sent top-level cache_control (whitelisted fields would
    // otherwise drop it silently).
    if (cache_control) payload.cache_control = cache_control;

    // ---- Server-side cache injection (config/caching) ----
    // Anthropic only caches prefixes the request marks. When the
    // client sent no markers anywhere, inject them so repeated
    // system prompts and multi-turn prefixes actually cache.
    const caching = this.serverConfig?.caching || {};
    if (caching.enabled !== false && !hasClientCacheControl(anthropicBody)) {
      // (1) Explicit breakpoint on the last system text block when it
      // clears the model's minimum cacheable prefix (below it the API
      // silently refuses to cache, so skip).
      if (caching.injectSystemBreakpoint !== false && system) {
        const estSysTokens = Math.ceil(extractSystemText(system).length / 3.5);
        const min =
          caching.systemBreakpointMinTokens?.[this.config.id] ??
          caching.defaultMinTokens ??
          2048;
        if (estSysTokens >= min) {
          payload.system = markLastSystemBlock(payload.system);
        }
      }
      // (2) Top-level automatic breakpoint for growing multi-turn
      // conversations (auto-places on the last cacheable block).
      if (caching.injectMultiTurnMarker !== false &&
          !payload.cache_control &&
          (messages?.length || 0) >= 2) {
        payload.cache_control = { type: "ephemeral", ttl: "1h" };
      }
    }

    return payload;
  }

  convertResponse(nativeResp, modelName) {
    // Anthropic response is already in Anthropic format — pass through
    // but ensure model name matches what client expects
    return {
      ...nativeResp,
      model: modelName || nativeResp.model,
    };
  }

  async streamResponse(nativeStream, res, modelName) {
    // Anthropic SSE is already in the format the client expects — pipe
    // it through unchanged, while reading the usage that Anthropic
    // includes natively: input/cache tokens on message_start,
    // output_tokens (+ cache fields) on the final message_delta.
    // No flag needed — always on.
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const mergeUsage = (src) => {
      if (!src) return;
      if (src.input_tokens !== undefined) usage.input_tokens = src.input_tokens;
      if (src.output_tokens !== undefined) usage.output_tokens = src.output_tokens;
      if (src.cache_read_input_tokens !== undefined) {
        usage.cache_read_input_tokens = src.cache_read_input_tokens;
      }
      if (src.cache_creation_input_tokens !== undefined) {
        usage.cache_creation_input_tokens = src.cache_creation_input_tokens;
      }
    };
    let buffer = "";

    return new Promise((resolve, reject) => {
      nativeStream.on("data", (chunk) => {
        res.write(chunk);

        // Parse usage out of the piped events.
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          let parsed;
          try { parsed = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (parsed.type === "message_start") {
            mergeUsage(parsed.message?.usage);
          } else if (parsed.type === "message_delta") {
            mergeUsage(parsed.usage);
          }
        }
      });
      nativeStream.on("end", () => {
        // Process the trailing buffer — the final message_delta often
        // has no trailing newline.
        const leftover = buffer.trim();
        if (leftover.startsWith("data:")) {
          try {
            const parsed = JSON.parse(leftover.slice(5).trim());
            if (parsed.type === "message_delta") mergeUsage(parsed.usage);
          } catch (_) {}
        }
        res.end();
        resolve(usage);
      });
      nativeStream.on("error", (err) => {
        console.error("Anthropic stream error:", err.message);
        if (!res.writableEnded) res.end();
        resolve(usage);
      });
    });
  }

  getApiUrl() {
    return `${ANTHROPIC_BASE_URL}/v1/messages`;
  }

  getHeaders() {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  }
}

module.exports = AnthropicProvider;
