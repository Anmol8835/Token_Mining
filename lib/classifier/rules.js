// ============================================================
// Rule-based prompt classifier
// Fast, zero-cost heuristics that run on every request.
//
// KEY DESIGN PRINCIPLE (cost-reduction focus):
//   The most RECENT user message is the primary signal for
//   task and complexity. System prompts indicate DOMAIN but say
//   NOTHING about how HARD the current request is. "Run npm dev"
//   in a Claude Code session is still a simple operational task.
//
// Emits the full classification taxonomy. Non-task fields
// (domain, risk, freshness, persona, modalities) come from the
// deterministic detectors in signals.js.
// ============================================================

const {
  getLastUserMessage,
  getRecentUserMessages,
  totalCharCount,
  hasImages,
  hasToolUse,
  hasToolDefinitions,
  hasRecentToolActivity,
  hasPendingToolResult,
} = require("./text-utils");

const { containsWord, extractSignals } = require("./signals");
const { normalize, applyRoutingRules } = require("./taxonomy");

// ----------------------------------------------------------
// Task patterns
//
// Ordered from most specific to most general. Each entry maps
// keyword evidence to a primary_task plus a baseline complexity.
// Confidence reflects how *diagnostic* the keywords are, not how
// important the task is.
// ----------------------------------------------------------

