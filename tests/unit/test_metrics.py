import json
import os
import shutil
import tempfile

import pytest

from src.metrics.aggregator import compute_aggregated, compute_summary


@pytest.fixture
def fake_results_dir():
    tmp = tempfile.mkdtemp()
    baseline = {
        "requests": {"successful": 20},
        "tokens": {"total_prompt": 2000, "total_completion": 1500},
        "cost": {"total_usd": 0.05},
        "latency": {"mean_ms": 50.0},
        "cache": {"hit_rate_percent": 0},
        "routing": {"premium": 20, "cheap": 0, "premium_reduction_pct": None},
    }
    with open(os.path.join(tmp, "phase0-baseline.json"), "w") as f:
        json.dump(baseline, f)

    latest = {
        "requests": {"successful": 20},
        "tokens": {"total_prompt": 800, "total_completion": 300},
        "cost": {"total_usd": 0.008},
        "latency": {
            "mean_ms": 35.0,
            "mean_premium_latency_ms": 40.0,
            "mean_cheap_latency_ms": 30.0,
        },
        "cache": {"hit_rate_percent": 30.0, "mean_cache_latency_ms": 2.0, "hits": 6, "misses": 14},
        "routing": {"premium": 9, "cheap": 5, "premium_reduction_pct": 55.0},
    }
    with open(os.path.join(tmp, "phase6-confidence-evaluation.json"), "w") as f:
        json.dump(latest, f)

    yield tmp
    shutil.rmtree(tmp)


def test_summary_has_expected_keys(fake_results_dir, monkeypatch):
    monkeypatch.chdir(fake_results_dir)
    monkeypatch.setattr("src.metrics.aggregator.RESULTS_DIR", fake_results_dir)
    summary = compute_summary()
    assert "baseline" in summary
    assert "latest" in summary
    assert "improvements" in summary
    assert "phases" in summary
    assert summary["baseline"]["total_tokens"] == 3500
    assert summary["latest"]["total_tokens"] == 1100
    assert summary["improvements"]["token_reduction_pct"] > 0
    assert summary["improvements"]["cost_reduction_pct"] > 0


def test_token_reduction_correct(fake_results_dir, monkeypatch):
    monkeypatch.chdir(fake_results_dir)
    monkeypatch.setattr("src.metrics.aggregator.RESULTS_DIR", fake_results_dir)
    summary = compute_summary()
    expected = round((1 - 1100 / 3500) * 100, 1)
    assert summary["improvements"]["token_reduction_pct"] == expected


def test_cost_reduction_correct(fake_results_dir, monkeypatch):
    monkeypatch.chdir(fake_results_dir)
    monkeypatch.setattr("src.metrics.aggregator.RESULTS_DIR", fake_results_dir)
    summary = compute_summary()
    expected = round((1 - 0.008 / 0.05) * 100, 1)
    assert summary["improvements"]["cost_reduction_pct"] == expected


def test_phases_includes_baseline_and_latest(fake_results_dir, monkeypatch):
    monkeypatch.chdir(fake_results_dir)
    monkeypatch.setattr("src.metrics.aggregator.RESULTS_DIR", fake_results_dir)
    summary = compute_summary()
    assert "phase0-baseline" in summary["phases"]
    assert "phase6-confidence-evaluation" in summary["phases"]
    assert summary["phases"]["phase0-baseline"]["requests"] == 20
    assert summary["phases"]["phase6-confidence-evaluation"]["requests"] == 20


def test_aggregated_computed_correctly(fake_results_dir, monkeypatch):
    monkeypatch.chdir(fake_results_dir)
    monkeypatch.setattr("src.metrics.aggregator.RESULTS_DIR", fake_results_dir)
    summary = compute_summary()
    agg = compute_aggregated(summary)
    assert agg["total_requests"] == 40
    assert agg["phase_count"] == 2
    assert agg["total_cost_usd"] == pytest.approx(0.058, abs=1e-6)
    assert agg["avg_latency_ms"] == pytest.approx(42.5, abs=0.1)


def test_aggregated_no_phases():
    assert compute_aggregated({}) == {}
    assert compute_aggregated({"phases": {}}) == {}


def test_summary_no_files_returns_empty(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setattr("src.metrics.aggregator.RESULTS_DIR", tmp)
        summary = compute_summary()
        assert summary == {}


def test_aggregated_handles_zero():
    data = {"phases": {"p1": {"requests": 0, "mean_latency_ms": 10, "total_cost_usd": 0}}}
    assert compute_aggregated(data) == {}
    assert compute_aggregated({}) == {}
    assert compute_aggregated({"phases": {}}) == {}
