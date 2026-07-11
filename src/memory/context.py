from typing import Optional

from src.models.client import estimate_tokens

SUMMARY_SYSTEM_PROMPT = (
    "You are a conversation summarizer. Condense the following conversation "
    "history into a concise summary under 700 tokens, preserving key facts, "
    "decisions, and context needed for future responses."
)

FALLBACK_SUMMARY_PREFIX = "[Summarized history: "


def _count_messages_tokens(messages: list[dict]) -> int:
    total = 0
    for m in messages:
        content = m.get("content", "")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    total += estimate_tokens(block.get("text", ""))
    return total


def _is_summarized(messages: list[dict]) -> bool:
    for m in messages:
        content = m.get("content", "")
        if isinstance(content, str) and content.startswith(FALLBACK_SUMMARY_PREFIX):
            return True
    return False


def _hard_truncate(messages: list[dict], budget: int) -> list[dict]:
    truncated = list(messages)
    while len(truncated) > 1 and _count_messages_tokens(truncated) > budget:
        removed = truncated.pop(0)
        removed_tok = estimate_tokens(
            removed.get("content", "") if isinstance(removed.get("content"), str) else ""
        )
        summary_msg = {
            "role": "system",
            "content": (
                f"{FALLBACK_SUMMARY_PREFIX}{removed_tok} tokens of earlier conversation removed...]"
            ),
        }
        truncated.insert(0, summary_msg)
        break
    while len(truncated) > 1 and _count_messages_tokens(truncated) > budget:
        removed = truncated.pop(0)
        if removed.get("role") == "system" and removed.get("content", "").startswith(
            FALLBACK_SUMMARY_PREFIX
        ):
            continue
    if _count_messages_tokens(truncated) > budget and truncated:
        last = truncated[-1]
        if isinstance(last.get("content"), str):
            max_chars = (budget - 10) * 4
            truncated[-1] = {**last, "content": last["content"][:max_chars]}
    return truncated


class RollingContextSummarizer:
    MAX_TOKENS = 800

    def __init__(self, llm_client=None):
        self._llm = llm_client

    async def summarize(self, messages: list[dict]) -> list[dict]:
        total = _count_messages_tokens(messages)
        if total <= self.MAX_TOKENS:
            return messages

        return await self._compress(messages)

    async def _compress(self, messages: list[dict]) -> list[dict]:
        budget = self.MAX_TOKENS
        summary_too = _count_messages_tokens([{"role": "system", "content": SUMMARY_SYSTEM_PROMPT}])
        effective_budget = budget - summary_too

        split_idx = self._find_split(messages, effective_budget)
        if split_idx <= 0:
            return _hard_truncate(messages, budget)

        history = messages[:split_idx]
        recent = messages[split_idx:]

        summary = await self._summarize_history(history)
        if summary is None:
            return _hard_truncate(messages, budget)

        result = [{"role": "system", "content": summary}] + recent
        if _count_messages_tokens(result) > budget:
            return _hard_truncate(messages, budget)
        return result

    def _find_split(self, messages: list[dict], budget: int) -> int:
        for i in range(len(messages) - 1, -1, -1):
            tail_tok = _count_messages_tokens(messages[i:])
            if tail_tok <= budget:
                return i
        return 1

    async def _summarize_history(self, messages: list[dict]) -> Optional[str]:
        summarization_messages = [
            {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": self._format_history(messages)},
        ]
        try:
            if self._llm is not None:
                result = await self._llm.chat_completion(
                    messages=summarization_messages,
                    temperature=0.3,
                    max_tokens=700,
                )
                return result.get("content", "").strip()
            else:
                return self._simulate_summary(messages)
        except Exception:
            return None

    def _simulate_summary(self, messages: list[dict]) -> str:
        parts = []
        for m in messages:
            content = m.get("content", "")
            if isinstance(content, str):
                content = content[:100]
            parts.append(f"[{m.get('role', 'user')}]: {content}")
        joined = " | ".join(parts)
        budget = self.MAX_TOKENS - 100
        while estimate_tokens(joined) > budget and len(joined) > 200:
            joined = joined[: len(joined) // 2] + "..."
        return f"{FALLBACK_SUMMARY_PREFIX}{joined}]"

    def _format_history(self, messages: list[dict]) -> str:
        parts = []
        for m in messages:
            content = m.get("content", "")
            if isinstance(content, list):
                text_parts = [
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                content = " ".join(text_parts)
            parts.append(f"{m.get('role', 'user')}: {content}")
        return "\n".join(parts)
