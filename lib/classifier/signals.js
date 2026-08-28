// ============================================================
// Deterministic signal detectors
//
// Zero-cost, zero-dependency extractors for the classification
// fields that can be read directly off the request: freshness,
// risk, domain, persona, output format, input modalities, and
// latency preference.
//
// These run on EVERY request and are shared by the rule
// classifier and the fusion layer. Because they are
// deterministic, they act as a floor: an LLM signal may raise
// risk or freshness, but these detectors guarantee the obvious
// cases are never missed.
// ============================================================

const {
  extractSystemText,
  getLastUserMessage,
  getRecentUserMessages,
  hasImages,
  hasToolDefinitions,
  totalCharCount,
} = require("./text-utils");

const { maxRisk, maxFreshness } = require("./taxonomy");

// ----------------------------------------------------------
// Matching helpers
// ----------------------------------------------------------

/**
 * Whole-word/phrase match, so "hi" does not match inside "this".
 */
function containsWord(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\b" + escaped + "\\b", "i").test(text);
}

/** True if any keyword in the list matches. */
function containsAny(text, keywords) {
  return keywords.some((kw) => containsWord(text, kw));
}

/** Count how many keywords in the list match. */
function countMatches(text, keywords) {
  return keywords.reduce((n, kw) => n + (containsWord(text, kw) ? 1 : 0), 0);
}

// ----------------------------------------------------------
// Freshness (rules 11 and 12)
//
// real_time — live prices, weather, scores, availability,
//             ongoing events
// recent    — current laws, news, products, officeholders,
//             policies, other changeable information
// ----------------------------------------------------------

const REAL_TIME_KEYWORDS = [
  // markets
  "stock price", "share price", "current price", "price right now",
  "exchange rate", "conversion rate", "crypto price", "bitcoin price",
  "market cap", "trading at", "ticker",
  // weather
  "weather", "forecast", "temperature right now", "is it raining",
  "humidity", "wind speed",
  // sport / competition
  "score", "scores", "live score", "final score", "standings",
  "who is winning", "match result", "fixtures",
  // availability / status
  "in stock", "availability", "available right now", "flight status",
  "delayed", "traffic", "open now", "currently open", "seat availability",
  // liveness markers
  "right now", "at this moment", "as of today", "live", "real time",
  "real-time", "happening now", "ongoing", "currently happening",
  "breaking",
];

const RECENT_KEYWORDS = [
  // news / events
  "news", "latest", "recent", "recently", "this week", "this month",
  "this year", "nowadays", "these days", "up to date", "up-to-date",
  "current", "currently",
  // officeholders / org state
  "who is the president", "who is the ceo", "prime minister",
  "current president", "current ceo", "elected", "in office",
  // products / versions
  "newest", "new version", "latest version", "release", "released",
  "changelog", "just launched", "state of the art", "best in 2025",
  "best in 2026",
  // policy / regulation
  "law", "laws", "legislation", "regulation", "regulations", "policy",
  "policies", "compliance", "tax rate", "deadline", "updated",
];

/**
 * Detect how fresh the underlying information must be.
 * @returns {{ freshness: string, confidence: number, reason: string|null }}
 */
function detectFreshness(text) {
  if (!text) {
    return { freshness: "not_required", confidence: 0.2, reason: null };
  }

  const realTimeHits = countMatches(text, REAL_TIME_KEYWORDS);
  if (realTimeHits > 0) {
    return {
      freshness: "real_time",
      confidence: Math.min(0.7 + realTimeHits * 0.08, 0.92),
      reason: "live or continuously changing information requested",
    };
  }

  const recentHits = countMatches(text, RECENT_KEYWORDS);
  if (recentHits > 0) {
    return {
      freshness: "recent",
      confidence: Math.min(0.6 + recentHits * 0.08, 0.88),
      reason: "changeable information requested",
    };
  }

  // An explicit recent year is a strong recency cue on its own.
  if (/\b20(2[4-9]|3\d)\b/.test(text)) {
    return {
      freshness: "recent",
      confidence: 0.6,
      reason: "request references a recent year",
    };
  }

  return { freshness: "not_required", confidence: 0.35, reason: null };
}

