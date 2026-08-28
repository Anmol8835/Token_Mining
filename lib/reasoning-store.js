// ============================================================
// Reasoning content store
//
// DeepSeek thinking-mode models require that every assistant
// message in a multi-turn conversation carries back the
// `reasoning_content` the API generated for that exact turn.
// Claude Code (Anthropic format) has no such field, so the proxy
// must remember it and re-attach it on the next request.
//
// Keys:
//   call:<tool_call_id> — assistant turns that emitted tool calls
//                         (tool_call ids are unique per API call)
//   text:<md5(content)>  — assistant turns that emitted plain text
//                         (history round-trips content verbatim)
// ============================================================

const crypto = require("crypto");

const TTL_MS = 60 * 60 * 1000; // 1 hour — covers any real session
const MAX_ENTRIES = 1000;

class ReasoningStore {
  constructor() {
    this.map = new Map(); // key -> { value, expiresAt }
  }

  put(key, reasoningContent) {
    if (!key || !reasoningContent) return;
    // Evict oldest if at capacity
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value: reasoningContent, expiresAt: Date.now() + TTL_MS });
  }

  get(key) {
    if (!key) return null;
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  /** Store reasoning keyed by every tool_call id in a native response. */
  captureFromMessage(message) {
    if (!message?.reasoning_content) return;
    const reasoning = message.reasoning_content;

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const tc of message.tool_calls) {
        if (tc.id) this.put(`call:${tc.id}`, reasoning);
      }
    } else if (message.content) {
      // Plain-text turn — key by content hash so the next request can
      // find it when the client re-sends the same assistant text.
      const text = typeof message.content === "string" ? message.content : "";
      if (text) {
        const hash = crypto.createHash("md5").update(text).digest("hex");
        this.put(`text:${hash}`, reasoning);
      }
    }
  }
}

module.exports = new ReasoningStore();
