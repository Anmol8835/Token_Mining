// ============================================================
// Rolling prompt compaction
//
// Policy (user-specified):
//   - Compact when estimated input exceeds thresholdPct of the
//     USABLE input budget (context − reserved output/tool space).
//   - Keep the last N exchanges verbatim; summarize older messages
//     and bulky tool outputs.
//   - The summary is FROZEN between compactions (append-only
//     conversation) so provider-side prefix caching stays warm.
//   - Structure: [stable system + tools] [frozen summary]
//     [recent, append-only] [new user message].
//
// Incremental: when the dropped range grows past the last boundary,
// re-summarize(previous summary + newly dropped turns) in ONE call.
// ============================================================

const crypto = require("crypto");
const axios = require("axios");
const {
  extractSystemText,
  estimateInputTokens,
  findCompactionCut,
} = require("./classifier/text-utils");

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

const SUMMARIZE_PROMPT = {
  type: "text",
  text: `You are a conversation compactor for an LLM routing proxy. Summarize the earlier part of the conversation so a model can continue seamlessly without the dropped history.

Preserve exactly:
- decisions made and constraints the user set
- unresolved tasks and what is still in progress
- exact details: numbers, filenames, commands, error messages, API responses
- key facts from tool outputs (results, values, failures)

Omit pleasantries, meta-commentary, and anything that no longer matters for continuing the work. Write the summary in second person addressed to the model ("The user asked you to..."). Keep it under 500 words.`,
};

// ------------------------------------------------------------------
// CompactionStore — frozen summaries keyed by conversation family.
// Entry key: familyKey:droppedCount, where familyKey = md5(systemText).
// boundaryHash = md5 of the LAST dropped message at write time, so a
// later request can verify the stored summary still covers a prefix
// of the newly dropped range (history is append-only).
// ------------------------------------------------------------------
class CompactionStore {
  constructor({ ttlMs = 60 * 60 * 1000, maxEntries = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> { cut, boundaryHash, summary, at }
  }

  _prune() {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      if (now - e.at > this.ttlMs) this.entries.delete(k);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  get(familyKey, cut, boundaryHash) {
    const key = `${familyKey}:${cut}`;
    const e = this.entries.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) { this.entries.delete(key); return null; }
    if (e.boundaryHash !== boundaryHash) { this.entries.delete(key); return null; }
    e.at = Date.now(); // touch — reads refresh, like a cache
    return e.summary;
  }

  /** Largest stored entry for this family whose cut is below `cut`. */
  findPrevious(familyKey, cut) {
    const prefix = `${familyKey}:`;
    let best = null;
    for (const [key, e] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      if (Date.now() - e.at > this.ttlMs) { this.entries.delete(key); continue; }
      if (e.cut >= cut) continue;
      if (!best || e.cut > best.cut) best = e;
    }
    return best;
  }

  set(familyKey, cut, boundaryHash, summary) {
    this._prune();
    this.entries.set(`${familyKey}:${cut}`, {
      cut, boundaryHash, summary, at: Date.now(),
    });
  }
}

let _store = null;
function getStore(cfg) {
  if (!_store) {
    const s = cfg.store || {};
    _store = new CompactionStore({
      ttlMs: (s.ttlMinutes ?? 60) * 60 * 1000,
      maxEntries: s.maxEntries ?? 500,
    });
  }
  return _store;
}

// In-flight summarize promises — concurrent identical requests must
// not fire duplicate summarize calls.
const inflight = new Map(); // key -> Promise<string>

// ------------------------------------------------------------------
// Rendering + the summarize call
// ------------------------------------------------------------------

/**
 * Render dropped messages as compact text for the summarizer.
 * The TAIL of the dropped range is kept when it exceeds maxChars —
 * the most recent dropped content matters most.
 */
function renderDropped(msgs, maxChars) {
  const parts = [];
  for (const m of msgs) {
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const bits = [];
      for (const b of m.content) {
        if (b.type === "text") bits.push(b.text);
        else if (b.type === "tool_use") {
          bits.push(`[Tool call: ${b.name}] ${JSON.stringify(b.input || {})}`);
        } else if (b.type === "tool_result") {
          const inner = Array.isArray(b.content)
            ? b.content.map((c) => c.text || "").join("\n")
            : (b.content || "");
          bits.push(`[Tool result]: ${inner}`);
        }
      }
      text = bits.join("\n");
    }
    if (text.trim()) parts.push(`${m.role}: ${text}`);
  }
  let out = parts.join("\n\n");
  if (out.length > maxChars) {
    out = "…(earlier portion omitted)…\n\n" + out.slice(-(maxChars - 40));
  }
  return out;
}

