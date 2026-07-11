import json

import pytest

from src.redact import RedactionLayer

FIXTURE_PATH = "bench/fixtures/pii_eval.json"


def load_fixtures():
    with open(FIXTURE_PATH) as f:
        return json.load(f)


@pytest.fixture
def redactor():
    return RedactionLayer()


class TestPIIEval:
    @pytest.mark.parametrize("case", load_fixtures(), ids=lambda c: c["text"][:40])
    def test_pii_detection(self, redactor, case):
        text = case["text"]
        expected_masks = case["expected_masks"]
        result = redactor.redact(text)
        for mask in expected_masks:
            assert mask.upper() in result.upper(), f"Expected {mask} in redacted output for: {text}"

    def test_precision_recall(self, redactor):
        cases = load_fixtures()
        tp = fp = fn = 0
        for case in cases:
            text = case["text"]
            expected = set(case["labels"])
            result = redactor.redact(text)
            found = set()
            for label in ["EMAIL", "PHONE", "SSN", "CC", "IP", "REDACTED"]:
                if f"[{label}]" in result or any(f"[{label}_{i}]" in result for i in range(10)):
                    found.add(label)
            tp += len(found & expected)
            fp += len(found - expected)
            fn += len(expected - found)
        precision = tp / (tp + fp) if (tp + fp) else 1.0
        recall = tp / (tp + fn) if (tp + fn) else 1.0
        assert precision >= 0.85, f"Precision {precision:.2f} < 0.85"
        assert recall >= 0.85, f"Recall {recall:.2f} < 0.85"
