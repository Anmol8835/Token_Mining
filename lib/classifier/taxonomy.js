// ============================================================
// Classification Taxonomy — single source of truth
//
// Defines every allowed enum value for the prompt classifier,
// the canonical output shape, a tolerant normalizer, and the
// deterministic routing rules.
//
// KEY DESIGN PRINCIPLE:
//   The classifier describes the REQUEST, never answers it.
//   Task, domain, persona, and capabilities are kept strictly
//   separate — a requested persona ("act as a lawyer") is NOT
//   the task, and a domain ("legal") is NOT a capability.
//
//   Every field is validated and coerced here so that no
//   downstream consumer ever sees an out-of-taxonomy value,
//   regardless of what an LLM signal hallucinated.
// ============================================================

// ----------------------------------------------------------
// Enum vocabularies
// ----------------------------------------------------------

const PRIMARY_TASKS = [
  "fact_lookup",
  "fact_check",
  "explanation",
  "research",
  "analysis",
  "logical_reasoning",
  "mathematics",
  "decision_support",
  "planning",
  "prediction",
  "summarization",
  "extraction",
  "classification",
  "translation",
  "rewriting",
  "completion",
  "creative_generation",
  "document_generation",
  "code_generation",
  "code_completion",
  "debugging",
  "code_explanation",
  "code_review",
  "code_refactoring",
  "technical_design",
  "command_generation",
  "general_conversation",
  "advice",
  "tutoring",
  "roleplay",
  "brainstorming",
  "interview_simulation",
  "other",
];

const DOMAINS = [
  "general",
  "software_engineering",
  "data_science",
  "mathematics",
  "science",
  "health",
  "legal",
  "finance",
  "education",
  "business",
  "marketing",
  "human_resources",
  "cybersecurity",
  "politics",
  "travel",
  "creative_writing",
  "personal_advice",
  "other",
];

const CAPABILITIES = [
  "basic_generation",
  "deep_reasoning",
  "long_context",
  "web_search",
  "source_citation",
  "code_understanding",
  "code_execution",
  "structured_output",
  "tool_use",
  "vision",
  "audio",
  "multilingual",
  "high_creativity",
  "deterministic_output",
];

const INPUT_MODALITIES = [
  "text",
  "code",
  "image",
  "audio",
  "document",
  "structured_data",
];

const MODEL_TYPES = [
  "fast_model",
  "general_model",
  "reasoning_model",
  "coding_model",
  "long_context_model",
  "multimodal_model",
  "safety_specialized_model",
];

const TOOLS = [
  "web_search",
  "browser",
  "code_interpreter",
  "calculator",
  "database",
  "file_reader",
  "image_analyzer",
  "speech_to_text",
  "none",
];

const COMPLEXITY_LEVELS = ["low", "medium", "high"];
const RISK_LEVELS = ["low", "medium", "high", "restricted"];
const FRESHNESS_LEVELS = ["not_required", "recent", "real_time"];
const LATENCY_PREFERENCES = ["fast", "normal", "quality_first"];

// ----------------------------------------------------------
// Ordered scales — used for "take the most severe" merges
// during fusion, where two signals disagree.
// ----------------------------------------------------------

const COMPLEXITY_RANK = { low: 0, medium: 1, high: 2 };
const RISK_RANK = { low: 0, medium: 1, high: 2, restricted: 3 };
const FRESHNESS_RANK = { not_required: 0, recent: 1, real_time: 2 };
const LATENCY_RANK = { fast: 0, normal: 1, quality_first: 2 };

function maxByRank(a, b, rank, fallback) {
  const ra = rank[a];
  const rb = rank[b];
  if (ra === undefined && rb === undefined) return fallback;
  if (ra === undefined) return b;
  if (rb === undefined) return a;
  return ra >= rb ? a : b;
}

const maxComplexity = (a, b) => maxByRank(a, b, COMPLEXITY_RANK, "medium");
const maxRisk = (a, b) => maxByRank(a, b, RISK_RANK, "low");
const maxFreshness = (a, b) => maxByRank(a, b, FRESHNESS_RANK, "not_required");

