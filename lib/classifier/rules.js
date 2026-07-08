// ============================================================
// Rule-based request classifier
// Fast, zero-cost heuristics that run on every request.
// Returns a classification with a confidence score.
// ============================================================

/**
 * Extract all text from a system prompt (string or array of blocks).
 */
function extractSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((s) => s.text || s.type === "text" ? s.text : "").join("\n");
  }
  return "";
}

/**
 * Extract text from all messages for analysis.
 */
function extractAllText(messages) {
  if (!messages) return "";
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
    return "";
  }).join("\n");
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
 * Count total characters across all messages.
 */
function totalCharCount(system, messages) {
  const sysLen = extractSystemText(system).length;
  const msgLen = messages ? messages.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length;
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s, b) => s + (b.text || "").length, 0);
    }
    return sum;
  }, 0) : 0;
  return sysLen + msgLen;
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
      if (msg.content.some((b) => b.type === "tool_use" || b.type === "tool_result")) return true;
    }
  }
  return false;
}

// ----------------------------------------------------------
// Classification heuristics
// Each returns { complexity, taskType, confidence } or null
// ----------------------------------------------------------

function checkClaudeCode(system, messages) {
  const sysText = extractSystemText(system);
  if (!sysText.includes("Claude Code") && !sysText.includes("You are Claude")) {
    return null;
  }

  // Claude Code detected. Now check if it's ACTUALLY doing agentic work.
  // Simple questions through Claude Code are still just "chat".
  const allText = extractAllText(messages).toLowerCase();
  const firstUserMsg = getFirstUserMessage(messages).toLowerCase();

  // Strong signals of real agentic/coding work: prior tool use, multi-turn tool chains
  const hasToolHistory = hasToolUse(messages);
  const msgCount = messages ? messages.length : 0;

  if (hasToolHistory && msgCount > 4) {
    // Active multi-turn tool use — genuinely agentic
    return { complexity: "high", taskType: "agentic", confidence: 0.95,
      reason: "Claude Code with active tool use (multi-turn)" };
  }

  // Check user message for agentic/coding intent vs just a question
  const codingActionPatterns = [
    "fix", "debug", "refactor", "implement", "rewrite", "optimize",
    "add a", "create a", "build a", "change the", "modify", "update the code",
    "write code", "write a function", "generate code",
  ];
  const isCodingAction = codingActionPatterns.some((p) => allText.includes(p));

  if (isCodingAction) {
    return { complexity: "high", taskType: "coding", confidence: 0.85,
      reason: "Claude Code + coding action request" };
  }

  const analysisPatterns = [
    "explain this code", "analyze this", "review this", "what does this do",
    "why is this", "how does this work", "find the bug in", "what's wrong with",
  ];
  const isAnalysis = analysisPatterns.some((p) => allText.includes(p));

  if (isAnalysis) {
    return { complexity: "medium", taskType: "analysis", confidence: 0.80,
      reason: "Claude Code + analysis request" };
  }

  // Claude Code detected but message is a simple question/chat/conversation
  // → don't force agentic, let other heuristics decide
  return null;
}

function checkToolsPresent(requestBody) {
  if (!requestBody.tools || requestBody.tools.length === 0) return null;

  // Tools are defined — check if they're actually being used
  const hasHistory = hasToolUse(requestBody.messages);
  const msgCount = requestBody.messages ? requestBody.messages.length : 0;

  if (hasHistory) {
    // Prior tool_use or tool_result blocks exist — this IS agentic
    return {
      complexity: msgCount > 4 ? "high" : "medium",
      taskType: "agentic",
      confidence: 0.90,
      reason: "Tools present with active tool use history",
    };
  }

  // Tools defined but no prior tool use — could just be the first message
  // of a session. Don't force agentic; let the user message decide.
  return {
    complexity: "medium",
    taskType: "agentic",
    confidence: 0.50,           // LOW confidence → falls through to user message check
    reason: "Tools defined but no history yet",
  };
}

function checkSystemPromptKeywords(system) {
  const sysText = extractSystemText(system).toLowerCase();
  if (!sysText) return null;

  const patterns = [
    { keywords: ["expert software engineer", "senior developer", "staff engineer"], taskType: "coding", complexity: "high", confidence: 0.9 },
    { keywords: ["code", "programming", "debug", "refactor", "function", "algorithm", "bug"], taskType: "coding", complexity: "medium", confidence: 0.7 },
    { keywords: ["explain", "analyze", "evaluate", "compare", "research", "investigate"], taskType: "analysis", complexity: "medium", confidence: 0.7 },
    { keywords: ["write a story", "creative", "poem", "fiction", "narrative"], taskType: "creative", complexity: "medium", confidence: 0.8 },
    { keywords: ["summarize", "summarization", "tldr", "brief", "summary", "condense"], taskType: "summarization", complexity: "low", confidence: 0.85 },
    { keywords: ["translate", "translation"], taskType: "translation", complexity: "low", confidence: 0.9 },
    { keywords: ["extract", "parse", "pull out", "list all"], taskType: "extraction", complexity: "low", confidence: 0.8 },
  ];

  let bestMatch = null;
  for (const pattern of patterns) {
    const matched = pattern.keywords.some((kw) => sysText.includes(kw));
    if (matched && (!bestMatch || pattern.confidence > bestMatch.confidence)) {
      bestMatch = {
        complexity: pattern.complexity,
        taskType: pattern.taskType,
        confidence: pattern.confidence,
        reason: `System prompt matches: ${pattern.taskType}`,
      };
    }
  }
  return bestMatch;
}

