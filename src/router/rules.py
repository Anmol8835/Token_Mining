import re
import time

SIMPLE_PATTERNS = [
    re.compile(r"^\s*(hello|hi|hey|howdy|greetings)", re.I),
    re.compile(r"how are you", re.I),
    re.compile(r"nice to meet", re.I),
    re.compile(r"good (morning|afternoon|evening)", re.I),
]

CREATIVE_PATTERNS = [
    re.compile(r"write a (story|poem|haiku|short story)", re.I),
    re.compile(r"(story|poem|haiku) about", re.I),
    re.compile(r"tell me a story", re.I),
    re.compile(r"creative", re.I),
]

FACTUAL_PATTERNS = [
    re.compile(r"what is the (capital|population|largest|highest)", re.I),
    re.compile(r"who (is|was|are|were)", re.I),
    re.compile(r"when was", re.I),
    re.compile(r"where is", re.I),
    re.compile(r"how (many|much|far|tall|long)", re.I),
]

MATH_PATTERNS = [
    re.compile(r"solve for", re.I),
    re.compile(r"equation", re.I),
    re.compile(r"calculate", re.I),
    # digits required on both sides of the operator so phrases like
    # "2-sentence" or "24-hour" don't false-positive on the bare hyphen
    re.compile(r"[0-9]+\s*[+\-*/^=]\s*[0-9]+", re.I),
]

SIMPLE_KEYWORDS = ["hello", "hi", "hey", "howdy", "greeting"]
CREATIVE_KEYWORDS = ["story", "poem", "haiku", "creative", "tale"]
FACTUAL_KEYWORDS = ["capital", "population", "what is", "who is", "where is"]
MATH_KEYWORDS = ["solve", "equation", "calculate"]
CODE_KEYWORDS = [
    "function",
    "refactor",
    "code",
    "algorithm",
    "sort",
    "fetch",
    "binary search",
    "hash table",
    "data structure",
    "python",
    "javascript",
]
ANALYSIS_KEYWORDS = [
    "analyze",
    "compare and contrast",
    "compare",
    "design a",
    "database schema",
    "sentiment",
    "summarize",
]


class RuleRouter:
    def classify(self, messages: list[dict]) -> str:
        t0 = time.monotonic()
        text = self._extract_text(messages)
        decision = self._classify(text)
        elapsed = time.monotonic() - t0
        return decision, round(elapsed * 1000, 2)

    def _extract_text(self, messages: list[dict]) -> str:
        parts = []
        for m in messages:
            c = m.get("content", "")
            if isinstance(c, list):
                for item in c:
                    if isinstance(item, dict) and item.get("type") == "text":
                        parts.append(item["text"])
            else:
                parts.append(str(c))
        return " ".join(parts)

    def _classify(self, text: str) -> str:
        score_map: dict[str, int] = {"cheap": 0, "premium": 0}

        for pat in SIMPLE_PATTERNS:
            if pat.search(text):
                score_map["cheap"] += 3
        for pat in CREATIVE_PATTERNS:
            if pat.search(text):
                score_map["cheap"] += 2
        for pat in FACTUAL_PATTERNS:
            if pat.search(text):
                score_map["cheap"] += 2
        for pat in MATH_PATTERNS:
            if pat.search(text):
                score_map["cheap"] += 1
                score_map["premium"] += 3

        text_lower = text.lower()
        for kw in CODE_KEYWORDS:
            if kw in text_lower:
                score_map["premium"] += 3
        for kw in ANALYSIS_KEYWORDS:
            if kw in text_lower:
                score_map["premium"] += 2

        if score_map["premium"] >= score_map["cheap"] or (
            score_map["premium"] > 0 and score_map["cheap"] == 0
        ):
            return "premium"
        if score_map["cheap"] > 0:
            return "cheap"
        return "premium"
