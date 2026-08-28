// ============================================================
// TF-IDF Embedding Similarity Classifier
// Zero external dependencies — pure JS implementation.
//
// Uses cosine similarity between TF-IDF vectors to match incoming
// requests against a curated set of labeled reference examples.
// Weighted top-K voting determines the final classification.
//
// Votes across the FULL taxonomy: primary/secondary task, domain,
// complexity, risk, freshness, latency, modalities, and format.
// The voting logic is field-agnostic; the reference examples are
// the only thing that needs to change when the taxonomy grows.
// ============================================================

const fs = require("fs");
const path = require("path");
const {
  extractSystemText,
  getFirstUserMessage,
  getLastUserMessage,
  getRecentUserMessages,
} = require("./text-utils");

const {
  normalize,
  applyRoutingRules,
  maxComplexity,
  maxRisk,
  maxFreshness,
  COMPLEXITY_RANK,
  RISK_RANK,
  FRESHNESS_RANK,
  LATENCY_RANK,
} = require("./taxonomy");

// ----------------------------------------------------------
// Stopwords — common English words filtered out during tokenization
// ----------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "under", "again",
  "further", "then", "once", "here", "there", "when", "where", "why",
  "how", "all", "both", "each", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than",
  "too", "very", "just", "because", "about", "until", "while", "if",
  "or", "and", "but", "it", "its", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
  "them", "their", "what", "which", "who", "whom", "also", "any",
  "does", "get", "got", "put", "set", "see", "use", "using", "used",
  "make", "made", "like", "well", "back", "even", "still", "way",
  "one", "two", "now", "new", "need", "know", "think", "going",
  "really", "much", "many", "without", "within", "around", "every",
  "often", "usually", "always", "never", "sometimes", "however",
  "therefore", "although", "since", "though", "whether", "either",
  "neither", "rather", "else", "already", "yet", "quite",
]);

/**
 * Tokenize text: lowercase, split on non-alphanumeric characters,
 * filter stopwords, minimum token length 2.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ----------------------------------------------------------
// TF-IDF Vectorizer
// ----------------------------------------------------------

class TfidfVectorizer {
  constructor() {
    this.vocabulary = new Map(); // term -> index
    this.idf = new Map(); // term -> idf value
    this.docCount = 0;
  }

  /**
   * Fit the vectorizer on a corpus of documents.
   * Builds vocabulary and computes IDF values.
   * @param {string[]} documents
   */
  fit(documents) {
    this.vocabulary.clear();
    this.idf.clear();
    this.docCount = documents.length;

    const docFreq = new Map();
    for (const doc of documents) {
      const terms = new Set(tokenize(doc));
      for (const term of terms) {
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
      }
    }

    let idx = 0;
    for (const [term, freq] of docFreq) {
      this.vocabulary.set(term, idx);
      // Smooth IDF: log((N + 1) / (df + 1)) + 1
      this.idf.set(term, Math.log((this.docCount + 1) / (freq + 1)) + 1);
      idx++;
    }
  }

  /**
   * Transform a single document into a sparse TF-IDF vector:
   * { index: tfidf_value, ... }
   */
  transform(text) {
    const tokens = tokenize(text);
    if (tokens.length === 0) return {};

    const tf = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }

    const vector = {};
    for (const [term, count] of Object.entries(tf)) {
      const idx = this.vocabulary.get(term);
      if (idx === undefined) continue; // OOV term, skip
      const idfVal = this.idf.get(term) || 1;
      vector[idx] = count * idfVal;
    }
    return vector;
  }

  /**
   * Cosine similarity between two sparse vectors ({ index: value }).
   * Returns 0 if either vector is empty.
   */
  static cosineSim(vecA, vecB) {
    const keysA = Object.keys(vecA);
    const keysB = Object.keys(vecB);
    if (keysA.length === 0 || keysB.length === 0) return 0;

    let dotProduct = 0;
    let normA2 = 0;
    let normB2 = 0;

    for (const k of keysA) {
      const a = vecA[k];
      normA2 += a * a;
      if (vecB[k] !== undefined) dotProduct += a * vecB[k];
    }
    for (const k of keysB) {
      const b = vecB[k];
      normB2 += b * b;
    }

    const normA = Math.sqrt(normA2);
    const normB = Math.sqrt(normB2);
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (normA * normB);
  }
}

