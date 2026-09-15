// ============================================================
// Math / MCQ graders — deterministic, no LLM calls
// ============================================================

const { extractMathAnswer, mathEquivalent, extractLetter } = require("./extract");

/**
 * Grade a math answer against the gold (boxed LaTeX) answer.
 */
function gradeMath(modelAnswer, goldAnswer) {
  const extracted = extractMathAnswer(modelAnswer);
  const gold = goldAnswer || "";
  // Strip the box wrapper from gold first.
  const goldBoxed = [...gold.matchAll(/\\boxed\{([\s\S]*?)\}/g)];
  const goldInner = goldBoxed.length > 0 ? goldBoxed[goldBoxed.length - 1][1] : gold;

  return {
    extracted,
    gold: goldInner,
    match: !!extracted && mathEquivalent(extracted, goldInner),
  };
}

/**
 * Grade an MCQ answer against the gold letter.
 */
function gradeMcq(modelAnswer, goldLetter) {
  const letter = extractLetter(modelAnswer);
  return {
    extracted: letter,
    gold: goldLetter,
    match: !!letter && letter.toUpperCase() === String(goldLetter).toUpperCase(),
  };
}

module.exports = { gradeMath, gradeMcq };
