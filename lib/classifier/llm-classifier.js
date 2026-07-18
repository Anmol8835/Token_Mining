// ============================================================
// LLM-based classifier — used as fallback when fused confidence
// from rules/embedding/profile is too low.
//
// Two variants:
//   1. classifyWithLLM — fast (last 3 msgs, 3000 char trunc, 5s timeout)
//   2. classifyWithLLMFallback — full context (last 5 msgs, 5000 char, 8s)
// ============================================================

const {
  extractSystemText,
  getRecentUserMessages,
  hasImages,
  hasToolUse,
  hasToolDefinitions,
} = require("./text-utils");

// ----------------------------------------------------------
// Classification prompt
// ----------------------------------------------------------

const CLASSIFICATION_PROMPT = {
  type: "text",
  text: `You are a request classifier for an LLM proxy router. Analyze the request and classify it.

Respond with ONLY a valid JSON object (no markdown, no explanation outside the JSON):

{
  "taskType": "<one of: coding, creative, summarization, analysis, chat, agentic, extraction, translation>",
  "complexity": "<one of: low, medium, high>",
  "costSensitivity": "<one of: budget, standard, premium>",
  "requiredCapabilities": {
    "needsTools": <true or false>,
    "needsVision": <true or false>,
    "needsStreaming": <true or false>
  }
}

Classification guidelines:

Task types:
- "agentic": the assistant is expected to use tools, take actions, operate autonomously, or execute multi-step tasks (e.g. file operations, running commands, making API calls)
- "coding": writing, reviewing, debugging, refactoring, or explaining code; generating functions, algorithms, or software designs
- "analysis": examining data, comparing options, research, investigation, code review, security auditing, or evaluating tradeoffs
- "creative": writing stories, poems, marketing copy, scripts, or original creative content
- "summarization": condensing long text into shorter summaries, extracting key points
- "extraction": pulling structured data (names, dates, prices, entities) from unstructured text
- "translation": converting text between languages
- "chat": general conversation, casual questions, greetings, small talk

Complexity:
- "high": multi-step reasoning, long/complex context, specialized domain knowledge, complex tool chains, system design, debugging subtle issues
- "medium": moderate reasoning, some domain knowledge, structured tasks with clear requirements
- "low": simple questions, short answers, common knowledge, greetings, trivial lookups

Cost sensitivity:
- "budget": simple enough for the cheapest available model; accuracy is not critical
- "standard": default; moderate cost is acceptable for good quality
- "premium": requires the best/most capable model regardless of cost; accuracy or safety is critical

Required capabilities:
- needsTools: true if the assistant needs to call tools, run code, access files, or execute commands
- needsVision: true if any message contains images or the task requires image understanding
- needsStreaming: true if the request explicitly asks for streaming output`,
};

// ----------------------------------------------------------
// Parse LLM response text into classification object
// ----------------------------------------------------------

function parseClassificationResponse(text) {
  let jsonStr = (text || "").trim();

  // Strip markdown code fences
  jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");

  // Find the first JSON object in the response
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  try {
    const result = JSON.parse(jsonStr);

    // Validate fields
    const validTaskTypes = [
      "coding", "creative", "summarization", "analysis",
      "chat", "agentic", "extraction", "translation",
    ];
    const validComplexity = ["low", "medium", "high"];
    const validCost = ["budget", "standard", "premium"];

    return {
      taskType: validTaskTypes.includes(result.taskType)
        ? result.taskType : "chat",
      complexity: validComplexity.includes(result.complexity)
        ? result.complexity : "medium",
      costSensitivity: validCost.includes(result.costSensitivity)
        ? result.costSensitivity : "standard",
      requiredCapabilities: {
        needsTools: !!result.requiredCapabilities?.needsTools,
        needsVision: !!result.requiredCapabilities?.needsVision,
        needsStreaming: !!result.requiredCapabilities?.needsStreaming,
      },
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------
// Shared: build classification request and call LLM
// ----------------------------------------------------------

/**
 * Build the context block sent to the classifier LLM.
 * @param {object} requestBody
 * @param {number} recentMsgCount - How many recent user messages to include
 * @param {number} truncation - Max chars per message field
 */
function buildContextBlock(requestBody, recentMsgCount, truncation) {
  const systemText = extractSystemText(requestBody.system);
  const recentMsgs = getRecentUserMessages(requestBody.messages, recentMsgCount);
  const totalMessages = requestBody.messages?.length || 0;
  const toolsDefined = hasToolDefinitions(requestBody);
  const toolHistory = hasToolUse(requestBody);
  const hasVisionContent = hasImages(requestBody);
  const streaming = !!requestBody.stream;

  const lines = [
    `System prompt: ${systemText.slice(0, truncation) || "(none)"}`,
  ];

  if (recentMsgs.length > 0) {
    lines.push(`Recent user messages (newest first):`);
    recentMsgs.forEach((msg, i) => {
      lines.push(`  [${i + 1}]: ${msg.slice(0, truncation)}`);
    });
  }

  lines.push(
    `Total messages in conversation: ${totalMessages}`,
    `Tools defined: ${toolsDefined}`,
    `Tool use history present: ${toolHistory}`,
    `Contains images: ${hasVisionContent}`,
    `Streaming requested: ${streaming}`
  );

  return lines.join("\n");
}

/**
 * Build the native classification request payload.
 */
function buildClassificationRequest(contextBlock, modelConfig) {
  return {
    model: modelConfig.apiModelId,
    system: [CLASSIFICATION_PROMPT],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: contextBlock }],
      },
    ],
    max_tokens: 256,
    temperature: 0,
    stream: false,
  };
}