/**
 * One summarize call: compaction model, thinking disabled (reasoning
 * tokens would eat the output budget), non-streaming. Mirrors the
 * classifier's _doChat pattern.
 *
 * @returns {Promise<{summary: string, costUsd: number|null}>}
 */
async function summarize(text, { registry, cfg }) {
  const modelId = cfg.model || "deepseek-flash";
  const model = registry.getModel(modelId);
  const provider = registry.getProvider(modelId);
  if (!model || !provider) {
    throw new Error(`compaction model "${modelId}" unavailable`);
  }

  const payload = provider.buildRequest({
    model: model.apiModelId,
    system: [SUMMARIZE_PROMPT],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    max_tokens: cfg.maxTokens ?? 1500,
    temperature: cfg.temperature ?? 0,
    stream: false,
    thinking: { type: "disabled" },
  });

  const url = provider.getNonStreamingUrl
    ? provider.getNonStreamingUrl()
    : provider.getApiUrl();
  const resp = await axios.post(url, payload, {
    headers: provider.getHeaders(),
    timeout: cfg.timeoutMs ?? 15000,
  });

  const data = resp.data;
  const content = data.choices?.[0]?.message?.content || "";
  if (!content.trim()) throw new Error("compaction summarize returned empty content");

  // Price the summarize call itself (cache-aware, same math as
  // index.js costFor — duplicated here to avoid a circular require).
  let costUsd = null;
  const usage = data.usage;
  if (usage && model.cost) {
    const totalIn = usage.prompt_tokens || 0;
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = totalIn - hit;
    const out = usage.completion_tokens || 0;
    costUsd =
      Math.round(
        (miss * model.cost.inputPer1M +
          hit * (model.cost.cacheHitInputPer1M ?? model.cost.inputPer1M) +
          out * model.cost.outputPer1M) / 1e6 * 1e6
      ) / 1e6;
  }

  return { summary: content.trim(), costUsd };
}

// ------------------------------------------------------------------
// maybeCompact — the index.js hook
// ------------------------------------------------------------------

/**
 * Compact a request body in place when its estimated input exceeds
 * the configured share of the selected model's usable input budget.
 *
 * Mutates body.system (frozen summary appended) and body.messages
 * (recent exchanges kept) only after the summary is obtained — on
 * any error the body is left untouched and the request proceeds
 * uncompacted.
 *
 * @returns {Promise<object|null>} compaction bookkeeping, or null
 *   when no compaction happened
 */
