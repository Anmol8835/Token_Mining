// ============================================================
// Eval-split report — quality per tier, router distribution,
// cost vs baselines, savings. Optional --after-policy simulation
// re-runs the REAL selectModel with config/router-policy.json
// applied, mapping the new pick to the stored tier answers (free).
//
//   node benchmark/report.js [--after-policy] [--out data/report/report.json]
// ============================================================

const fs = require("fs");
const path = require("path");
const { readJsonl, DATA_DIR } = require("./lib/io");
const { registry } = require("./lib/clients");

const TIER_OF_COST = { budget: "cheap", low: "cheap", standard: "middle", premium: "flagship" };
const TIER_MODELS = ["deepseek-flash", "deepseek-v4-pro", "claude-opus-4-8"];

// DeepSeek retired these alias ids (2026-09): the API now serves all
// of them with deepseek-flash. Historical response rows carry the old
// ids — normalize before registry lookup so they still count as cheap.
const MODEL_ALIASES = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
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

function groupBy(rows, keyFn) {
  const out = {};
  for (const r of rows) out[keyFn(r)] = r;
  return out;
}

function tierOfModel(modelId, reg) {
  const m = reg.getModel(MODEL_ALIASES[modelId] || modelId);
  if (!m) return null;
  return TIER_OF_COST[m.profile.costTier] || null;
}

