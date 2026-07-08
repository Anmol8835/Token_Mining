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

    const payload = {
      model: model || this.config.apiModelId,
      messages: converter.convertMessages(system, messages),
      max_tokens: max_tokens || 4096,
      temperature: temperature ?? 1,
      stream: !!anthropicBody.stream,
    };

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