// ----------------------------------------------------------
// Task groupings — drive rules 13, 14, 15
//
// Rule 13: coding_model for debugging, code review, refactoring,
//          repository analysis, non-trivial code generation.
// Rule 14: reasoning_model for mathematics, difficult analysis,
//          planning, logical reasoning, complex decision support.
// Rule 15: fast_model for simple extraction, classification,
//          rewriting, translation, short summarization.
// ----------------------------------------------------------

const CODING_TASKS = new Set([
  "code_generation",
  "code_completion",
  "debugging",
  "code_explanation",
  "code_review",
  "code_refactoring",
  "technical_design",
  "command_generation",
]);

const REASONING_TASKS = new Set([
  "mathematics",
  "logical_reasoning",
  "analysis",
  "planning",
  "decision_support",
  "prediction",
  "research",
  "fact_check",
]);

const FAST_TASKS = new Set([
  "fact_lookup",
  "extraction",
  "classification",
  "translation",
  "rewriting",
  "summarization",
  "completion",
  "general_conversation",
]);

/** Domains where a wrong answer carries real-world consequences (rule 18). */
const HIGH_STAKES_DOMAINS = new Set([
  "health",
  "legal",
  "finance",
  "cybersecurity",
]);

/** Tasks that inherently require gathering/synthesizing sources (rule 10). */
const SOURCE_BACKED_TASKS = new Set(["research", "fact_check"]);

// ----------------------------------------------------------
// Per-task capability and tool defaults
//
// These are seeds, not overrides: a signal that explicitly
// asked for a capability keeps it. They exist so a bare
// primary_task still routes sensibly.
// ----------------------------------------------------------

const TASK_CAPABILITIES = {
  fact_lookup: ["basic_generation"],
  fact_check: ["web_search", "source_citation", "deep_reasoning"],
  explanation: ["basic_generation"],
  research: ["web_search", "source_citation", "deep_reasoning"],
  analysis: ["deep_reasoning"],
  logical_reasoning: ["deep_reasoning"],
  mathematics: ["deep_reasoning", "deterministic_output"],
  decision_support: ["deep_reasoning"],
  planning: ["deep_reasoning"],
  prediction: ["deep_reasoning"],
  // NOTE: long_context is deliberately NOT seeded from task type.
  // Rule 16 keys off actual input size, so it is added only when
  // the request really carries large documents / many files.
  summarization: ["basic_generation"],
  extraction: ["structured_output"],
  classification: ["structured_output", "deterministic_output"],
  translation: ["multilingual"],
  rewriting: ["basic_generation"],
  completion: ["basic_generation"],
  creative_generation: ["high_creativity"],
  document_generation: ["basic_generation"],
  code_generation: ["code_understanding"],
  code_completion: ["code_understanding"],
  debugging: ["code_understanding", "deep_reasoning"],
  code_explanation: ["code_understanding"],
  code_review: ["code_understanding", "deep_reasoning"],
  code_refactoring: ["code_understanding", "deep_reasoning"],
  technical_design: ["code_understanding", "deep_reasoning"],
  command_generation: ["code_understanding", "deterministic_output"],
  general_conversation: ["basic_generation"],
  advice: ["basic_generation"],
  tutoring: ["basic_generation"],
  roleplay: ["high_creativity"],
  brainstorming: ["high_creativity"],
  interview_simulation: ["high_creativity"],
  other: ["basic_generation"],
};

const TASK_TOOLS = {
  fact_check: ["web_search"],
  research: ["web_search"],
  mathematics: ["calculator"],
  debugging: ["code_interpreter"],
  code_generation: ["code_interpreter"],
  code_review: ["code_interpreter"],
  code_refactoring: ["code_interpreter"],
};

// ----------------------------------------------------------
// Tolerant key aliases
//
// LLM signals occasionally emit camelCase or near-miss names.
// Rather than discarding the whole object, remap known variants.
// ----------------------------------------------------------

