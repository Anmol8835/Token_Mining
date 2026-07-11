import pytest

from src.memory.context import (
    FALLBACK_SUMMARY_PREFIX,
    RollingContextSummarizer,
    _count_messages_tokens,
    _hard_truncate,
    _is_summarized,
)
from src.models.client import estimate_tokens


def _make_msg(content: str, role: str = "user") -> dict:
    return {"role": role, "content": content}


def _token_count(text: str) -> int:
    return estimate_tokens(text)


@pytest.fixture
def summarizer():
    return RollingContextSummarizer()


class TestCountMessagesTokens:
    def test_empty(self):
        assert _count_messages_tokens([]) == 0

    def test_single_message(self):
        assert _count_messages_tokens([_make_msg("hello")]) == _token_count("hello")

    def test_multiple_messages(self):
        msgs = [_make_msg("hello"), _make_msg("world")]
        expected = _token_count("hello") + _token_count("world")
        assert _count_messages_tokens(msgs) == expected

    def test_non_text_content_blocks(self):
        msg = {
            "role": "user",
            "content": [
                {"type": "text", "text": "hello world"},
                {"type": "image_url", "image_url": {"url": "http://example.com/img.png"}},
            ],
        }
        assert _count_messages_tokens([msg]) == _token_count("hello world")


class TestIsSummarized:
    def test_not_summarized(self):
        assert _is_summarized([_make_msg("hello")]) is False

    def test_is_summarized(self):
        msg = {"role": "system", "content": f"{FALLBACK_SUMMARY_PREFIX}stuff]"}
        assert _is_summarized([msg]) is True


class TestHardTruncate:
    def test_truncates_oversized(self):
        msgs = [_make_msg("a" * 4000), _make_msg("b" * 4000)]
        result = _hard_truncate(msgs, 800)
        assert _count_messages_tokens(result) <= 800

    def test_empty_returns_empty(self):
        assert _hard_truncate([], 800) == []

    def test_already_under_budget(self):
        msgs = [_make_msg("hi")]
        result = _hard_truncate(msgs, 800)
        assert result == msgs


class TestRollingContextSummarizer:
    @pytest.mark.asyncio
    async def test_below_budget_returns_original(self, summarizer):
        msgs = [_make_msg("a" * 3196)]
        result = await summarizer.summarize(msgs)
        assert result is msgs

    @pytest.mark.asyncio
    async def test_exactly_800_does_not_trigger(self, summarizer):
        msgs = [_make_msg("a" * 3200)]
        result = await summarizer.summarize(msgs)
        assert result is msgs

    @pytest.mark.asyncio
    async def test_801_triggers_summarization(self, summarizer):
        msgs = [_make_msg("a" * 3204)]
        result = await summarizer.summarize(msgs)
        assert result is not msgs
        assert _count_messages_tokens(result) <= summarizer.MAX_TOKENS

    @pytest.mark.asyncio
    async def test_post_summary_tokens_under_800(self, summarizer):
        msgs = [_make_msg("a" * 4000), _make_msg("b" * 4000)]
        result = await summarizer.summarize(msgs)
        assert _count_messages_tokens(result) <= summarizer.MAX_TOKENS

    @pytest.mark.asyncio
    async def test_idempotent_on_second_call(self, summarizer):
        msgs = [_make_msg("a" * 4000)]
        first = await summarizer.summarize(msgs)
        assert _count_messages_tokens(first) <= summarizer.MAX_TOKENS
        second = await summarizer.summarize(first)
        assert second is first

    @pytest.mark.asyncio
    async def test_fallback_on_llm_failure(self):
        class FailingClient:
            async def chat_completion(self, **kwargs):
                raise RuntimeError("LLM summarization failed")

        s = RollingContextSummarizer(llm_client=FailingClient())
        msgs = [_make_msg("a" * 4000)]
        result = await s.summarize(msgs)
        assert _count_messages_tokens(result) <= s.MAX_TOKENS

    @pytest.mark.asyncio
    async def test_empty_history(self, summarizer):
        assert await summarizer.summarize([]) == []

    @pytest.mark.asyncio
    async def test_single_message_exceeds_budget(self, summarizer):
        msgs = [_make_msg("a" * 20000)]
        result = await summarizer.summarize(msgs)
        assert _count_messages_tokens(result) <= summarizer.MAX_TOKENS

    @pytest.mark.asyncio
    async def test_non_text_content_blocks(self, summarizer):
        msgs = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Tell me a story"},
                    {"type": "image_url", "image_url": {"url": "http://example.com/img.png"}},
                ],
            }
        ]
        result = await summarizer.summarize(msgs)
        assert result is msgs

    @pytest.mark.asyncio
    async def test_rolling_context_preserves_recent(self, summarizer):
        old = [_make_msg("a" * 2000, "user"), _make_msg("b" * 2000, "assistant")]
        recent = [_make_msg("final short", "user")]
        msgs = old + recent
        result = await summarizer.summarize(msgs)
        assert _count_messages_tokens(result) <= summarizer.MAX_TOKENS
        assert len(result) >= 1

    @pytest.mark.asyncio
    async def test_summary_includes_system_role(self, summarizer):
        msgs = [_make_msg("a" * 4000)]
        result = await summarizer.summarize(msgs)
        roles = {m.get("role") for m in result}
        assert "system" in roles
