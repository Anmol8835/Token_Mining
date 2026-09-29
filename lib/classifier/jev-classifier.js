// ============================================================
// Jev (TypeSafe) classifier — https://docs.typesafe.ai
//
// One POST to https://api.typesafe.ai/v1/systemone sends the prompt
// state plus a handful of typed Choice questions; Jev returns the
// chosen option, probability distribution, and confidence per
// question. Answers are mapped onto the taxonomy shape and run
// through normalize() + applyRoutingRules(), so the rest of the
// pipeline (router, metrics, eval) consumes them exactly like any
// other classification. Choice primitive only, by design.
//
// Never throws for API/parse failures: with no fusion to fall back
// to, a failed call degrades to a safe default classification
// (confidence 0.15, primary_task "other") with metadata.degraded.
// ============================================================

const {
  getRecentUserMessages,
  hasImages,
  hasToolDefinitions,
  totalCharCount,
} = require("./text-utils");

const {
  PRIMARY_TASKS,
  DOMAINS,
  COMPLEXITY_LEVELS,
  RISK_LEVELS,
  FRESHNESS_LEVELS,
  normalize,
  applyRoutingRules,
  clampConfidence,
} = require("./taxonomy");

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

// ----------------------------------------------------------
// Criteria rubrics — authored to mirror the rules in
// llm-classifier.js CLASSIFICATION_PROMPT so eval parity with
// llm mode is a fair comparison.
// ----------------------------------------------------------

const TASK_RUBRICS = {
  fact_lookup: "Retrieve a known fact or simple information",
  fact_check: "Verify a supplied claim against sources",
  explanation: "Explain a concept, process, or how something works",
  research: "Gather and synthesize information from multiple sources",
  analysis: "Interpret data or text to find patterns and insights",
  logical_reasoning: "Solve a logic puzzle or deduce a conclusion",
  mathematics: "Solve a math problem or computation",
  decision_support: "Weigh options and decide between alternatives",
  planning: "Create a plan, roadmap, or sequence of steps",
  prediction: "Forecast an unknown future outcome",
  summarization: "Condense provided text or content",
  extraction: "Pull specific facts or data out of provided content",
  classification: "Categorize or label provided content",
  translation: "Translate between languages",
  rewriting: "Rewrite or restyle provided text",
  completion: "Continue or finish partial text or code",
  creative_generation: "Create original creative writing or ideas",
  document_generation: "Produce a structured document such as a report, letter, or essay",
  code_generation: "Write new code from scratch",
  code_completion: "Finish or fill in existing code",
  debugging: "Find and fix errors in code",
  code_explanation: "Explain how existing code works",
  code_review: "Review code for quality, bugs, or security",
  code_refactoring: "Restructure existing code without changing behavior",
  technical_design: "Design software architecture or technical solutions",
  command_generation: "Produce shell commands or CLI instructions",
  general_conversation: "Casual chat or small talk",
  advice: "Ask for personal recommendations or counsel",
  tutoring: "Learn a subject with step-by-step guidance",
  roleplay: "Adopt a persona or simulate a scenario",
  brainstorming: "Generate many creative ideas",
  interview_simulation: "Practice a mock interview",
  other: "None of the above fits",
};

const DOMAIN_RUBRICS = {
  general: "No specific subject area",
  software_engineering: "Programming, systems, development practices",
  data_science: "Statistics, machine learning, data analysis",
  mathematics: "Pure or applied mathematics",
  science: "Physics, chemistry, biology, other sciences",
  health: "Medical or health topics",
  legal: "Law, contracts, regulations",
  finance: "Money, markets, investing, accounting",
  education: "Teaching, learning, academia",
  business: "Strategy, management, operations, sales",
  marketing: "Advertising, branding, content marketing",
  human_resources: "Hiring, workplace policies, personnel",
  cybersecurity: "Security, vulnerabilities, threats",
  politics: "Government, policy, elections",
  travel: "Trips, destinations, logistics",
  creative_writing: "Fiction, poetry, storytelling craft",
  personal_advice: "Relationships, lifestyle, self-improvement",
  other: "None of the above fits",
};

