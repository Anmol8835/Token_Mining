// ============================================================
// LLM-based classifier — fallback for ambiguous requests
// Uses a cheap model to classify, with built-in timeout.
// ============================================================

const CLASSIFIER_TIMEOUT_MS = 5000;

/**
 * Extract text from system prompt.
 */
function extractSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((s) => s.text || "").join("\n");
  }
  return "";
}

/**
 * Extract text from first user message.
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

const CLASSIFICATION_PROMPT = {
  type: "text",
  text: `You are a request classifier for an LLM proxy. Analyze the following request and classify it.

Respond with ONLY a valid JSON object (no markdown, no explanation outside the JSON) with these exact fields:
- "taskType": one of "coding", "creative", "summarization", "analysis", "chat", "agentic", "extraction", "translation"
- "complexity": one of "low", "medium", "high"
- "costSensitivity": one of "budget", "standard", "premium"

Classification guidelines:
- "agentic": the assistant is expected to use tools, take actions, or operate autonomously
- "coding": writing, reviewing, debugging, or explaining code
- "analysis": examining data, comparing options, research, or investigation
- "creative": writing stories, poems, marketing copy, or creative content
- "summarization": condensing long text into shorter summaries
- "extraction": pulling structured data from unstructured text
- "translation": converting text between languages
- "chat": general conversation, questions, or assistance
- "high" complexity: multi-step reasoning, long context, specialized domain knowledge, or complex tool use required
- "low" complexity: simple questions, short answers, common knowledge
- "medium" complexity: moderate reasoning, some domain knowledge needed
- "budget" cost sensitivity: simple enough for a cheap model
- "premium" cost sensitivity: requires the best/most capable model regardless of cost
- "standard" cost sensitivity: default, moderate cost is acceptable`,
};

/**
 * Classify a request using an LLM.
 *
 * @param {object} requestBody - The full Anthropic-format request
 * @param {object} provider - Provider instance to use for classification
 * @param {object} modelConfig - Model config entry for the classifier model
 * @param {Function} doChat - Function (provider, payload) => native response
 * @returns {Promise<object>} Classification result
 */
async function classifyWithLLM(requestBody, provider, modelConfig, doChat) {
  const systemText = extractSystemText(requestBody.system);
  const firstUserMsg = getFirstUserMessage(requestBody.messages);
  const toolsPresent = !!(requestBody.tools && requestBody.tools.length > 0);
  const totalMessages = requestBody.messages ? requestBody.messages.length : 0;

  const classificationRequest = {
    model: modelConfig.apiModelId,
    system: [CLASSIFICATION_PROMPT],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `System prompt: ${systemText.slice(0, 1500) || "(none)"}`,
              `First user message: ${firstUserMsg.slice(0, 1500) || "(none)"}`,
              `Tools present: ${toolsPresent}`,
              `Total messages in conversation: ${totalMessages}`,
            ].join("\n"),
          },
        ],
      },
    ],
    max_tokens: 256,
    temperature: 0,
    stream: false,
  };

  // Build native request
  const nativeReq = provider.buildRequest(classificationRequest);

  // Call with timeout
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("LLM classifier timed out")), CLASSIFIER_TIMEOUT_MS)
  );

  const response = await Promise.race([doChat(provider, nativeReq), timeoutPromise]);

  // Extract text from response
  let text = "";
  if (response.choices) {
    // OpenAI format
    text = response.choices[0]?.message?.content || "";
  } else if (response.content) {
    // Anthropic format
    const textBlocks = Array.isArray(response.content)
      ? response.content.filter((b) => b.type === "text")
      : [];
    text = textBlocks.map((b) => b.text).join("\n");
  } else if (response.candidates) {
    // Gemini format
    text = response.candidates[0]?.content?.parts
      ?.filter((p) => p.text)
      ?.map((p) => p.text)
      ?.join("\n") || "";
  }

  // Parse JSON from response (strip markdown code fences if present)
  let jsonStr = text.trim();
  jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");

  try {
    const classification = JSON.parse(jsonStr);
    return {
      taskType: classification.taskType || "chat",
      complexity: classification.complexity || "medium",
      costSensitivity: classification.costSensitivity || "standard",
      confidence: 0.85,
      source: "llm",
      reason: `LLM classified as: ${classification.taskType}/${classification.complexity}`,
    };
  } catch (parseErr) {
    console.warn("Failed to parse LLM classifier response:", jsonStr.slice(0, 200));
    // Fallback to default
    return {
      taskType: "chat",
      complexity: "medium",
      costSensitivity: "standard",
      confidence: 0.3,
      source: "llm",
      reason: "LLM classifier returned unparseable response — using defaults",
    };
  }
}

module.exports = { classifyWithLLM };
