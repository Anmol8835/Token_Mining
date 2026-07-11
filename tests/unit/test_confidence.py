import pytest

from src.memory.confidence import ConfidenceEngine


@pytest.fixture
def engine():
    return ConfidenceEngine(escalation_threshold=0.5)


class TestConfidenceEngine:
    def test_premium_always_full_score(self, engine):
        score = engine.score("short", model_used="gpt-4o")
        assert score == 1.0

        score2 = engine.score("anything really", model_used="premium-model-v2")
        assert score2 == 1.0

    def test_empty_response_zero_score(self, engine):
        score = engine.score("")
        assert score == 0.0

        score2 = engine.score("   ")
        assert score2 == 0.0

    def test_short_response_low_confidence(self, engine):
        score = engine.score("No", model_used="cheap")
        assert score < 0.5

    def test_detailed_response_higher_confidence(self, engine):
        response = (
            "FastAPI is a modern web framework for building APIs with Python. "
            "It provides automatic OpenAPI documentation and validation."
        )
        score = engine.score(response, model_used="cheap-model")
        assert score >= 0.5

    def test_hedging_lowers_confidence(self, engine):
        vague = "I think the answer might be something, but I'm not sure"
        score = engine.score(vague, model_used="cheap-model")
        assert score < 0.5

    def test_relative_ordering(self, engine):
        vague = "maybe it works"
        detailed = (
            "The Python sort function works by comparing elements using "
            "the less-than operator. It implements Timsort algorithm."
        )
        score_vague = engine.score(vague, model_used="cheap-model")
        score_detailed = engine.score(detailed, model_used="cheap-model")
        assert score_vague < score_detailed

    def test_should_escalate_low_confidence(self, engine):
        assert engine.should_escalate(0.3) is True
        assert engine.should_escalate(0.1) is True

    def test_should_not_escalate_high_confidence(self, engine):
        assert engine.should_escalate(0.7) is False
        assert engine.should_escalate(0.9) is False

    def test_boundary_at_threshold(self, engine):
        assert engine.should_escalate(0.5) is False
        assert engine.should_escalate(0.49) is True

    def test_custom_threshold(self):
        strict = ConfidenceEngine(escalation_threshold=0.8)
        assert strict.should_escalate(0.7) is True
        assert strict.should_escalate(0.9) is False

        lenient = ConfidenceEngine(escalation_threshold=0.2)
        assert lenient.should_escalate(0.3) is False
        assert lenient.should_escalate(0.1) is True

    def test_multiple_hedge_words_compound(self, engine):
        very_hedgy = (
            "I think maybe it could be sort of like that, but I'm not sure, perhaps I don't know"
        )
        score = engine.score(very_hedgy, model_used="cheap-model")
        assert score < 0.5

    def test_multi_sentence_structure_higher_score(self, engine):
        unstructured = "just a single short phrase"
        structured = (
            "Point one: this is important. "
            "Point two: this follows logically. "
            "Point three: this concludes the argument."
        )
        s_un = engine.score(unstructured, model_used="cheap-model")
        s_st = engine.score(structured, model_used="cheap-model")
        assert s_st > s_un

    def test_single_sentence_gets_no_structure_bonus(self, engine):
        single = "This is a single sentence that is pretty long but gets no structure boost"
        score_single = engine.score(single, model_used="cheap-model")
        score_no_structure = 0.3 * min(1.0, len(single) / 80.0) + 0.4 * 1.0
        assert score_single == pytest.approx(score_no_structure, abs=0.01)
