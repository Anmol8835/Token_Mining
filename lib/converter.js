// ============================================================
// Anthropic <-> OpenAI conversion helpers
// ============================================================

function blockToText(block) {
  if (block.type === "text") return block.text;
  if (block.type === "tool_use") return `[Tool Call: ${block.name}] ${JSON.stringify(block.input)}`;
  return "";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockToText).filter(Boolean).join("\n");
}

function convertMessages(system, messages) {
  const out = [];

  if (system) {
    const systemText = typeof system === "string" ? system : system.map((s) => s.text || "").join("\n");
    out.push({ role: "system", content: systemText });
  }

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "user") {
      const toolResults = msg.content.filter((b) => b.type === "tool_result");
      const rest = msg.content.filter((b) => b.type !== "tool_result");

      for (const tr of toolResults) {
        const inner = Array.isArray(tr.content)
          ? tr.content.map((c) => c.text || "").join("\n")
          : tr.content || "";
        out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: inner });
      }
      if (rest.length > 0) {
        out.push({ role: "user", content: contentToText(rest) });
      }
    } else if (msg.role === "assistant") {
      const toolUses = msg.content.filter((b) => b.type === "tool_use");
      const textBlocks = msg.content.filter((b) => b.type === "text");

      const assistantMsg = { role: "assistant", content: textBlocks.map((b) => b.text).join("\n") || null };

      if (toolUses.length > 0) {
        assistantMsg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        }));
      }
      out.push(assistantMsg);
    } else {
      out.push({ role: msg.role, content: contentToText(msg.content) });
    }
  }

  return out;
}

function convertTools(tools) {
  if (!tools) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function convertToolChoice(tool_choice) {
  if (!tool_choice) return undefined;
  if (tool_choice.type === "auto") return "auto";
  if (tool_choice.type === "any") return "required";
  if (tool_choice.type === "tool") return { type: "function", function: { name: tool_choice.name } };
  return undefined;
}

function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}

// ============================================================
// Non-streaming response conversion (OpenAI -> Anthropic)
// ============================================================

function convertResponse(openaiResp, modelName) {
  const choice = openaiResp.choices[0];
  const msg = choice.message;
  const content = [];

  if (msg.content) content.push({ type: "text", text: msg.content });

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: modelName,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

// ============================================================
// Streaming conversion (OpenAI SSE -> Anthropic SSE)
// ============================================================

async function streamToAnthropic(openaiStream, res, modelName) {
  const messageId = `msg_${Date.now()}`;
  let buffer = "";
  let currentBlockIndex = 0;
  let textBlockStarted = false;
  const toolCallBlocks = {};

  function send(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  send("message_start", {
    type: "message_start",
    message: {
      id: messageId, type: "message", role: "assistant", model: modelName,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  openaiStream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") continue;

      let parsed;
      try { parsed = JSON.parse(dataStr); } catch (_) { continue; }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        if (!textBlockStarted) {
          send("content_block_start", {
            type: "content_block_start", index: currentBlockIndex,
            content_block: { type: "text", text: "" },
          });
          textBlockStarted = true;
        }
        send("content_block_delta", {
          type: "content_block_delta", index: currentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!(idx in toolCallBlocks)) {
            if (textBlockStarted) {
              send("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });
              textBlockStarted = false;
              currentBlockIndex++;
            }
            toolCallBlocks[idx] = { blockIndex: currentBlockIndex };
            send("content_block_start", {
              type: "content_block_start", index: currentBlockIndex,
              content_block: { type: "tool_use", id: tc.id, name: tc.function?.name, input: {} },
            });
            currentBlockIndex++;
          }
          if (tc.function?.arguments) {
            send("content_block_delta", {
              type: "content_block_delta", index: toolCallBlocks[idx].blockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            });
          }
        }
      }

      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (finishReason) {
        if (textBlockStarted) {
          send("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });
          textBlockStarted = false;
        }
        for (const key of Object.keys(toolCallBlocks)) {
          send("content_block_stop", { type: "content_block_stop", index: toolCallBlocks[key].blockIndex });
        }
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        send("message_stop", { type: "message_stop" });
      }
    }
  });

  return new Promise((resolve) => {
    openaiStream.on("end", () => { res.end(); resolve(); });
    openaiStream.on("error", (err) => {
      console.error("Stream error:", err.message);
      res.end();
      resolve();
    });
  });
}

module.exports = {
  contentToText,
  convertMessages,
  convertTools,
  convertToolChoice,
  mapFinishReason,
  convertResponse,
  streamToAnthropic,
};