// ----------------------------------------------------------
// Embedding Classifier
// ----------------------------------------------------------

class EmbeddingClassifier {
  /**
   * @param {string} referencePath - Path to reference-examples.json
   * @param {object} config - Configuration { minSimilarity, topK }
   */
  constructor(referencePath, config = {}) {
    this.minSimilarity = config.minSimilarity ?? 0.25;
    this.topK = config.topK ?? 3;

    const fullPath = referencePath || path.join(__dirname, "reference-examples.json");
    const ref = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    this.examples = ref.examples || [];

    // Build TF-IDF on the reference corpus.
    this.vectorizer = new TfidfVectorizer();
    const docs = this.examples.map(
      (e) => (e.systemHint || "") + " " + e.text
    );
    this.vectorizer.fit(docs);

    this.referenceVectors = this.examples.map((e) =>
      this.vectorizer.transform((e.systemHint || "") + " " + e.text)
    );
  }

  /**
   * Classify a request body using embedding similarity.
   * @param {object} requestBody - Full Anthropic-format request
   * @returns {object} Normalized classification with source "embedding"
   */
  classify(requestBody) {
    const sysText = extractSystemText(requestBody.system);

    // The LAST user message is the PRIMARY signal — it represents
    // what the user is asking RIGHT NOW, not 50 turns ago. Recent
    // messages add context, and the last message is duplicated to
    // increase its TF-IDF weight.
    const lastUserText = getLastUserMessage(requestBody.messages);
    const firstUserText = getFirstUserMessage(requestBody.messages);
    const recentMsgs = getRecentUserMessages(requestBody.messages, 3);

    const recentText = recentMsgs.join(" ");
    const combinedText = [
      lastUserText,                                    // primary signal
      lastUserText,                                    // doubled for TF weight
      recentText,                                      // recent context
      sysText,                                         // system prompt
    ].join(" ");

    if (!combinedText.trim()) {
      return this._noSignal("Empty request text");
    }

    const inputVec = this.vectorizer.transform(combinedText);
    if (Object.keys(inputVec).length === 0) {
      return this._noSignal("No known terms in request");
    }

    // Compute cosine similarity against all reference examples.
    const scored = [];
    for (let i = 0; i < this.referenceVectors.length; i++) {
      const sim = TfidfVectorizer.cosineSim(inputVec, this.referenceVectors[i]);
      scored.push({ sim, example: this.examples[i] });
    }

    scored.sort((a, b) => b.sim - a.sim);
    const topK = scored.slice(0, this.topK);

    if (topK[0].sim < this.minSimilarity) {
      return this._noSignal(
        `Best similarity ${topK[0].sim.toFixed(3)} below threshold ${this.minSimilarity}`
      );
    }

    const totalWeight = topK.reduce((s, t) => s + t.sim, 0);
    const topMatches = topK.map((t) => ({
      label: t.example.label,
      similarity: Math.round(t.sim * 1000) / 1000,
    }));

    // --- Weighted top-K voting over the full taxonomy ---
    const voted = this._vote(topK, totalWeight);

    // Best similarity scaled as confidence, capped at 0.85 — the
    // embedding signal is a hint, never a certainty.
    const taskAgreement =
      new Set(topK.map((t) => t.example.primary_task)).size === 1;
    const confidence = Math.min(
      topK[0].sim * 0.85 + (taskAgreement ? 0.05 : 0),
      0.85
    );

    const routed = applyRoutingRules(voted, {
      forceModelType: true,
    });

    return {
      ...routed,
      confidence,
      source: "embedding",
      reason:
        `Embedding match: ${topK[0].example.label} ` +
        `(sim=${topK[0].sim.toFixed(3)}, k=${topK.length})`,
      metadata: { topMatches },
    };
  }

  // ----------------------------------------------------------
  // Weighted voting helpers
  // ----------------------------------------------------------

