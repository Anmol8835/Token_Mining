import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
RESULTS_DIR = REPO_ROOT / "bench" / "results"


def _load_benchmark(phase: str) -> dict:
    base = Path(RESULTS_DIR) if isinstance(RESULTS_DIR, str) else RESULTS_DIR
    path = base / f"{phase}.json"
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)


def compute_summary() -> dict:
    baseline = _load_benchmark("phase0-baseline")
    latest = _load_benchmark("phase6-confidence-evaluation")

    if not baseline or not latest:
        return {}

    bl_reqs = baseline.get("requests", {}).get("successful", 1)
    lt_reqs = latest.get("requests", {}).get("successful", 0)

    bl_pt = baseline.get("tokens", {}).get("total_prompt", 0)
    bl_ct = baseline.get("tokens", {}).get("total_completion", 0)
    bl_tokens = bl_pt + bl_ct
    lt_pt = latest.get("tokens", {}).get("total_prompt", 0)
    lt_ct = latest.get("tokens", {}).get("total_completion", 0)
    lt_tokens = lt_pt + lt_ct

    bl_cost = baseline.get("cost", {}).get("total_usd", 0)
    lt_cost = latest.get("cost", {}).get("total_usd", 0)

    lt_cache = latest.get("cache", {})
    lt_routing = latest.get("routing", {})
    lt_latency = latest.get("latency", {})

    phases = {}
    base = Path(RESULTS_DIR) if isinstance(RESULTS_DIR, str) else RESULTS_DIR
    for fname in sorted(os.listdir(str(base))):
        if fname.endswith(".json"):
            phase_name = fname.replace(".json", "")
            data = _load_benchmark(phase_name)
            if data:
                phases[phase_name] = {
                    "requests": data.get("requests", {}).get("successful", 0),
                    "mean_latency_ms": data.get("latency", {}).get("mean_ms", 0),
                    "total_tokens": (
                        data.get("tokens", {}).get("total_prompt", 0)
                        + data.get("tokens", {}).get("total_completion", 0)
                    ),
                    "total_cost_usd": data.get("cost", {}).get("total_usd", 0),
                    "cache_hit_rate": data.get("cache", {}).get("hit_rate_percent", 0),
                    "premium_calls": data.get("routing", {}).get("premium", 0),
                    "cheap_calls": data.get("routing", {}).get("cheap", 0),
                }

    token_reduction_pct = round((1 - lt_tokens / max(bl_tokens, 1)) * 100, 1) if bl_tokens else 0
    cost_reduction_pct = round((1 - lt_cost / max(bl_cost, 1e-9)) * 100, 1) if bl_cost else 0

    return {
        "baseline": {
            "total_tokens": bl_tokens,
            "total_cost_usd": round(bl_cost, 6),
            "requests": bl_reqs,
        },
        "latest": {
            "phase": "phase6-confidence-evaluation",
            "total_tokens": lt_tokens,
            "total_cost_usd": round(lt_cost, 6),
            "requests": lt_reqs,
            "mean_latency_ms": lt_latency.get("mean_ms", 0),
            "cache_hit_rate_pct": lt_cache.get("hit_rate_percent", 0),
            "premium_calls": lt_routing.get("premium", 0),
            "cheap_calls": lt_routing.get("cheap", 0),
            "mean_cache_latency_ms": lt_cache.get("mean_cache_latency_ms", 0),
            "mean_premium_latency_ms": lt_latency.get("mean_premium_latency_ms", 0),
            "mean_cheap_latency_ms": lt_latency.get("mean_cheap_latency_ms", 0),
        },
        "improvements": {
            "token_reduction_pct": token_reduction_pct,
            "cost_reduction_pct": cost_reduction_pct,
            "premium_reduction_pct": lt_routing.get("premium_reduction_pct"),
        },
        "phases": phases,
    }


def compute_aggregated(stats: dict) -> dict:
    if not stats or "phases" not in stats:
        return {}
    phases = stats["phases"]
    total_requests = sum(p["requests"] for p in phases.values())
    if not total_requests:
        return {}
    avg_latency = (
        sum(p["mean_latency_ms"] * p["requests"] for p in phases.values()) / total_requests
    )
    total_cost = sum(p["total_cost_usd"] for p in phases.values())
    return {
        "total_requests": total_requests,
        "avg_latency_ms": round(avg_latency, 2),
        "total_cost_usd": round(total_cost, 6),
        "phase_count": len(phases),
    }
