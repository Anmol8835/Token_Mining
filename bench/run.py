#!/usr/bin/env python3
"""
ACOS Benchmark Harness — Phase 0 baseline / Phase 1+ cache-aware.

Usage:
    python bench/run.py [--phase phase1-exact-cache] [--fixture bench/fixtures/workload.json]
                        [--gateway-url http://localhost:8080] [--output bench/results/<phase>.json]

Replays a fixture workload against the gateway and records latency,
token usage, cost, and cache metrics. Results are written to bench/results/.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent

# per-backend rates: a cache hit costs nothing and consumes no new tokens;
# cheap and premium backends are billed at their own real per-token rates,
# not one blended rate, so routing/caching savings actually show up here.
COST_PER_1K = {
    "premium": {"prompt": 0.0025, "completion": 0.0100},
    "cheap": {"prompt": 0.00015, "completion": 0.00060},
    "cache": {"prompt": 0.0, "completion": 0.0},
}


def load_fixture(path: str) -> list[dict]:
    with open(path) as f:
        return json.load(f)


def load_baseline_premium_calls() -> Optional[int]:
    """Premium-call count from the Phase 0 baseline run (100% premium, no
    routing), used as the denominator for premium_reduction_pct. Returns
    None if no baseline has been recorded yet (e.g. this run *is* Phase 0).
    """
    baseline_path = REPO_ROOT / "bench" / "results" / "phase0-baseline.json"
    if not baseline_path.exists():
        return None
    with open(baseline_path) as f:
        baseline = json.load(f)
    return baseline.get("requests", {}).get("successful")


async def run_benchmark(
    fixture_path: str,
    gateway_url: str,
    output_path: str,
) -> dict:
    fixture = load_fixture(fixture_path)
    results = []
    seen_contents = set()
    repeat_count = 0
    repeat_hits = 0
    total_latency = 0.0
    total_prompt_tokens = 0
    total_completion_tokens = 0
    total_cost = 0.0
    errors = 0
    cache_hits = 0
    cache_misses = 0
    cheap_calls = 0
    premium_calls = 0
    cache_latencies = []
    cheap_latencies = []
    premium_latencies = []
    routing_times = []

    async with httpx.AsyncClient(base_url=gateway_url, timeout=120.0) as client:
        for item in fixture:
            t0 = time.monotonic()
            try:
                resp = await client.post(
                    "/v1/chat/completions",
                    json={
                        "messages": item["messages"],
                        "temperature": 0.0,
                        "max_tokens": 512,
                    },
                )
                elapsed = time.monotonic() - t0
                resp.raise_for_status()
                body = resp.json()
            except Exception as e:
                elapsed = time.monotonic() - t0
                errors += 1
                results.append(
                    {
                        "id": item["id"],
                        "error": str(e),
                        "latency_ms": round(elapsed * 1000, 2),
                    }
                )
                continue

            usage = body.get("usage", {})
            served_pt = usage.get("prompt_tokens", 0)
            served_ct = usage.get("completion_tokens", 0)

            trace = body.get("acos_trace", {})
            was_cache_hit = trace.get("cache_hit", False)
            route = trace.get("route", "unknown")

            # tokens/cost actually incurred THIS request: zero on a cache
            # hit (no model call happened), billed at the serving
            # backend's own rate otherwise. served_pt/served_ct (above)
            # are the response's token counts regardless of route, used
            # only for content-size stats, not cost/savings accounting.
            if was_cache_hit:
                pt, ct = 0, 0
                cost = 0.0
            else:
                rate = COST_PER_1K.get(route, COST_PER_1K["premium"])
                pt, ct = served_pt, served_ct
                cost = (pt / 1000) * rate["prompt"] + (ct / 1000) * rate["completion"]

            total_latency += elapsed
            total_prompt_tokens += pt
            total_completion_tokens += ct
            total_cost += cost

            if was_cache_hit:
                cache_hits += 1
                cache_latencies.append(elapsed * 1000)
            elif route == "cheap":
                cache_misses += 1
                cheap_calls += 1
                cheap_latencies.append(elapsed * 1000)
            else:
                cache_misses += 1
                premium_calls += 1
                premium_latencies.append(elapsed * 1000)

            rt = trace.get("routing_time_ms")
            if rt is not None:
                routing_times.append(rt)

            content = json.dumps(item["messages"], sort_keys=True)
            is_repeat = content in seen_contents
            if not is_repeat:
                seen_contents.add(content)
            else:
                repeat_count += 1
                if was_cache_hit:
                    repeat_hits += 1

            results.append(
                {
                    "id": item["id"],
                    "category": item.get("category", "unknown"),
                    "latency_ms": round(elapsed * 1000, 2),
                    "prompt_tokens": pt,
                    "completion_tokens": ct,
                    "total_tokens": pt + ct,
                    "served_prompt_tokens": served_pt,
                    "served_completion_tokens": served_ct,
                    "model": body.get("model", "unknown"),
                    "cost": round(cost, 6),
                    "cache_hit": was_cache_hit,
                    "acos_trace": trace,
                }
            )

    n = len(fixture)
    n_ok = n - errors
    baseline_premium_calls = load_baseline_premium_calls()

    def avg(vals):
        return round(sum(vals) / len(vals), 2) if vals else 0.0

    report = {
        "phase": os.path.splitext(os.path.basename(output_path))[0],
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fixture": fixture_path,
        "gateway_url": gateway_url,
        "requests": {
            "total": n,
            "errors": errors,
            "successful": n_ok,
        },
        "cache": {
            "hits": cache_hits,
            "misses": cache_misses,
            "hit_rate_percent": round(cache_hits / max(n_ok, 1) * 100, 1),
            "repeat_count": repeat_count,
            "repeat_hits": repeat_hits,
            "repeat_hit_rate_percent": round(repeat_hits / max(repeat_count, 1) * 100, 1),
            "mean_cache_latency_ms": avg(cache_latencies),
        },
        "routing": {
            "cheap": cheap_calls,
            "premium": premium_calls,
            "mean_routing_time_ms": avg(routing_times),
            "premium_reduction_pct": (
                round((1 - premium_calls / baseline_premium_calls) * 100, 1)
                if baseline_premium_calls
                else None
            ),
        },
        "latency": {
            "mean_ms": round((total_latency / max(n_ok, 1)) * 1000, 2),
            "total_seconds": round(total_latency, 3),
            "per_request": [r["latency_ms"] for r in results if "error" not in r],
            "mean_cheap_latency_ms": avg(cheap_latencies),
            "mean_premium_latency_ms": avg(premium_latencies),
        },
        "tokens": {
            "total_prompt": total_prompt_tokens,
            "total_completion": total_completion_tokens,
            "total": total_prompt_tokens + total_completion_tokens,
        },
        "cost": {
            "total_usd": round(total_cost, 6),
            "mean_per_request_usd": round(total_cost / max(n_ok, 1), 8),
        },
        "results": results,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(report, f, indent=2)

    return report


def main():
    parser = argparse.ArgumentParser(description="ACOS Benchmark Harness")
    parser.add_argument(
        "--phase",
        default="phase0-baseline",
        help="Phase label (used for output filename)",
    )
    parser.add_argument(
        "--fixture",
        default=str(REPO_ROOT / "bench" / "fixtures" / "workload.json"),
        help="Path to fixture workload JSON",
    )
    parser.add_argument(
        "--gateway-url",
        default="http://localhost:8080",
        help="ACOS gateway base URL",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output path (default: bench/results/<phase>.json)",
    )
    args = parser.parse_args()

    if args.output is None:
        args.output = str(REPO_ROOT / "bench" / "results" / f"{args.phase}.json")

    import asyncio

    report = asyncio.run(
        run_benchmark(
            fixture_path=args.fixture,
            gateway_url=args.gateway_url,
            output_path=args.output,
        )
    )

    print(f"\n{'=' * 60}")
    print(f"  Phase:           {report['phase']}")
    req_ok = report["requests"]["successful"]
    req_errors = report["requests"]["errors"]
    print(f"  Requests:        {req_ok} ok / {req_errors} errors")
    c = report["cache"]
    print(f"  Cache hit rate:  {c['hit_rate_percent']}% ({c['hits']} hits, {c['misses']} misses)")
    if c["repeat_count"] > 0:
        rh = c["repeat_hits"]
        rc = c["repeat_count"]
        print(f"  Repeat hit rate: {c['repeat_hit_rate_percent']}% ({rh}/{rc} repeats hit cache)")
    print(f"  Cache latency:   {c['mean_cache_latency_ms']} ms avg")
    r = report["routing"]
    print(f"  Routing:         {r['cheap']} cheap, {r['premium']} premium")
    print(f"  Routing time:    {r['mean_routing_time_ms']} ms avg (<50ms target)")
    reduct = r["premium_reduction_pct"]
    reduct_str = f"{reduct}%" if reduct is not None else "n/a (no phase0-baseline.json found)"
    print(f"  Premium reduct:  {reduct_str} vs baseline (target >=50%)")
    lat = report["latency"]
    if lat.get("mean_cheap_latency_ms"):
        print(f"  Cheap latency:   {lat['mean_cheap_latency_ms']} ms avg")
    if lat.get("mean_premium_latency_ms"):
        print(f"  Premium latency: {lat['mean_premium_latency_ms']} ms avg")
    print(f"  Mean latency:    {lat['mean_ms']} ms")
    pt_tok = report["tokens"]["total_prompt"]
    ct_tok = report["tokens"]["total_completion"]
    print(
        f"  Total tokens:    {report['tokens']['total']} (prompt: {pt_tok}, completion: {ct_tok})"
    )
    print(f"  Total cost:      ${report['cost']['total_usd']:.6f}")
    print(f"  Output:          {args.output}")
    print(f"{'=' * 60}\n")

    if req_errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
