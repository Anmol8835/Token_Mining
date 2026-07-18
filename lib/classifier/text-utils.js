// ============================================================
// Shared text extraction utilities for all classifiers
// ============================================================

const crypto = require("crypto");

/**
 * Extract all text from a system prompt (string or array of blocks).
 */
function extractSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((s) => (s.text || (s.type === "text" ? s.text : "")))
      .join("\n");
  }
  return "";
}

/**
 * Extract text from all messages for analysis.
 */
function extractAllText(messages) {
  if (!messages) return "";
  return messages
    .map((msg) => {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      }
      return "";
    })
    .join("\n");
}

/**
 * Get the first user message text.
 */
function getFirstUserMessage(messages) {
  if (!messages) return "";
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      }
    }
  }
  return "";
}

/**
 * Get text content from a single message (any role).
 */
function getMessageText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * Get the last N user messages as an array of strings.
 * Returns newest-first (index 0 = most recent).
 */
function getRecentUserMessages(messages, n) {
  if (!messages) return [];
  const userMsgs = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const text = getMessageText(messages[i]);
      if (text) userMsgs.push(text);
      if (userMsgs.length >= n) break;
    }
  }
  return userMsgs;
}

/**
 * Count total characters across system prompt and all messages.
 */
function totalCharCount(system, messages) {
  const sysLen = extractSystemText(system).length;
  const msgLen = messages
    ? messages.reduce((sum, m) => {
        if (typeof m.content === "string") return sum + m.content.length;
        if (Array.isArray(m.content)) {
          return (
            sum +
            m.content.reduce((s, b) => s + (b.text || "").length, 0)
          );
        }
        return sum;
      }, 0)
    : 0;
  return sysLen + msgLen;
}

/**
 * Count messages by role.
 * Returns { user: n, assistant: n }.
 */
function countMessagesByRole(messages) {
  const counts = { user: 0, assistant: 0 };
  if (!messages) return counts;
  for (const msg of messages) {
    if (msg.role === "user") counts.user++;
    else if (msg.role === "assistant") counts.assistant++;
  }
  return counts;
}

/**
 * Check if any content blocks contain images.
 */
function hasImages(messages) {
  if (!messages) return false;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      if (msg.content.some((b) => b.type === "image")) return true;
    }
  }
  return false;
}

/**
 * Check if any content blocks contain tool_use or tool_result.
 */
function hasToolUse(messages) {
  if (!messages) return false;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      if (
        msg.content.some(
          (b) => b.type === "tool_use" || b.type === "tool_result"
        )
      )
        return true;
    }
  }
  return false;
}

/**
 * Check if the request defines tools.
 */
function hasToolDefinitions(requestBody) {
  return !!(requestBody.tools && requestBody.tools.length > 0);
}

/**
 * Hash the last N messages for cache key generation.
 * Returns an array of MD5 hex strings (one per message, newest first).
 * If fewer than N messages, returns hashes for all available.
 */
function hashMessages(messages, n) {
  if (!messages || messages.length === 0) return [];
  const slice = messages.slice(-n);
  return slice.map((m) =>
    crypto.createHash("md5").update(JSON.stringify(m)).digest("hex")
  );
}

module.exports = {
  extractSystemText,
  extractAllText,
  getFirstUserMessage,
  getMessageText,
  getRecentUserMessages,
  totalCharCount,
  countMessagesByRole,
  hasImages,
  hasToolUse,
  hasToolDefinitions,
  hashMessages,
};
