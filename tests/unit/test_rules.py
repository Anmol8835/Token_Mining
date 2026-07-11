import pytest

from src.router.rules import RuleRouter


@pytest.fixture
def router():
    return RuleRouter()


class TestRuleRouter:
    def test_greeting_is_cheap(self, router):
        decision, _ = router.classify([{"role": "user", "content": "Hello! How are you?"}])
        assert decision == "cheap"

    def test_hello_is_cheap(self, router):
        decision, _ = router.classify([{"role": "user", "content": "Hi there!"}])
        assert decision == "cheap"

    def test_code_request_is_premium(self, router):
        decision, _ = router.classify(
            [
                {
                    "role": "user",
                    "content": "Write a Python function that sorts "
                    "a list of dictionaries by a given key.",
                },
            ]
        )
        assert decision == "premium"

    def test_refactor_is_premium(self, router):
        decision, _ = router.classify(
            [
                {"role": "user", "content": "Refactor this code to be more efficient."},
            ]
        )
        assert decision == "premium"

    def test_analysis_is_premium(self, router):
        decision, _ = router.classify(
            [
                {"role": "user", "content": "Analyze the sentiment of this customer review."},
            ]
        )
        assert decision == "premium"

    def test_compare_contrast_is_premium(self, router):
        decision, _ = router.classify(
            [
                {"role": "user", "content": "Compare and contrast REST and GraphQL APIs."},
            ]
        )
        assert decision == "premium"

    def test_story_is_cheap(self, router):
        decision, _ = router.classify(
            [
                {"role": "user", "content": "Write a story about a robot that learns to paint."},
            ]
        )
        assert decision == "cheap"

    def test_story_with_leading_number_is_cheap(self, router):
        # regression: "2-sentence" previously false-matched the math
        # digit-operator pattern via the bare hyphen and routed to premium
        decision, _ = router.classify(
            [
                {
                    "role": "user",
                    "content": "Write a 2-sentence story about a robot that learns to paint.",
                },
            ]
        )
        assert decision == "cheap"

    def test_poem_is_cheap(self, router):
        decision, _ = router.classify(
            [
                {"role": "user", "content": "Write a haiku about debugging."},
            ]
        )
        assert decision == "cheap"

    def test_factual_is_cheap(self, router):
        decision, _ = router.classify(
            [
                {"role": "user", "content": "What is the capital of Mongolia?"},
            ]
        )
        assert decision == "cheap"

    def test_math_is_premium(self, router):
        decision, _ = router.classify(
            [
                {"role": "user", "content": "Solve for x: 3x^2 + 12x - 15 = 0"},
            ]
        )
        assert decision == "premium"

    def test_design_is_premium(self, router):
        decision, _ = router.classify(
            [
                {
                    "role": "user",
                    "content": "Design a database schema for a multi-tenant SaaS application.",
                },
            ]
        )
        assert decision == "premium"

    def test_routing_time_under_50ms(self, router):
        _, routing_time_ms = router.classify(
            [
                {"role": "user", "content": "Write a Python function that sorts data."},
            ]
        )
        assert routing_time_ms < 50

    def test_multi_turn_messages(self, router):
        decision, _ = router.classify(
            [
                {"role": "user", "content": "Hi"},
                {"role": "assistant", "content": "Hello!"},
                {"role": "user", "content": "Write code to sort an array."},
            ]
        )
        assert decision == "premium"
