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


class ConfidenceEngine:
    def __init__(self, escalation_threshold: float = 0.6):
        self.escalation_threshold = escalation_threshold

    def score(self, response: str, model_used: str = "") -> float:
        lower = model_used.lower()
        premium_exact = {"gpt-4o", "gpt-4-turbo", "claude-3-opus", "claude-4", "gemini-ultra"}
        model_name = lower.split(" (")[0].strip()
        if model_name in premium_exact:
            return 1.0
        if lower.startswith("premium"):
            return 1.0

        stripped = response.strip()
        if not stripped:
            return 0.0

        length_score = min(1.0, len(stripped) / 80.0)

        hedge_penalty = self._hedge_penalty(stripped)

        structure_score = self._structure_score(stripped)

        raw = 0.3 * length_score + 0.4 * (1.0 - hedge_penalty) + 0.3 * structure_score
        return max(0.0, min(1.0, raw))

    def should_escalate(self, score: float) -> bool:
        return score < self.escalation_threshold

    def _hedge_penalty(self, text: str) -> float:
        lower = text.lower()
        matches = sum(1 for w in HEDGE_WORDS if w in lower)
        return min(1.0, matches * 0.25)

    def _structure_score(self, text: str) -> float:
        sentences = [
            s.strip() for s in text.replace("!", ".").replace("?", ".").split(".") if s.strip()
        ]
        if len(sentences) >= 2:
            avg_len = sum(len(s) for s in sentences) / len(sentences)
            if avg_len >= 15:
                return 1.0
            if avg_len >= 8:
                return 0.5
        return 0.0