const TASK_PATTERNS = [
  // ---------- Code: heavy ----------
  {
    task: "debugging",
    complexity: "high",
    confidence: 0.85,
    keywords: [
      "debug", "fix this bug", "fix the bug", "fix that bug", "why is this failing",
      "stack trace", "traceback", "exception", "error:", "throws an error",
      "not working", "race condition", "deadlock", "memory leak", "segfault",
      "flaky test", "reproduce the issue", "root cause of this error",
    ],
  },
  {
    task: "code_refactoring",
    complexity: "high",
    confidence: 0.85,
    keywords: [
      "refactor", "clean up this code", "restructure", "extract a function",
      "reduce duplication", "simplify this code", "make this more readable",
      "split this file", "decouple", "modernize this code",
    ],
  },
  {
    task: "code_review",
    complexity: "high",
    confidence: 0.85,
    keywords: [
      "review this code", "code review", "review my", "critique this code",
      "what's wrong with this code", "any issues with this", "audit this code",
      "security review", "review the pull request", "review this pr",
      // Generic "review this X" where X is a code artifact
      "review this", "review the",
    ],
  },
  {
    task: "technical_design",
    complexity: "high",
    confidence: 0.8,
    keywords: [
      "system design", "architecture", "design pattern", "how should i structure",
      "rearchitect", "redesign", "design a system", "scalable design",
      "technical design", "schema design", "api design", "tradeoffs between",
      "microservice", "should i use a queue",
    ],
  },
  {
    task: "code_generation",
    complexity: "medium",
    confidence: 0.82,
    keywords: [
      "write a function", "write code", "implement", "generate code", "code that",
      "create an api", "build a component", "write a script", "add a feature",
      "write a class", "create an endpoint", "write a test", "add a test",
      "scaffold", "boilerplate", "write a query",
    ],
  },
  {
    task: "code_completion",
    complexity: "low",
    confidence: 0.8,
    keywords: [
      "finish this function", "complete this code", "complete the function",
      "fill in the rest", "finish the implementation", "continue this code",
      "what comes next in this code",
    ],
  },
  {
    task: "code_explanation",
    complexity: "medium",
    confidence: 0.78,
    keywords: [
      "explain this code", "explain the code", "what does this code do",
      "what does this function do", "how does this code work",
      "walk me through this code", "what does this line do",
      "what is this regex", "explain this error",
    ],
  },
  {
    task: "command_generation",
    complexity: "low",
    confidence: 0.82,
    keywords: [
      "run npm", "npm run", "npm install", "npm test", "run the app",
      "run the server", "start the server", "run the test", "git command",
      "shell command", "bash command", "docker command", "kubectl",
      "curl command", "what's the command", "how do i run", "deploy",
      "build the project", "install the package", "terminal command",
    ],
  },

  // ---------- Knowledge ----------
  {
    task: "fact_check",
    complexity: "medium",
    confidence: 0.85,
    keywords: [
      "is it true", "is this true", "fact check", "fact-check", "verify that",
      "verify this claim", "debunk", "confirm whether", "did they really",
      "i heard that", "someone told me", "is it accurate", "myth or fact",
      "true or false",
    ],
  },
  {
    task: "research",
    complexity: "high",
    confidence: 0.82,
    keywords: [
      "research", "literature review", "survey the", "gather sources",
      "cite sources", "with citations", "find studies", "what do the studies say",
      "compile information", "in depth report on", "state of the art",
      "comprehensive overview of", "look across",
    ],
  },
  {
    task: "fact_lookup",
    complexity: "low",
    confidence: 0.78,
    keywords: [
      "what is the capital", "who invented", "who wrote", "when did", "what year",
      "how many", "how tall", "how far", "define", "definition of",
      "what does it stand for", "who is", "where is", "what is the population",
      "what's the difference between",
      // Current-value lookups: still "known information", just volatile.
      "what is the current", "what's the current", "what is the price",
      "what's the price", "how much is", "how much does", "current price of",
      "stock price", "exchange rate", "what is the weather", "what's the weather",
    ],
  },
  {
    task: "explanation",
    complexity: "medium",
    confidence: 0.7,
    keywords: [
      "explain", "why does", "why do", "how does", "what causes", "what happens when",
      "help me understand", "the reason behind", "how come",
    ],
  },
  {
    task: "tutoring",
    complexity: "medium",
    confidence: 0.8,
    keywords: [
      "teach me", "explain like i'm", "eli5", "i'm learning", "i am learning",
      "walk me through step by step", "practice problems", "quiz me",
      "give me exercises", "beginner friendly", "as a student",
    ],
  },

  // ---------- Reasoning ----------
  {
    task: "mathematics",
    complexity: "high",
    confidence: 0.85,
    keywords: [
      "solve for", "calculate", "compute the", "integral", "derivative",
      "differentiate", "equation", "prove that", "theorem", "matrix",
      "probability that", "factorial", "logarithm", "what is the sum of",
      "percentage of", "simplify the expression",
    ],
  },
  {
    task: "logical_reasoning",
    complexity: "high",
    confidence: 0.8,
    keywords: [
      "logic puzzle", "riddle", "if all", "deduce", "syllogism",
      "who is telling the truth", "brain teaser", "logically follows",
      "is this argument valid", "fallacy",
    ],
  },
  {
    task: "prediction",
    complexity: "high",
    confidence: 0.8,
    keywords: [
      "predict", "forecast", "will it", "will they", "what will happen",
      "how likely is", "probability of it happening", "projection",
      "expected to reach", "outlook for", "by 2030", "by 2040",
      "future of", "trend going forward",
    ],
  },
  {
    task: "analysis",
    complexity: "high",
    confidence: 0.75,
    keywords: [
      "analyze", "analyse", "analysis of", "interpret", "identify patterns",
      "what does this data show", "find trends", "root cause", "break down the",
      "evaluate", "assess", "what insights", "correlation between",
    ],
  },
  {
    task: "decision_support",
    complexity: "high",
    confidence: 0.82,
    keywords: [
      "should i choose", "which is better", "pros and cons", "help me decide",
      "which one should", "tradeoffs", "trade-offs", "compare and recommend",
      "what would you recommend", "worth it", "a or b",
    ],
  },
  {
    task: "planning",
    complexity: "high",
    confidence: 0.82,
    keywords: [
      "make a plan", "create a plan", "roadmap", "itinerary", "schedule for",
      "timeline for", "steps to launch", "how should i approach",
      "project plan", "strategy for", "organize a", "milestones",
    ],
  },

  // ---------- Text transformation ----------
  {
    task: "summarization",
    complexity: "low",
    confidence: 0.88,
    keywords: [
      "summarize", "summarise", "summary of", "tldr", "tl;dr", "key points",
      "condense", "in a nutshell", "brief overview", "main takeaways",
      "shorten this to",
    ],
  },
  {
    task: "extraction",
    complexity: "low",
    confidence: 0.85,
    keywords: [
      "extract", "pull out", "parse out", "list all the names", "get the dates",
      "find all the emails", "pull the numbers", "structured data from",
      "into json", "tabulate the",
    ],
  },
  {
    task: "classification",
    complexity: "low",
    confidence: 0.85,
    keywords: [
      "classify", "categorize", "categorise", "label this", "which category",
      "sentiment of", "is this spam", "tag this", "bucket these", "sort these into",
    ],
  },
  {
    task: "translation",
    complexity: "low",
    confidence: 0.9,
    keywords: [
      "translate", "translation of", "in spanish", "in french", "in german",
      "in japanese", "in chinese", "in hindi", "to english", "say this in",
      "how do you say",
    ],
  },
  {
    task: "rewriting",
    complexity: "low",
    confidence: 0.85,
    keywords: [
      "rewrite", "rephrase", "reword", "proofread", "fix the grammar",
      "make this more formal", "make it casual", "improve the wording",
      "polish this", "make this clearer", "edit this text", "tighten this up",
    ],
  },
  {
    task: "completion",
    complexity: "low",
    confidence: 0.8,
    keywords: [
      "continue this", "finish this sentence", "complete the following",
      "keep writing", "what comes next", "finish the paragraph",
      "continue where i left off",
    ],
  },

  // ---------- Generation ----------
  {
    task: "creative_generation",
    complexity: "medium",
    confidence: 0.85,
    keywords: [
      "write a story", "write a poem", "tell me a story", "creative writing",
      "write a song", "write lyrics", "screenplay", "write a scene",
      "short story", "haiku", "fiction about", "write a joke",
    ],
  },
  {
    task: "document_generation",
    complexity: "medium",
    confidence: 0.82,
    keywords: [
      "write a report", "draft a proposal", "write an email", "draft an email",
      "cover letter", "write a memo", "create a document", "write the docs",
      "write documentation", "product requirements", "write a contract",
      "draft a letter", "press release", "write a blog post",
      // "write me a X" / "give me a X" phrasings
      "write me a report", "write me an email", "give me a report",
      "draft me a", "put together a report", "write up a",
    ],
  },
  {
    task: "brainstorming",
    complexity: "medium",
    confidence: 0.85,
    keywords: [
      "brainstorm", "ideas for", "give me ideas", "come up with names",
      "suggestions for", "list some options", "what are some ways",
      "name ideas", "possible approaches",
    ],
  },

  // ---------- Interaction ----------
  {
    task: "interview_simulation",
    complexity: "medium",
    confidence: 0.88,
    keywords: [
      "mock interview", "interview me", "practice interview", "behavioral interview",
      "technical interview practice", "ask me interview questions",
      "simulate an interview",
    ],
  },
  {
    task: "roleplay",
    complexity: "medium",
    confidence: 0.85,
    keywords: [
      "let's roleplay", "role play", "stay in character", "dungeon master",
      "pretend we are", "you play the role", "in character as",
      "text adventure", "improv scene",
    ],
  },
  {
    task: "advice",
    complexity: "medium",
    confidence: 0.75,
    keywords: [
      "what should i do", "any advice", "advice on", "how do i deal with",
      "tips for", "how can i improve my", "what would you do if",
      "is it a good idea to", "help me with my situation",
      // Personal-applicability questions, including health/finance ones
      "should i take", "should i use", "is it safe to", "is it safe for",
      "how much should i", "what dosage", "do i need to see",
      "am i allowed to", "can i legally", "whether my landlord can",
      "can my landlord", "am i entitled to",
    ],
  },
  {
    task: "general_conversation",
    complexity: "low",
    confidence: 0.8,
    keywords: [
      "hello", "hi", "hey", "how are you", "what's up", "good morning",
      "thanks", "thank you", "who are you", "tell me about yourself",
    ],
  },
];