const KEY_ALIASES = {
  primaryTask: "primary_task",
  task: "primary_task",
  secondaryTasks: "secondary_tasks",
  subTasks: "secondary_tasks",
  inputModalities: "input_modalities",
  modalities: "input_modalities",
  outputFormat: "output_format",
  latencyPreference: "latency_preference",
  subDomain: "subdomain",
  sub_domain: "subdomain",
};

const ROUTING_KEY_ALIASES = {
  modelType: "model_type",
  model: "model_type",
  useMultiStepPipeline: "use_multi_step_pipeline",
  multiStep: "use_multi_step_pipeline",
  humanReviewRecommended: "human_review_recommended",
  humanReview: "human_review_recommended",
};

function applyAliases(obj, aliases) {
  if (!obj || typeof obj !== "object") return {};
  const out = { ...obj };
  for (const [from, to] of Object.entries(aliases)) {
    if (out[from] !== undefined && out[to] === undefined) {
      out[to] = out[from];
    }
  }
  return out;
}

// ----------------------------------------------------------
// Coercion primitives
// ----------------------------------------------------------

/**
 * Coerce a value into an allowed enum member.
 * Normalizes case/spacing/hyphens before matching so that
 * "Code Review" and "code-review" both resolve to "code_review".
 */
function coerceEnum(value, allowed, fallback = null) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return allowed.includes(cleaned) ? cleaned : fallback;
}

/**
 * Coerce an array into a deduplicated list of allowed enum members.
 * Non-arrays and invalid members are dropped rather than throwing.
 */
function coerceEnumArray(value, allowed, { limit = Infinity } = {}) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const item of raw) {
    const coerced = coerceEnum(item, allowed, null);
    if (coerced && !out.includes(coerced)) out.push(coerced);
    if (out.length >= limit) break;
  }
  return out;
}

/** Clamp confidence into [0, 1] (rule 19), rounded to 2 decimals. */
function clampConfidence(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0.3;
  return Math.round(Math.min(Math.max(n, 0), 1) * 100) / 100;
}

/**
 * Keep reason under 30 words and free of newlines (rule 20).
 * Truncation happens on a word boundary so the text stays readable.
 */
function clampReason(value, maxWords = 29) {
  const text = (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
  if (!text) return "No reason provided";
  const words = text.split(" ");
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ");
}

/** Coerce a free-form string field, trimming and bounding length. */
function coerceString(value, { maxLength = 120, fallback = null } = {}) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  // Treat explicit null-ish text as absent — LLMs sometimes emit "none".
  if (/^(null|none|n\/a|na|undefined)$/i.test(cleaned)) return fallback;
  return cleaned.slice(0, maxLength);
}

// ----------------------------------------------------------
// Canonical output shape
// ----------------------------------------------------------

/**
 * The exact structure every classifier signal and the final
 * result must conform to.
 */
function emptyClassification() {
  return {
    primary_task: "other",
    secondary_tasks: [],
    domain: "general",
    subdomain: null,
    persona: null,
    capabilities: [],
    input_modalities: ["text"],
    output_format: "text",
    complexity: "medium",
    risk: "low",
    freshness: "not_required",
    latency_preference: "normal",
    routing: {
      model_type: "general_model",
      tools: [],
      use_multi_step_pipeline: false,
      human_review_recommended: false,
    },
    confidence: 0.3,
    reason: "No signal",
  };
}

/**
 * Normalize arbitrary input into the exact classification shape.
 * Every field is validated against the taxonomy; anything invalid
 * falls back to a safe default rather than propagating.
 *
 * @param {object} raw - Partial or malformed classification object
 * @returns {object} A fully-populated, taxonomy-valid classification
 */
