// ============================================================
// DeepSeek provider (OpenAI-compatible API)
// ============================================================

const BaseProvider = require("./base");
const converter = require("../converter");

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

class DeepSeekProvider extends BaseProvider {
  constructor(modelConfig) {
    super(modelConfig);
    this.apiKey = process.env.DEEPSEEK_API_KEY || "";
  }

  validate() {
    if (!this.apiKey) {
      throw new Error("DEEPSEEK_API_KEY is not set");
    }
  }

  buildRequest(anthropicBody) {
    const { system, messages, tools, tool_choice, max_tokens, temperature, model, thinking } = anthropicBody;

    // Clamp to the model's documented output limit instead of 400ing
    // when the client's max_tokens exceeds it (see anthropic.js).
    const cap = this.config.capabilities?.maxOutputTokens;
    const mt = cap ? Math.min(max_tokens || 4096, cap) : max_tokens || 4096;
    if (mt !== (max_tokens || 4096)) {
      console.log(`  ✂️ max_tokens ${max_tokens} > ${cap} (model cap), clamped`);
    }

    const payload = {
      model: model || this.config.apiModelId,
      // echoReasoning: DeepSeek thinking-mode models reject multi-turn
      // tool calls unless the assistant turns carry back the
      // reasoning_content the API generated for them.
      messages: converter.convertMessages(system, messages, { echoReasoning: true }),
      max_tokens: mt,
      temperature: temperature ?? 1,
      stream: !!anthropicBody.stream,
    };

    // thinking: {type: "disabled"} opts out of DeepSeek's default
    // thinking mode — used where reasoning tokens would eat the
    // output budget (classifier JSON, judge verdict fallback).
    if (thinking) payload.thinking = thinking;

    // Streaming usage: OpenAI-compatible APIs only report tokens in
    // the final chunk when explicitly asked.
    if (anthropicBody.stream) {
      payload.stream_options = { include_usage: true };
    }

    const openaiTools = converter.convertTools(tools);
    if (openaiTools) {
      payload.tools = openaiTools;
      const tc = converter.convertToolChoice(tool_choice);
      if (tc) payload.tool_choice = tc;
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
    return `${DEEPSEEK_BASE_URL}/chat/completions`;
  }

  getHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}

module.exports = DeepSeekProvider;
