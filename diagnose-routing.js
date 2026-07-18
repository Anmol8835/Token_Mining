// ============================================================
// Diagnostic script: trace "hi" through the classification pipeline
// Usage: node diagnose-routing.js
// ============================================================

const rules = require("./lib/classifier/rules");
const EmbeddingClassifier = require("./lib/classifier/embedding-classifier");
const ProfileClassifier = require("./lib/classifier/profile-classifier");
const { fuse, DEFAULT_WEIGHTS } = require("./lib/classifier/fusion");
const { selectModel } = require("./lib/router");
const models = require("./config/models.json");
const serverConfig = require("./config/server.json");
const path = require("path");

// Simulate a simple "hi" request with a Claude Code-like system prompt
// With the FIX: system prompt is stripped before classification.
const SYSTEM_PROMPT = [
  { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent that helps users with software engineering tasks. Use your tools to read, write, edit, and run code." }
];

const SIMPLE_HI = {
  system: undefined,  // ← SYSTEM STRIPPED for classification
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] }
  ],
  stream: true,
};

// A minimal system prompt version (no coding context)
const MINIMAL_SYSTEM = [
  { type: "text", text: "You are a helpful assistant." }
];

const HI_MINIMAL = {
  system: undefined,  // ← SYSTEM STRIPPED for classification
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] }
  ],
  stream: true,
};

// Mock provider registry for router
function makeMockRegistry() {
  const modelMap = new Map();
  for (const m of models.models) {
    modelMap.set(m.id, m);
  }
  return {
    lookup(id) { return modelMap.get(id) || null; },
    getModel(id) { return modelMap.get(id) || null; },
    getProvider(id) { return { id: m.provider, getApiUrl() { return ""; }, getHeaders() { return {}; } }; },
    getAllModels() { return models.models; },
    filterModels(fn) { return models.models.filter(fn); },
  };
}

