// ============================================================
// Routing metrics
//
// Records every classified request: what the classifier decided,
// how the router scored the candidates, which model served the
// request, how long it took, and what it cost.
//
// TWO scopes:
//   - session: in-memory since this server process started
//   - global:  persisted to data/usage-stats.json, accumulates
//              across restarts — "spend until now"
//
// Served as JSON on GET /metrics so the dashboard can poll it.
// ============================================================

const fs = require("fs");
const path = require("path");

const MAX_RECORDS = 250;
const STATS_VERSION = 1;
const STATS_FILE = path.join(__dirname, "..", "data", "usage-stats.json");

function emptyGlobal() {
  return {
    version: STATS_VERSION,
    since: new Date().toISOString(),
    requests: 0,
    provider: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    classifier: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
    // Cumulative hypothetical cost per baseline model (same tokens,
    // one fixed model always). Saved = hypothetical − actual.
    baselines: [],
  };
}

class MetricsStore {
  constructor() {
    this.records = []; // ring buffer, newest first
    this.startedAt = Date.now();
    this.pricing = null; // config/pricing.json — set via setPricing()
    this.global = this._loadGlobal();
    this.reset();
  }

  /**
   * Pricing config (config/pricing.json). Used to compute what the
   * same traffic WOULD have cost on a fixed baseline model.
   */
  setPricing(pricing) {
    this.pricing = pricing;
  }

  // ----------------------------------------------------------
  // Global (persistent) stats
  // ----------------------------------------------------------