  /**
   * Weighted vote over all top-K examples.
   * Scalars use plurality; ordered enums use the most-severe
   * value with meaningful support; lists use thresholded union.
   */
  _vote(topK, totalWeight) {
    const votes = {};
    // Each top-K example contributes its SIMILARITY as vote weight.
    // A 0.83 match outweighs two 0.30 matches — unweighted counting
    // lets a pair of weak ties beat a single strong match.
    const addVote = (field, value, sim) => {
      if (value === undefined || value === null) return;
      votes[field] = votes[field] || {};
      votes[field][value] = (votes[field][value] || 0) + sim;
    };

    // Similarity-weighted plurality winner for a scalar field.
    const plurality = (field) => {
      const tally = votes[field];
      if (!tally) return null;
      return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
    };

    // Most-severe value among those with real support (at least 40%
    // of the strongest value's weight), so a stray hard example
    // doesn't dominate a field that is otherwise clearly easier.
    const mostSevere = (field, rank, floor) => {
      const tally = votes[field];
      if (!tally) return floor;
      const maxW = Math.max(...Object.values(tally));
      return Object.entries(tally)
        .filter(([, w]) => w >= maxW * 0.4)
        .map(([v]) => v)
        .reduce((a, b) => (rank[a] >= rank[b] ? a : b));
    };

    // Similarity-weighted union with the same support threshold.
    const unionList = (field) => {
      const tally = votes[field];
      if (!tally) return [];
      const maxW = Math.max(0, ...Object.values(tally));
      return Object.entries(tally)
        .filter(([, w]) => w >= maxW * 0.4)
        .map(([v]) => v);
    };

    for (const { sim, example } of topK) {
      addVote("primary_task", example.primary_task, sim);
      for (const t of example.secondary_tasks || []) {
        addVote("secondary_tasks", t, sim);
      }
      addVote("domain", example.domain, sim);
      addVote("complexity", example.complexity, sim);
      addVote("risk", example.risk, sim);
      addVote("freshness", example.freshness, sim);
      addVote("latency_preference", example.latency_preference, sim);
      addVote("output_format", example.output_format, sim);
      for (const c of example.capabilities || []) {
        addVote("capabilities", c, sim);
      }
      for (const m of example.input_modalities || []) {
        addVote("input_modalities", m, sim);
      }
    }

    const primary_task = plurality("primary_task") || "other";
    // Secondary tasks are only trusted when the TOP example carries
    // them. Neighbors at low similarity are noise: "a task one vaguely
    // related example happened to have" is not a task the user asked for.
    const topExample = topK[0].example;
    const secondary_tasks = (topExample.secondary_tasks || []).filter(
      (t) => t !== primary_task
    );

    const input_modalities = unionList("input_modalities");
    // A modality only matters if it requires handling beyond text —
    // a lone example referencing an image shouldn't force multimodal.
    const capabilities = unionList("capabilities").filter(
      (c) =>
        c !== "vision" &&
        c !== "audio" &&
        c !== "long_context" &&
        c !== "code_execution"
    );

    return normalize({
      primary_task,
      secondary_tasks,
      domain: plurality("domain") || "general",
      persona: null, // structural; rules and LLM own persona
      capabilities,
      input_modalities: input_modalities.length
        ? input_modalities
        : ["text"],
      output_format: plurality("output_format") || "text",
      complexity: mostSevere("complexity", COMPLEXITY_RANK, "medium"),
      risk: mostSevere("risk", RISK_RANK, "low"),
      freshness: mostSevere("freshness", FRESHNESS_RANK, "not_required"),
      latency_preference: plurality("latency_preference") || "normal",
      routing: {
        tools: [],
        use_multi_step_pipeline: false,
        human_review_recommended: false,
      },
      confidence: 0.5,
      reason: "Embedding-derived classification",
    });
  }

  /**
   * Return a "no signal" result when text is empty or similarity
   * is too low. Confidence is minimal so fusion ignores it.
   */
  _noSignal(reason) {
    return {
      ...normalize({
        confidence: 0.05,
        reason: `No embedding signal: ${reason}`,
      }),
      source: "embedding",
      metadata: { noSignal: true },
    };
  }
}

module.exports = EmbeddingClassifier;
