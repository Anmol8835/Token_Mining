// ============================================================
// TF-IDF Embedding Similarity Classifier
// Zero external dependencies — pure JS implementation.
//
// Uses cosine similarity between TF-IDF vectors to match incoming
// requests against a curated set of labeled reference examples.
// Weighted top-K voting determines the final classification.
// ============================================================

const fs = require("fs");
const path = require("path");
const { extractSystemText, getFirstUserMessage } = require("./text-utils");

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

    // Count document frequency for each term
    const docFreq = new Map();
    for (const doc of documents) {
      const terms = new Set(tokenize(doc));
      for (const term of terms) {
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
      }
    }

    // Build vocabulary from terms that appear in at least 1 document
    let idx = 0;
    for (const [term, freq] of docFreq) {
      this.vocabulary.set(term, idx);
      // Smooth IDF: log((N + 1) / (df + 1)) + 1
      this.idf.set(term, Math.log((this.docCount + 1) / (freq + 1)) + 1);
      idx++;
    }
  }

  /**
   * Transform a single document into a sparse TF-IDF vector.
   * Returns a plain object: { index: tfidf_value, ... }
   */
  transform(text) {
    const tokens = tokenize(text);
    if (tokens.length === 0) return {};

    // Term frequency (raw count)
    const tf = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }

    // TF-IDF: tf * idf, stored sparsely by index
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
   * Compute cosine similarity between two sparse vectors.
   * Each vector is { index: value }.
   * Returns 0 if either vector is empty.
   */
  static cosineSim(vecA, vecB) {
    const keysA = Object.keys(vecA);
    const keysB = Object.keys(vecB);
    if (keysA.length === 0 || keysB.length === 0) return 0;

    let dotProduct = 0;
    let normA2 = 0;
    let normB2 = 0;

    // Compute dot product and normA in one pass
    for (const k of keysA) {
      const a = vecA[k];
      normA2 += a * a;
      if (vecB[k] !== undefined) {
        dotProduct += a * vecB[k];
      }
    }

    // Compute normB
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
    this.minSimilarity = config.minSimilarity ?? 0.15;
    this.topK = config.topK ?? 3;

    // Load reference examples
    const fullPath = referencePath || path.join(__dirname, "reference-examples.json");
    const ref = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    this.examples = ref.examples || [];

    // Build TF-IDF on reference corpus
    this.vectorizer = new TfidfVectorizer();
    const docs = this.examples.map(
      (e) => (e.systemHint || "") + " " + e.text
    );
    this.vectorizer.fit(docs);

    // Pre-compute reference vectors
    this.referenceVectors = this.examples.map((e) =>
      this.vectorizer.transform((e.systemHint || "") + " " + e.text)
    );

    console.log(
      `[embedding-classifier] Initialized with ${this.examples.length} examples, ` +
      `vocabulary size: ${this.vectorizer.vocabulary.size}`
    );
  }

  /**
   * Classify a request body using embedding similarity.
   * @param {object} requestBody - Full Anthropic-format request
   * @returns {object} Classification result
   */
  classify(requestBody) {
    const sysText = extractSystemText(requestBody.system);
    const userText = getFirstUserMessage(requestBody.messages);
    const combinedText = sysText + " " + userText;

    if (!combinedText.trim()) {
      return this._noSignal("Empty request text");
    }

    // Vectorize the input
    const inputVec = this.vectorizer.transform(combinedText);

    if (Object.keys(inputVec).length === 0) {
      return this._noSignal("No known terms in request");
    }

    // Compute cosine similarity to all reference examples
    const scored = [];
    for (let i = 0; i < this.referenceVectors.length; i++) {
      const sim = TfidfVectorizer.cosineSim(inputVec, this.referenceVectors[i]);
      scored.push({ sim, example: this.examples[i] });
    }

    // Sort by similarity descending, take top K
    scored.sort((a, b) => b.sim - a.sim);
    const topK = scored.slice(0, this.topK);

    // Check minimum similarity threshold
    if (topK[0].sim < this.minSimilarity) {
      return this._noSignal(
        `Best similarity ${topK[0].sim.toFixed(3)} below threshold ${this.minSimilarity}`
      );
    }

    // --- Weighted top-K voting ---
    const totalWeight = topK.reduce((s, t) => s + t.sim, 0);

    // Task type: weighted vote
    const taskVotes = {};
    for (const { sim, example } of topK) {
      taskVotes[example.taskType] = (taskVotes[example.taskType] || 0) + sim;
    }
    const taskType = Object.entries(taskVotes).sort(
      (a, b) => b[1] - a[1]
    )[0][0];

    // Complexity: weighted average mapped to nearest label
    const complexityMap = { low: 0, medium: 1, high: 2 };
    const revComplexityMap = ["low", "medium", "high"];
    const complexityScore =
      topK.reduce(
        (s, t) => s + t.sim * (complexityMap[t.example.complexity] ?? 1),
        0
      ) / totalWeight;
    const complexity =
      complexityScore < 0.6
        ? "low"
        : complexityScore < 1.4
          ? "medium"
          : "high";

    // Cost sensitivity: weighted average
    const costMap = { budget: 0, standard: 1, premium: 2 };
    const revCostMap = ["budget", "standard", "premium"];
    const costScore =
      topK.reduce(
        (s, t) => s + t.sim * (costMap[t.example.costSensitivity] ?? 1),
        0
      ) / totalWeight;
    const costSensitivity =
      costScore < 0.6 ? "budget" : costScore < 1.4 ? "standard" : "premium";

    // Required capabilities: OR of all top-K (only include if confidence > 0)
    const requiredCapabilities = {
      needsTools: topK.some(
        (t) => t.example.requiredCapabilities?.needsTools
      ),
      needsVision: topK.some(
        (t) => t.example.requiredCapabilities?.needsVision
      ),
      needsStreaming: topK.some(
        (t) => t.example.requiredCapabilities?.needsStreaming
      ),
    };

    // Confidence: best similarity scaled, capped at 0.85
    const confidence = Math.min(topK[0].sim * 0.85, 0.85);

    // Check agreement among top K
    const topKTaskTypes = new Set(topK.map((t) => t.example.taskType));
    const agreementBonus = topKTaskTypes.size === 1 ? 0.05 : 0;

    return {
      taskType,
      complexity,
      costSensitivity,
      requiredCapabilities,
      confidence: Math.min(confidence + agreementBonus, 0.85),
      source: "embedding",
      reason: `Embedding match: ${topK[0].example.label} (sim=${topK[0].sim.toFixed(3)}, k=${topK.length})`,
      metadata: {
        topMatches: topK.map((t) => ({
          label: t.example.label,
          similarity: Math.round(t.sim * 1000) / 1000,
        })),
      },
    };
  }

  /**
   * Return a "no signal" result when text is empty or similarity is too low.
   */
  _noSignal(reason) {
    return {
      taskType: "chat",
      complexity: "medium",
      costSensitivity: "standard",
      requiredCapabilities: {},
      confidence: 0.05,
      source: "embedding",
      reason: `No embedding signal: ${reason}`,
    };
  }
}

module.exports = EmbeddingClassifier;
