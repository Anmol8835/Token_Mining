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
const db = require("./db");

const MAX_RECORDS = 250;
const STATS_VERSION = 1;
const STATS_FILE = path.join(__dirname, "..", "data", "usage-stats.json");

// ---- SQLite: per-user daily rollups + durable request history ----
// usage_daily = the account-totals store the dashboard reads; deltas
// accumulate in memory and flush on the persist gate. request_events
// is the Activity-page history (metadata only, ring-buffered).
const EVENT_RETENTION_DAYS = 14;
const EVENT_RETENTION_ROWS = 20_000;

const upsertDailyStmt = db.prepare(
  `INSERT INTO usage_daily
     (user_id, day, requests, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, cost_usd,
      classifier_cost_usd, baseline_cost_usd)
   VALUES
     (@userId, @day, @requests, @inputTokens, @outputTokens,
      @cacheReadTokens, @cacheWriteTokens, @costUsd,
      @classifierCostUsd, @baselineCostUsd)
   ON CONFLICT(user_id, day) DO UPDATE SET
     requests = requests + excluded.requests,
     input_tokens = input_tokens + excluded.input_tokens,
     output_tokens = output_tokens + excluded.output_tokens,
     cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
     cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
     cost_usd = cost_usd + excluded.cost_usd,
     classifier_cost_usd = classifier_cost_usd + excluded.classifier_cost_usd,
     baseline_cost_usd = baseline_cost_usd + excluded.baseline_cost_usd`
);