// ----------------------------------------------------------
// Risk (rule 18)
//
// The classifier only LABELS risk so the router can pick a
// safety-tuned model and flag human review. It never decides
// whether to answer.
// ----------------------------------------------------------

const RESTRICTED_KEYWORDS = [
  "how to make a bomb", "build a bomb", "explosive device", "pipe bomb",
  "synthesize meth", "make methamphetamine", "cook meth",
  "untraceable poison", "nerve agent", "chemical weapon", "bioweapon",
  "kill myself", "end my life", "commit suicide", "how to self harm",
  "child porn", "csam",
  "ransomware payload", "keylogger to steal", "steal credit card",
  "carding", "bypass antivirus undetected",
];

const HIGH_RISK_KEYWORDS = [
  // medical decisions
  "diagnose", "diagnosis", "dosage", "dose", "prescribe", "prescription",
  "mg of", "overdose", "drug interaction", "side effects", "symptoms",
  "should i take", "is it safe to take", "treatment for", "cancer",
  "chemotherapy", "insulin", "blood pressure medication",
  // legal decisions
  "sue", "lawsuit", "legal advice", "am i liable", "breach of contract",
  "custody", "deportation", "plea", "criminal charges", "will and testament",
  "immigration status", "visa denial",
  // financial decisions
  "should i invest", "investment advice", "buy or sell", "portfolio",
  "retirement savings", "mortgage", "loan approval", "tax filing",
  "bankruptcy", "life savings", "financial advice",
  // security
  "exploit", "vulnerability", "penetration test", "pentest", "sql injection",
  "privilege escalation", "reverse shell", "cve", "malware", "phishing",
  "credential stuffing", "ddos",
  // safety
  "self harm", "suicidal", "abuse", "emergency", "overdosing",
];

const MEDIUM_RISK_KEYWORDS = [
  "health", "medical", "doctor", "medication", "therapy", "mental health",
  "legal", "lawyer", "attorney", "contract", "regulation", "compliance",
  "gdpr", "hipaa", "invest", "stock", "tax", "insurance", "salary",
  "security", "encryption", "authentication", "password", "firewall",
  "privacy", "personal data",
];

/**
 * Detect the risk tier of a request.
 * @param {string} text
 * @param {string} domain - Already-detected domain, used to sharpen the call
 * @returns {{ risk: string, confidence: number, safetySensitive: boolean, reason: string|null }}
 */
function detectRisk(text, domain) {
  if (!text) {
    return { risk: "low", confidence: 0.3, safetySensitive: false, reason: null };
  }

  if (containsAny(text, RESTRICTED_KEYWORDS)) {
    return {
      risk: "restricted",
      confidence: 0.9,
      safetySensitive: true,
      reason: "request touches restricted or self-harm content",
    };
  }

  const highHits = countMatches(text, HIGH_RISK_KEYWORDS);
  if (highHits > 0) {
    return {
      risk: "high",
      confidence: Math.min(0.65 + highHits * 0.08, 0.9),
      safetySensitive: true,
      reason: "high-impact medical, legal, financial, or security request",
    };
  }

  const mediumHits = countMatches(text, MEDIUM_RISK_KEYWORDS);
  const sensitiveDomain = ["health", "legal", "finance", "cybersecurity"].includes(
    domain
  );

  if (mediumHits > 0 || sensitiveDomain) {
    return {
      risk: "medium",
      confidence: 0.55,
      safetySensitive: sensitiveDomain,
      reason: "sensitive subject matter without high-impact decision",
    };
  }

  return { risk: "low", confidence: 0.4, safetySensitive: false, reason: null };
}

