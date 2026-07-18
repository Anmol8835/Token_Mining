// ============================================================
// Rule-based request classifier
// Fast, zero-cost heuristics that run on every request.
// Returns a classification with a confidence score.
// ============================================================

const {
  extractSystemText,
  extractAllText,
  getFirstUserMessage,
  getRecentUserMessages,
  totalCharCount,
  hasImages,
  hasToolUse,
  hasToolDefinitions,
} = require("./text-utils");

// ----------------------------------------------------------
// Classification heuristics
// Each returns { complexity, taskType, confidence, reason } or null
// ----------------------------------------------------------

function checkClaudeCode(system, messages) {
  const sysText = extractSystemText(system);
  if (!sysText.includes("Claude Code") && !sysText.includes("You are Claude")) {
    return null;
  }

  // Claude Code detected. Check if it's ACTUALLY doing agentic work.
  const allText = extractAllText(messages).toLowerCase();

  // Strong signals of real agentic/coding work: prior tool use, multi-turn tool chains
  const hasToolHistory = hasToolUse(messages);
  const msgCount = messages ? messages.length : 0;

  if (hasToolHistory && msgCount > 4) {
    return {
      complexity: "high",
      taskType: "agentic",
      confidence: 0.95,
      reason: "Claude Code with active tool use (multi-turn)",
    };
  }

  // Check user message for agentic/coding intent
  const codingActionPatterns = [
    "fix", "debug", "refactor", "implement", "rewrite", "optimize",
    "add a", "create a", "build a", "change the", "modify", "update the code",
    "write code", "write a function", "generate code",
  ];
  const isCodingAction = codingActionPatterns.some((p) => allText.includes(p));

  if (isCodingAction) {
    return {
      complexity: "high",
      taskType: "coding",
      confidence: 0.85,
      reason: "Claude Code + coding action request",
    };
  }

  const analysisPatterns = [
    "explain this code", "analyze this", "review this", "what does this do",
    "why is this", "how does this work", "find the bug in", "what's wrong with",
  ];
  const isAnalysis = analysisPatterns.some((p) => allText.includes(p));

  if (isAnalysis) {
    return {
      complexity: "medium",
      taskType: "analysis",
      confidence: 0.80,
      reason: "Claude Code + analysis request",
    };
  }

  // Claude Code detected but message is a simple question/chat
  return null;
}

function checkToolsPresent(requestBody) {
  if (!hasToolDefinitions(requestBody)) return null;

  const hasHistory = hasToolUse(requestBody.messages);
  const msgCount = requestBody.messages ? requestBody.messages.length : 0;

  if (hasHistory) {
    return {
      complexity: msgCount > 4 ? "high" : "medium",
      taskType: "agentic",
      confidence: 0.90,
      reason: "Tools present with active tool use history",
    };
  }

  // Tools defined but no prior tool use — low confidence
  return {
    complexity: "medium",
    taskType: "agentic",
    confidence: 0.50,
    reason: "Tools defined but no history yet",
  };
}

function checkSystemPromptKeywords(system) {
  const sysText = extractSystemText(system).toLowerCase();
  if (!sysText) return null;

  const patterns = [
    {
      keywords: ["expert software engineer", "senior developer", "staff engineer"],
      taskType: "coding",
      complexity: "high",
      confidence: 0.9,
    },
    {
      keywords: ["code", "programming", "debug", "refactor", "function", "algorithm", "bug"],
      taskType: "coding",
      complexity: "medium",
      confidence: 0.7,
    },
    {
      keywords: ["explain", "analyze", "evaluate", "compare", "research", "investigate"],
      taskType: "analysis",
      complexity: "medium",
      confidence: 0.7,
    },
    {
      keywords: ["write a story", "creative", "poem", "fiction", "narrative"],
      taskType: "creative",
      complexity: "medium",
      confidence: 0.8,
    },
    {
      keywords: ["summarize", "summarization", "tldr", "brief", "summary", "condense"],
      taskType: "summarization",
      complexity: "low",
      confidence: 0.85,
    },
    {
      keywords: ["translate", "translation"],
      taskType: "translation",
      complexity: "low",
      confidence: 0.9,
    },
    {
      keywords: ["extract", "parse", "pull out", "list all"],
      taskType: "extraction",
      complexity: "low",
      confidence: 0.8,
    },
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
  // Also check the most recent user message (may differ in multi-turn)
  const recentMsgs = getRecentUserMessages(messages, 2);
  const lastMsg = recentMsgs.length > 0 ? recentMsgs[0].toLowerCase() : "";
  const allText = extractAllText(messages).toLowerCase();

  // Combine first message + last message + all text for keyword matching
  const combined = [firstMsg, lastMsg, allText].join(" ");

  if (!combined.trim()) return null;

  const patterns = [
    {
      keywords: ["debug", "fix this bug", "error:", "exception", "stack trace", "race condition"],
      taskType: "coding",
      complexity: "high",
      confidence: 0.75,
    },
    {
      keywords: ["write a function", "implement", "code that", "refactor this"],
      taskType: "coding",
      complexity: "medium",
      confidence: 0.8,
    },
    {
      keywords: ["explain how", "why does", "what is the difference", "compare"],
      taskType: "analysis",
      complexity: "medium",
      confidence: 0.7,
    },
    {
      keywords: ["write a poem", "tell me a story", "creative writing"],
      taskType: "creative",
      complexity: "medium",
      confidence: 0.85,
    },
    {
      keywords: ["summarize this", "give me a summary", "tldr"],
      taskType: "summarization",
      complexity: "low",
      confidence: 0.9,
    },
    {
      keywords: ["translate", "in english", "in french"],
      taskType: "translation",
      complexity: "low",
      confidence: 0.9,
    },
    {
      keywords: ["hello", "hi", "how are you", "what's up"],
      taskType: "chat",
      complexity: "low",
      confidence: 0.85,
    },
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
  return { complexity: "medium", confidence: 0.3 };
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

  // ---- Trivial message override ----
  // Only applies when there are NO tools present and NO tool history.
  // A short message in a tool-use session is NOT trivial.
  const hasTools = hasToolDefinitions(requestBody) || hasToolUse(messages);
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

  if (!hasTools && (isTrivial || isVeryShort) && bestResult.complexity !== "low") {
    bestResult = {
      complexity: "low",
      taskType:
        bestResult.taskType === "agentic" || bestResult.taskType === "chat"
          ? "chat"
          : bestResult.taskType,
      confidence: 0.9,
      reason: `Simple user message override: "${firstUserMsg}"`,
    };
  }

  // ---- Build requiredCapabilities from request structure ----
  const requiredCapabilities = {
    needsTools: hasToolUse(messages) || hasToolDefinitions(requestBody),
    needsVision: hasImages(messages),
    needsStreaming: !!requestBody.stream,
  };

  return {
    taskType: bestResult.taskType,
    complexity: bestResult.complexity,
    costSensitivity:
      bestResult.complexity === "low"
        ? "budget"
        : bestResult.complexity === "high"
          ? "standard"
          : "standard",
    requiredCapabilities,
    confidence: bestResult.confidence,
    source: "rule",
    reason: bestResult.reason,
  };
}

module.exports = { classify };
