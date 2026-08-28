// ============================================================
// Profile Classifier — structural signal analysis (recency-weighted)
//
// Extracts context size, conversation depth, tool activity,
// modality needs, and latency intent from the request shape.
//
// KEY DESIGN PRINCIPLE:
//   Task complexity is determined by RECENT message patterns,
//   NOT by total conversation size. A "Hi" at the end of a
//   50-message coding session is still low complexity.
//   Context metrics inform CAPABILITY requirements (long_context,
//   modalities), not model tier.
//
//   The profile classifier has no semantic knowledge, so it
//   leaves content fields (task, domain, persona, format) to the
//   other signals and only votes on the fields it can actually
//   see: complexity, modalities, capabilities, latency, risk.
// ============================================================

const {
  extractSystemText,
  totalCharCount,
  countMessagesByRole,
  hasImages,
  hasToolUse,
  hasToolDefinitions,
  getLastUserMessage,
  getRecentUserMessages,
  hasRecentToolActivity,
  hasPendingToolResult,
} = require("./text-utils");

const { normalize, applyRoutingRules } = require("./taxonomy");
const { extractSignals } = require("./signals");

const DEFAULTS = {
  lowCharCount: 500,
  highCharCount: 12000,
  deepConversation: 8,
  longSystemPrompt: 3000,
  // Input size (chars) above which a long-context model is
  // considered (rule 16).
  largeInputChars: 20000,
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
   * @returns {object} Normalized classification with source "profile"
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

    // Deterministic content signals: the profile can see these
    // without semantic understanding.
    const contentSignals = extractSignals(requestBody);

    // ----------------------------------------------------------
    // 1. Context capacity metrics (for capability gating — NOT complexity)
    // ----------------------------------------------------------
    const contextSize =
      charCount < this.thresholds.lowCharCount
        ? "tiny"
        : charCount < 3000
          ? "small"
          : charCount < this.thresholds.highCharCount
            ? "large"
            : "massive";

    const conversationDepth =
      msgCount <= 2
        ? "single"
        : msgCount <= 5
          ? "shallow"
          : msgCount <= this.thresholds.deepConversation
            ? "moderate"
            : "deep";

    // ----------------------------------------------------------
    // 2. Recent message analysis (primary signal for complexity)
    // ----------------------------------------------------------
    const lastUserMsg = getLastUserMessage(messages);
    const lastUserMsgLen = lastUserMsg.length;
    const recentUserMsgs = getRecentUserMessages(messages, 3);

    // Wind-down detection: the last 2-3 user messages are all very short.
    const allRecentShort =
      recentUserMsgs.length >= 2 &&
      recentUserMsgs.every((m) => m.length < 30);

    const lastMsgVeryShort = lastUserMsgLen > 0 && lastUserMsgLen < 20;

    // Recent tool activity (only last 6 messages — ancient history doesn't matter).
    const recentToolActive = hasRecentToolActivity(messages, 6);
    const pendingTool = hasPendingToolResult(messages);

    // ----------------------------------------------------------
    // 3. Tool activity scoped to recency
    // ----------------------------------------------------------
    const toolActivity = !toolsDefined
      ? "none"
      : !toolHistory
        ? "defined_only"
        : recentToolActive
          ? "active_recent"
          : "active_past";

    // ----------------------------------------------------------
    // 4. System prompt complexity
    // ----------------------------------------------------------
    const systemPromptLength =
      sysText.length < 500
        ? "minimal"
        : sysText.length < this.thresholds.longSystemPrompt
          ? "normal"
          : "elaborate";

    // ----------------------------------------------------------
    // 5. User-to-assistant ratio
    // ----------------------------------------------------------
    const userRatio = msgCount > 0 ? roleCounts.user / msgCount : 0;

    // ----------------------------------------------------------
    // 6. Task complexity score — RECENCY-WEIGHTED
    //    Context size does NOT contribute to complexity. Only
    //    RECENT patterns matter; context size goes into metadata
    //    for the router's long-context gating instead.
    // ----------------------------------------------------------
    let complexityScore = 0;

    // --- Recent message length (strongest structural signal) ---
    if (lastUserMsgLen > 2000) complexityScore += 2;
    else if (lastUserMsgLen > 500) complexityScore += 1;

    // --- Recent tool activity ---
    if (recentToolActive) {
      complexityScore += 2; // actively using tools RIGHT NOW
    } else if (toolsDefined && toolHistory && !recentToolActive) {
      complexityScore += 1;
    } else if (toolsDefined && !toolHistory) {
      complexityScore += 1;
    }

    // --- Conversation depth (mild, capped by wind-down) ---
    if (conversationDepth === "deep" && !allRecentShort) {
      complexityScore += 1;
    } else if (
      conversationDepth === "moderate" &&
      recentUserMsgs.length >= 2
    ) {
      const avgRecentLen =
        recentUserMsgs.reduce((s, m) => s + m.length, 0) /
        recentUserMsgs.length;
      if (avgRecentLen > 200) complexityScore += 1;
    }

    // --- Vision content ---
    if (hasVisionContent) complexityScore += 1;

    // --- Elaborate system prompt ---
    if (systemPromptLength === "elaborate") complexityScore += 1;

    // --- Deterministic risk escalates the effort required ---
    if (contentSignals.risk === "high" || contentSignals.risk === "restricted") {
      complexityScore += 1;
    }

    // ----------------------------------------------------------
    // 7. Wind-down override: last 2+ user messages all < 30 chars
    //    means the conversation is winding down regardless of
    //    what happened earlier. Cap complexity at low (score ≤ 1).
    // ----------------------------------------------------------
    if (allRecentShort) {
      complexityScore = Math.min(complexityScore, 1);
    }

    // ----------------------------------------------------------
    // 8. Map score to complexity label
    // ----------------------------------------------------------
    const complexity =
      complexityScore >= 5 ? "high"
        : complexityScore >= 2 ? "medium"
        : "low";

    // ----------------------------------------------------------
    // 9. Modalities & capabilities — the profile's real strength
    // ----------------------------------------------------------
    const input_modalities = contentSignals.input_modalities;
    const capabilities = [];

    if (toolsDefined || toolHistory) capabilities.push("tool_use");
    if (hasVisionContent) capabilities.push("vision");
    if (
      input_modalities.includes("image") ||
      input_modalities.includes("audio")
    ) {
      // Vision/audio are already covered above for images; audio
      // is surfaced through the modality list to the router.
      if (input_modalities.includes("audio")) capabilities.push("audio");
    }
    // Rule 16: large input → long context.
    const hasLargeInput = charCount > this.thresholds.largeInputChars;
    if (hasLargeInput) capabilities.push("long_context");
    if (pendingTool && (toolsDefined || toolHistory)) {
      capabilities.push("code_execution");
    }

    // ----------------------------------------------------------
    // 10. Risk — profile can only echo deterministic detection
    // ----------------------------------------------------------
    const risk = contentSignals.risk;

    // ----------------------------------------------------------
    // 11. Confidence
    //
    // Confidence is proportional to how many distinct RECENT
    // signals are active. Wind-down REDUCES confidence about
    // complexity (though we are MORE confident it is low).
    // ----------------------------------------------------------
    const activeSignals = [
      lastUserMsgLen > 100,
      recentToolActive || toolsDefined,
      hasVisionContent,
      conversationDepth !== "single",
      systemPromptLength !== "minimal",
      hasLargeInput,
      input_modalities.includes("code"),
    ].filter(Boolean).length;

    let confidence = Math.min(activeSignals * 0.12, 0.55);
    if (allRecentShort && complexity === "low") {
      confidence = Math.max(confidence, 0.50);
    }

    // ----------------------------------------------------------
    // 12. Assemble — content fields are left at taxonomy defaults
    //     because the profile cannot see them; fusion weights mean
    //     those defaults barely contribute votes on content fields.
    // ----------------------------------------------------------
    const result = normalize({
      capabilities,
      input_modalities,
      complexity,
      risk,
      freshness: contentSignals.freshness,
      latency_preference: contentSignals.latency_preference,
      routing: {
        tools: [],
        use_multi_step_pipeline: false,
        human_review_recommended: false,
      },
      confidence,
      reason:
        `Profile: recent=${lastUserMsgLen}chars, tools=${toolActivity}, ` +
        `conv=${conversationDepth}, ctx=${contextSize}, ` +
        `vision=${hasVisionContent}, streaming=${streaming}, ` +
        `sysPrompt=${systemPromptLength} (score=${complexityScore})`,
    });

    const routed = applyRoutingRules(result, {
      hasLargeInput,
      hasToolDefinitions: toolsDefined,
      safetySensitive: contentSignals.safetySensitive,
      // The profile cannot judge task type, so it must not force a
      // task-derived model type. Deriving one from the default task
      // would only add noise.
      forceModelType: false,
    });
    // Undo the derivation — the profile has no task opinion.
    routed.routing.model_type = "general_model";

    return {
      ...routed,
      source: "profile",
      metadata: {
        // Fusion uses this to exclude the profile's model_type from
        // voting — it is a structural signal with no task opinion.
        noTaskOpinion: true,
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
          lastUserMsgLen,
          allRecentShort,
          recentToolActive,
          pendingTool,
          hasLargeInput,
          modalities: input_modalities,
        },
      },
    };
  }
}

module.exports = ProfileClassifier;
