// ============================================================
// Fit router policy from TRAIN-split results.
//   node benchmark/fit-policy.js [--min-n 8] [--cheap-thresh 0.75]
//                                [--middle-thresh 0.75] [--out config/router-policy.json]
//
// Buckets: (primary_task × complexity) from the router records'
// stored classifications. Quality signal per bucket:
//   chat → cheap_ok_rate / middle_ok_rate (judge)
//   math/mcq/code → cheap pass/EM rate, middle pass/EM rate
//
// Rules:
//   cheap < threshold && middle >= threshold → minCostTier standard
//   both < threshold                          → minCostTier premium
//   cheap >= threshold                        → minCostTier budget
// Buckets below --min-n fall back to task-only buckets.
// ============================================================

const fs = require("fs");
const path = require("path");
const { readJsonl, DATA_DIR } = require("./lib/io");

const CATEGORY_FILES = {
  chat: { prompts: "chat.jsonl", responses: "chat.jsonl", quality: "judge" },
  math: { prompts: "math.jsonl", responses: "math.jsonl", quality: "grade" },
  mcq: { prompts: "mcq.jsonl", responses: "mcq.jsonl", quality: "grade" },
  code: { prompts: "code.jsonl", responses: "code.jsonl", quality: "grade" },
};

function parseFlags() {
  const flags = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) { flags[a.slice(2)] = next; i++; }
      else flags[a.slice(2)] = true;
    }
  }
  return flags;
}

function loadPerPromptQuality(flags) {
  // id → { cheap: bool|null, middle: bool|null, primary_task, complexity }
  const out = {};
  const labels = readJsonl(path.join(DATA_DIR, "labels", "labels.jsonl"));
  for (const l of labels) {
    if (l.split !== "train") continue;
    out[l.id] = out[l.id] || {};
    out[l.id].cheap = l.cheap_ok;
    out[l.id].middle = l.middle_ok;
  }
  for (const cat of ["math", "mcq", "code"]) {
    const grades = readJsonl(path.join(DATA_DIR, "grades", `${cat}.jsonl`));
    const prompts = readJsonl(path.join(DATA_DIR, "prompts", `${cat}.jsonl`));
    const splitById = Object.fromEntries(prompts.map((p) => [p.id, p.split]));
    for (const g of grades) {
      if (splitById[g.id] !== "train") continue;
      out[g.id] = out[g.id] || {};
      out[g.id][g.tier === "cheap" ? "cheap" : g.tier === "middle" ? "middle" : null] = g.match ?? g.pass;
    }
  }

  // Router records carry the classification per prompt.
  for (const cat of Object.keys(CATEGORY_FILES)) {
    const responses = readJsonl(path.join(DATA_DIR, "responses", `${cat}.jsonl`));
    for (const r of responses) {
      if (r.tier !== "router" || !r.classification) continue;
      if (!out[r.id]) continue; // train-only
      out[r.id].primary_task = r.classification.primary_task;
      out[r.id].complexity = r.classification.complexity;
    }
  }
  return out;
}

function rate(values) {
  const known = values.filter((v) => v !== null && v !== undefined);
  return { n: values.length, known: known.length, ok: known.filter(Boolean).length };
}

function main() {
  const flags = parseFlags();
  const minN = parseInt(flags["min-n"] || "8", 10);
  const cheapThresh = parseFloat(flags["cheap-thresh"] || "0.75");
  const middleThresh = parseFloat(flags["middle-thresh"] || "0.75");
  const outPath = flags.out || path.join(__dirname, "..", "config", "router-policy.json");

  const perPrompt = loadPerPromptQuality(flags);
  const rows = Object.entries(perPrompt).map(([id, v]) => ({ id, ...v }));
  const withTask = rows.filter((r) => r.primary_task);

  // Bucket by (task × complexity), then task-only fallback.
  const taskBuckets = {};
  const fineBuckets = {};
  for (const r of withTask) {
    const t = taskBuckets[r.primary_task] || (taskBuckets[r.primary_task] = { cheap: [], middle: [] });
    t.cheap.push(r.cheap); t.middle.push(r.middle);
    const key = `${r.primary_task}::${r.complexity}`;
    const f = fineBuckets[key] || (fineBuckets[key] = { cheap: [], middle: [], task: r.primary_task, complexity: r.complexity });
    f.cheap.push(r.cheap); f.middle.push(r.middle);
  }

  const rules = [];
  const seen = new Set();

  const makeRule = (cond, minCostTier, cheapRate, middleRate) => {
    const key = JSON.stringify(cond);
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({
      if: cond,
      minCostTier,
      provenance: {
        cheap_ok_rate: Math.round(cheapRate.ok / Math.max(cheapRate.known, 1) * 100) / 100,
        middle_ok_rate: Math.round(middleRate.ok / Math.max(middleRate.known, 1) * 100) / 100,
        n_train: cheapRate.n,
      },
    });
  };

  // Fine buckets first; too-small buckets merge up to task level.
  for (const [key, b] of Object.entries(fineBuckets)) {
    if (b.cheap.length + b.middle.length < minN) continue;
    const cheap = rate(b.cheap), middle = rate(b.middle);
    if (cheap.known === 0 && middle.known === 0) continue;
    const cheapRate = cheap.known > 0 ? cheap.ok / cheap.known : 0;
    const middleRate = middle.known > 0 ? middle.ok / middle.known : 0;
    let minTier = "budget";
    if (cheapRate < cheapThresh && middleRate >= middleThresh) minTier = "standard";
    else if (cheapRate < cheapThresh && middleRate < middleThresh) minTier = "premium";
    makeRule(
      { primary_task: b.task, complexity: b.complexity },
      minTier,
      { ok: cheap.ok, known: cheap.known, n: cheap.n },
      { ok: middle.ok, known: middle.known, n: middle.n }
    );
  }

  // Task-level buckets (fallback / merged).
  for (const [task, b] of Object.entries(taskBuckets)) {
    if (b.cheap.length + b.middle.length < minN) continue; // too few prompts — no rule
    const cheap = rate(b.cheap), middle = rate(b.middle);
    if (cheap.known === 0 && middle.known === 0) continue;
    const cheapRate = cheap.known > 0 ? cheap.ok / cheap.known : 0;
    const middleRate = middle.known > 0 ? middle.ok / middle.known : 0;
    let minTier = "budget";
    if (cheapRate < cheapThresh && middleRate >= middleThresh) minTier = "standard";
    else if (cheapRate < cheapThresh && middleRate < middleThresh) minTier = "premium";
    makeRule(
      { primary_task: task },
      minTier,
      { ok: cheap.ok, known: cheap.known, n: cheap.n },
      { ok: middle.ok, known: middle.known, n: middle.n }
    );
  }

  const policy = {
    version: 1,
    generatedAt: new Date().toISOString(),
    notes: "minCostTier order: budget < low < standard < premium. Generated by benchmark/fit-policy.js from train-split results.",
    rules,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(policy, null, 2) + "\n");
  console.log(`fit-policy: ${rules.length} rules -> ${outPath}`);
  for (const r of rules) {
    console.log(`  ${JSON.stringify(r.if)} → min ${r.minCostTier} ` +
      `(cheap ${r.provenance.cheap_ok_rate * 100}% / middle ${r.provenance.middle_ok_rate * 100}%, n=${r.provenance.n_train})`);
  }
}

main();
