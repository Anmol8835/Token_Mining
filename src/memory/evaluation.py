import json
import os

HEDGE_WORDS = frozenset(
    {
        "maybe",
        "perhaps",
        "possibly",
        "i think",
        "not sure",
        "might",
        "could be",
        "i'm not",
        "i don't know",
        "unsure",
        "probably",
        "sort of",
        "kind of",
        "i guess",
        "not certain",
        "i believe",
    }
)

GOOD_RESPONSE_MIN_LEN = 30


class EvaluationEngine:
    def __init__(self, good_threshold: float = 0.6):
        self.good_threshold = good_threshold

    def evaluate(self, response: str) -> dict:
        stripped = response.strip()
        if not stripped:
            return {"score": 0.0, "passed": False}

        score = 0.3
        if len(stripped) >= GOOD_RESPONSE_MIN_LEN:
            score += 0.4
        if self._has_structure(stripped):
            score += 0.3
        if self._is_hedging(stripped):
            score -= 0.6

        score = max(0.0, round(score, 4))
        return {
            "score": score,
            "passed": score >= self.good_threshold,
        }

    def evaluate_batch(self, labeled_path: str) -> dict:
        if not os.path.exists(labeled_path):
            return {"error": f"File not found: {labeled_path}", "precision": 0.0, "recall": 0.0}

        with open(labeled_path) as f:
            data = json.load(f)

        tp = tn = fp = fn = 0
        results = []

        for ex in data["examples"]:
            response = ex["response"]
            true_label = ex["label"]
            pred = self.evaluate(response)
            pred_label = "good" if pred["passed"] else "bad"

            if true_label == "good" and pred_label == "good":
                tp += 1
            elif true_label == "bad" and pred_label == "bad":
                tn += 1
            elif true_label == "bad" and pred_label == "good":
                fp += 1
            elif true_label == "good" and pred_label == "bad":
                fn += 1

            results.append(
                {
                    "id": ex["id"],
                    "true_label": true_label,
                    "pred_label": pred_label,
                    "score": pred["score"],
                }
            )

        precision = tp / max(tp + fp, 1)
        recall = tp / max(tp + fn, 1)
        f1 = 2 * precision * recall / max(precision + recall, 1e-9)
        accuracy = (tp + tn) / max(tp + tn + fp + fn, 1)

        return {
            "total": len(data["examples"]),
            "tp": tp,
            "tn": tn,
            "fp": fp,
            "fn": fn,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "accuracy": round(accuracy, 4),
            "results": results,
        }

    def _has_structure(self, text: str) -> bool:
        sentences = [
            s.strip() for s in text.replace("!", ".").replace("?", ".").split(".") if s.strip()
        ]
        return len(sentences) >= 2

    def _is_hedging(self, text: str) -> bool:
        lower = text.lower()
        return any(w in lower for w in HEDGE_WORDS)
