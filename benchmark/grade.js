// ============================================================
// Automated grading — math / mcq / code (no LLM calls)
//
//   node benchmark/grade.js <math|mcq|code> [--limit N] [--split eval|train]
//     [--canonical-check] [--resume] [--source bigcodebench|humanevalplus]
//
// --canonical-check: run gold solutions through the code harness
// BEFORE spending model calls — validates the runner itself.
// ============================================================

const path = require("path");
const { readJsonl, writeJsonl, appendJsonl, responsesPath, DATA_DIR } = require("./lib/io");
const { gradeMath, gradeMcq } = require("./lib/grader-math");
const { runCodeTests } = require("./lib/grader-code");
const { extractCodeBlock } = require("./lib/extract");

function parseArgs() {
  const category = process.argv[2];
  const flags = {};
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) { flags[a.slice(2)] = next; i++; }
      else flags[a.slice(2)] = true;
    }
  }
  return { category, flags };
}

/**
 * Reconstruct the full canonical function: BigCodeBench stores the
 * body in canonical_solution and the signature in complete_prompt
 * (imports + docstring + "def task_func(...):" line).
 */
function canonicalCode(p) {
  const cp = p.complete_prompt || "";
  const sigIdx = cp.lastIndexOf(`def ${p.entry_point}`);
  if (sigIdx !== -1) {
    const sigLine = cp.slice(sigIdx).split("\n")[0].trim();
    return `${cp.slice(0, sigIdx).trim()}\n${sigLine}\n${p.canonical_solution || ""}`;
  }
  return p.canonical_solution || "";
}

function collectPrompts(category, source) {
  const f = category === "code" && source === "humanevalplus" ? "code-he.jsonl" : `${category}.jsonl`;
  return readJsonl(path.join(DATA_DIR, "prompts", f));
}

function groupResponses(rows) {
  const byId = {};
  for (const r of rows) {
    byId[r.id] = byId[r.id] || {};
    byId[r.id][r.tier] = r;
  }
  return byId;
}

async function main() {
  const { category, flags } = parseArgs();
  if (!["math", "mcq", "code"].includes(category)) {
    console.error("usage: node benchmark/grade.js <math|mcq|code> [--canonical-check]");
    process.exit(1);
  }

  // ---- Canonical check (code only, zero LLM cost) ----
  if (category === "code" && flags["canonical-check"]) {
    const prompts = collectPrompts("code", flags.source || "bigcodebench");
    let pass = 0, fail = 0;
    for (const p of prompts) {
      const code = canonicalCode(p);
      const r = await runCodeTests({
        candidateCode: code, testSource: p.test, entryPoint: p.entry_point, taskId: p.task_id,
      });
      if (r.pass) pass++; else fail++;
      console.log(`${r.pass ? "PASS" : "FAIL"} ${p.task_id}${r.output_snippet ? " — " + r.output_snippet.slice(0, 90).replace(/\s+/g, " ") : ""}`);
    }
    console.log(`canonical check: ${pass}/${pass + fail} pass`);
    return;
  }

  const prompts = collectPrompts(category, flags.source || "bigcodebench");
  let pRows = prompts;
  if (flags.split) pRows = pRows.filter((r) => r.split === flags.split);
  if (flags.limit) pRows = pRows.slice(0, parseInt(flags.limit, 10));

  const responses = groupResponses(readJsonl(responsesPath(category, flags.source || "bigcodebench")));
  const outPath = path.join(DATA_DIR, "grades", `${category}.jsonl`);

  const done = new Set(readJsonl(outPath).map((r) => r.id + ":" + r.tier));
  if (flags.resume) {
    pRows = pRows.filter((r) => !["cheap", "middle", "flagship", "router"].every((t) => done.has(r.id + ":" + t)));
  }

  console.log(`grade.js ${category}: ${pRows.length} prompts`);

  for (const p of pRows) {
    const byTier = responses[p.id] || {};
    for (const tier of ["cheap", "middle", "flagship", "router"]) {
      const resp = byTier[tier];
      if (!resp || resp.error || !resp.answer) continue;
      if (flags.resume && done.has(p.id + ":" + tier)) continue;

      if (category === "math") {
        const g = gradeMath(resp.answer, p.answer);
        appendJsonl(outPath, { id: p.id, tier, ...g });
      } else if (category === "mcq") {
        const g = gradeMcq(resp.answer, p.answer);
        appendJsonl(outPath, { id: p.id, tier, ...g });
      } else {
        const code = extractCodeBlock(resp.answer);
        if (!code) {
          appendJsonl(outPath, { id: p.id, tier, pass: false, exit_code: -1, output_snippet: null, error: "no code extracted" });
          continue;
        }
        const r = await runCodeTests({
          candidateCode: code, testSource: p.test, entryPoint: p.entry_point, taskId: p.task_id,
        });
        appendJsonl(outPath, { id: p.id, tier, pass: r.pass, exit_code: r.exit_code, output_snippet: r.output_snippet, error: r.error });
      }
    }
  }
  console.log("done.");
}

main().catch((err) => { console.error("grade failed:", err.message); process.exit(1); });
