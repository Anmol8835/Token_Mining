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
    const { system, messages, tools, tool_choice, max_tokens, temperature, model } = anthropicBody;

    const payload = {
      model: model || this.config.apiModelId,
      // echoReasoning: DeepSeek thinking-mode models reject multi-turn
      // tool calls unless the assistant turns carry back the
      // reasoning_content the API generated for them.
      messages: converter.convertMessages(system, messages, { echoReasoning: true }),
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