const insertEventStmt = db.prepare(
  `INSERT INTO request_events
     (user_id, ts, model, route, input_tokens, output_tokens, cost_usd, ok)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

const trimEventsStmt = db.prepare(
  `DELETE FROM request_events
   WHERE ts < ?
      OR id <= (SELECT COALESCE(MAX(id), 0) FROM request_events) - ?`
);

// Persist at most every 30s under traffic — mirrors the api-keys.js
// lastUsedAt gate. Explicit resets pass force=true and always write
// immediately. Trade-off: up to 30s of global counters can be lost
// on a crash (they're dashboard-only, so that's acceptable).
const PERSIST_GATE_MS = 30_000;
let lastPersistAt = 0;

function emptyGlobal() {
  return {
    version: STATS_VERSION,
    since: new Date().toISOString(),
    requests: 0,
    provider: {
      costUsd: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, cacheSavingsUsd: 0,
    },
    classifier: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
    compaction: { costUsd: 0, calls: 0 },
    // Cumulative hypothetical cost per baseline model (same token
    // bundle — plain in/out + cache reads/writes — on one fixed
    // model always). Saved = hypothetical − actual.
    baselines: [],
  };
}

/**
 * Fair cost of a token bundle on a given pricing entry: the SAME
 * traffic (plain in/out plus cache reads and writes) priced on one
 * fixed model. Cache reads price at the model's cache-hit rate;
 * cache-creation tokens price at the model's write premium when it
 * has one (Anthropic multipliers — 2x under the 1h TTL), and as
 * plain input otherwise (OpenAI-style providers bill misses at the
 * full input rate, with no separate write charge).
 *
 * Works on raw config/pricing.json entries (multipliers / hit-rate
 * fields), not the registry's pre-computed cost fields.
 */
function hypotheticalCost(pricing, usage) {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  const read = usage?.cache_read_input_tokens || 0;
  const write = usage?.cache_creation_input_tokens || 0;

  let readPrice = pricing.inputPer1M;
  let writePrice = pricing.inputPer1M;
  if (pricing.cacheReadMultiplier) {
    readPrice = pricing.inputPer1M * pricing.cacheReadMultiplier;
    writePrice = pricing.inputPer1M * (pricing.cacheWriteMultiplier ?? 1.25);
  } else if (pricing.cacheHitInputPer1M) {
    readPrice = pricing.cacheHitInputPer1M;
  }

  return (
    input * pricing.inputPer1M +
    output * pricing.outputPer1M +
    read * readPrice +
    write * writePrice
  ) / 1e6;
}

class MetricsStore {
  constructor() {
    this.records = []; // ring buffer, newest first
    this.startedAt = Date.now();
    this.pricing = null; // config/pricing.json — set via setPricing()
    this.hypotheticalCost = hypotheticalCost; // shared with index.js logging
    this.global = this._loadGlobal();
    // Pending per-user usage_daily deltas, flushed on the persist
    // tick. NOT cleared by reset() — a session reset must not drop
    // accumulation owed to the durable store.
    this.daily = new Map(); // key: userId + "\x00" + day
    // Legacy v1 files predate the cache/compaction fields — fill them
    // in so accumulation never hits undefined += n.
    const g = this.global;
    g.provider = g.provider || {};
    g.provider.cacheReadTokens = g.provider.cacheReadTokens || 0;
    g.provider.cacheWriteTokens = g.provider.cacheWriteTokens || 0;
    g.provider.cacheSavingsUsd = g.provider.cacheSavingsUsd || 0;
    g.classifier = g.classifier || {};
    g.compaction = g.compaction || { costUsd: 0, calls: 0 };
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

  _persistGlobal(force = false) {
    if (!force && Date.now() - lastPersistAt < PERSIST_GATE_MS) return;
    try {
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.global, null, 2));
      lastPersistAt = Date.now();
    } catch (err) {
      console.warn("[metrics] Could not persist global stats:", err.message);
    }
    this._flushDaily();
  }

  /**
   * Flush pending per-user daily deltas into usage_daily and trim
   * request_events. Rides the same 30s persist gate as the JSON
   * counter — up to 30s of deltas can be lost on a crash, identical
   * to the existing trade-off. The UPSERT ADDS to any existing row,
   * so a restart mid-day neither double-counts nor loses the
   * pre-restart portion of the day.
   */
  _flushDaily() {
    if (this.daily.size) {
      const tx = db.transaction(() => {
        for (const d of this.daily.values()) upsertDailyStmt.run(d);
        this.daily.clear();
      });
      try {
        tx();
      } catch (err) {
        console.warn("[metrics] daily rollup flush failed:", err.message);
      }
    }
    try {
      trimEventsStmt.run(
        Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        EVENT_RETENTION_ROWS
      );
    } catch (err) {
      console.warn("[metrics] request_events trim failed:", err.message);
    }
  }

  /**
   * Wipe the persistent JSON counter — session reset alone does NOT.
   * The SQLite tables (usage_daily, request_events) are the durable
   * per-account store and deliberately survive a global reset.
   */
  resetGlobal() {
    this.global = emptyGlobal();
    this._persistGlobal(true);
  }

  /**
   * Fresh session-aggregate container. Also the per-user slot shape
   * (this.byUser values) — every place that aggregates a request
   * works on one of these, so the operator view and a scoped user
   * view are computed by the exact same code.
   */
  _emptyAgg() {
    return {
      counts: {
        requests: 0,
        providerFallbacks: 0,
        providerFailures: 0,
        llmFallbacks: 0,
        humanReviewFlags: 0,
      },
      sums: {
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
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheSavingsUsd: 0,     // vs a no-caching baseline
        compactionCostUsd: 0,
        compactionCalls: 0,
        compactionTokensSaved: 0,
      },
      byTask: {},      // primary_task -> count
      byModel: {},     // model id -> { count, costUsd }
      byModelType: {}, // routing.model_type -> count
      byRisk: {},      // risk -> count
      byMode: {},      // routing mode -> count
      candidateScores: {}, // model id -> { total, count } running avg
    };
  }

  /** Lazily create the per-user session aggregate slot. */
  _userAgg(userId) {
    let agg = this.byUser.get(userId);
    if (!agg) {
      agg = this._emptyAgg();
      this.byUser.set(userId, agg);
    }
    return agg;
  }

  reset() {
    this.records = [];
    Object.assign(this, this._emptyAgg());
    this.eval = null;      // last eval-set run summary
    this.startedAt = Date.now();
    // Per-user session aggregates — session-only like the rest of
    // this state, so a reset clears them too. `daily` (durable
    // usage_daily deltas owed to SQLite) deliberately survives.
    this.byUser = new Map();
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
   * @param {string|null} [entry.userId] - Account owning the API key
   *   (per-user attribution in usage_daily; null = bootstrap traffic)
   */
  /**
   * Apply one request's session aggregates to `agg` — a container
   * shaped by _emptyAgg(). Called with `this` for the instance-wide
   * (operator) view and with the owning account's slot for the
   * scoped view, so both are computed by identical code.
   *
   * @param {object} agg
   * @param {object} entry - same shape as record()'s
   * @param {number} cacheSavingsUsd - precomputed (see record())
   */
  _applyEntry(agg, entry, cacheSavingsUsd) {
    const c = entry.classification || {};
    const p = entry.providerResult;
    const clsCost = entry.classifierCost;

    agg.counts.requests++;
    agg.sums.classifierMs += entry.classifierMs || 0;
    agg.sums.confidence += c.confidence || 0;

    // LLM-fallback classifier calls bill tokens too — account for
    // them so savings numbers are honest.
    if (clsCost?.costUsd) {
      agg.sums.classifierCostUsd += clsCost.costUsd;
      agg.sums.classifierInputTokens += clsCost.inputTokens || 0;
      agg.sums.classifierOutputTokens += clsCost.outputTokens || 0;
      agg.sums.classifierCalls += 1;
    }

    if (c.source === "llm") agg.counts.llmFallbacks++;
    if (c.routing?.human_review_recommended) agg.counts.humanReviewFlags++;

    agg.byTask[c.primary_task] = (agg.byTask[c.primary_task] || 0) + 1;
    agg.byRisk[c.risk] = (agg.byRisk[c.risk] || 0) + 1;
    if (c.routing?.model_type) {
      agg.byModelType[c.routing.model_type] =
        (agg.byModelType[c.routing.model_type] || 0) + 1;
    }

    if (entry.route) {
      agg.byMode[entry.route.detail?.mode || "?"] =
        (agg.byMode[entry.route.detail?.mode || "?"] || 0) + 1;

      // Running average of candidate scores so the dashboard can
      // show which models the router keeps ranking where.
      for (const [modelId, score] of entry.route.detail?.scores || []) {
        const slot = agg.candidateScores[modelId] || { total: 0, count: 0 };
        slot.total += score;
        slot.count += 1;
        agg.candidateScores[modelId] = slot;
      }
    }

    if (p) {
      agg.sums.latencyMs += p.latencyMs || 0;
      agg.sums.inputTokens += p.usage?.input_tokens || 0;
      agg.sums.outputTokens += p.usage?.output_tokens || 0;
      agg.sums.costUsd += p.costUsd || 0;

      const modelSlot = agg.byModel[p.modelId] || { count: 0, costUsd: 0 };
      modelSlot.count += 1;
      modelSlot.costUsd += p.costUsd || 0;
      agg.byModel[p.modelId] = modelSlot;

      if (!p.ok) agg.counts.providerFailures++;

      // Cache accounting: reads avoid the full input rate; Anthropic
      // writes cost a premium (negative contribution to savings).
      agg.sums.cacheReadTokens += p.usage?.cache_read_input_tokens || 0;
      agg.sums.cacheWriteTokens += p.usage?.cache_creation_input_tokens || 0;
      agg.sums.cacheSavingsUsd += cacheSavingsUsd;
    }

    if (entry.providerFallbacks > 0) {
      agg.counts.providerFallbacks += entry.providerFallbacks;
    }
  }

  record(entry) {
    const c = entry.classification || {};
    const p = entry.providerResult;
    const clsCost = entry.classifierCost;

    // Cache accounting: reads avoid the full input rate; Anthropic
    // writes cost a premium (negative contribution to savings).
    // Computed once — it feeds the session aggregates, the persisted
    // global counter and the per-user daily rollups alike.
    let cacheSavingsUsd = 0;
    if (p) {
      const read = p.usage?.cache_read_input_tokens || 0;
      const write = p.usage?.cache_creation_input_tokens || 0;
      const price = this.pricing?.models?.[p.modelId];
      if (price && (read || write)) {
        const readPrice =
          price.cacheReadInputPer1M ?? price.cacheHitInputPer1M ?? price.inputPer1M;
        cacheSavingsUsd =
          (read * (price.inputPer1M - readPrice) +
            (price.cacheWriteInputPer1M
              ? write * (price.inputPer1M - price.cacheWriteInputPer1M)
              : 0)) /
          1e6;
      }
    }

    // Session aggregates: the instance-wide view plus, for
    // attributed traffic, the owning account's own slot.
    this._applyEntry(this, entry, cacheSavingsUsd);
    if (entry.userId) this._applyEntry(this._userAgg(entry.userId), entry, cacheSavingsUsd);

    // ---- Global accumulation (persisted) ----
    // Demo traffic is simulated — it lives in session metrics only,
    // never in the real "spend until now" counter.
    if (!entry.demo) {
      this.global.requests += 1;
      if (p) {
        this.global.provider.costUsd += p.costUsd || 0;
        this.global.provider.inputTokens += p.usage?.input_tokens || 0;
        this.global.provider.outputTokens += p.usage?.output_tokens || 0;
        this.global.provider.cacheReadTokens += p.usage?.cache_read_input_tokens || 0;
        this.global.provider.cacheWriteTokens += p.usage?.cache_creation_input_tokens || 0;
        this.global.provider.cacheSavingsUsd += cacheSavingsUsd;
      }
      if (clsCost?.costUsd) {
        this.global.classifier.costUsd += clsCost.costUsd;
        this.global.classifier.inputTokens += clsCost.inputTokens || 0;
        this.global.classifier.outputTokens += clsCost.outputTokens || 0;
        this.global.classifier.calls += 1;
      }

      // Cumulative hypothetical: this request's full token bundle
      // (plain in/out + cache reads/writes) priced on each baseline
      // model. Saved money = hypothetical − actual.
      for (const b of this.pricing?.baselines || []) {
        const price = this.pricing?.models?.[b.modelId];
        if (!price) continue;
        const hypo = hypotheticalCost(price, p?.usage || {});
        let slot = this.global.baselines.find((g) => g.modelId === b.modelId);
        if (!slot) {
          slot = { modelId: b.modelId, label: b.label, hypotheticalCost: 0 };
          this.global.baselines.push(slot);
        }
        slot.hypotheticalCost += hypo;
      }

      // ---- Per-user daily rollups (SQLite usage_daily) ----
      // The durable per-account totals store. Unattributed traffic
      // (zero-key bootstrap mode) lands under "anonymous" — NULL
      // would break the composite PK (SQLite treats NULLs as
      // distinct). Compaction cost stays global-only.
      const userId = entry.userId || "anonymous";
      const day = new Date().toISOString().slice(0, 10);
      const dailyKey = userId + "\x00" + day;
      let d = this.daily.get(dailyKey);
      if (!d) {
        d = {
          userId,
          day,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          classifierCostUsd: 0,
          baselineCostUsd: 0,
        };
        this.daily.set(dailyKey, d);
      }
      d.requests += 1;
      if (p) {
        d.inputTokens += p.usage?.input_tokens || 0;
        d.outputTokens += p.usage?.output_tokens || 0;
        d.cacheReadTokens += p.usage?.cache_read_input_tokens || 0;
        d.cacheWriteTokens += p.usage?.cache_creation_input_tokens || 0;
        d.costUsd += p.costUsd || 0;
        // The same traffic priced on the PRIMARY baseline (flagship).
        // Per-user saved = baselineCostUsd − (costUsd + classifierCostUsd).
        const primary = this.pricing?.baselines?.[0];
        const price = primary && this.pricing?.models?.[primary.modelId];
        if (price) d.baselineCostUsd += hypotheticalCost(price, p.usage || {});
      }
      if (clsCost?.costUsd) d.classifierCostUsd += clsCost.costUsd;

      // Durable request history — metadata only, no prompt text.
      insertEventStmt.run(
        entry.userId ?? null,
        Date.now(),
        entry.route?.model?.id || p?.modelId || null,
        c.routing?.model_type || null,
        p?.usage?.input_tokens ?? null,
        p?.usage?.output_tokens ?? null,
        p?.costUsd ?? null,
        p ? (p.ok ? 1 : 0) : null
      );

      this._persistGlobal();
    }

    this.records.unshift({
      ts: Date.now(),
      // Owning account (null = bootstrap traffic). snapshot() filters
      // on this to scope a signed-in user's Activity view.
      userId: entry.userId ?? null,
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
      cacheReadTokens: p?.usage?.cache_read_input_tokens ?? null,
      compactionDroppedMsgs: entry.compaction?.droppedCount ?? null,
      compactionCostUsd: entry.compaction?.costUsd ?? null,
      tokens: p ? (p.usage?.input_tokens || 0) + (p.usage?.output_tokens || 0) : null,
      ok: p ? p.ok : null,
      scores: entry.route?.detail?.scores || null,
      reason: entry.route?.reason || null,
    });
    if (this.records.length > MAX_RECORDS) this.records.pop();
  }

  /**
   * Record a compaction event. Separate from record() so the
   * explicit-model path (which skips classification metrics) still
   * accounts for compaction spend.
   */
  recordCompaction(info, cost) {
    if (!info) return;
    this.sums.compactionCalls += 1;
    this.sums.compactionCostUsd += cost?.costUsd || 0;
    this.sums.compactionTokensSaved +=
      Math.max(0, (info.tokensBefore || 0) - (info.tokensAfter || 0));
    this.global.compaction.costUsd += cost?.costUsd || 0;
    this.global.compaction.calls += 1;
    this._persistGlobal();
  }

  // ----------------------------------------------------------
  // Snapshot
  // ----------------------------------------------------------

  /**
   * Presentation view of one baseline row: the same traffic priced
   * on a single fixed model vs what it actually cost. Shared by the
   * operator all-time block and the per-user all-time block so the
   * two can never diverge.
   */
  _baselineView(b, totalCostUsd) {
    const savedUsd = Math.round((b.hypotheticalCost - totalCostUsd) * 10000) / 10000;
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
  }

  /**
   * Per-user "all-time" block, assembled from the durable store
   * (usage_daily — the same table the dashboard's /api/totals route
   * reads). Shape mirrors the `global` block in snapshot().
   *
   * Documented gaps: fields the rollup doesn't persist per user read
   * 0 here — cache savings (global-only), classifier token/call
   * counts, and compaction. The accurate per-user savings figure is
   * baselineCost − actual, shown in AccountUsage on the dashboard.
   */
  userAllTime(userId) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(requests), 0)            AS requests,
                COALESCE(SUM(input_tokens), 0)        AS inputTokens,
                COALESCE(SUM(output_tokens), 0)       AS outputTokens,
                COALESCE(SUM(cache_read_tokens), 0)   AS cacheReadTokens,
                COALESCE(SUM(cache_write_tokens), 0)  AS cacheWriteTokens,
                COALESCE(SUM(cost_usd), 0)            AS costUsd,
                COALESCE(SUM(classifier_cost_usd), 0) AS classifierCostUsd,
                MIN(day)                              AS since
         FROM usage_daily WHERE user_id = ?`
      )
      .get(userId);

    const totalCostUsd =
      Math.round((row.costUsd + row.classifierCostUsd) * 10000) / 10000;

    // Same cumulative hypothetical as the global counter: the user's
    // whole token bundle priced on each baseline model.
    const baselines = [];
    for (const b of this.pricing?.baselines || []) {
      const price = this.pricing?.models?.[b.modelId];
      if (!price) continue;
      const hypo = hypotheticalCost(price, {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cache_read_input_tokens: row.cacheReadTokens,
        cache_creation_input_tokens: row.cacheWriteTokens,
      });
      baselines.push(
        this._baselineView(
          { modelId: b.modelId, label: b.label, hypotheticalCost: hypo },
          totalCostUsd
        )
      );
    }

    return {
      since: row.since ? `${row.since}T00:00:00.000Z` : new Date().toISOString(),
      requests: row.requests,
      provider: {
        costUsd: Math.round(row.costUsd * 10000) / 10000,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        cacheSavingsUsd: 0, // not persisted per user (global-only)
      },
      classifier: {
        costUsd: Math.round(row.classifierCostUsd * 10000) / 10000,
        inputTokens: 0, // not persisted per user
        outputTokens: 0,
        calls: 0,
      },
      compaction: { costUsd: 0, calls: 0 }, // global-only
      totalCostUsd,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      baselines,
    };
  }

  /**
   * @param {string|null} [userId] - null: the whole process (the
   *   operator view, identical to the pre-scoping behavior). A user
   *   id: that account's own session aggregates + ring-buffer
   *   records, with `global` served from its usage_daily totals.
   */
  snapshot(userId = null) {
    const agg =
      userId === null ? this : this.byUser.get(userId) || this._emptyAgg();
    const records =
      userId === null
        ? this.records
        : this.records.filter((r) => r.userId === userId);

    const avg = (sum, key) =>
      agg.counts.requests > 0
        ? Math.round((sum[key] / agg.counts.requests) * 100) / 100
        : 0;

    const toSortedEntries = (obj) =>
      Object.entries(obj)
        .map(([key, value]) =>
          typeof value === "object" ? { key, ...value } : { key, value }
        )
        .sort((a, b) => (b.value ?? b.count ?? 0) - (a.value ?? a.count ?? 0));

    const scoredModels = Object.entries(agg.candidateScores)
      .map(([modelId, slot]) => ({
        model: modelId,
        avgScore: Math.round((slot.total / slot.count) * 1000) / 1000,
        scored: slot.count,
      }))
      .sort((a, b) => b.avgScore - a.avgScore);

    // ---- Fixed-model baseline comparison ----
    // What would this exact traffic have cost if every request had
    // gone to one fixed model? Fair comparison: the SAME token bundle
    // — plain in/out plus cache reads and writes — priced at that
    // model's own cache rates. Savings = the routing's cost benefit
    // over "no proxy" configurations.
    const costBaselines = (this.pricing?.baselines || []).map((b) => {
      const price = this.pricing?.models?.[b.modelId];
      if (!price) return { ...b, error: "no pricing for " + b.modelId };
      const hypothetical = hypotheticalCost(price, {
        input_tokens: agg.sums.inputTokens,
        output_tokens: agg.sums.outputTokens,
        cache_read_input_tokens: agg.sums.cacheReadTokens,
        cache_creation_input_tokens: agg.sums.cacheWriteTokens,
      });
      // Fair comparison: proxy's FULL spend (providers + classifier + compaction).
      const actual =
        agg.sums.costUsd + agg.sums.classifierCostUsd + agg.sums.compactionCostUsd;
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
        requests: agg.counts.requests,
      };
    });

    return {
      startedAt: this.startedAt,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      counts: agg.counts,
      averages: {
        latencyMs: avg(agg.sums, "latencyMs"),
        classifierMs: avg(agg.sums, "classifierMs"),
        confidence: avg(agg.sums, "confidence"),
      },
      totals: {
        inputTokens: agg.sums.inputTokens,
        outputTokens: agg.sums.outputTokens,
        costUsd: Math.round(agg.sums.costUsd * 10000) / 10000,
        classifierCostUsd: Math.round(agg.sums.classifierCostUsd * 10000) / 10000,
        classifierInputTokens: agg.sums.classifierInputTokens,
        classifierOutputTokens: agg.sums.classifierOutputTokens,
        classifierCalls: agg.sums.classifierCalls,
        cacheReadTokens: agg.sums.cacheReadTokens,
        cacheWriteTokens: agg.sums.cacheWriteTokens,
        cacheSavingsUsd: Math.round(agg.sums.cacheSavingsUsd * 10000) / 10000,
        compactionCostUsd: Math.round(agg.sums.compactionCostUsd * 10000) / 10000,
        compactionCalls: agg.sums.compactionCalls,
        compactionTokensSaved: agg.sums.compactionTokensSaved,
        // Everything the proxy spent, classifier + compaction included.
        totalCostUsd:
          Math.round((agg.sums.costUsd + agg.sums.classifierCostUsd + agg.sums.compactionCostUsd) * 10000) / 10000,
      },
      // ---- All-time view ----
      // Operator: the persisted process-wide counter. Scoped user:
      // its own durable usage_daily totals (userAllTime above).
      global:
        userId === null
          ? (() => {
              const g = this.global;
              // Legacy v1 files predate the cache/compaction fields — guard.
              const gCompaction = g.compaction || { costUsd: 0, calls: 0 };
              const totalCostUsd =
                Math.round((g.provider.costUsd + g.classifier.costUsd + gCompaction.costUsd) * 10000) / 10000;
              const baselines = g.baselines.map((b) =>
                this._baselineView(b, totalCostUsd)
              );
              return {
                since: g.since,
                requests: g.requests,
                provider: {
                  ...g.provider,
                  costUsd: Math.round(g.provider.costUsd * 10000) / 10000,
                  cacheReadTokens: g.provider.cacheReadTokens || 0,
                  cacheWriteTokens: g.provider.cacheWriteTokens || 0,
                  cacheSavingsUsd: Math.round((g.provider.cacheSavingsUsd || 0) * 10000) / 10000,
                },
                classifier: {
                  ...g.classifier,
                  costUsd: Math.round(g.classifier.costUsd * 10000) / 10000,
                },
                compaction: {
                  costUsd: Math.round(gCompaction.costUsd * 10000) / 10000,
                  calls: gCompaction.calls || 0,
                },
                totalCostUsd,
                inputTokens: g.provider.inputTokens + g.classifier.inputTokens,
                outputTokens: g.provider.outputTokens + g.classifier.outputTokens,
                baselines,
              };
            })()
          : this.userAllTime(userId),
      byTask: toSortedEntries(agg.byTask),
      byModel: toSortedEntries(agg.byModel),
      byModelType: toSortedEntries(agg.byModelType),
      byRisk: toSortedEntries(agg.byRisk),
      byMode: toSortedEntries(agg.byMode),
      candidateScores: scoredModels,
      costBaselines,
      eval: this.eval,
      recent: records.slice(0, 30),
      allRecords: records,
    };
  }
}

// Singleton for the server process.
module.exports = new MetricsStore();
