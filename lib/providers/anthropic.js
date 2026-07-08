// ============================================================
// Anthropic provider (native pass-through)
// ============================================================

const BaseProvider = require("./base");

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

class AnthropicProvider extends BaseProvider {
  constructor(modelConfig) {
    super(modelConfig);
    this.apiKey = process.env.ANTHROPIC_API_KEY || "";
  }

  validate() {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
  }

  buildRequest(anthropicBody) {
    // Anthropic format is already native — just set the model and api key implicitly
    const { system, messages, tools, tool_choice, max_tokens, temperature } = anthropicBody;

    const payload = {
      model: anthropicBody.model || this.config.apiModelId,
      messages,
      max_tokens: max_tokens || 4096,
      temperature: temperature ?? 1,
      stream: !!anthropicBody.stream,
    };

    if (system) payload.system = system;
    if (tools) payload.tools = tools;
    if (tool_choice) payload.tool_choice = tool_choice;

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
    // Anthropic SSE is already in the format the client expects — pipe directly
    return new Promise((resolve, reject) => {
      nativeStream.on("data", (chunk) => {
        res.write(chunk);
      });
      nativeStream.on("end", () => {
        res.end();
        resolve();
      });
      nativeStream.on("error", (err) => {
        console.error("Anthropic stream error:", err.message);
        if (!res.writableEnded) res.end();
        resolve();
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
