// ============================================================
// Anthropic provider (native pass-through)
// ============================================================

const BaseProvider = require("./base");

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

class AnthropicProvider extends BaseProvider {
  constructor(modelConfig) {
    super(modelConfig);
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
    const { system, messages, tools, tool_choice, max_tokens, temperature } = anthropicBody;

    const payload = {
      model: anthropicBody.model || this.config.apiModelId,
      messages,
      max_tokens: max_tokens || 4096,
      stream: !!anthropicBody.stream,
    };

    // Sampling params were removed on the 4.6+ model family — sending
    // `temperature` at all returns 400 ("temperature is deprecated").
    // Only pass it through for models that still accept it (Haiku 4.5).
    if (temperature !== undefined && /haiku/i.test(payload.model)) {
      payload.temperature = temperature;
    }

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
    // Anthropic SSE is already in the format the client expects — pipe
    // it through unchanged, while reading the usage that Anthropic
    // includes natively: input_tokens on message_start, output_tokens
    // on the final message_delta. No flag needed — always on.
    let usage = { input_tokens: 0, output_tokens: 0 };
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
          if (parsed.type === "message_start" && parsed.message?.usage) {
            usage.input_tokens = parsed.message.usage.input_tokens || 0;
            if (parsed.message.usage.output_tokens) {
              usage.output_tokens = parsed.message.usage.output_tokens;
            }
          } else if (parsed.type === "message_delta" && parsed.usage?.output_tokens) {
            usage.output_tokens = parsed.usage.output_tokens;
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
            if (parsed.type === "message_delta" && parsed.usage?.output_tokens) {
              usage.output_tokens = parsed.usage.output_tokens;
            }
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