function normalize(raw) {
  const base = emptyClassification();
  if (!raw || typeof raw !== "object") return base;

  const src = applyAliases(raw, KEY_ALIASES);
  const rawRouting = applyAliases(src.routing, ROUTING_KEY_ALIASES);

  const primary_task = coerceEnum(src.primary_task, PRIMARY_TASKS, "other");

  // Secondary tasks never duplicate the primary task (rules 1-2).
  const secondary_tasks = coerceEnumArray(src.secondary_tasks, PRIMARY_TASKS, {
    limit: 5,
  }).filter((t) => t !== primary_task);

  const input_modalities = coerceEnumArray(src.input_modalities, INPUT_MODALITIES);

  return {
    primary_task,
    secondary_tasks,
    domain: coerceEnum(src.domain, DOMAINS, "general"),
    subdomain: coerceString(src.subdomain, { maxLength: 60 }),
    // Persona is stored, never promoted to a task (rule 3).
    persona: coerceString(src.persona, { maxLength: 80 }),
    capabilities: coerceEnumArray(src.capabilities, CAPABILITIES),
    // Every request has text unless a signal proved otherwise.
    input_modalities: input_modalities.length ? input_modalities : ["text"],
    output_format: coerceString(src.output_format, { maxLength: 40 }) || "text",
    complexity: coerceEnum(src.complexity, COMPLEXITY_LEVELS, "medium"),
    risk: coerceEnum(src.risk, RISK_LEVELS, "low"),
    freshness: coerceEnum(src.freshness, FRESHNESS_LEVELS, "not_required"),
    latency_preference: coerceEnum(
      src.latency_preference,
      LATENCY_PREFERENCES,
      "normal"
    ),
    routing: {
      model_type: coerceEnum(rawRouting.model_type, MODEL_TYPES, "general_model"),
      tools: coerceEnumArray(rawRouting.tools, TOOLS).filter((t) => t !== "none"),
      use_multi_step_pipeline: !!rawRouting.use_multi_step_pipeline,
      human_review_recommended: !!rawRouting.human_review_recommended,
    },
    confidence: clampConfidence(src.confidence),
    reason: clampReason(src.reason),
  };
}

// ----------------------------------------------------------
// Deterministic routing rules (rules 10-18)
//
// Applied AFTER any signal produces a classification, so the
// routing block is always internally consistent — even when an
// LLM signal returned something self-contradictory.
// ----------------------------------------------------------

/**
 * Derive the model type implied by the classification (rules 13-16).
 * Hard overrides are checked first because they reflect a hard
 * capability requirement, not a preference.
 */
function deriveModelType(c) {
  const caps = c.capabilities || [];
  const mods = c.input_modalities || [];

  // Restricted content needs the safety-tuned path regardless of task.
  if (c.risk === "restricted") return "safety_specialized_model";

  // Non-text input is a hard capability requirement.
  if (mods.includes("image") || mods.includes("audio")) {
    return "multimodal_model";
  }
  if (caps.includes("vision") || caps.includes("audio")) {
    return "multimodal_model";
  }

  // Rule 16: large documents / many files / big repository.
  if (caps.includes("long_context")) return "long_context_model";

  // Rule 13: coding work.
  if (CODING_TASKS.has(c.primary_task)) {
    // Trivial code completion doesn't need a coding-tier model.
    if (c.primary_task === "code_completion" && c.complexity === "low") {
      return "fast_model";
    }
    return "coding_model";
  }

  // Rule 14: reasoning-heavy work.
  if (REASONING_TASKS.has(c.primary_task)) {
    // Simple lookups masquerading as analysis stay cheap.
    if (c.complexity === "low" && c.primary_task !== "mathematics") {
      return "general_model";
    }
    return "reasoning_model";
  }

  // Rule 15: simple mechanical tasks.
  if (FAST_TASKS.has(c.primary_task)) {
    // A "short summarization" that is actually high complexity
    // (dense technical source) deserves a general model.
    return c.complexity === "high" ? "general_model" : "fast_model";
  }

  // Everything else: general, escalating to reasoning when hard (rule 21).
  return c.complexity === "high" ? "reasoning_model" : "general_model";
}

