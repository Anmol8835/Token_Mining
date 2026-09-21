// ============================================================
// Judgments → per-prompt labels (cheap_ok / middle_ok)
//   node benchmark/label.js
// ============================================================

const path = require("path");
const { readJsonl, writeJsonl, DATA_DIR } = require("./lib/io");

function main() {
  const judgments = readJsonl(path.join(DATA_DIR, "judgments", "judgments.jsonl"));
  const prompts = readJsonl(path.join(DATA_DIR, "prompts", "chat.jsonl"));

  const byIdPair = {};
  for (const j of judgments) {
    byIdPair[j.id + ":" + j.pair] = j;
  }

  const rows = [];
  for (const p of prompts) {
    const cheap = byIdPair[p.id + ":cheap_vs_flagship"];
    const middle = byIdPair[p.id + ":middle_vs_flagship"];
    rows.push({
      id: p.id,
      category: "chat",
      split: p.split,
      cheap_ok: cheap && cheap.verdict ? cheap.ok : null,
      middle_ok: middle && middle.verdict ? middle.ok : null,
    });
  }

  writeJsonl(path.join(DATA_DIR, "labels", "labels.jsonl"), rows);
  const labeled = rows.filter((r) => r.cheap_ok !== null || r.middle_ok !== null);
  console.log(`labels: ${rows.length} prompts, ${labeled.length} with at least one judged pair`);
}

main();
