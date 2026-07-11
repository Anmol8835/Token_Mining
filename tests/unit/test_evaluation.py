import os

import pytest

from src.memory.evaluation import EvaluationEngine

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "bench", "fixtures")


@pytest.fixture
def engine():
    return EvaluationEngine(good_threshold=0.6)


class TestEvaluationEngine:
    def test_empty_response_fails(self, engine):
        result = engine.evaluate("")
        assert result["passed"] is False
        assert result["score"] == 0.0

    def test_blank_response_fails(self, engine):
        result = engine.evaluate("   ")
        assert result["passed"] is False
        assert result["score"] == 0.0

    def test_detailed_response_passes(self, engine):
        response = (
            "FastAPI is a modern web framework for building APIs with Python. "
            "It includes automatic OpenAPI docs and data validation."
        )
        result = engine.evaluate(response)
        assert result["passed"] is True
        assert result["score"] >= 0.6

    def test_short_response_fails(self, engine):
        result = engine.evaluate("I don't know")
        assert result["passed"] is False

    def test_hedging_response_fails(self, engine):
        result = engine.evaluate("I think the answer might be Paris, but I'm not sure")
        assert result["passed"] is False

    def test_good_response_passes(self, engine):
        response = (
            "The capital of France is Paris. It is one of the most visited "
            "cities in the world, known for the Eiffel Tower."
        )
        result = engine.evaluate(response)
        assert result["passed"] is True

    def test_single_long_sentence_passes(self, engine):
        response = (
            "Python's sort() method sorts lists in place using Timsort, "
            "a hybrid stable sorting algorithm."
        )
        result = engine.evaluate(response)
        assert result["passed"] is True

    def test_precision_recall_on_labeled_set(self, engine):
        labeled_path = os.path.join(FIXTURES_DIR, "eval_labeled.json")
        if not os.path.exists(labeled_path):
            pytest.skip("eval_labeled.json not found")

        report = engine.evaluate_batch(labeled_path)
        assert report["precision"] >= 0.9, f"Precision {report['precision']} < 0.9"
        assert report["recall"] >= 0.9, f"Recall {report['recall']} < 0.9"

    def test_evaluate_batch_returns_metrics(self, engine):
        labeled_path = os.path.join(FIXTURES_DIR, "eval_labeled.json")
        if not os.path.exists(labeled_path):
            pytest.skip("eval_labeled.json not found")

        report = engine.evaluate_batch(labeled_path)
        assert "precision" in report
        assert "recall" in report
        assert "f1" in report
        assert "accuracy" in report
        assert "tp" in report
        assert "tn" in report
        assert "fp" in report
        assert "fn" in report
        assert "results" in report
        assert report["total"] == len(report["results"])

    def test_evaluate_batch_missing_file(self, engine):
        report = engine.evaluate_batch("/nonexistent/path.json")
        assert "error" in report
        assert report["precision"] == 0.0

    def test_custom_threshold(self):
        strict = EvaluationEngine(good_threshold=0.8)
        response = "Python is a programming language."
        result = strict.evaluate(response)
        assert result["passed"] is False

        lenient = EvaluationEngine(good_threshold=0.2)
        result2 = lenient.evaluate(response)
        assert result2["passed"] is True