const COMPLEXITY_RUBRICS = {
  low: "Simple, mechanical, single-step",
  medium: "Moderate reasoning or several parts",
  high: "Deep reasoning, large output, or many dependent parts",
};

const RISK_RUBRICS = {
  low: "No meaningful consequence if wrong",
  medium: "Some real-world consequence",
  high: "High-impact consequences in health, legal, financial, or security matters",
  restricted: "Harmful, disallowed, or safety-sensitive content",
};

const FRESHNESS_RUBRICS = {
  not_required: "Timeless information, no recency needed",
  recent: "Needs recent but not live information",
  real_time: "Needs live data: prices, weather, scores, availability",
};

/** Build the criteria map for one Choice question from an enum list. */
function criteriaFrom(enumList, rubrics) {
  const criteria = {};
  for (const option of enumList) {
    criteria[option] = rubrics[option] ?? null;
  }
  return criteria;
}

/**
 * The five routing-critical Choice questions, evaluated in parallel
 * by Jev in a single call. Options always mirror the taxonomy enums
 * so a schema drift can never reach the router.
 */
function buildJevQuestions() {
  return {
    primary_task: {
      type: "choice",
      instructions:
        "What is the single main outcome the user asks for? Ignore any persona the prompt merely mentions. If nothing fits, choose other.",
      criteria: criteriaFrom(PRIMARY_TASKS, TASK_RUBRICS),
    },
    complexity: {
      type: "choice",
      instructions: "How complex is the request to fulfill?",
      criteria: criteriaFrom(COMPLEXITY_LEVELS, COMPLEXITY_RUBRICS),
    },
    domain: {
      type: "choice",
      instructions: "Which subject area does the request belong to?",
      criteria: criteriaFrom(DOMAINS, DOMAIN_RUBRICS),
    },
    risk: {
      type: "choice",
      instructions: "How much harm can a wrong answer cause?",
      criteria: criteriaFrom(RISK_LEVELS, RISK_RUBRICS),
    },
    freshness: {
      type: "choice",
      instructions: "Does the request need current or live information?",
      criteria: criteriaFrom(FRESHNESS_LEVELS, FRESHNESS_RUBRICS),
    },
  };
}

/**
 * The `state` Jev evaluates: the last few user messages joined,
 * truncated to a fixed budget (mirrors the LLM classifier's context
 * block; follow-ups like "what about Python?" stay classified in
 * context).
 */
function buildState(requestBody, opts) {
  const recent = getRecentUserMessages(
    requestBody.messages,
    opts.recentMsgCount
  );
  const joined = recent
    .filter((t) => t && t.trim().length > 0)
    .join("\n\n")
    .slice(0, opts.stateCharLimit);
  return joined || "(empty)";
}

function buildJevRequest(requestBody, opts) {
  return {
    state: buildState(requestBody, opts),
    model: opts.model,
    questions: buildJevQuestions(),
  };
}

/**
 * POST with one retry on 429/529 (rate limit / overloaded), honoring
 * Retry-After capped at 2s. Other statuses and network failures
 * rethrow immediately.
 */
