// ============================================================
// Chat pairwise judging — cheap_vs_flagship and middle_vs_flagship
// per prompt, blind A/B with seeded position randomization.
//
//   node benchmark/judge.js [--limit N] [--split eval|train]
//     [--double] [--resume] [--dry-run] [--judge-model deepseek-v4-pro]
// ============================================================

const {
  readJsonl, appendJsonl, responsesPath,
} = require("./lib/io");
const { judgePair } = require("./lib/judge");
const { resolveTiers } = require("./lib/clients");

const DATA_DIR = require("path").join(__dirname, "data");

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

function groupResponses(rows) {
  const byId = {};
  for (const r of rows) {
    byId[r.id] = byId[r.id] || {};
    byId[r.id][r.tier] = r;
  }
  return byId;
}

async function judgeOne(promptRow, tiers, responses, outPath, flags, judgeModel) {
  const pairs = [
    { pair: "cheap_vs_flagship", sub: "cheap" },
    { pair: "middle_vs_flagship", sub: "middle" },
  ];

  for (const { pair, sub } of pairs) {
    const subResp = responses[sub];
    const flagResp = responses.flagship;
    if (!subResp?.answer || !flagResp?.answer) continue;

    if (flags.dryRun) {
      appendJsonl(outPath, {
        id: promptRow.id, pair, order: [sub, "flagship"], verdict: "tie",
        sub_position: "A", ok: true, consistent: true,
        judge_model: judgeModel, judge_usage: null, judge_costUsd: null, raw: "DRY-RUN", error: null,
      });
      continue;
    }

    const j = await judgePair(
      promptRow.prompt,
      { text: subResp.answer },
      { text: flagResp.answer },
      judgeModel
    );
    appendJsonl(outPath, {
      id: promptRow.id, pair,
      order: j.sub_position === "A" ? [sub, "flagship"] : ["flagship", sub],
      verdict: j.verdict, sub_position: j.sub_position, ok: j.ok,
      consistent: true,
      judge_model: j.judgeModel || judgeModel, judge_usage: j.judge_usage,
      judge_costUsd: j.judge_costUsd, raw: j.raw, error: j.error,
    });
  }
}

async function main() {
  const flags = parseFlags();
  const judgeModel = flags["judge-model"] || "deepseek-v4-pro";
  const outPath = require("path").join(DATA_DIR, "judgments", "judgments.jsonl");

  const chat = readJsonl(responsesPath("chat"));
  const byId = groupResponses(chat);
  let prompts = readJsonl(require("./lib/io").promptsPath("chat"));
  if (flags.split) prompts = prompts.filter((r) => r.split === flags.split);
  if (flags.limit) prompts = prompts.slice(0, parseInt(flags.limit, 10));

  if (flags.resume) {
    const done = new Set(readJsonl(outPath).map((r) => r.id + ":" + r.pair));
    prompts = prompts.filter(
      (p) => !(done.has(p.id + ":cheap_vs_flagship") && done.has(p.id + ":middle_vs_flagship"))
    );
  }

  const judged = new Set(readJsonl(outPath).map((r) => r.id + ":" + r.pair));
  prompts = prompts.filter(
    (p) => !judged.has(p.id + ":cheap_vs_flagship") || !judged.has(p.id + ":middle_vs_flagship")
  );

  console.log(`judge.js: ${prompts.length} chat prompts, judge=${judgeModel}, ${flags.dryRun ? "DRY-RUN" : "LIVE"}`);

  let i = 0;
  for (const p of prompts) {
    i++;
    if (!byId[p.id]) { console.log(`[${i}/${prompts.length}] ${p.id} — no responses yet, skip`); continue; }
    await judgeOne(p, null, byId[p.id], outPath, flags, judgeModel);
    console.log(`[${i}/${prompts.length}] ${p.id} judged`);
  }
  console.log("done.");
}

main().catch((err) => { console.error("judge failed:", err.message); process.exit(1); });
