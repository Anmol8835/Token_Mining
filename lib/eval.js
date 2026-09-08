// ============================================================
// Eval runner — measures classifier accuracy against a labeled
// prompt set (config/eval-prompts.json).
//
// Each entry declares the fields it asserts. Only those fields
// are compared — everything else is ignored. Results aggregate
// per-field accuracy so the dashboard shows WHERE the classifier
// fails, not just how often.
// ============================================================

const fs = require("fs");
const path = require("path");

const DEFAULT_EVAL_PATH = path.join(__dirname, "..", "config", "eval-prompts.json");

/**
 * Load the labeled eval set.
 * @returns {Array<{id, prompt, expected}>}
 */
function loadEvalPrompts(filePath) {
  const p = filePath || DEFAULT_EVAL_PATH;
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  return data.prompts || [];
}

/**
 * Compare a classification against the asserted fields.
 * @returns {{ checked: string[], fails: Array<{field, got, want}> }}
 */
function compareEval(classification, expected) {
  const fails = [];
  const checked = Object.keys(expected);

  // Field accessors — some expectations live in the routing block.
  const get = (key) => {
    switch (key) {
      case "model_type": return classification.routing?.model_type ?? null;
      case "human_review": return !!classification.routing?.human_review_recommended;
      case "multi_step": return !!classification.routing?.use_multi_step_pipeline;
      case "tools_include": return (classification.routing?.tools || []).includes(expected.tools_include);
      case "capabilities_include": return (classification.capabilities || []).includes(expected.capabilities_include);
      default: return classification[key] ?? null;
    }
  };

  for (const key of checked) {
    const got = get(key);
    if (got !== expected[key]) {
      fails.push({ field: key, got, want: expected[key] });
    }
  }
  return { checked, fails };
}

/**
 * Run the full eval set through the classifier.
 * Does NOT record into the request metrics — eval traffic is
 * measurement, not production traffic.
 *
 * @param {HybridClassifier} classifier
 * @param {string} filePath - Optional override for the eval file
 * @returns {Promise<object>} Eval summary for metrics + dashboard
 */
async function runEvalSet(classifier, filePath) {
  const prompts = loadEvalPrompts(filePath);

  const results = [];
  const byField = {};

  for (const e of prompts) {
    const classification = await classifier.classify({
      messages: [{ role: "user", content: e.prompt }],
    });

    const { checked, fails } = compareEval(classification, e.expected);

    // Aggregate per-field accuracy
    for (const field of checked) {
      byField[field] = byField[field] || { passed: 0, total: 0 };
      byField[field].total++;
      if (!fails.some((f) => f.field === field)) byField[field].passed++;
    }

    results.push({
      id: e.id,
      prompt: e.prompt,
      passed: fails.length === 0,
      fails,
      primary_task: classification.primary_task,
      domain: classification.domain,
      risk: classification.risk,
      model_type: classification.routing?.model_type ?? null,
      confidence: classification.confidence,
      source: classification.source,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    accuracy: results.length
      ? Math.round((passed / results.length) * 10000) / 100
      : 0,
    byField: Object.entries(byField)
      .map(([field, v]) => ({
        field,
        passed: v.passed,
        total: v.total,
        accuracy: Math.round((v.passed / v.total) * 10000) / 100,
      }))
      .sort((a, b) => a.accuracy - b.accuracy), // worst fields first
    failures: results.filter((r) => !r.passed),
  };
}

module.exports = { loadEvalPrompts, compareEval, runEvalSet };
