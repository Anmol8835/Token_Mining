// ============================================================
// Google Gemini provider
// ============================================================

const BaseProvider = require("./base");

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

class GeminiProvider extends BaseProvider {
  constructor(modelConfig) {
    super(modelConfig);
    this.apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
  }

  validate() {
    if (!this.apiKey) {
      throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY is not set");
    }
  }

  // ----------------------------------------------------------
  // Anthropic -> Gemini request conversion
  // ----------------------------------------------------------

  _extractText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  _extractToolCalls(content) {
    if (!Array.isArray(content)) return [];
    return content.filter((b) => b.type === "tool_use");
  }

  _extractToolResults(content) {
    if (!Array.isArray(content)) return [];
    return content.filter((b) => b.type === "tool_result");
  }

  _convertParts(content) {
    if (typeof content === "string") {
      return [{ text: content }];
    }
    if (!Array.isArray(content)) {
      return [{ text: "" }];
    }

    const parts = [];
    for (const block of content) {
      if (block.type === "text") {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input || {},
          },
        });
      } else if (block.type === "tool_result") {
        const resultText = Array.isArray(block.content)
          ? block.content.map((c) => c.text || "").join("\n")
          : block.content || "";
        parts.push({
          functionResponse: {
            name: block.tool_use_id, // Gemini uses name to match, we store the tool_use_id here
            response: { result: resultText },
          },
        });
      } else if (block.type === "image" && block.source?.type === "base64") {
        parts.push({
          inlineData: {
            mimeType: block.source.media_type || "image/png",
            data: block.source.data,
          },
        });
      }
      // Ignore unknown block types
    }
    return parts;
  }

  buildRequest(anthropicBody) {
    const { system, messages, tools, max_tokens, temperature, model } = anthropicBody;

    const payload = {
      model: model || this.config.apiModelId,
      contents: [],
      generationConfig: {
        maxOutputTokens: max_tokens || 4096,
        temperature: temperature ?? 1,
      },
    };

    // System instruction
    if (system) {
      const systemText = typeof system === "string"
        ? system
        : system.map((s) => s.text || "").join("\n");
      payload.system_instruction = { parts: [{ text: systemText }] };
    }

    // Convert messages to Gemini contents
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        // Simple string content
        payload.contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
        continue;
      }

      // User message with tool results
      if (msg.role === "user") {
        const toolResults = this._extractToolResults(msg.content);
        const rest = msg.content.filter((b) => b.type !== "tool_result");

        // Tool results become separate functionResponse messages
        for (const tr of toolResults) {
          const resultText = Array.isArray(tr.content)
            ? tr.content.map((c) => c.text || "").join("\n")
            : tr.content || "";
          payload.contents.push({
            role: "user",
            parts: [{
              functionResponse: {
                name: tr.tool_use_id,
                response: { result: resultText },
              },
            }],
          });
        }

        if (rest.length > 0) {
          const parts = this._convertParts(rest);
          if (parts.length > 0) {
            payload.contents.push({ role: "user", parts });
          }
        }
      } else if (msg.role === "assistant") {
        const parts = this._convertParts(msg.content);
        if (parts.length > 0) {
          payload.contents.push({ role: "model", parts });
        }
      } else {
        // Other roles fall through
        const parts = this._convertParts(msg.content);
        if (parts.length > 0) {
          payload.contents.push({ role: "user", parts });
        }
      }
    }

    // Convert tools
    if (tools && tools.length > 0) {
      payload.tools = [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || { type: "object", properties: {} },
        })),
      }];
    }

    return payload;
  }

  // ----------------------------------------------------------
  // Gemini -> Anthropic response conversion (non-streaming)
  // ----------------------------------------------------------

  convertResponse(nativeResp, modelName) {
    const candidate = nativeResp.candidates?.[0];
    if (!candidate) {
      return {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: modelName,
        content: [{ type: "text", text: "" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: nativeResp.usageMetadata?.promptTokenCount || 0,
          output_tokens: nativeResp.usageMetadata?.candidatesTokenCount || 0,
        },
      };
    }

    const content = [];
    for (const part of candidate.content?.parts || []) {
      if (part.text !== undefined) {
        content.push({ type: "text", text: part.text });
      } else if (part.functionCall) {
        content.push({
          type: "tool_use",
          id: `tcu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        });
      }
    }

    const finishMap = {
      STOP: "end_turn",
      MAX_TOKENS: "max_tokens",
      SAFETY: "end_turn",
      RECITATION: "end_turn",
      TOOL_CALLS: "tool_use",
    };

    return {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: modelName,
      content,
      stop_reason: finishMap[candidate.finishReason] || "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: nativeResp.usageMetadata?.promptTokenCount || 0,
        output_tokens: nativeResp.usageMetadata?.candidatesTokenCount || 0,
      },
    };
  }

  // ----------------------------------------------------------
  // Gemini -> Anthropic SSE streaming conversion
  // ----------------------------------------------------------

  async streamResponse(nativeStream, res, modelName) {
    const messageId = `msg_${Date.now()}`;
    let buffer = "";
    let currentBlockIndex = 0;
    let textBlockStarted = false;
    let toolCallBlockIndex = null;
    let finishSent = false;

    const send = (event, data) => {
      if (finishSent && event !== "message_stop") return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("message_start", {
      type: "message_start",
      message: {
        id: messageId, type: "message", role: "assistant", model: modelName,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    return new Promise((resolve) => {
      nativeStream.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;

          let parsed;
          try { parsed = JSON.parse(dataStr); } catch (_) { continue; }

          // Gemini streams as an array of candidates
          const candidates = Array.isArray(parsed) ? parsed : [parsed];

          for (const item of candidates) {
            const candidate = item.candidates?.[0];
            if (!candidate) continue;

            for (const part of candidate.content?.parts || []) {
              if (part.text !== undefined) {
                if (!textBlockStarted && !finishSent) {
                  send("content_block_start", {
                    type: "content_block_start", index: currentBlockIndex,
                    content_block: { type: "text", text: "" },
                  });
                  textBlockStarted = true;
                }
                send("content_block_delta", {
                  type: "content_block_delta", index: currentBlockIndex,
                  delta: { type: "text_delta", text: part.text },
                });
              }

              if (part.functionCall) {
                if (textBlockStarted) {
                  send("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });
                  textBlockStarted = false;
                  currentBlockIndex++;
                }

                if (toolCallBlockIndex === null) {
                  toolCallBlockIndex = currentBlockIndex;
                  const tcId = `tcu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                  send("content_block_start", {
                    type: "content_block_start", index: toolCallBlockIndex,
                    content_block: {
                      type: "tool_use",
                      id: tcId,
                      name: part.functionCall.name,
                      input: {},
                    },
                  });
                  currentBlockIndex++;
                }

                send("content_block_delta", {
                  type: "content_block_delta", index: toolCallBlockIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(part.functionCall.args || {}),
                  },
                });
              }
            }

            // Check for finish
            const finishReason = candidate.finishReason;
            if (finishReason && !finishSent) {
              if (textBlockStarted) {
                send("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });
                textBlockStarted = false;
              }
              if (toolCallBlockIndex !== null) {
                send("content_block_stop", { type: "content_block_stop", index: toolCallBlockIndex });
              }

              const finishMap = {
                STOP: "end_turn",
                MAX_TOKENS: "max_tokens",
                TOOL_CALLS: "tool_use",
              };

              send("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: finishMap[finishReason] || "end_turn",
                  stop_sequence: null,
                },
                usage: { output_tokens: 0 },
              });
              send("message_stop", { type: "message_stop" });
              finishSent = true;
            }
          }
        }
      });

      nativeStream.on("end", () => {
        if (!finishSent) {
          if (textBlockStarted) {
            send("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });
          }
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          });
          send("message_stop", { type: "message_stop" });
        }
        res.end();
        resolve();
      });

      nativeStream.on("error", (err) => {
        console.error("Gemini stream error:", err.message);
        if (!res.writableEnded) res.end();
        resolve();
      });
    });
  }

  // ----------------------------------------------------------
  // API config
  // ----------------------------------------------------------

  getApiUrl() {
    return `${GEMINI_BASE_URL}/v1beta/models/${this.config.apiModelId}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
  }

  getNonStreamingUrl() {
    return `${GEMINI_BASE_URL}/v1beta/models/${this.config.apiModelId}:generateContent?key=${this.apiKey}`;
  }

  getHeaders() {
    return {
      "Content-Type": "application/json",
    };
  }
}

module.exports = GeminiProvider;