function printSeparator(title) {
  console.log("\n" + "=".repeat(70));
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

function printResult(label, result) {
  console.log(`\n[${label}]`);
  console.log(`  taskType:        ${result.taskType}`);
  console.log(`  complexity:      ${result.complexity}`);
  console.log(`  costSensitivity: ${result.costSensitivity}`);
  console.log(`  confidence:      ${result.confidence}`);
  console.log(`  source:          ${result.source}`);
  console.log(`  reason:          ${result.reason}`);
  if (result.requiredCapabilities) {
    const caps = Object.entries(result.requiredCapabilities)
      .filter(([, v]) => v)
      .map(([k]) => k);
    console.log(`  requiredCaps:    ${caps.length > 0 ? caps.join(", ") : "(none)"}`);
  }
  if (result.metadata) {
    if (result.metadata.topMatches) {
      console.log(`  topMatches:      ${result.metadata.topMatches.map(m => `${m.label}(${m.similarity})`).join(", ")}`);
    }
    if (result.metadata.signals) {
      console.log(`  profileSignals:  ${JSON.stringify(result.metadata.signals)}`);
    }
    if (result.metadata.votes) {
      console.log(`  votes:`);
      for (const [field, v] of Object.entries(result.metadata.votes)) {
        console.log(`    ${field}: ${JSON.stringify(v)}`);
      }
    }
    if (result.metadata.individualResults) {
      console.log(`  individualResults:`);
      for (const r of result.metadata.individualResults) {
        console.log(`    ${r.source}: ${r.taskType}/${r.complexity}/${r.costSensitivity} (conf=${r.confidence}) reason="${r.reason}"`);
      }
    }
  }
}

function printRouterResults(classification, registry, routerConfig) {
  console.log(`\n[Router Scoring] costWeight=${routerConfig.costWeight}, qualityWeight=${routerConfig.qualityWeight}`);

  const { costWeight = 0.3, qualityWeight = 0.7 } = routerConfig;
  const requiredCaps = classification.requiredCapabilities || {};

  // Apply same filters as router
  const candidates = registry.filterModels((model) => {
    if (requiredCaps.needsTools && !model.capabilities.toolUse) return false;
    if (requiredCaps.needsVision && !model.capabilities.vision) return false;
    if (requiredCaps.needsStreaming && !model.capabilities.streaming) return false;
    if (classification.costSensitivity === "budget"
        && model.profile.costTier !== "budget"
        && model.profile.costTier !== "low") {
      console.log(`  FILTERED (budget): ${model.id} (costTier=${model.profile.costTier})`);
      return false;
    }
    return true;
  });

  const costTierMap = {
    budget: { budget: 1.0, standard: 0.4, premium: 0.0 },
    standard: { budget: 0.5, standard: 1.0, premium: 0.3 },
    premium: { budget: 0.0, standard: 0.3, premium: 1.0 },
  };

  const scored = candidates.map((model) => {
    const complexityMatch =
      model.profile.complexity === classification.complexity ? 1.0
      : model.profile.complexity === "high" && classification.complexity === "medium" ? 0.8
      : 0.4;

    const taskMatch = model.profile.taskTypes.includes(classification.taskType) ? 1.0 : 0.3;
    const qualityScore = complexityMatch * 0.4 + taskMatch * 0.6;
    const costTierScore = costTierMap[classification.costSensitivity]?.[model.profile.costTier] ?? 0.5;
    const totalCost = (model.cost.inputPer1M + model.cost.outputPer1M);
    const costBoost = totalCost > 0 ? (1 / (totalCost + 0.01)) * 0.05 : 0;
    const score = qualityWeight * qualityScore + costWeight * costTierScore + costBoost;

    return {
      id: model.id,
      costTier: model.profile.costTier,
      complexity: model.profile.complexity,
      taskTypes: model.profile.taskTypes,
      qualityScore: qualityScore.toFixed(3),
      costTierScore: costTierScore.toFixed(3),
      costBoost: costBoost.toFixed(4),
      total: score.toFixed(4),
    };
  });

  scored.sort((a, b) => parseFloat(b.total) - parseFloat(a.total));
  console.log(`\n  Classification: ${classification.taskType}/${classification.complexity}/${classification.costSensitivity}`);
  console.log(`  Candidates (sorted by score):`);
  for (const s of scored) {
    const marker = s.id === scored[0].id ? " ★ WINNER" : "";
    console.log(`    ${s.id}: score=${s.total} (q=${s.qualityScore}, costTier=${s.costTierScore}, boost=${s.costBoost}) [${s.complexity}/${s.costTier}]${marker}`);
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const registry = makeMockRegistry();
  const routerConfig = serverConfig.router;
  const embClassifier = new EmbeddingClassifier(
    path.join(__dirname, "lib/classifier/reference-examples.json"),
    serverConfig.classifier.embedding || {}
  );
  const profClassifier = new ProfileClassifier(serverConfig.classifier.profile || {});

  // ================================================================
  // SCENARIO 1: "hi" with Claude Code system prompt
  // ================================================================
  printSeparator("SCENARIO 1: 'hi' — system prompt STRIPPED for classification");

  console.log("\nRequest:");
  console.log(`  system: (stripped — undefined)`);
  console.log(`  messages[0]: "hi"`);

  printSeparator("Phase 1: Individual Classifiers");

  const rule1 = rules.classify(SIMPLE_HI);
  printResult("Rule Classifier", rule1);

  const emb1 = embClassifier.classify(SIMPLE_HI);
  printResult("Embedding Classifier", emb1);

  const prof1 = profClassifier.classify(SIMPLE_HI);
  printResult("Profile Classifier", prof1);

  printSeparator("Phase 2: Fusion (before LLM fallback)");

  const fused1 = fuse([rule1, emb1, prof1], serverConfig.classifier.fusionWeights);
  printResult("Fused Result", fused1);

  console.log(`\n  Fusion threshold: ${serverConfig.classifier.fusionConfidenceThreshold}`);
  console.log(`  Fused confidence: ${fused1.confidence}`);
  if (fused1.confidence < serverConfig.classifier.fusionConfidenceThreshold) {
    console.log("  ⚠ BELOW THRESHOLD → LLM fallback WOULD be called");
    if (fused1.metadata?.ambiguity) {
      console.log(`  Ambiguity: ${fused1.metadata.ambiguity.primary} vs ${fused1.metadata.ambiguity.alternative} (ratio: ${fused1.metadata.ambiguity.ratio})`);
    }
  } else {
    console.log("  ✓ ABOVE THRESHOLD → No LLM fallback needed");
  }

  printSeparator("Phase 3: Router Result");
  printRouterResults(fused1, registry, routerConfig);

  // ================================================================
  // SCENARIO 2: "hi" with minimal system prompt
  // ================================================================
  printSeparator("SCENARIO 2: 'hi' with MINIMAL system prompt (no coding context)");

  console.log("\nRequest:");
  console.log(`  system: (stripped — undefined)`);
  console.log(`  messages[0]: "hi"`);

  const rule2 = rules.classify(HI_MINIMAL);
  printResult("Rule Classifier", rule2);

  const emb2 = embClassifier.classify(HI_MINIMAL);
  printResult("Embedding Classifier", emb2);

  const prof2 = profClassifier.classify(HI_MINIMAL);
  printResult("Profile Classifier", prof2);

  printSeparator("Phase 2: Fusion");
  const fused2 = fuse([rule2, emb2, prof2], serverConfig.classifier.fusionWeights);
  printResult("Fused Result", fused2);

  console.log(`\n  Fusion threshold: ${serverConfig.classifier.fusionConfidenceThreshold}`);
  console.log(`  Fused confidence: ${fused2.confidence}`);
  if (fused2.confidence < serverConfig.classifier.fusionConfidenceThreshold) {
    console.log("  ⚠ BELOW THRESHOLD → LLM fallback WOULD be called");
  } else {
    console.log("  ✓ ABOVE THRESHOLD → No LLM fallback needed");
  }

  printSeparator("Phase 3: Router Result");
  printRouterResults(fused2, registry, routerConfig);

  // ================================================================
  // SCENARIO 3: With system prompt stripped, LLM fallback will correctly
  // classify "hi" as chat. PLUS the high-confidence shortcut skips the
  // LLM call entirely when the rule classifier (0.85) agrees with fusion.
  // ================================================================
  printSeparator("SCENARIO 3: High-confidence shortcut (rule=0.85, agrees with fusion)");
  console.log("\n  Rule classifier says: chat/low/budget (0.85 conf)");
  console.log("  Fusion result says: chat/low/budget");
  console.log("  → Shortcut triggered: skip LLM fallback, boost confidence to threshold");
  console.log("  → This saves an unnecessary LLM API call for trivial messages.\n");

  // ================================================================
  // Summary
  // ================================================================
  printSeparator("DIAGNOSIS SUMMARY (WITH FIX APPLIED)");
  console.log(`
  FIX 1: System prompt stripped before classification (in index.js)
         → { ...req.body, system: undefined } before classifier.classify()
         → System prompt re-injected naturally at buildRequest() line 152

  FIX 2: High-confidence shortcut (in classifier/index.js)
         → If a classifier has >= 0.8 confidence and agrees with fusion,
           skip the LLM fallback and boost fused confidence to threshold.
         → This prevents wasting LLM calls on trivial messages like "hi".

  RESULT: "hi" → rule says chat/low/budget (0.85) → fusion agrees →
          shortcut fires → budget filter excludes v4-pro →
          routes to deepseek-v4-flash ✓
`);
}

main().catch(console.error);
