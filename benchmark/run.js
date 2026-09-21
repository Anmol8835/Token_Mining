// ============================================================
// Serving runner — capture the router path + all three tier
// baselines for every prompt.
//
//   node benchmark/run.js <chat|math|mcq|code> [flags]
//     --limit N --split train|eval --offset N --dry-run --resume
//     --mode cheap --concurrency 2 --source bigcodebench|humanevalplus
//     --cheap-model deepseek-flash
//
// Responses append to data/responses/<category>.jsonl as they are
// produced, so interrupted runs resume with --resume.
// ============================================================

const path = require("path");
const {
  readJsonl, appendJsonl, promptsPath, responsesPath,
} = require("./lib/io");
const { resolveTiers, callTierDirect, callRouterViaProxy } = require("./lib/clients");

const CATEGORIES = ["chat", "math", "mcq", "code"];

function parseArgs() {
  const args = process.argv.slice(2);
  const category = args[0];
  const flags = {};
  // --dry-run -> flags.dryRun, --cheap-model -> flags.cheapModel
  const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = camel(a.slice(2));
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { category, flags };
}

function renderPrompt(row) {
  if (row.category === "mcq") {
    const opts = row.options
      .map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`)
      .join("\n");
    return `${row.question}\n\nOptions:\n${opts}\n\nAnswer with just the letter.`;
  }
  if (row.category === "code") {
    return `${row.prompt}\n\nReturn only Python code, no explanation.`;
  }
  if (row.category === "math") return row.problem;
  return row.prompt;
}

async function serveOne(row, tiers, opts, outPath) {
  const prompt = renderPrompt(row);
  let costSum = 0;

  const record = (rec) => {
    costSum += rec.costUsd || 0;
    appendJsonl(outPath, rec);
  };

  // --- Router path ---
  if (opts.dryRun) {
    record({
      id: row.id, tier: "router", model: "dry-run", prompt,
      answer: "DRY-RUN", usage: { input_tokens: 300, output_tokens: 200 },
      costUsd: 0, latencyMs: 0, classification: null, classifierCostUsd: null, error: null,
    });
  } else {
    try {
      const r = await callRouterViaProxy(prompt, { mode: opts.mode || "cheap" });
      record({
        id: row.id, tier: "router", model: r.modelId, prompt,
        answer: r.answer, usage: r.usage, costUsd: r.costUsd, latencyMs: r.latencyMs,
        classification: r.classification, classifierCostUsd: r.classifierCostUsd, error: null,
      });
    } catch (err) {
      record({
        id: row.id, tier: "router", model: null, prompt,
        answer: null, usage: null, costUsd: null, latencyMs: null,
        classification: null, classifierCostUsd: null, error: err.message,
      });
    }
  }

  // --- Tier baselines ---
  for (const [tier, modelId] of Object.entries(tiers)) {
    if (!modelId) {
      record({
        id: row.id, tier, model: null, prompt,
        answer: null, usage: null, costUsd: null, latencyMs: null,
        classification: null, classifierCostUsd: null, error: `${tier} model unavailable`,
      });
      continue;
    }
    if (opts.dryRun) {
      record({
        id: row.id, tier, model: modelId, prompt,
        answer: "DRY-RUN", usage: { input_tokens: 300, output_tokens: 200 },
        costUsd: 0, latencyMs: 0, classification: null, classifierCostUsd: null, error: null,
      });
      continue;
    }
    try {
      const r = await callTierDirect(modelId, prompt);
      record({
        id: row.id, tier, model: r.modelId, prompt,
        answer: r.answer, usage: r.usage, costUsd: r.costUsd, latencyMs: r.latencyMs,
        classification: null, classifierCostUsd: null, error: null,
      });
    } catch (err) {
      record({
        id: row.id, tier, model: modelId, prompt,
        answer: null, usage: null, costUsd: null, latencyMs: null,
        classification: null, classifierCostUsd: null, error: err.message,
      });
    }
  }

  return costSum;
}

async function main() {
  const { category, flags } = parseArgs();
  if (!CATEGORIES.includes(category)) {
    console.error(`usage: node benchmark/run.js <${CATEGORIES.join("|")}> [--limit N] [--dry-run] [--resume] [--split train|eval] [--offset N] [--mode cheap]`);
    process.exit(1);
  }

  const source = flags.source || "bigcodebench";
  const inPath = promptsPath(category, source);
  const outPath = responsesPath(category, source);

  let rows = readJsonl(inPath, { missingOk: false });
  if (flags.split) rows = rows.filter((r) => r.split === flags.split);
  const offset = parseInt(flags.offset || "0", 10);
  rows = rows.slice(offset);
  if (flags.limit) rows = rows.slice(0, parseInt(flags.limit, 10));

  if (flags.resume) {
    const done = new Set(readJsonl(outPath).map((r) => r.id + ":" + r.tier));
    rows = rows.filter((r) => !done.has(r.id + ":router"));
  }

  if (rows.length === 0) {
    console.log("no prompts to run (check --limit/--split/--resume)");
    return;
  }

  const tiers = resolveTiers({ cheap: flags["cheap-model"] || undefined });
  console.log(`benchmark/run.js ${category}: ${rows.length} prompts ` +
    `(tiers: cheap=${tiers.cheap} middle=${tiers.middle} flagship=${tiers.flagship}, ` +
    `mode=${flags.mode || "cheap"}, ${flags.dryRun ? "DRY-RUN" : "LIVE"})`);

  const concurrency = Math.max(1, parseInt(flags.concurrency || "2", 10));
  let idx = 0;
  let totalCost = 0;

  async function worker() {
    while (idx < rows.length) {
      const i = idx++;
      const row = rows[i];
      // Track costs in-memory — re-reading the growing responses file
      // per prompt was O(n²) and ate memory on long runs.
      const newCosts = await serveOne(row, tiers, flags, outPath);
      totalCost += newCosts;
      console.log(`[${i + 1}/${rows.length}] ${row.id} | running total $${totalCost.toFixed(4)}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  console.log(`done. total recorded cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error("run failed:", err.message);
  process.exit(1);
});