async function maybeCompact(body, { serverConfig, registry, selectedModel }) {
  const cfg = serverConfig?.compaction || {};
  if (cfg.enabled === false) return null;
  if (!Array.isArray(body.messages) || body.messages.length < 3) return null;

  const cap = selectedModel?.capabilities || {};
  const maxIn = cap.maxInputTokens || 128000;
  const maxOut = cap.maxOutputTokens || 8192;
  const usable = Math.max(1000, maxIn - maxOut - (cfg.toolHeadroomTokens ?? 8000));

  const thresholdPct = cfg.thresholdPct ?? 0.75;
  const before = estimateInputTokens(body.system, body.messages);
  if (before <= usable * thresholdPct) return null;

  // ---- Boundary: keep the last N exchanges, adjust toward target ----
  const keep = cfg.keepRecentExchanges ?? 8;
  let cut = findCompactionCut(body.messages, keep);
  if (cut <= 0) return null;

  const maxPct = cfg.maxPct ?? 0.55;
  const minPct = cfg.minPct ?? 0.35;
  const minKept = Math.max(1, cfg.minKeptExchanges ?? 1);
  const keptEst = (c) => estimateInputTokens(body.system, body.messages.slice(c));

  let keptTokens = keptEst(cut);
  if (keptTokens > usable * maxPct) {
    // Recent exchanges alone exceed the ceiling (bulky tool output) —
    // drop exchanges down to the floor.
    for (let k = keep - 1; k >= minKept; k--) {
      const c2 = findCompactionCut(body.messages, k);
      if (c2 <= 0) break;
      cut = c2;
      if (keptEst(c2) <= usable * maxPct) break;
    }
    keptTokens = keptEst(cut);
  } else if (keptTokens < usable * minPct && keep < 16) {
    // Plenty of room — keep more exchanges (better quality, same
    // frozen-summary discipline).
    for (let k = keep + 1; k <= 16; k++) {
      const c2 = findCompactionCut(body.messages, k);
      if (c2 <= 0) break;
      const est = keptEst(c2);
      if (est > usable * maxPct) break;
      cut = c2;
      keptTokens = est;
      if (est > usable * minPct) break;
    }
  }
  if (cut <= 0) return null;

  const dropped = body.messages.slice(0, cut);
  const kept = body.messages.slice(cut);

  // ---- Frozen summary (incremental) ----
  const systemText = extractSystemText(body.system);
  const familyKey = md5(systemText);
  const boundaryHash = md5(JSON.stringify(dropped[dropped.length - 1]));

  const store = getStore(cfg);
  let summary = store.get(familyKey, dropped.length, boundaryHash);
  let reused = !!summary;
  let costUsd = null;

  if (!summary) {
    const inflightKey = `${familyKey}:${dropped.length}`;
    if (inflight.has(inflightKey)) {
      summary = await inflight.get(inflightKey);
      reused = false;
    } else {
      const prev = store.findPrevious(familyKey, dropped.length);
      let target;
      if (prev && prev.boundaryHash === md5(JSON.stringify(body.messages[prev.cut - 1]))) {
        // The stored summary still covers a prefix of the dropped
        // range — fold in only the newly dropped turns.
        target = `${prev.summary}\n\n=== NEWER, ALSO DROPPED ===\n\n` +
          renderDropped(body.messages.slice(prev.cut, cut), cfg.maxDroppedChars ?? 60000);
      } else {
        target = renderDropped(dropped, cfg.maxDroppedChars ?? 60000);
      }

      const promise = summarize(target, { registry, cfg })
        .then((r) => {
          inflight.delete(inflightKey);
          return r;
        })
        .catch((err) => {
          inflight.delete(inflightKey);
          throw err;
        });
      inflight.set(inflightKey, promise);

      const result = await promise;
      summary = result.summary;
      costUsd = result.costUsd;
      store.set(familyKey, dropped.length, boundaryHash, summary);
    }
  }

  // ---- Rewrite body in place ----
  const summaryBlock = { type: "text", text: summary };
  if (typeof body.system === "string") {
    body.system = [{ type: "text", text: body.system }, summaryBlock];
  } else if (Array.isArray(body.system)) {
    body.system = [...body.system, summaryBlock];
  } else {
    body.system = [summaryBlock];
  }
  body.messages = kept;

  return {
    reused,
    cut,
    droppedCount: dropped.length,
    tokensBefore: before,
    tokensAfter: estimateInputTokens(body.system, body.messages),
    summaryCharLen: summary.length,
    costUsd,
  };
}

module.exports = { maybeCompact, CompactionStore, renderDropped };
