// ============================================================
// JSONL helpers for benchmark artifacts
// ============================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function readJsonl(filePath, { missingOk = true } = {}) {
  if (!fs.existsSync(filePath)) {
    if (missingOk) return [];
    throw new Error(`missing file: ${filePath}`);
  }
  const rows = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch (_) { /* skip malformed */ }
  }
  return rows;
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(row) + "\n");
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function promptsPath(category, source) {
  if (category === "code" && source === "humanevalplus") {
    return path.join(DATA_DIR, "prompts", "code-he.jsonl");
  }
  return path.join(DATA_DIR, "prompts", `${category}.jsonl`);
}

function responsesPath(category, source) {
  return path.join(DATA_DIR, "responses", `${category}${source === "humanevalplus" ? "-he" : ""}.jsonl`);
}

module.exports = { DATA_DIR, readJsonl, writeJsonl, appendJsonl, promptsPath, responsesPath };