/**
 * Apply rules 10-18 to a normalized classification.
 * Returns a new object; the input is not mutated.
 *
 * @param {object} classification - Normalized classification
 * @param {object} ctx - Structural context from the request
 * @param {boolean} ctx.forceModelType - Recompute model_type even if set
 * @returns {object} Classification with a consistent routing block
 */
function applyRoutingRules(classification, ctx = {}) {
  const c = normalize(classification);
  const caps = new Set(c.capabilities);
  const tools = new Set(c.routing.tools);

  // --- Rule 10: current/changing info or sources needed → web_search ---
  const needsFreshInfo = c.freshness !== "not_required";
  const needsSources =
    SOURCE_BACKED_TASKS.has(c.primary_task) ||
    c.secondary_tasks.some((t) => SOURCE_BACKED_TASKS.has(t)) ||
    caps.has("source_citation");

  if (needsFreshInfo || needsSources) {
    caps.add("web_search");
    tools.add("web_search");
  }
  if (needsSources) {
    caps.add("source_citation");
  }

  // --- Seed task-implied capabilities and tools ---
  for (const cap of TASK_CAPABILITIES[c.primary_task] || []) caps.add(cap);
  for (const task of c.secondary_tasks) {
    for (const cap of TASK_CAPABILITIES[task] || []) caps.add(cap);
  }
  for (const tool of TASK_TOOLS[c.primary_task] || []) tools.add(tool);

  // --- Modality-implied capabilities and tools ---
  const mods = c.input_modalities;
  if (mods.includes("image")) {
    caps.add("vision");
    tools.add("image_analyzer");
  }
  if (mods.includes("audio")) {
    caps.add("audio");
    tools.add("speech_to_text");
  }
  if (mods.includes("document")) tools.add("file_reader");
  if (mods.includes("structured_data")) caps.add("structured_output");
  if (mods.includes("code")) caps.add("code_understanding");

  // Tool availability in the request implies tool_use.
  if (ctx.hasToolDefinitions) {
    caps.add("tool_use");
  }

  // A structured output_format is a real capability requirement.
  if (/^(json|xml|yaml|csv|table|structured)/i.test(c.output_format)) {
    caps.add("structured_output");
  }

  // --- Rule 16: long context ---
  if (ctx.hasLargeInput) caps.add("long_context");

  // --- Rule 17: multiple dependent tasks, or research → generation ---
  const GENERATION_TASKS = new Set([
    "document_generation",
    "creative_generation",
    "code_generation",
    "technical_design",
    "planning",
    "decision_support",
  ]);
  // Output formats that represent a produced artifact — asking for
  // one on top of a research task is itself a research-then-generate
  // pipeline, even when no second task was named explicitly.
  const ARTIFACT_FORMATS = new Set([
    "report", "essay", "document", "slides", "letter", "email", "table",
  ]);

  const allTasks = [c.primary_task, ...c.secondary_tasks];
  const hasResearchStep = allTasks.some((t) => SOURCE_BACKED_TASKS.has(t));
  const hasGenerationStep =
    allTasks.some((t) => GENERATION_TASKS.has(t)) ||
    ARTIFACT_FORMATS.has(c.output_format);

  const multiStep =
    c.routing.use_multi_step_pipeline ||
    c.secondary_tasks.length >= 2 ||
    (hasResearchStep && hasGenerationStep) ||
    (c.secondary_tasks.length >= 1 && c.complexity === "high");

  // --- Rule 18: human review for high-impact sensitive requests ---
  // High-stakes domains are escalated in two tiers:
  //   - any request at high complexity, because a long/detailed
  //     answer in these domains carries real consequences;
  //   - personal decision questions (advice, decision_support) even
  //     at medium complexity, because a specific, concrete situation
  //     is being weighed ("is my landlord allowed to keep my deposit").
  const sensitiveDomain = HIGH_STAKES_DOMAINS.has(c.domain);
  const personalDecision = allTasks.some((t) =>
    ["advice", "decision_support"].includes(t)
  );
  const humanReview =
    c.routing.human_review_recommended ||
    c.risk === "restricted" ||
    (c.risk === "high" && (sensitiveDomain || ctx.safetySensitive)) ||
    (sensitiveDomain && c.complexity === "high") ||
    (sensitiveDomain && personalDecision && c.complexity !== "low");

  // --- Model type (rules 13-16) ---
  const withCaps = { ...c, capabilities: [...caps] };
  const derived = deriveModelType(withCaps);
  // Trust an explicitly-provided model_type unless a hard capability
  // override applies — those reflect requirements, not preferences.
  const HARD_OVERRIDES = new Set([
    "safety_specialized_model",
    "multimodal_model",
    "long_context_model",
  ]);
  let model_type =
    ctx.forceModelType || HARD_OVERRIDES.has(derived)
      ? derived
      : c.routing.model_type || derived;

  // A high-stakes request must never be served by the cheapest tier,
  // even when its task type looks mechanical (rule 18 + rule 21).
  // Coding/multimodal/long-context choices are capability-driven and
  // are left alone; only the generic tiers get escalated.
  const ESCALATABLE = new Set(["fast_model", "general_model"]);
  if (ESCALATABLE.has(model_type) && (c.risk === "high" || humanReview)) {
    model_type = "reasoning_model";
  }

  // --- Latency: quality-first work should never be rushed ---
  let latency = c.latency_preference;
  if (humanReview || c.risk === "restricted") {
    latency = "quality_first";
  } else if (multiStep && latency === "fast") {
    latency = "normal";
  }

  return {
    ...c,
    capabilities: [...caps],
    latency_preference: latency,
    routing: {
      model_type,
      tools: [...tools],
      use_multi_step_pipeline: multiStep,
      human_review_recommended: humanReview,
    },
  };
}

