// ============================================================
// Answer extraction — code blocks, math answers, MCQ letters
// ============================================================

/** Extract the first fenced code block (python preferred). */
function extractCodeBlock(answer) {
  const text = answer || "";
  const fences = [...text.matchAll(/```([\w+-]*)[\s\S]*?```/g)].map((m) => ({
    lang: (m[1] || "").toLowerCase(),
    code: m[0].replace(/^```[\w+-]*\s*\n?/, "").replace(/\n?```\s*$/, ""),
  }));
  if (fences.length === 0) {
    // No fence — heuristic: everything from the first def/import line.
    const lines = text.split("\n");
    const idx = lines.findIndex((l) => /^(def |import |from |class )/.test(l.trim()));
    if (idx === -1) return null;
    return lines.slice(idx).join("\n").trim();
  }
  const py = fences.find((f) => f.lang.includes("python") || f.lang.includes("py"));
  return (py || fences[0]).code.trim();
}

/** Normalize a math answer string for comparison. */
function normalizeMath(s) {
  return (s || "")
    .replace(/\\left|\\right|\\,|\\;|\\!|\\qquad|\\quad|\\space/g, "")
    .replace(/\\dfrac|\\tfrac/g, "\\frac")
    .replace(/\\times/g, "*")
    .replace(/\\cdot/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\$/g, "")
    .replace(/%/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\text\s*\{([^}]*)\}/gi, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

/** Last \boxed{...} or "answer is ..." or last standalone number. */
function extractMathAnswer(answer) {
  const text = answer || "";

  const boxed = [...text.matchAll(/\\boxed\{([\s\S]*?)\}/g)];
  if (boxed.length > 0) return boxed[boxed.length - 1][1];

  const decl = text.match(/the\s+(?:final\s+)?answer\s+is:?\s*(.+)$/im);
  if (decl) return decl[1].trim();

  const numbers = [...text.matchAll(/-?\d+(?:\.\d+)?(?:\\?frac\{\d+\}\{\d+\})?/g)];
  if (numbers.length > 0) return numbers[numbers.length - 1][0];

  return text.trim();
}

/** Numeric equivalence with 1e-6 relative tolerance. */
function mathEquivalent(a, b) {
  const na = normalizeMath(a);
  const nb = normalizeMath(b);
  if (na === nb) return true;
  const parseNum = (s) => {
    const frac = s.match(/^\\?frac\{(-?\d+)\}\{(-?\d+)\}$/);
    if (frac) return parseFloat(frac[1]) / parseFloat(frac[2]);
    const n = Number(s.replace(/^[=:]/, ""));
    return Number.isFinite(n) ? n : null;
  };
  const va = parseNum(na);
  const vb = parseNum(nb);
  if (va === null || vb === null) return false;
  if (va === 0 && vb === 0) return true;
  return Math.abs(va - vb) / Math.max(Math.abs(va), Math.abs(vb), 1e-12) < 1e-6;
}

/** Extract the chosen MCQ letter (A-J). */
function extractLetter(answer) {
  const text = answer || "";
  const patterns = [
    /\b(?:answer|option|choice)\s*(?:is|:)?\s*[\(\[\{]?\s*([A-Ja-j])/i,
    /(?:^|\s)\(?([A-Ja-j])\)?[\s\.\),:]/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].toUpperCase();
  }
  const letters = text.match(/[A-Ja-j]/g);
  if (letters && letters.length === 1) return letters[0].toUpperCase();
  return null;
}

module.exports = { extractCodeBlock, extractMathAnswer, mathEquivalent, normalizeMath, extractLetter };