// ----------------------------------------------------------
// Domain and subdomain
// ----------------------------------------------------------

const DOMAIN_KEYWORDS = {
  software_engineering: {
    keywords: [
      "code", "function", "class", "api", "bug", "debug", "compile", "deploy",
      "repository", "repo", "git", "commit", "merge", "typescript", "javascript",
      "python", "java", "rust", "golang", "react", "node", "docker", "kubernetes",
      "database schema", "endpoint", "backend", "frontend", "refactor", "unit test",
      "stack trace", "exception", "npm", "webpack", "microservice", "latency",
    ],
    subdomains: {
      web_development: ["react", "vue", "angular", "css", "html", "frontend", "browser"],
      backend: ["api", "endpoint", "server", "microservice", "rest", "graphql"],
      devops: ["docker", "kubernetes", "ci/cd", "deploy", "terraform", "pipeline"],
      mobile: ["android", "ios", "swift", "kotlin", "react native", "flutter"],
      databases: ["sql", "postgres", "mysql", "mongodb", "query", "index", "schema"],
    },
  },
  data_science: {
    keywords: [
      "dataset", "dataframe", "pandas", "numpy", "regression", "classification model",
      "neural network", "machine learning", "training data", "feature engineering",
      "model accuracy", "precision", "recall", "clustering", "statistics",
      "correlation", "hypothesis test", "p-value", "visualization", "etl",
    ],
    subdomains: {
      machine_learning: ["neural network", "training", "model", "gradient", "overfitting"],
      analytics: ["dashboard", "metric", "kpi", "cohort", "funnel"],
      statistics: ["p-value", "hypothesis test", "distribution", "variance"],
    },
  },
  mathematics: {
    keywords: [
      "integral", "derivative", "equation", "theorem", "proof", "matrix",
      "algebra", "calculus", "geometry", "probability", "combinatorics",
      "polynomial", "logarithm", "factorial", "solve for", "prime number",
    ],
    subdomains: {
      calculus: ["integral", "derivative", "limit"],
      algebra: ["polynomial", "equation", "matrix"],
      probability: ["probability", "random variable", "distribution"],
    },
  },
  science: {
    keywords: [
      "physics", "chemistry", "biology", "molecule", "atom", "quantum",
      "gravity", "photosynthesis", "evolution", "dna", "protein", "cell",
      "experiment", "hypothesis", "astronomy", "planet", "climate",
    ],
    subdomains: {
      physics: ["quantum", "gravity", "relativity", "particle"],
      chemistry: ["molecule", "reaction", "compound", "atom"],
      biology: ["dna", "cell", "protein", "evolution", "organism"],
    },
  },
  health: {
    keywords: [
      "symptom", "symptoms", "diagnosis", "treatment", "medication", "doctor",
      "patient", "disease", "pain", "therapy", "mental health", "anxiety",
      "depression", "diet", "nutrition", "exercise", "sleep", "pregnancy",
      "vaccine", "surgery", "dosage",
    ],
    subdomains: {
      mental_health: ["anxiety", "depression", "therapy", "stress", "mental health"],
      nutrition: ["diet", "nutrition", "calories", "vitamin"],
      clinical: ["diagnosis", "treatment", "dosage", "symptoms", "prescription"],
    },
  },
  legal: {
    keywords: [
      "law", "legal", "lawyer", "attorney", "contract", "clause", "liability",
      "lawsuit", "court", "statute", "regulation", "compliance", "copyright",
      "trademark", "patent", "gdpr", "terms of service", "nda", "jurisdiction",
    ],
    subdomains: {
      contracts: ["contract", "clause", "nda", "agreement", "terms"],
      intellectual_property: ["copyright", "trademark", "patent"],
      compliance: ["gdpr", "hipaa", "compliance", "regulation"],
    },
  },
  finance: {
    keywords: [
      "invest", "investment", "stock", "bond", "portfolio", "revenue", "profit",
      "cash flow", "balance sheet", "valuation", "interest rate", "mortgage",
      "loan", "tax", "budget", "accounting", "dividend", "roi", "ebitda",
    ],
    subdomains: {
      investing: ["stock", "portfolio", "dividend", "bond", "etf"],
      accounting: ["balance sheet", "ledger", "accounting", "ebitda"],
      personal_finance: ["budget", "savings", "mortgage", "loan", "credit score"],
    },
  },
  education: {
    keywords: [
      "teach", "learn", "student", "curriculum", "lesson", "homework",
      "assignment", "exam", "study", "course", "syllabus", "grade",
      "explain like i'm", "beginner", "tutorial",
    ],
    subdomains: {
      tutoring: ["homework", "explain", "practice problem", "study"],
      curriculum: ["syllabus", "curriculum", "lesson plan"],
    },
  },
  business: {
    keywords: [
      "strategy", "roadmap", "stakeholder", "okr", "kpi", "product manager",
      "go to market", "competitor", "market share", "operations", "supply chain",
      "startup", "b2b", "saas", "pricing model", "business plan",
    ],
    subdomains: {
      strategy: ["strategy", "roadmap", "competitor", "market share"],
      operations: ["supply chain", "operations", "logistics", "process"],
    },
  },
  marketing: {
    keywords: [
      "campaign", "brand", "seo", "copywriting", "ad copy", "landing page",
      "conversion rate", "social media", "newsletter", "audience", "engagement",
      "influencer", "email marketing", "ctr", "funnel",
    ],
    subdomains: {
      content: ["copywriting", "blog", "newsletter", "ad copy"],
      seo: ["seo", "keyword", "backlink", "ranking"],
      paid_media: ["campaign", "ctr", "ad spend", "roas"],
    },
  },
  human_resources: {
    keywords: [
      "hiring", "recruit", "candidate", "resume", "cv", "interview",
      "onboarding", "employee", "performance review", "compensation",
      "job description", "hr policy", "termination", "benefits",
    ],
    subdomains: {
      recruiting: ["candidate", "resume", "hiring", "job description"],
      people_ops: ["onboarding", "performance review", "benefits", "hr policy"],
    },
  },
  cybersecurity: {
    keywords: [
      "vulnerability", "exploit", "malware", "phishing", "firewall",
      "encryption", "authentication", "penetration test", "pentest",
      "threat model", "zero day", "ransomware", "intrusion", "sql injection",
      "xss", "csrf", "security audit", "cve",
    ],
    subdomains: {
      appsec: ["xss", "csrf", "sql injection", "owasp", "input validation"],
      threat_intel: ["malware", "ransomware", "threat model", "zero day"],
      defensive: ["firewall", "intrusion", "siem", "hardening", "security audit"],
    },
  },
  politics: {
    keywords: [
      "election", "president", "senator", "parliament", "vote", "campaign trail",
      "policy", "government", "democrat", "republican", "legislation",
      "geopolitics", "diplomacy", "sanctions",
    ],
    subdomains: {
      elections: ["election", "vote", "ballot", "candidate"],
      policy: ["legislation", "policy", "bill", "regulation"],
    },
  },
  travel: {
    keywords: [
      "flight", "hotel", "itinerary", "visa", "trip", "vacation", "destination",
      "airbnb", "booking", "tourist", "backpacking", "layover", "passport",
    ],
    subdomains: {
      planning: ["itinerary", "trip", "destination", "vacation"],
      logistics: ["flight", "hotel", "booking", "layover", "visa"],
    },
  },
  creative_writing: {
    keywords: [
      "story", "poem", "novel", "character", "plot", "screenplay", "script",
      "fiction", "narrative", "protagonist", "verse", "haiku", "lyrics",
      "short story", "worldbuilding",
    ],
    subdomains: {
      fiction: ["story", "novel", "character", "plot", "protagonist"],
      poetry: ["poem", "verse", "haiku", "rhyme"],
      screenwriting: ["screenplay", "script", "scene", "dialogue"],
    },
  },
  personal_advice: {
    keywords: [
      "should i", "my girlfriend", "my boyfriend", "my partner", "my friend",
      "relationship", "breakup", "family", "my boss", "career change",
      "feeling stuck", "life advice", "motivation", "habit",
    ],
    subdomains: {
      relationships: ["relationship", "breakup", "partner", "dating"],
      career: ["career change", "my boss", "quit my job", "promotion"],
    },
  },
};