/**
 * Strip internal bookkeeping fields, returning only the exact
 * structure defined by the classifier spec. Used at the API edge.
 */
function toPublicShape(classification) {
  const c = normalize(classification);
  return {
    primary_task: c.primary_task,
    secondary_tasks: c.secondary_tasks,
    domain: c.domain,
    subdomain: c.subdomain,
    persona: c.persona,
    capabilities: c.capabilities,
    input_modalities: c.input_modalities,
    output_format: c.output_format,
    complexity: c.complexity,
    risk: c.risk,
    freshness: c.freshness,
    latency_preference: c.latency_preference,
    routing: {
      model_type: c.routing.model_type,
      // "none" communicates "no tools needed" more clearly than [].
      tools: c.routing.tools.length ? c.routing.tools : ["none"],
      use_multi_step_pipeline: c.routing.use_multi_step_pipeline,
      human_review_recommended: c.routing.human_review_recommended,
    },
    confidence: c.confidence,
    reason: c.reason,
  };
}

module.exports = {
  // Vocabularies
  PRIMARY_TASKS,
  DOMAINS,
  CAPABILITIES,
  INPUT_MODALITIES,
  MODEL_TYPES,
  TOOLS,
  COMPLEXITY_LEVELS,
  RISK_LEVELS,
  FRESHNESS_LEVELS,
  LATENCY_PREFERENCES,
  // Groupings
  CODING_TASKS,
  REASONING_TASKS,
  FAST_TASKS,
  HIGH_STAKES_DOMAINS,
  SOURCE_BACKED_TASKS,
  TASK_CAPABILITIES,
  TASK_TOOLS,
  // Scales
  COMPLEXITY_RANK,
  RISK_RANK,
  FRESHNESS_RANK,
  LATENCY_RANK,
  maxComplexity,
  maxRisk,
  maxFreshness,
  // Coercion
  coerceEnum,
  coerceEnumArray,
  clampConfidence,
  clampReason,
  coerceString,
  // Shape
  emptyClassification,
  normalize,
  deriveModelType,
  applyRoutingRules,
  toPublicShape,
};
