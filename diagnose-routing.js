// ============================================================
// Diagnostic script: trace a request through the classification pipeline
// Usage: node diagnose-routing.js ["optional prompt text"]
// ============================================================

const rules = require("./lib/classifier/rules");
const EmbeddingClassifier = require("./lib/classifier/embedding-classifier");
const ProfileClassifier = require("./lib/classifier/profile-classifier");
const { fuse, DEFAULT_WEIGHTS } = require("./lib/classifier/fusion");
const { selectModel } = require("./lib/router");
const models = require("./config/models.json");
const serverConfig = require("./config/server.json");
const path = require("path");

const PROMPT = process.argv[2] || "hi";

const REQUEST = {
  system: undefined, // ← SYSTEM STRIPPED for classification
  messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
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
    getProvider(id) { return { id: modelMap.get(id).provider, getApiUrl() { return ""; }, getHeaders() { return {}; } }; },
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
  console.log(`  primary_task:    ${result.primary_task}`);
  console.log(`  secondary_tasks: ${JSON.stringify(result.secondary_tasks)}`);
  console.log(`  domain:          ${result.domain} (${result.subdomain || "-"})`);
  console.log(`  persona:         ${result.persona || "-"}`);
  console.log(`  complexity:      ${result.complexity}`);
  console.log(`  risk:            ${result.risk}`);
  console.log(`  freshness:       ${result.freshness}`);
  console.log(`  latency:         ${result.latency_preference}`);
  console.log(`  capabilities:    ${result.capabilities.join(", ") || "(none)"}`);
  console.log(`  modalities:      ${result.input_modalities.join(", ")}`);
  console.log(`  output_format:   ${result.output_format}`);
  console.log(`  model_type:      ${result.routing.model_type}`);
  console.log(`  tools:           ${JSON.stringify(result.routing.tools)}`);
  console.log(`  multi_step:      ${result.routing.use_multi_step_pipeline}`);
  console.log(`  human_review:    ${result.routing.human_review_recommended}`);
  console.log(`  confidence:      ${result.confidence}`);
  console.log(`  source:          ${result.source}`);
  console.log(`  reason:          ${result.reason}`);
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
        console.log(`    ${r.source}: ${r.primary_task}/${r.domain}/${r.complexity} (conf=${r.confidence})`);
      }
    }
  }
}

function printRouterResults(classification, registry, routerConfig) {
  console.log(`\n[Router Result]`);
  const result = selectModel(classification, registry, routerConfig, null, "cheap");
  console.log(`  Selected model: ${result.model.id} (${result.model.provider})`);
  console.log(`  Reason: ${result.reason}`);
  if (classification.routing.human_review_recommended) {
    console.log("  ⚠ HUMAN REVIEW RECOMMENDED — routing to most capable model");
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

  printSeparator(`REQUEST: "${PROMPT}" — system prompt STRIPPED for classification`);
  console.log("\nRequest:");
  console.log(`  system: (stripped — undefined)`);
  console.log(`  messages[0]: "${PROMPT}"`);

  printSeparator("Phase 1: Individual Classifiers");

  const rule1 = rules.classify(REQUEST);
  printResult("Rule Classifier", rule1);

  const emb1 = embClassifier.classify(REQUEST);
  printResult("Embedding Classifier", emb1);

  const prof1 = profClassifier.classify(REQUEST);
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

  printSeparator("SUMMARY");
  console.log(`
  Classifier: ${fused1.primary_task}/${fused1.domain}/${fused1.complexity}
  Routing:    ${fused1.routing.model_type}, review=${fused1.routing.human_review_recommended}
  Confidence: ${fused1.confidence} (threshold ${serverConfig.classifier.fusionConfidenceThreshold})
`);
}

main().catch(console.error);