async function postWithRetry(payload, opts) {
  const transport = opts.transport || require("axios");
  const config = {
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    timeout: opts.timeoutMs,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await transport.post(JEV_ENDPOINT, payload, config);
      return resp.data;
    } catch (err) {
      const status = err?.response?.status;
      if (attempt === 0 && (status === 429 || status === 529)) {
        const retryAfter = parseInt(
          err?.response?.headers?.["retry-after"],
          10
        );
        const delay = Number.isFinite(retryAfter)
          ? Math.min(retryAfter * 1000, 2000)
          : 300;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Map a systemone response onto the canonical taxonomy shape.
 * Order matters: normalize + applyRoutingRules rebuild the object
 * from known fields only, so source/metadata are attached AFTER.
 */
function mapJevResponse(requestBody, data, opts) {
  const answers = data?.answers || {};
  const primary = answers.primary_task;
  if (!primary || typeof primary.choice !== "string") {
    throw new Error(
      "unparseable Jev answer payload (missing answers.primary_task.choice)"
    );
  }

  const complexity = answers.complexity?.choice;
  const domain = answers.domain?.choice;
  const risk = answers.risk?.choice;
  const freshness = answers.freshness?.choice;

  const raw = {
    primary_task: primary.choice,
    complexity,
    domain,
    risk,
    freshness,
    input_modalities: hasImages(requestBody.messages)
      ? ["text", "image"]
      : ["text"],
    confidence: primary.confidence,
    reason:
      `Jev classification: ${primary.choice}, ${domain || "general"}, ` +
      `complexity ${complexity || "medium"}, risk ${risk || "low"}, ` +
      `freshness ${freshness || "not_required"}`,
  };

  // forceModelType: true — Jev gives no model_type opinion, and
  // normalize() would otherwise fill a "general_model" default that
  // applyRoutingRules treats as an explicitly-provided value.
  const routed = applyRoutingRules(normalize(raw), {
    hasToolDefinitions: hasToolDefinitions(requestBody),
    forceModelType: true,
    hasLargeInput:
      totalCharCount(undefined, requestBody.messages) >
      (opts.largeInputChars ?? 20000),
  });

  const usage = data?.usage || {};
  return {
    ...routed,
    confidence: clampConfidence(primary.confidence ?? routed.confidence),
    source: "jev",
    metadata: {
      jevModel: data?.model || null,
      answers,
      classifierCost: {
        model: opts.model || DEFAULT_MODEL,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: 0, // TypeSafe publishes no pricing; tokens recorded, cost unknown
      },
    },
  };
}

/**
 * Safe default classification for when Jev cannot answer: mirrors
 * the LLM classifier's degrade (confidence 0.15, primary_task
 * "other") so the router still gets a conservative, valid shape.
 */
function degraded(requestBody, reason, opts) {
  const routed = applyRoutingRules(
    normalize({
      primary_task: "other",
      confidence: 0.15,
      reason: "Jev classifier unavailable; using safe defaults",
    }),
    {
      hasToolDefinitions: hasToolDefinitions(requestBody),
      forceModelType: true,
      hasLargeInput:
        totalCharCount(undefined, requestBody.messages) >
        (opts.largeInputChars ?? 20000),
    }
  );
  return {
    ...routed,
    source: "jev",
    metadata: { degraded: true, degradedReason: reason },
  };
}

/**
 * Classify a request with Jev. Never throws on API/parse failures —
 * degrades instead. Options:
 *   apiKey (required), model, timeoutMs, recentMsgCount,
 *   stateCharLimit, largeInputChars, transport (test hook)
 */
async function classifyWithJev(requestBody, options = {}) {
  const opts = {
    model: DEFAULT_MODEL,
    timeoutMs: 5000,
    recentMsgCount: 3,
    stateCharLimit: 3000,
    largeInputChars: 20000,
    ...options,
  };

  if (!opts.apiKey) {
    throw new TypeError(
      "classifyWithJev requires options.apiKey (TYPESAFE_API_KEY)"
    );
  }

  try {
    const payload = buildJevRequest(requestBody, opts);
    const data = await postWithRetry(payload, opts);
    return mapJevResponse(requestBody, data, opts);
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const bodySnippet =
      typeof body === "string"
        ? body.slice(0, 200)
        : body
          ? JSON.stringify(body).slice(0, 200)
          : "";
    const summary =
      `Jev classifier failed: ${err.message}` +
      (status ? ` (HTTP ${status})` : "") +
      (bodySnippet ? ` — ${bodySnippet}` : "");
    console.warn(`[jev-classifier] ${summary}`);
    return degraded(requestBody, summary, opts);
  }
}

module.exports = { classifyWithJev, buildJevQuestions, mapJevResponse };
