// ============================================================
// In-memory routing metrics
//
// Records every classified request: what the classifier decided,
// how the router scored the candidates, which model served the
// request, how long it took, and what it cost.
//
// Served as JSON on GET /metrics so the dashboard can poll it.
// All aggregates are computed on snapshot — no background work.
// ============================================================

const MAX_RECORDS = 250;

class MetricsStore {
  constructor() {
    this.records = []; // ring buffer, newest first
    this.startedAt = Date.now();
    this.reset();
  }

  reset() {
    this.records = [];
    this.counts = {
      requests: 0,
      providerFallbacks: 0,
      providerFailures: 0,
      llmFallbacks: 0,
      humanReviewFlags: 0,
    };
    this.sums = {
      latencyMs: 0,
      classifierMs: 0,
      confidence: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    this.byTask = {};      // primary_task -> count
    this.byModel = {};     // model id -> { count, costUsd }
    this.byModelType = {}; // routing.model_type -> count
    this.byRisk = {};      // risk -> count
    this.byMode = {};      // routing mode -> count
    this.candidateScores = {}; // model id -> { total, count } running avg
    this.startedAt = Date.now();
  }

  // ----------------------------------------------------------
  // Recording
  // ----------------------------------------------------------

  /**
   * Record a completed (or attempted) request.
   *
   * @param {object} entry
   * @param {string} entry.prompt - User prompt preview (last user message)
   * @param {object} entry.classification - Full taxonomy classification
   * @param {object|null} entry.route - Router result { model, reason, detail }
   * @param {object} entry.providerResult - { modelId, ok, latencyMs, usage, costUsd }
   */
  record(entry) {
    const c = entry.classification || {};
    this.counts.requests++;

    this.sums.classifierMs += entry.classifierMs || 0;
    this.sums.confidence += c.confidence || 0;

    if (c.source === "llm") this.counts.llmFallbacks++;
    if (c.routing?.human_review_recommended) this.counts.humanReviewFlags++;

    this.byTask[c.primary_task] = (this.byTask[c.primary_task] || 0) + 1;
    this.byRisk[c.risk] = (this.byRisk[c.risk] || 0) + 1;
    if (c.routing?.model_type) {
      this.byModelType[c.routing.model_type] =
        (this.byModelType[c.routing.model_type] || 0) + 1;
    }

    if (entry.route) {
      this.byMode[entry.route.detail?.mode || "?"] =
        (this.byMode[entry.route.detail?.mode || "?"] || 0) + 1;

      // Running average of candidate scores so the dashboard can
      // show which models the router keeps ranking where.
      for (const [modelId, score] of entry.route.detail?.scores || []) {
        const slot = this.candidateScores[modelId] || { total: 0, count: 0 };
        slot.total += score;
        slot.count += 1;
        this.candidateScores[modelId] = slot;
      }
    }

    const p = entry.providerResult;
    if (p) {
      this.sums.latencyMs += p.latencyMs || 0;
      this.sums.inputTokens += p.usage?.input_tokens || 0;
      this.sums.outputTokens += p.usage?.output_tokens || 0;
      this.sums.costUsd += p.costUsd || 0;

      const modelSlot = this.byModel[p.modelId] || { count: 0, costUsd: 0 };
      modelSlot.count += 1;
      modelSlot.costUsd += p.costUsd || 0;
      this.byModel[p.modelId] = modelSlot;

      if (!p.ok) this.counts.providerFailures++;
    }
    if (entry.providerFallbacks > 0) {
      this.counts.providerFallbacks += entry.providerFallbacks;
    }

    this.records.unshift({
      ts: Date.now(),
      prompt: (entry.prompt || "").slice(0, 120),
      primary_task: c.primary_task,
      domain: c.domain,
      complexity: c.complexity,
      risk: c.risk,
      model_type: c.routing?.model_type,
      review: !!c.routing?.human_review_recommended,
      confidence: c.confidence,
      source: c.source,
      classifierMs: entry.classifierMs,
      selectedModel: entry.route?.model?.id || p?.modelId || null,
      winnerScore: entry.route?.detail?.winnerScore ?? null,
      candidateCount: entry.route?.detail?.scores?.length || 0,
      providerMs: p?.latencyMs ?? null,
      costUsd: p?.costUsd ?? null,
      tokens: p ? (p.usage?.input_tokens || 0) + (p.usage?.output_tokens || 0) : null,
      ok: p ? p.ok : null,
      scores: entry.route?.detail?.scores || null,
      reason: entry.route?.reason || null,
    });
    if (this.records.length > MAX_RECORDS) this.records.pop();
  }

  // ----------------------------------------------------------
  // Snapshot
  // ----------------------------------------------------------

  snapshot() {
    const avg = (sum, key) =>
      this.counts.requests > 0
        ? Math.round((sum[key] / this.counts.requests) * 100) / 100
        : 0;

    const toSortedEntries = (obj) =>
      Object.entries(obj)
        .map(([key, value]) =>
          typeof value === "object" ? { key, ...value } : { key, value }
        )
        .sort((a, b) => (b.value ?? b.count ?? 0) - (a.value ?? a.count ?? 0));

    const scoredModels = Object.entries(this.candidateScores)
      .map(([modelId, slot]) => ({
        model: modelId,
        avgScore: Math.round((slot.total / slot.count) * 1000) / 1000,
        scored: slot.count,
      }))
      .sort((a, b) => b.avgScore - a.avgScore);

    return {
      startedAt: this.startedAt,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      counts: this.counts,
      averages: {
        latencyMs: avg(this.sums, "latencyMs"),
        classifierMs: avg(this.sums, "classifierMs"),
        confidence: avg(this.sums, "confidence"),
      },
      totals: {
        inputTokens: this.sums.inputTokens,
        outputTokens: this.sums.outputTokens,
        costUsd: Math.round(this.sums.costUsd * 10000) / 10000,
      },
      byTask: toSortedEntries(this.byTask),
      byModel: toSortedEntries(this.byModel),
      byModelType: toSortedEntries(this.byModelType),
      byRisk: toSortedEntries(this.byRisk),
      byMode: toSortedEntries(this.byMode),
      candidateScores: scoredModels,
      recent: this.records.slice(0, 30),
      allRecords: this.records,
    };
  }
}

// Singleton for the server process.
module.exports = new MetricsStore();