  _loadGlobal() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      if (raw && raw.version === STATS_VERSION) return raw;
    } catch (_) {
      // First run or corrupted file — start fresh.
    }
    return emptyGlobal();
  }

  _persistGlobal() {
    try {
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.global, null, 2));
    } catch (err) {
      console.warn("[metrics] Could not persist global stats:", err.message);
    }
  }

  /** Wipe the persistent counter — session reset alone does NOT. */
  resetGlobal() {
    this.global = emptyGlobal();
    this._persistGlobal();
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
      costUsd: 0,             // provider cost only
      classifierCostUsd: 0,   // LLM-fallback classifier calls
      classifierInputTokens: 0,
      classifierOutputTokens: 0,
      classifierCalls: 0,
    };
    this.byTask = {};      // primary_task -> count
    this.byModel = {};     // model id -> { count, costUsd }
    this.byModelType = {}; // routing.model_type -> count
    this.byRisk = {};      // risk -> count
    this.byMode = {};      // routing mode -> count
    this.candidateScores = {}; // model id -> { total, count } running avg
    this.eval = null;      // last eval-set run summary
    this.startedAt = Date.now();
  }

  /**
   * Store the latest eval-set run. Eval traffic is NOT counted in
   * request aggregates — it is measurement, not production traffic.
   */
  recordEvalRun(summary) {
    this.eval = { ...summary, lastRunAt: Date.now() };
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

    // LLM-fallback classifier calls bill tokens too — account for
    // them so savings numbers are honest.
    const clsCost = entry.classifierCost;
    if (clsCost?.costUsd) {
      this.sums.classifierCostUsd += clsCost.costUsd;
      this.sums.classifierInputTokens += clsCost.inputTokens || 0;
      this.sums.classifierOutputTokens += clsCost.outputTokens || 0;
      this.sums.classifierCalls += 1;
    }

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

    // ---- Global accumulation (persisted) ----
    // Demo traffic is simulated — it lives in session metrics only,
    // never in the real "spend until now" counter.
    if (!entry.demo) {
      this.global.requests += 1;
      if (p) {
        this.global.provider.costUsd += p.costUsd || 0;
        this.global.provider.inputTokens += p.usage?.input_tokens || 0;
        this.global.provider.outputTokens += p.usage?.output_tokens || 0;
      }
      if (clsCost?.costUsd) {
        this.global.classifier.costUsd += clsCost.costUsd;
        this.global.classifier.inputTokens += clsCost.inputTokens || 0;
        this.global.classifier.outputTokens += clsCost.outputTokens || 0;
        this.global.classifier.calls += 1;
      }

      // Cumulative hypothetical: this request's tokens on each
      // baseline model. Saved money = hypothetical − actual.
      const inTok = p?.usage?.input_tokens || 0;
      const outTok = p?.usage?.output_tokens || 0;
      for (const b of this.pricing?.baselines || []) {
        const price = this.pricing?.models?.[b.modelId];
        if (!price) continue;
        const hypo = (inTok * price.inputPer1M + outTok * price.outputPer1M) / 1e6;
        let slot = this.global.baselines.find((g) => g.modelId === b.modelId);
        if (!slot) {
          slot = { modelId: b.modelId, label: b.label, hypotheticalCost: 0 };
          this.global.baselines.push(slot);
        }
        slot.hypotheticalCost += hypo;
      }

      this._persistGlobal();
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
      classifierCostUsd: entry.classifierCost?.costUsd ?? null,
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

    // ---- Fixed-model baseline comparison ----
    // What would this exact traffic (same token counts) have cost if
    // every request had gone to one fixed model? Savings = the
    // routing's cost benefit over "no proxy" configurations.
    const costBaselines = (this.pricing?.baselines || []).map((b) => {
      const price = this.pricing?.models?.[b.modelId];
      if (!price) return { ...b, error: "no pricing for " + b.modelId };
      const hypothetical =
        (this.sums.inputTokens * price.inputPer1M +
          this.sums.outputTokens * price.outputPer1M) / 1e6;
      // Fair comparison: proxy's FULL spend (providers + classifier).
      const actual = this.sums.costUsd + this.sums.classifierCostUsd;
      return {
        modelId: b.modelId,
        label: b.label,
        inputPer1M: price.inputPer1M,
        outputPer1M: price.outputPer1M,
        actualCost: Math.round(actual * 10000) / 10000,
        hypotheticalCost: Math.round(hypothetical * 10000) / 10000,
        savedUsd: Math.round((hypothetical - actual) * 10000) / 10000,
        savedPct:
          hypothetical > 0
            ? Math.round((1 - actual / hypothetical) * 10000) / 100
            : null,
        requests: this.counts.requests,
      };
    });

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
        classifierCostUsd: Math.round(this.sums.classifierCostUsd * 10000) / 10000,
        classifierInputTokens: this.sums.classifierInputTokens,
        classifierOutputTokens: this.sums.classifierOutputTokens,
        classifierCalls: this.sums.classifierCalls,
        // Everything the proxy spent, classifier included.
        totalCostUsd:
          Math.round((this.sums.costUsd + this.sums.classifierCostUsd) * 10000) / 10000,
      },
      // ---- Global (persisted) view ----
      global: (() => {
        const g = this.global;
        const totalCostUsd =
          Math.round((g.provider.costUsd + g.classifier.costUsd) * 10000) / 10000;
        const baselines = g.baselines.map((b) => {
          const savedUsd =
            Math.round((b.hypotheticalCost - totalCostUsd) * 10000) / 10000;
          return {
            ...b,
            hypotheticalCost: Math.round(b.hypotheticalCost * 10000) / 10000,
            actualCost: totalCostUsd,
            savedUsd,
            savedPct:
              b.hypotheticalCost > 0
                ? Math.round((1 - totalCostUsd / b.hypotheticalCost) * 10000) / 100
                : null,
          };
        });
        return {
          since: g.since,
          requests: g.requests,
          provider: { ...g.provider, costUsd: Math.round(g.provider.costUsd * 10000) / 10000 },
          classifier: {
            ...g.classifier,
            costUsd: Math.round(g.classifier.costUsd * 10000) / 10000,
          },
          totalCostUsd,
          inputTokens: g.provider.inputTokens + g.classifier.inputTokens,
          outputTokens: g.provider.outputTokens + g.classifier.outputTokens,
          baselines,
        };
      })(),
      byTask: toSortedEntries(this.byTask),
      byModel: toSortedEntries(this.byModel),
      byModelType: toSortedEntries(this.byModelType),
      byRisk: toSortedEntries(this.byRisk),
      byMode: toSortedEntries(this.byMode),
      candidateScores: scoredModels,
      costBaselines,
      eval: this.eval,
      recent: this.records.slice(0, 30),
      allRecords: this.records,
    };
  }
}

// Singleton for the server process.
module.exports = new MetricsStore();