/**
 * Extract text from the LLM's native response (provider-agnostic).
 */
function extractResponseText(response) {
  if (response.choices) {
    // OpenAI format
    return response.choices[0]?.message?.content || "";
  }
  if (response.content) {
    // Anthropic format
    const textBlocks = Array.isArray(response.content)
      ? response.content.filter((b) => b.type === "text")
      : [];
    return textBlocks.map((b) => b.text).join("\n");
  }
  if (response.candidates) {
    // Gemini format
    return (
      response.candidates[0]?.content?.parts
        ?.filter((p) => p.text)
        ?.map((p) => p.text)
        ?.join("\n") || ""
    );
  }
  return "";
}

// ----------------------------------------------------------
// Fast classifier (used in parallel phase when LLM is included)
// ----------------------------------------------------------

const FAST_TIMEOUT_MS = 5000;

/**
 * Classify a request using an LLM with truncated context.
 * Used in the parallel classification phase.
 *
 * @param {object} requestBody - Full Anthropic-format request
 * @param {object} provider - Provider instance
 * @param {object} modelConfig - Model config for the classifier model
 * @param {Function} doChat - (provider, nativePayload) => nativeResponse
 * @returns {Promise<object>} Classification result
 */
async function classifyWithLLM(requestBody, provider, modelConfig, doChat) {
  const contextBlock = buildContextBlock(requestBody, 3, 3000);
  const classificationRequest = buildClassificationRequest(contextBlock, modelConfig);
  const nativeReq = provider.buildRequest(classificationRequest);

  // Call with timeout
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("LLM classifier timed out")),
      FAST_TIMEOUT_MS
    )
  );

  const response = await Promise.race([doChat(provider, nativeReq), timeoutPromise]);
  const responseText = extractResponseText(response);
  const parsed = parseClassificationResponse(responseText);

  if (parsed) {
    return {
      ...parsed,
      confidence: 0.85,
      source: "llm",
      reason: `LLM classified: ${parsed.taskType}/${parsed.complexity}/${parsed.costSensitivity}`,
    };
  }

  // Parse failure — return low-confidence default
  console.warn(
    "LLM classifier returned unparseable response:",
    responseText.slice(0, 200)
  );
  return {
    taskType: "chat",
    complexity: "medium",
    costSensitivity: "standard",
    requiredCapabilities: {},
    confidence: 0.2,
    source: "llm",
    reason: "LLM classifier response unparseable — using defaults",
    metadata: { parseError: true, rawSnippet: responseText.slice(0, 200) },
  };
}

// ----------------------------------------------------------
// Fallback classifier (full context, only when fusion is uncertain)
// ----------------------------------------------------------

const FALLBACK_TIMEOUT_MS = 8000;

/**
 * Classify a request using an LLM with FULL context.
 * Only called when the fused confidence from the fast signals
 * is below the threshold. Uses more messages and longer truncation.
 *
 * @param {object} requestBody - Full Anthropic-format request
 * @param {object} provider - Provider instance
 * @param {object} modelConfig - Model config for the classifier model
 * @param {Function} doChat - (provider, nativePayload) => nativeResponse
 * @returns {Promise<object>} Classification result
 */
async function classifyWithLLMFallback(requestBody, provider, modelConfig, doChat) {
  const contextBlock = buildContextBlock(requestBody, 5, 5000);
  const classificationRequest = buildClassificationRequest(contextBlock, modelConfig);
  const nativeReq = provider.buildRequest(classificationRequest);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("LLM fallback classifier timed out")),
      FALLBACK_TIMEOUT_MS
    )
  );

  const response = await Promise.race([doChat(provider, nativeReq), timeoutPromise]);
  const responseText = extractResponseText(response);
  const parsed = parseClassificationResponse(responseText);

  if (parsed) {
    return {
      ...parsed,
      confidence: 0.90, // Higher confidence — more context
      source: "llm",
      reason: `LLM (fallback) classified: ${parsed.taskType}/${parsed.complexity}/${parsed.costSensitivity}`,
    };
  }

  // Parse failure on fallback — throw so orchestrator uses fused result
  throw new Error(
    `LLM fallback response unparseable: "${responseText.slice(0, 200)}"`
  );
}

module.exports = { classifyWithLLM, classifyWithLLMFallback };
