// ============================================================
// Router policy — data-only cost-tier floor rules
//
// config/router-policy.json shape (emitted by fit-policy.js):
//   { "rules": [ { "if": { "primary_task": "...", "complexity": "..." },
//                  "minCostTier": "budget|low|standard|premium", ... } ] }
//
// The router applies matching rules as a candidate filter; this
// module also re-implements the filter so the benchmark can
// SIMULATE policy effects on stored artifacts without the proxy.
// ============================================================

const fs = require("fs");
const path = require("path");

const POLICY_PATH = path.join(__dirname, "..", "..", "config", "router-policy.json");

const TIER_RANK = { budget: 0, low: 1, standard: 2, premium: 3 };

function loadPolicy(filePath) {
  const p = filePath || POLICY_PATH;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return raw.rules ? raw : { rules: [] };
  } catch (_) {
    return { rules: [] }; // inert when missing/corrupt
  }
}

/** Does a rule's `if` match a classification? */
function ruleMatches(rule, classification) {
  const cond = rule.if || {};
  for (const [key, want] of Object.entries(cond)) {
    const got =
      key === "complexity" ? classification.complexity
      : key === "primary_task" ? classification.primary_task
      : key === "domain" ? classification.domain
      : classification[key];
    if (got !== want) return false;
  }
  return true;
}

/** Most restrictive minCostTier among matching rules (null = none). */
function minTierFor(classification, policy) {
  let best = null;
  for (const rule of policy.rules) {
    if (ruleMatches(rule, classification)) {
      if (best === null || TIER_RANK[rule.minCostTier] > TIER_RANK[best]) {
        best = rule.minCostTier;
      }
    }
  }
  return best;
}

/**
 * Filter candidate models by policy. Mirrors the router patch:
 * drop below-tier candidates; never fail routing.
 * @returns {object[]} filtered candidates (same refs)
 */
function applyPolicy(candidates, classification, policy) {
  if (!policy.rules.length) return candidates;
  const minTier = minTierFor(classification, policy);
  if (!minTier) return candidates;

  const kept = candidates.filter(
    (m) => TIER_RANK[m.profile?.costTier] >= TIER_RANK[minTier]
  );
  return kept.length > 0 ? kept : candidates;
}

module.exports = { loadPolicy, applyPolicy, minTierFor, ruleMatches, TIER_RANK, POLICY_PATH };
