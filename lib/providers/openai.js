// ============================================================
// OpenAI provider (OpenAI-compatible API)
// ============================================================

const BaseProvider = require("./base");
const converter = require("../converter");

const OPENAI_BASE_URL = "https://api.openai.com";

class OpenAIProvider extends BaseProvider {
  constructor(modelConfig) {
    super(modelConfig);
    this.apiKey = process.env.OPENAI_API_KEY || "";
  }

  validate() {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
  }

  buildRequest(anthropicBody) {
    const { system, messages, tools, tool_choice, max_tokens, temperature, model } = anthropicBody;

    // Clamp to the model's documented output limit instead of 400ing
    // when the client's max_tokens exceeds it (see anthropic.js).
    const cap = this.config.capabilities?.maxOutputTokens;
    const mt = cap ? Math.min(max_tokens || 4096, cap) : max_tokens || 4096;
    if (mt !== (max_tokens || 4096)) {
      console.log(`  ✂️ max_tokens ${max_tokens} > ${cap} (model cap), clamped`);
    }

    // OpenAI reasoning-family models (gpt-5.x / gpt-6 / o-series)
    // reject the legacy `max_tokens` parameter ("Use
    // 'max_completion_tokens' instead") and reject non-default
    // `temperature`. All recent OpenAI models accept
    // `max_completion_tokens`, so use it for every OpenAI call.
    const isReasoningFamily = /^(gpt-5|gpt-6|o[0-9])/.test(model || this.config.apiModelId);

    const payload = {
      model: model || this.config.apiModelId,
      messages: converter.convertMessages(system, messages),
      max_completion_tokens: mt,
      stream: !!anthropicBody.stream,
    };

    if (isReasoningFamily) {
      if (temperature !== undefined && temperature !== 1) {
        console.log(
          `  ✂️ dropped temperature ${temperature} (reasoning model only accepts the default)`
        );
      }
    } else {
      payload.temperature = temperature ?? 1;
    }

    const openaiTools = converter.convertTools(tools);
    if (openaiTools) {
      payload.tools = openaiTools;
      const tc = converter.convertToolChoice(tool_choice);
      if (tc) payload.tool_choice = tc;

      // The gpt-5.6 line refuses function tools alongside reasoning
      // in /v1/chat/completions but accepts reasoning_effort "none",
      // so disable reasoning there when tools exist. (gpt-6 has no
      // "none" value — tools on gpt-6 are impossible in this endpoint
      // and are handled by the fail-over in index.js instead.)
      if (/^gpt-5\.6/.test(model || this.config.apiModelId)) {
        payload.reasoning_effort = "none";
        console.log(
          "  ✂️ reasoning_effort=none (gpt-5.6 tools are incompatible with reasoning in chat/completions)"
        );
      }
    }

    // Streaming usage: only reported in the final chunk when asked.
    if (anthropicBody.stream) {
      payload.stream_options = { include_usage: true };
    }

    return payload;
  }

  convertResponse(nativeResp, modelName) {
    return converter.convertResponse(nativeResp, modelName);
  }

  async streamResponse(nativeStream, res, modelName) {
    return converter.streamToAnthropic(nativeStream, res, modelName);
  }

  getApiUrl() {
    return `${OPENAI_BASE_URL}/v1/chat/completions`;
  }

  getHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}

module.exports = OpenAIProvider;