/**
 * Detect the subject-matter domain and an optional finer subdomain.
 * @returns {{ domain: string, subdomain: string|null, confidence: number }}
 */
function detectDomain(text) {
  if (!text) return { domain: "general", subdomain: null, confidence: 0.2 };

  let best = null;
  for (const [domain, spec] of Object.entries(DOMAIN_KEYWORDS)) {
    const hits = countMatches(text, spec.keywords);
    if (hits > 0 && (!best || hits > best.hits)) {
      best = { domain, hits, spec };
    }
  }

  if (!best) return { domain: "general", subdomain: null, confidence: 0.3 };

  // Pick the subdomain with the most hits within the winning domain.
  let subdomain = null;
  let subHits = 0;
  for (const [name, keywords] of Object.entries(best.spec.subdomains || {})) {
    const hits = countMatches(text, keywords);
    if (hits > subHits) {
      subHits = hits;
      subdomain = name;
    }
  }

  return {
    domain: best.domain,
    subdomain,
    confidence: Math.min(0.5 + best.hits * 0.1, 0.9),
  };
}

// ----------------------------------------------------------
// Persona (rule 3)
//
// A requested persona is stored, never treated as the task.
// ----------------------------------------------------------

const PERSONA_PATTERNS = [
  /\b(?:act|behave|respond|reply|answer)\s+(?:as|like)\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+|the\s+)?([a-z][a-z0-9 '\-/]{2,60})/i,
  /\bpretend\s+(?:to\s+be|that\s+you(?:'re|\s+are))\s+(?:an?\s+|the\s+)?([a-z][a-z0-9 '\-/]{2,60})/i,
  /\byou\s+are\s+(?:now\s+)?(?:an?\s+|the\s+)([a-z][a-z0-9 '\-/]{2,60})/i,
  /\brole\s*[:=]\s*([a-z][a-z0-9 '\-/]{2,60})/i,
  /\btake\s+on\s+the\s+role\s+of\s+(?:an?\s+|the\s+)?([a-z][a-z0-9 '\-/]{2,60})/i,
  /\bimagine\s+you(?:'re|\s+are)\s+(?:an?\s+|the\s+)?([a-z][a-z0-9 '\-/]{2,60})/i,
  /\bas\s+an?\s+(?:experienced|expert|senior|professional|certified)\s+([a-z][a-z0-9 '\-/]{2,60})/i,
];

// Trailing filler that regularly gets swept into the capture group.
const PERSONA_TRAILERS =
  /\s+(?:and|who|that|which|please|explain|help|tell|write|give|answer|respond|with|for|to|in)\b.*$/i;

/**
 * Extract a requested persona, e.g. "act as a lawyer" -> "lawyer".
 * @returns {{ persona: string|null, confidence: number }}
 */
function detectPersona(text) {
  if (!text) return { persona: null, confidence: 0 };

  for (const pattern of PERSONA_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    let persona = (match[1] || "").trim().replace(PERSONA_TRAILERS, "").trim();
    persona = persona.replace(/[.,;:!?]+$/, "").trim();

    // Reject captures that are too short, too long, or clearly not a role.
    if (persona.length < 3 || persona.length > 60) continue;
    if (/^(a|an|the|it|this|that|there|here|able|going|sure)$/i.test(persona)) continue;

    return { persona: persona.toLowerCase(), confidence: 0.8 };
  }

  return { persona: null, confidence: 0 };
}

// ----------------------------------------------------------
// Output format
// ----------------------------------------------------------

const OUTPUT_FORMAT_PATTERNS = [
  { format: "json", keywords: ["json", "as json", "json format", "json object"] },
  { format: "yaml", keywords: ["yaml", "yml"] },
  { format: "xml", keywords: ["xml"] },
  { format: "csv", keywords: ["csv", "comma separated"] },
  { format: "sql", keywords: ["sql query", "select statement", "write sql"] },
  { format: "table", keywords: ["table", "tabular", "in a table", "spreadsheet"] },
  { format: "bullet_points", keywords: ["bullet points", "bulleted list", "bullets"] },
  { format: "numbered_list", keywords: ["numbered list", "step by step", "steps"] },
  { format: "markdown", keywords: ["markdown", "md format"] },
  { format: "code", keywords: ["code block", "snippet", "write a function", "script"] },
  { format: "diff", keywords: ["diff", "patch", "unified diff"] },
  { format: "email", keywords: ["email", "e-mail", "draft a mail"] },
  { format: "letter", keywords: ["letter", "cover letter"] },
  { format: "essay", keywords: ["essay", "article", "blog post"] },
  { format: "report", keywords: ["report", "whitepaper", "memo"] },
  { format: "summary", keywords: ["summary", "tldr", "tl;dr", "abstract"] },
  { format: "poem", keywords: ["poem", "haiku", "verse", "lyrics"] },
  { format: "slides", keywords: ["slides", "presentation", "deck"] },
  { format: "diagram", keywords: ["diagram", "flowchart", "mermaid", "uml"] },
];

/**
 * Detect the requested output format. Defaults to "text".
 * @returns {{ output_format: string, confidence: number }}
 */
function detectOutputFormat(text) {
  if (!text) return { output_format: "text", confidence: 0.2 };

  for (const { format, keywords } of OUTPUT_FORMAT_PATTERNS) {
    if (containsAny(text, keywords)) {
      return { output_format: format, confidence: 0.75 };
    }
  }
  return { output_format: "text", confidence: 0.4 };
}

// ----------------------------------------------------------
// Input modalities
//
// Read off the request structure first (authoritative), then
// supplemented by content inspection.
// ----------------------------------------------------------

const CODE_FENCE_RE = /```/;
const CODE_HINT_RE =
  /\b(function|const |let |var |class |import |from |def |return|public static|#include|SELECT .*FROM|=>|\{\s*$)/m;
const STACK_TRACE_RE = /\b(at .*\(.*:\d+:\d+\)|Traceback \(most recent call last\)|Exception in thread)/;
const STRUCTURED_RE = /^\s*[[{][\s\S]*[\]}]\s*$/;
const DOC_HINT_RE =
  /\b(attached|pdf|docx?|spreadsheet|the document|this document|the transcript|the article below|following text)\b/i;

/**
 * Determine which modalities the request actually contains.
 * @param {object} requestBody
 * @param {string} text - Combined user text
 * @returns {{ input_modalities: string[], hasLargeInput: boolean }}
 */
function detectInputModalities(requestBody, text) {
  const modalities = new Set(["text"]);

  // Structural signals are authoritative.
  if (hasImages(requestBody.messages)) modalities.add("image");

  // Content signals.
  if (CODE_FENCE_RE.test(text) || CODE_HINT_RE.test(text) || STACK_TRACE_RE.test(text)) {
    modalities.add("code");
  }
  if (STRUCTURED_RE.test(text.trim())) modalities.add("structured_data");
  if (DOC_HINT_RE.test(text)) modalities.add("document");

  // A very large pasted body is effectively a document.
  const charCount = totalCharCount(requestBody.system, requestBody.messages);
  if (charCount > 20000) modalities.add("document");

  return {
    input_modalities: [...modalities],
    hasLargeInput: charCount > 20000,
  };
}

// ----------------------------------------------------------
// Latency preference
// ----------------------------------------------------------

const FAST_KEYWORDS = [
  "quick", "quickly", "asap", "fast", "briefly", "brief", "in one line",
  "one sentence", "short answer", "tldr", "tl;dr", "just tell me",
  "no explanation", "concise", "in a nutshell",
];

const QUALITY_KEYWORDS = [
  "thorough", "thoroughly", "detailed", "in detail", "comprehensive",
  "in depth", "in-depth", "take your time", "carefully", "rigorous",
  "production ready", "production-ready", "exhaustive", "step by step",
  "well researched", "deep dive", "as accurate as possible",
];

/**
 * Detect how the user is trading off speed against quality.
 * @returns {{ latency_preference: string, confidence: number }}
 */
function detectLatencyPreference(text) {
  if (!text) return { latency_preference: "normal", confidence: 0.3 };

  const quality = countMatches(text, QUALITY_KEYWORDS);
  const fast = countMatches(text, FAST_KEYWORDS);

  if (quality > fast) {
    return { latency_preference: "quality_first", confidence: 0.75 };
  }
  if (fast > quality) {
    return { latency_preference: "fast", confidence: 0.75 };
  }
  return { latency_preference: "normal", confidence: 0.4 };
}

// ----------------------------------------------------------
// Aggregate extractor
// ----------------------------------------------------------

/**
 * Run every deterministic detector over a request.
 *
 * The last user message is the primary signal (it is what the
 * user wants right now); recent messages provide context.
 *
 * @param {object} requestBody - Anthropic-format request body
 * @returns {object} All detected signals plus structural context
 */
function extractSignals(requestBody) {
  const messages = requestBody.messages || [];
  const lastUserMsg = getLastUserMessage(messages);
  const recentMsgs = getRecentUserMessages(messages, 3);
  const systemText = extractSystemText(requestBody.system);

  // Primary text: what the user is asking now.
  const primaryText = lastUserMsg || recentMsgs[0] || "";
  // Context text: recent turns plus the system prompt, for domain hints.
  const contextText = [primaryText, ...recentMsgs, systemText].join("\n");

  const domainSignal = detectDomain(contextText);
  const riskSignal = detectRisk(contextText, domainSignal.domain);
  const freshnessSignal = detectFreshness(primaryText || contextText);
  const personaSignal = detectPersona(primaryText || contextText);
  const formatSignal = detectOutputFormat(primaryText);
  const latencySignal = detectLatencyPreference(primaryText);
  const modalitySignal = detectInputModalities(requestBody, contextText);

  return {
    text: { primaryText, contextText, systemText },
    domain: domainSignal.domain,
    subdomain: domainSignal.subdomain,
    domainConfidence: domainSignal.confidence,
    risk: riskSignal.risk,
    riskConfidence: riskSignal.confidence,
    safetySensitive: riskSignal.safetySensitive,
    riskReason: riskSignal.reason,
    freshness: freshnessSignal.freshness,
    freshnessConfidence: freshnessSignal.confidence,
    freshnessReason: freshnessSignal.reason,
    persona: personaSignal.persona,
    output_format: formatSignal.output_format,
    latency_preference: latencySignal.latency_preference,
    input_modalities: modalitySignal.input_modalities,
    hasLargeInput: modalitySignal.hasLargeInput,
    hasToolDefinitions: hasToolDefinitions(requestBody),
  };
}

module.exports = {
  containsWord,
  containsAny,
  countMatches,
  detectFreshness,
  detectRisk,
  detectDomain,
  detectPersona,
  detectOutputFormat,
  detectInputModalities,
  detectLatencyPreference,
  extractSignals,
  // Re-exported so callers merging signals don't need taxonomy too.
  maxRisk,
  maxFreshness,
};
