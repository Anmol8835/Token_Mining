// ============================================================
// Profile Classifier — structural signal analysis
// Extracts context size, conversation depth, tool activity,
// vision needs, and streaming intent from the request shape.
// Does NOT look at message content — only structure.
// ============================================================

const {
  extractSystemText,
  totalCharCount,
  countMessagesByRole,
  hasImages,
  hasToolUse,
  hasToolDefinitions,
} = require("./text-utils");

const DEFAULTS = {
  lowCharCount: 500,
  highCharCount: 12000,
  deepConversation: 8,
  longSystemPrompt: 3000,
};

class ProfileClassifier {
  /**
   * @param {object} config - Threshold configuration from server.json
   */
  constructor(config = {}) {
    this.thresholds = { ...DEFAULTS, ...config };
  }

  /**
   * Classify a request based on structural signals only.
   * @param {object} requestBody - Full Anthropic-format request
   * @returns {object} Classification result
   */
  classify(requestBody) {
    const { system, messages } = requestBody;
    const sysText = extractSystemText(system);
    const msgCount = (messages || []).length;
    const roleCounts = countMessagesByRole(messages);
    const charCount = totalCharCount(system, messages);
    const hasVisionContent = hasImages(messages);
    const toolHistory = hasToolUse(messages);
    const toolsDefined = hasToolDefinitions(requestBody);
    const streaming = !!requestBody.stream;

    // --- 1. Context size ---
    const contextSize =
      charCount < this.thresholds.lowCharCount
        ? "tiny"
        : charCount < 3000
          ? "small"
          : charCount < this.thresholds.highCharCount
            ? "large"
            : "massive";

    // --- 2. Conversation depth ---
    const conversationDepth =
      msgCount <= 2
        ? "single"
        : msgCount <= 5
          ? "shallow"
          : msgCount <= this.thresholds.deepConversation
            ? "moderate"
            : "deep";

    // --- 3. Tool activity ---
    const toolActivity = !toolsDefined
      ? "none"
      : !toolHistory
        ? "defined_only"
        : "active";

    // --- 4. System prompt complexity ---
    const systemPromptLength =
      sysText.length < 500
        ? "minimal"
        : sysText.length < this.thresholds.longSystemPrompt
          ? "normal"
          : "elaborate";

    // --- 5. User-to-assistant ratio ---
    const userRatio =
      msgCount > 0 ? roleCounts.user / msgCount : 0;

    // --- Compute complexity score ---
    let complexityScore = 0;

    // Context size → complexity
    if (contextSize === "massive") complexityScore += 2;
    else if (contextSize === "large") complexityScore += 1;
    // tiny/small: no change

    // Conversation depth → complexity
    if (conversationDepth === "deep") complexityScore += 2;
    else if (conversationDepth === "moderate") complexityScore += 1;

    // Tool activity → complexity
    if (toolActivity === "active") complexityScore += 2;
    else if (toolActivity === "defined_only") complexityScore += 1;

    // Visual content → complexity
    if (hasVisionContent) complexityScore += 1;

    // Elaborate system prompt → complexity
    if (systemPromptLength === "elaborate") complexityScore += 1;

    // Map score to complexity label
    const complexity =
      complexityScore >= 5 ? "high"
        : complexityScore >= 2 ? "medium"
        : "low";

    // --- Task type inference ---
    // Profile alone cannot reliably determine task type from structure.
    // It can only detect "agentic" when tools are actively used in a
    // multi-turn conversation.
    let taskType = "chat";
    if (toolActivity === "active" && conversationDepth !== "single") {
      taskType = "agentic";
    }

    // --- Cost sensitivity ---
    const costSensitivity =
      complexity === "low" ? "budget"
        : complexity === "high" ? "standard"
        : "standard";

    // --- Required capabilities ---
    const requiredCapabilities = {
      needsTools: toolActivity !== "none",
      needsVision: hasVisionContent,
      needsStreaming: streaming,
    };

    // --- Confidence ---
    // Profile signals are structural — they correlate with but don't
    // determine classification. Confidence is proportional to how many
    // distinct signals are active.
    const activeSignals = [
      complexityScore > 0,
      toolActivity !== "none",
      hasVisionContent,
      conversationDepth !== "single",
      systemPromptLength !== "minimal",
    ].filter(Boolean).length;

    const confidence = Math.min(activeSignals * 0.12, 0.55);

    return {
      taskType,
      complexity,
      costSensitivity,
      requiredCapabilities,
      confidence,
      source: "profile",
      reason: `Profile: ${contextSize} ctx, ${conversationDepth} conv, tools=${toolActivity}, ` +
        `vision=${hasVisionContent}, streaming=${streaming}, ` +
        `sysPrompt=${systemPromptLength} (score=${complexityScore})`,
      metadata: {
        signals: {
          contextSize,
          conversationDepth,
          toolActivity,
          systemPromptLength,
          hasVision: hasVisionContent,
          streaming,
          userRatio: Math.round(userRatio * 100) / 100,
          charCount,
          msgCount,
        },
      },
    };
  }
}

module.exports = ProfileClassifier;
