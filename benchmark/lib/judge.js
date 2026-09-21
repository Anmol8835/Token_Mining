// ============================================================
// Pairwise blind LLM judge (chat category)
//
// Compares two answers to the same prompt without knowing which
// model produced which. Position is assigned by a seeded hash so
// re-runs reproduce the order.
// ============================================================

const { callTierDirect } = require("./clients");

const JUDGE_SYSTEM = `You are an impartial LLM judge evaluating answer quality. You will compare two
answers to the same user prompt. Judge purely on helpfulness, correctness, and
faithfulness to the request. Ignore differences in length, style, or verbosity
unless they affect correctness. Do not let the order of presentation influence
your decision.`;

function judgeUserTemplate(prompt, answerA, answerB) {
  return `You are judging two AI assistants' answers to the same user request.

<user_request>
${prompt}
</user_request>

<answer_a>
${answerA}
</answer_a>

<answer_b>
${answerB}
</answer_b>

Decide which answer is better. Reply with exactly one line, and nothing else:
- VERDICT: A   if answer A is clearly better
- VERDICT: B   if answer B is clearly better
- VERDICT: tie if they are of roughly equal quality`;
}

function parseVerdict(raw) {
  const m = (raw || "").match(/VERDICT\s*:\s*(A|B|TIE)/i);
  return m ? m[1].toUpperCase() : null;
}

/** Deterministic coin flip from a string seed. */
function seededFlip(seed) {
  let h = 2166136261;
  for (const c of String(seed)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 16) & 1) === 0;
}

/**
 * Judge one pair (sub-tier vs flagship).
 * @param {string} prompt
 * @param {{text: string}} sub - cheaper tier's answer
 * @param {{text: string}} flagship - flagship tier's answer
 * @param {string} judgeModel
 * @returns {{verdict, sub_position, ok, raw, judgeModel, judge_usage, judge_costUsd, error}}
 */
async function judgePair(prompt, sub, flagship, judgeModel) {
  const putSubFirst = seededFlip(prompt + judgeModel);
  const answerA = putSubFirst ? sub.text : flagship.text;
  const answerB = putSubFirst ? flagship.text : sub.text;

  const result = {
    verdict: null,
    sub_position: putSubFirst ? "A" : "B",
    ok: null,
    raw: null,
    judgeModel,
    judge_usage: null,
    judge_costUsd: null,
    error: null,
  };

  // v4-pro is a thinking-mode model: thinking consumes output budget
  // first, and occasionally returns empty content entirely. Retry it,
  // then fall back to deepseek-flash with thinking disabled for the pair.
  const attempts = [
    { model: judgeModel, maxTokens: 1024 },
    { model: judgeModel, maxTokens: 1024 },
    judgeModel === "deepseek-flash"
      ? null
      : { model: "deepseek-flash", maxTokens: 256, thinking: { type: "disabled" } },
  ];

  for (const { model, maxTokens, thinking } of attempts) {
    if (!model) break;
    try {
      const resp = await callTierDirect(model, judgeUserTemplate(prompt, answerA, answerB), {
        maxTokens,
        temperature: 0,
        ...(thinking ? { thinking } : {}),
      });
      result.raw = resp.answer;
      result.judge_usage = resp.usage;
      result.judge_costUsd = resp.costUsd;
      result.judgeModel = model;
      result.verdict = parseVerdict(resp.answer);
      if (result.verdict) break;
    } catch (err) {
      result.error = err.message;
    }
  }

  if (result.verdict === null) return result; // unjudgeable — excluded from rates

  // Acceptable iff the sub-tier wins or ties.
  result.ok = result.verdict === "TIE" || result.verdict === result.sub_position;
  return result;
}

module.exports = { judgePair, parseVerdict, seededFlip, JUDGE_SYSTEM, judgeUserTemplate };
