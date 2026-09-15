// ============================================================
// Benchmark cost math — mirrors index.js costFor() exactly.
// pricing.json is the single source of truth.
// ============================================================

const fs = require("fs");
const path = require("path");

const PRICING_PATH = path.join(__dirname, "..", "..", "config", "pricing.json");

function loadPricing() {
  return JSON.parse(fs.readFileSync(PRICING_PATH, "utf8"));
}

/**
 * (inputTokens × inputPer1M + outputTokens × outputPer1M) / 1e6
 * Same formula as index.js:123 — 6 dp.
 */
function costFor(usage, modelId, pricing) {
  const p = pricing || loadPricing();
  const price = p.models?.[modelId];
  if (!price || !usage) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  return Math.round(((input * price.inputPer1M + output * price.outputPer1M) / 1e6) * 1e6) / 1e6;
}

module.exports = { loadPricing, costFor, PRICING_PATH };