function checkUserMessageKeywords(messages) {
  const firstMsg = getFirstUserMessage(messages).toLowerCase();
  const allText = extractAllText(messages).toLowerCase();
  if (!firstMsg && !allText) return null;

  const combined = firstMsg + " " + allText;

  const patterns = [
    { keywords: ["debug", "fix this bug", "error:", "exception", "stack trace", "race condition"], taskType: "coding", complexity: "high", confidence: 0.75 },
    { keywords: ["write a function", "implement", "code that", "refactor this"], taskType: "coding", complexity: "medium", confidence: 0.8 },
    { keywords: ["explain how", "why does", "what is the difference", "compare"], taskType: "analysis", complexity: "medium", confidence: 0.7 },
    { keywords: ["write a poem", "tell me a story", "creative writing"], taskType: "creative", complexity: "medium", confidence: 0.85 },
    { keywords: ["summarize this", "give me a summary", "tldr"], taskType: "summarization", complexity: "low", confidence: 0.9 },
    { keywords: ["translate", "in english", "in french"], taskType: "translation", complexity: "low", confidence: 0.9 },
    { keywords: ["hello", "hi", "how are you", "what's up"], taskType: "chat", complexity: "low", confidence: 0.85 },
  ];

  let bestMatch = null;
  for (const pattern of patterns) {
    const matched = pattern.keywords.some((kw) => combined.includes(kw));
    if (matched && (!bestMatch || pattern.confidence > bestMatch.confidence)) {
      bestMatch = {
        complexity: pattern.complexity,
        taskType: pattern.taskType,
        confidence: pattern.confidence,
        reason: `User message matches: ${pattern.taskType}`,
      };
    }
  }
  return bestMatch;
}

function checkComplexitySignals(system, messages) {
  const sysText = extractSystemText(system);
  const allText = extractAllText(messages);
  const combined = (sysText + " " + allText).toLowerCase();

  const charCount = totalCharCount(system, messages);
  const msgCount = messages ? messages.length : 0;
  const hasVision = hasImages(messages);

  const signals = [];

  if (charCount < 300) signals.push("low");
  if (charCount > 8000) signals.push("high");
  if (msgCount > 8) signals.push("high");
  if (msgCount <= 2 && charCount < 500) signals.push("low");
  if (hasVision) signals.push("high");

  const highCount = signals.filter((s) => s === "high").length;
  const lowCount = signals.filter((s) => s === "low").length;

  if (highCount > lowCount) {
    return { complexity: "high", confidence: 0.6 };
  } else if (lowCount > highCount) {
    return { complexity: "low", confidence: 0.6 };
  }
  return { complexity: "medium", confidence: 0.3 }; // Uncertain
}

// ----------------------------------------------------------
// Main classification function
// ----------------------------------------------------------

function classify(requestBody) {
  const { system, messages } = requestBody;

  // Run all heuristics in order of confidence
  const checks = [
    checkClaudeCode(system, messages),
    checkToolsPresent(requestBody),
    checkSystemPromptKeywords(system),
    checkUserMessageKeywords(messages),
  ];

  let bestResult = null;
  for (const result of checks) {
    if (result && (!bestResult || result.confidence > bestResult.confidence)) {
      bestResult = result;
    }
  }

  // If no heuristic matched, use complexity signals
  if (!bestResult) {
    const signals = checkComplexitySignals(system, messages);
    bestResult = {
      complexity: signals.complexity,
      taskType: "chat",
      confidence: signals.confidence,
      reason: "Complexity signals only",
    };
  }

  // ---- Final override: if the actual user message is trivially simple,
  //      downgrade complexity even if system prompt / tools suggest otherwise ----
  const firstUserMsg = getFirstUserMessage(messages).toLowerCase().trim();
  const trivialPatterns = [
    /^hi\b/, /^hello\b/, /^hey\b/, /^yo\b/, /^sup\b/,
    /^thanks?\b/, /^ty\b/, /^ok\b/, /^okay\b/, /^k\b/,
    /^yes\b/, /^no\b/, /^yep\b/, /^nope\b/,
    /^bye\b/, /^goodbye\b/, /^cya\b/, /^later\b/,
    /^what's up\b/, /^howdy\b/,
    /^good morning\b/, /^good evening\b/, /^good night\b/,
    /^nice\b/,
  ];

  const isTrivial = trivialPatterns.some((p) => p.test(firstUserMsg));
  const isVeryShort = firstUserMsg.length > 0 && firstUserMsg.length < 15;

  if ((isTrivial || isVeryShort) && bestResult.complexity !== "low") {
    bestResult = {
      complexity: "low",
      taskType: bestResult.taskType === "agentic" || bestResult.taskType === "chat" ? "chat" : bestResult.taskType,
      confidence: 0.9,
      reason: `Simple user message override: "${firstUserMsg}"`,
    };
  }

  return {
    taskType: bestResult.taskType,
    complexity: bestResult.complexity,
    costSensitivity: bestResult.complexity === "low" ? "budget"
      : bestResult.complexity === "high" ? "standard"
      : "standard",
    confidence: bestResult.confidence,
    source: "rule",
    reason: bestResult.reason,
  };
}

module.exports = { classify };