// ----------------------------------------------------------
// Trivial messages — a wind-down turn should never inherit the
// complexity of the work that came before it.
// ----------------------------------------------------------

const TRIVIAL_PATTERNS = [
  /^hi\b/, /^hello\b/, /^hey\b/, /^yo\b/, /^sup\b/,
  /^thanks?\b/, /^ty\b/, /^ok\b/, /^okay\b/, /^k$/,
  /^yes\b/, /^no\b/, /^yep\b/, /^nope\b/,
  /^bye\b/, /^goodbye\b/, /^cya\b/, /^later\b/,
  /^what'?s up\b/, /^howdy\b/,
  /^good (morning|evening|night|afternoon)\b/,
  /^nice\b/, /^cool\b/, /^great\b/, /^awesome\b/, /^perfect\b/,
  /^got it\b/, /^gotcha\b/, /^understood\b/,
  /^sure\b/, /^alright\b/, /^fine\b/,
  /^lol\b/, /^haha\b/, /^hehe\b/,
  /^\?+$/, /^!+$/, /^\.{1,3}$/,
];

function isTrivialMessage(text) {
  return TRIVIAL_PATTERNS.some((p) => p.test(text));
}

// ----------------------------------------------------------
// Task matching
// ----------------------------------------------------------

/**
 * Score every task pattern against the request text.
 * The last user message is weighted above older context.
 *
 * @returns {Array<{task, complexity, score, hits}>} sorted descending
 */