function main() {
  const flags = parseFlags();
  const reg = registry();
  const evalIds = new Set();
  for (const f of ["chat.jsonl", "math.jsonl", "mcq.jsonl", "code.jsonl"]) {
    for (const p of readJsonl(path.join(DATA_DIR, "prompts", f))) {
      if (p.split === "eval") evalIds.add(p.id);
    }
  }

  const categories = [];
  const results = {}; // category → { prompts, router, tiers }

  for (const cat of ["chat", "math", "mcq", "code"]) {
    const prompts = readJsonl(path.join(DATA_DIR, "prompts", `${cat}.jsonl`))
      .filter((p) => evalIds.has(p.id));
    const responses = readJsonl(path.join(DATA_DIR, "responses", `${cat}.jsonl`))
      .filter((r) => evalIds.has(r.id));
    const labels = cat === "chat"
      ? groupBy(readJsonl(path.join(DATA_DIR, "labels", "labels.jsonl")), (r) => r.id)
      : {};
    const grades = groupBy(
      readJsonl(path.join(DATA_DIR, "grades", `${cat}.jsonl`)),
      (r) => r.id + ":" + r.tier
    );

    results[cat] = { prompts, responses, labels, grades };
  }

  const sections = [];
  let totalRouterCost = 0;
  let totalFlagshipCost = 0;
  let totalMiddleCost = 0;

  for (const cat of Object.keys(results)) {
    const { prompts, responses, labels, grades } = results[cat];
    if (prompts.length === 0) continue;

    const byId = {};
    for (const r of responses) {
      byId[r.id] = byId[r.id] || {};
      byId[r.id][r.tier] = r;
    }

    let qualityOk = 0, qualityN = 0, cost = 0, flagshipCost = 0, middleCost = 0;
    const dist = { cheap: 0, middle: 0, flagship: 0, other: 0 };
    let errors = 0;

    for (const p of prompts) {
      const r = byId[p.id] || {};
      const routerResp = r.router;

      // ---- Router tier (before policy, or after simulation) ----
      let chosenTier = null;
      if (routerResp?.model) {
        let modelId = routerResp.model;
        if (flags["after-policy"] && routerResp.classification) {
          const { selectModel } = require("../../lib/router");
          try {
            const sim = selectModel(
              routerResp.classification, reg,
              require("../../config/server.json").router, null, "cheap"
            );
            modelId = sim.model.id;
          } catch (_) { /* keep actual */ }
        }
        chosenTier = tierOfModel(modelId, reg);
        dist[chosenTier || "other"]++;
      }

      // ---- Router quality (map chosen tier → its stored answer) ----
      if (chosenTier && routerResp?.answer) {
        if (cat === "chat") {
          const label = labels[p.id];
          const ok = chosenTier === "flagship" ? true
            : chosenTier === "middle" ? label?.middle_ok
            : label?.cheap_ok;
          if (ok !== null && ok !== undefined) { qualityN++; if (ok) qualityOk++; }
        } else {
          const g = grades[p.id + ":" + chosenTier];
          if (g && (g.match !== undefined ? true : g.pass !== undefined)) {
            qualityN++;
            if (g.match || g.pass) qualityOk++;
          }
        }
      }

      // ---- Cost ----
      if (routerResp?.costUsd) cost += routerResp.costUsd + (routerResp.classifierCostUsd || 0);
      if (r.flagship?.costUsd) flagshipCost += r.flagship.costUsd;
      if (r.middle?.costUsd) middleCost += r.middle.costUsd;
      if (routerResp?.error) errors++;
    }

    totalRouterCost += cost;
    totalFlagshipCost += flagshipCost;
    totalMiddleCost += middleCost;

    const tierQuality = {};
    for (const tier of ["cheap", "middle", "flagship"]) {
      let ok = 0, n = 0;
      for (const p of prompts) {
        const g = grades[p.id + ":" + tier];
        if (!g) continue;
        if (cat === "chat") {
          const label = labels[p.id];
          const v = tier === "flagship" ? true : tier === "middle" ? label?.middle_ok : label?.cheap_ok;
          if (v === null || v === undefined) continue;
          n++; if (v) ok++;
        } else {
          if (g.match !== undefined) { n++; if (g.match) ok++; }
          else if (g.pass !== undefined) { n++; if (g.pass) ok++; }
        }
      }
      tierQuality[tier] = n > 0 ? Math.round((ok / n) * 1000) / 10 : null;
    }

    sections.push({
      category: cat,
      n: prompts.length,
      dist,
      routerQuality: qualityN > 0 ? Math.round((qualityOk / qualityN) * 1000) / 10 : null,
      qualityN,
      tierQuality,
      cost: Math.round(cost * 10000) / 10000,
      flagshipCost: Math.round(flagshipCost * 10000) / 10000,
      middleCost: Math.round(middleCost * 10000) / 10000,
      errors,
    });
  }

  // ---- Console table ----
  const pad = (s, w) => String(s).padEnd(w);
  console.log("\n" + pad("CATEGORY", 8) + pad("n", 5) + pad("router-tier%", 34) + pad("quality%", 10) +
    pad("cost$", 10) + pad("vs flagship", 12) + pad("vs middle", 11));
  for (const s of sections) {
    const total = Math.max(1, s.dist.cheap + s.dist.middle + s.dist.flagship + s.dist.other);
    const distStr = `cheap ${Math.round(s.dist.cheap / total * 100)} / middle ${Math.round(s.dist.middle / total * 100)} / flagship ${Math.round(s.dist.flagship / total * 100)}`;
    const vsFlag = s.flagshipCost > 0 ? Math.round((1 - s.cost / s.flagshipCost) * 1000) / 10 + "%" : "–";
    const vsMid = s.middleCost > 0 ? Math.round((1 - s.cost / s.middleCost) * 1000) / 10 + "%" : "–";
    console.log(
      pad(s.category, 8) + pad(s.n, 5) + pad(distStr, 34) + pad(s.routerQuality === null ? "–" : s.routerQuality, 10) +
      pad(s.cost.toFixed(4), 10) + pad(vsFlag, 12) + pad(vsMid, 11)
    );
  }
  const grandTotal = sections.reduce((s, x) => s + x.n, 0);
  const vsFlagTotal = totalFlagshipCost > 0
    ? Math.round((1 - totalRouterCost / totalFlagshipCost) * 1000) / 10 + "%" : "–";
  console.log(
    pad("TOTAL", 8) + pad(grandTotal, 5) + pad("", 34) + pad("", 10) +
    pad(totalRouterCost.toFixed(4), 10) + pad(vsFlagTotal, 12) + pad(totalMiddleCost > 0 ? Math.round((1 - totalRouterCost / totalMiddleCost) * 1000) / 10 + "%" : "–", 11)
  );

  // ---- JSON report ----
  const outPath = flags.out || path.join(DATA_DIR, "report", "report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    afterPolicy: !!flags["after-policy"],
    evalPromptCount: grandTotal,
    sections,
    totals: {
      routerCost: Math.round(totalRouterCost * 10000) / 10000,
      allFlagshipCost: Math.round(totalFlagshipCost * 10000) / 10000,
      allMiddleCost: Math.round(totalMiddleCost * 10000) / 10000,
      savingsVsFlagshipPct: totalFlagshipCost > 0 ? Math.round((1 - totalRouterCost / totalFlagshipCost) * 1000) / 10 : null,
      savingsVsMiddlePct: totalMiddleCost > 0 ? Math.round((1 - totalRouterCost / totalMiddleCost) * 1000) / 10 : null,
    },
  }, null, 2) + "\n");
  console.log(`\nreport -> ${outPath}`);
}

main();