function matchTasks(lastMsg, recentText) {
  const scored = [];

  for (const pattern of TASK_PATTERNS) {
    const lastHits = pattern.keywords.filter((kw) => containsWord(lastMsg, kw)).length;
    const recentHits = pattern.keywords.filter((kw) =>
      containsWord(recentText, kw)
    ).length;

    if (lastHits === 0 && recentHits === 0) continue;

    // A hit in the current message is worth far more than an old one.
    let score = pattern.confidence;
    if (lastHits > 0) {
      score += 0.05 + Math.min(lastHits - 1, 3) * 0.02;
    } else {
      score -= 0.2; // only matched older context
    }

    scored.push({
      task: pattern.task,
      complexity: pattern.complexity,
      score: Math.min(score, 0.95),
      hits: lastHits || recentHits,
      fromLastMessage: lastHits > 0,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.hits - a.hits);
  return scored;
}

// ----------------------------------------------------------
// Structural complexity adjustment
//
// Pattern complexity is a baseline. Request shape nudges it:
// a long, dense request is harder; a terse one is easier.
// ----------------------------------------------------------

function adjustComplexity(baseComplexity, requestBody, signals) {
  const messages = requestBody.messages || [];
  const lastLen = getLastUserMessage(messages).length;
  const charCount = totalCharCount(requestBody.system, messages);
  const recentToolActive = hasRecentToolActivity(messages, 6);

  let score = { low: 0, medium: 1, high: 2 }[baseComplexity] ?? 1;

  // Long, detailed requests carry more moving parts.
  if (lastLen > 2000) score += 1;
  else if (lastLen > 600) score += 0.5;

  // Terse requests are usually simple, even in a complex session.
  if (lastLen > 0 && lastLen < 60) score -= 0.5;

  // Large context or attached documents raise the bar.
  if (charCount > 20000) score += 0.5;

  // Active multi-step tool work is genuinely harder.
  if (recentToolActive) score += 0.5;

  // Vision and high-stakes content both demand more care.
  if (hasImages(messages)) score += 0.5;
  if (signals.risk === "high" || signals.risk === "restricted") score += 0.5;

  // Explicit quality demands should not be served by a cheap model.
  if (signals.latency_preference === "quality_first") score += 0.5;
  if (signals.latency_preference === "fast") score -= 0.5;

  if (score >= 1.75) return "high";
  if (score >= 0.75) return "medium";
  return "low";
}

// ----------------------------------------------------------
// Main classification
// ----------------------------------------------------------

/**
 * Classify a request using deterministic rules only.
 *
 * @param {object} requestBody - Anthropic-format request body
 * @returns {object} Normalized classification with source "rule"
 */
function classify(requestBody) {
  const messages = requestBody.messages || [];
  const signals = extractSignals(requestBody);

  const lastMsg = getLastUserMessage(messages).toLowerCase().trim();
  const recentText = getRecentUserMessages(messages, 3).join(" ").toLowerCase();

  const matches = matchTasks(lastMsg, recentText);
  const pendingTool = hasPendingToolResult(messages);
  const toolsActive =
    hasToolUse(messages) || hasToolDefinitions(requestBody);

  // ---- Primary task ----
  let primary = matches[0] || null;
  let confidence = primary ? primary.score : 0.25;
  let reason = primary
    ? `Keyword match on ${primary.task}${primary.fromLastMessage ? "" : " from recent context"}`
    : "No task keywords matched; defaulted from request shape";

  // No keyword matched — fall back to request shape.
  let primaryTask = primary ? primary.task : null;
  let baseComplexity = primary ? primary.complexity : "medium";

  // ---- Domain-consistency guard ----
  // "Review this X" is only a code review when X is a code artifact.
  // A generic review request (essay, document) is analysis instead.
  if (primaryTask === "code_review") {
    const codeContext =
      signals.domain === "software_engineering" ||
      signals.domain === "cybersecurity" ||
      signals.input_modalities.includes("code") ||
      /(code|pull request|pr\b|middleware|function|class|api|endpoint|script|repo|diff|test)/i.test(
        lastMsg
      );
    if (!codeContext) {
      primaryTask = "analysis";
      baseComplexity = "medium";
      confidence = Math.min(confidence, 0.6);
      reason = "Generic review request without code context — classified as analysis";
    }
  }

  if (!primaryTask) {
    if (toolsActive && pendingTool) {
      // Mid-agentic-loop with tool output waiting to be processed.
      primaryTask = "analysis";
      baseComplexity = "medium";
      confidence = 0.45;
      reason = "Tool result pending; treating turn as analysis of tool output";
    } else if (signals.input_modalities.includes("code")) {
      primaryTask = "code_explanation";
      baseComplexity = "medium";
      confidence = 0.4;
      reason = "Code present without explicit task keywords";
    } else {
      primaryTask = "general_conversation";
      baseComplexity = "low";
      confidence = 0.3;
    }
  }

  // ---- Trivial-message override (recency-aware) ----
  // A short acknowledgement should not inherit the previous turn's task.
  const trivial = isTrivialMessage(lastMsg);
  const veryShort = lastMsg.length > 0 && lastMsg.length < 15;
  if ((trivial || veryShort) && !pendingTool) {
    primaryTask = "general_conversation";
    baseComplexity = "low";
    confidence = 0.9;
    reason = `Trivial turn: "${lastMsg.slice(0, 24)}"`;
  }

  // ---- Secondary tasks (rule 2) ----
  // Additional requested outcomes, strongest first, primary excluded.
  // Catch-all buckets are never secondary outcomes — "good morning"
  // inside a translation request is not a second thing being asked for.
  const CATCH_ALL = new Set(["general_conversation", "other"]);
  const secondary = matches
    .filter(
      (m) =>
        m.task !== primaryTask &&
        m.score >= 0.7 &&
        m.fromLastMessage &&
        !CATCH_ALL.has(m.task)
    )
    .slice(0, 3)
    .map((m) => m.task);

  // ---- Complexity ----
  const complexity =
    trivial || veryShort
      ? "low"
      : adjustComplexity(baseComplexity, requestBody, signals);

  // ---- Capabilities implied by request structure ----
  // Task-implied capabilities are seeded later by applyRoutingRules.
  const capabilities = [];
  if (toolsActive) capabilities.push("tool_use");
  if (hasImages(messages)) capabilities.push("vision");
  if (signals.hasLargeInput) capabilities.push("long_context");

  const result = normalize({
    primary_task: primaryTask,
    secondary_tasks: secondary,
    domain: signals.domain,
    subdomain: signals.subdomain,
    persona: signals.persona,
    capabilities,
    input_modalities: signals.input_modalities,
    output_format: signals.output_format,
    complexity,
    risk: signals.risk,
    freshness: signals.freshness,
    latency_preference: signals.latency_preference,
    routing: {
      // Left for applyRoutingRules to derive from task + capabilities.
      tools: [],
      use_multi_step_pipeline: false,
      human_review_recommended: false,
    },
    confidence,
    reason,
  });

  const routed = applyRoutingRules(result, {
    hasLargeInput: signals.hasLargeInput,
    hasToolDefinitions: signals.hasToolDefinitions,
    safetySensitive: signals.safetySensitive,
    forceModelType: true,
  });

  return {
    ...routed,
    source: "rule",
    metadata: {
      matchedTasks: matches.slice(0, 4).map((m) => ({
        task: m.task,
        score: Math.round(m.score * 100) / 100,
      })),
      signals: {
        domain: signals.domain,
        risk: signals.risk,
        freshness: signals.freshness,
        persona: signals.persona,
        trivial,
        pendingTool,
      },
    },
  };
}

module.exports = { classify, matchTasks, isTrivialMessage, TASK_PATTERNS };
