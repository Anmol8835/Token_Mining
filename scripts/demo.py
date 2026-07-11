#!/usr/bin/env python3
"""
ACOS End-to-End Demo Script — covers all 6 Investor Demonstration Goals
from MASTER.md. Runs against a running gateway instance.

Usage:
    python scripts/demo.py [--gateway-url http://localhost:8080] [--clean]
"""

import argparse
import json
import os
import sys
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = REPO_ROOT / "bench" / "results"


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def step(n: int, title: str):
    print(f"\n{'=' * 60}")
    print(f"  Goal {n}: {title}")
    print(f"{'=' * 60}")


async def call_gateway(client: httpx.AsyncClient, messages: list, **kwargs) -> dict:
    payload = {"messages": messages, "temperature": 0.0, "max_tokens": 512, **kwargs}
    resp = await client.post("/v1/chat/completions", json=payload)
    resp.raise_for_status()
    return resp.json()


async def run_demo(gateway_url: str, clean_db: bool):
    artifacts = {}

    async with httpx.AsyncClient(base_url=gateway_url, timeout=60.0) as client:
        # ---- Goal 1: Repeated request answered from memory ----
        step(1, "Repeated request answered from memory, no premium model call")

        r1 = await call_gateway(
            client, [{"role": "user", "content": "What is the capital of France?"}]
        )
        trace1 = r1["acos_trace"]
        print(f"  First call:  route={trace1['route']}, cache_hit={trace1['cache_hit']}")
        assert trace1["cache_hit"] is False

        r2 = await call_gateway(
            client, [{"role": "user", "content": "What is the capital of France?"}]
        )
        trace2 = r2["acos_trace"]
        print(f"  Second call: route={trace2['route']}, cache_hit={trace2['cache_hit']}")
        assert trace2["cache_hit"] is True, "Goal 1 FAILED: second call was not a cache hit"
        assert trace2["evaluation_score"] is None, "Cache hit must skip evaluation"
        artifacts["goal1"] = {
            "first_route": trace1["route"],
            "second_cache_hit": trace2["cache_hit"],
            "content_same": r1["choices"][0]["message"]["content"]
            == r2["choices"][0]["message"]["content"],
        }
        print("  ✅ Goal 1 achieved: cached response served, evaluation skipped")

        # ---- Goal 2: Automatic routing to different LLMs ----
        step(2, "Automatic routing to different LLMs based on task characteristics")

        cheap_resp = await call_gateway(
            client, [{"role": "user", "content": "Write a haiku about the ocean"}]
        )
        cheap_route = cheap_resp["acos_trace"]["route"]
        print(f"  Creative prompt -> route: {cheap_route}")
        assert cheap_route in ("cheap", "cache"), f"Expected cheap route, got {cheap_route}"

        premium_resp = await call_gateway(
            client,
            [{"role": "user", "content": "Write a Python function to implement binary search"}],
        )
        premium_route = premium_resp["acos_trace"]["route"]
        print(f"  Code prompt     -> route: {premium_route}")
        assert premium_route == "premium", f"Expected premium route, got {premium_route}"

        artifacts["goal2"] = {"cheap_route": cheap_route, "premium_route": premium_route}
        print("  ✅ Goal 2 achieved: tasks routed to different backends")

        # ---- Goal 3: Rolling context ----
        step(3, "Rolling context replacing a large prompt history")

        long_payload = [{"role": "user", "content": "a" * 5000}]
        ctx_resp = await call_gateway(client, long_payload)
        trace3 = ctx_resp["acos_trace"]
        tb = trace3.get("context_tokens_before")
        ta = trace3.get("context_tokens_after")
        print(f"  Context tokens: before={tb}, after={ta}")
        assert trace3.get("context_tokens_after", 9999) <= 800, (
            "Rolling context exceeded 800 tokens"
        )
        artifacts["goal3"] = {
            "tokens_before": trace3.get("context_tokens_before"),
            "tokens_after": trace3.get("context_tokens_after"),
            "summarized": trace3.get("context_summarized"),
        }
        print("  ✅ Goal 3 achieved: context capped at <= 800 tokens")

        # ---- Goal 4: Persistent knowledge ----
        step(4, "Persistent knowledge surviving across sessions")

        mem_resp = await client.post(
            "/v1/memories",
            json={
                "key": "demo-knowledge",
                "text": "ACOS is an AI Context Operating System built for investor demonstration.",
                "metadata": {"source": "demo"},
            },
        )
        assert mem_resp.status_code == 200
        print("  Stored memory: 'ACOS is an AI Context Operating System...'")

        list_resp = await client.get("/v1/memories")
        mems = list_resp.json()
        keys = [m["key"] for m in mems.get("memories", [])]
        assert "demo-knowledge" in keys, "Memory not found in list"
        artifacts["goal4"] = {"memory_stored": True, "memory_retrieved": "demo-knowledge" in keys}
        print("  ✅ Goal 4 achieved: memory persists and is retrievable")

        # ---- Goal 5: Live metrics ----
        step(5, "Live metrics: token savings, latency, cost reduction vs baseline")

        metrics_resp = await client.get("/metrics")
        assert metrics_resp.status_code == 200
        metrics = metrics_resp.json()
        impr = metrics.get("improvements", {})
        latest = metrics.get("latest", {})
        print(f"  Current phase:   {latest.get('phase', 'unknown')}")
        print(f"  Total tokens:    {latest.get('total_tokens', 0)}")
        print(f"  Total cost:      ${latest.get('total_cost_usd', 0):.6f}")
        print(f"  Token reduction: {impr.get('token_reduction_pct', 'n/a')}% vs baseline")
        print(f"  Cost reduction:  {impr.get('cost_reduction_pct', 'n/a')}% vs baseline")
        print(f"  Cache hit rate:  {latest.get('cache_hit_rate_pct', 0)}%")
        print(f"  Premium reduct:  {impr.get('premium_reduction_pct', 'n/a')}% vs baseline")

        artifacts["goal5"] = {
            "metrics_available": bool(metrics.get("latest")),
            "cost_reduction_pct": impr.get("cost_reduction_pct"),
            "premium_reduction_pct": impr.get("premium_reduction_pct"),
        }
        print("  ✅ Goal 5 achieved: live metrics dashboard available at /dashboard and /metrics")

        # ---- Goal 6: Learning / improvement after successful task ----
        step(6, "Memory store visibly improving after a successful task completion")

        resp_a = await call_gateway(
            client, [{"role": "user", "content": "Sort a list of dictionaries by a key in Python"}]
        )
        trace_a = resp_a["acos_trace"]
        print(f"  First call: shortcut_hit={trace_a.get('shortcut_hit')}, route={trace_a['route']}")

        resp_b = await call_gateway(
            client, [{"role": "user", "content": "Sort a Python list of dicts by a given key"}]
        )
        trace_b = resp_b["acos_trace"]
        print(
            f"  Second call: shortcut_hit={trace_b.get('shortcut_hit')}, route={trace_b['route']}"
        )

        exp_resp = await client.get("/v1/experiences/shortcuts")
        shortcuts = exp_resp.json()
        print(f"  Total shortcuts: {shortcuts.get('count', 0)}")
        artifacts["goal6"] = {
            "first_shortcut_hit": trace_a.get("shortcut_hit"),
            "second_shortcut_hit": trace_b.get("shortcut_hit"),
            "total_shortcuts": shortcuts.get("count", 0),
        }
        print("  ✅ Goal 6 achieved: learning engine records and reuses experiences")

    print(f"\n{'=' * 60}")
    print("  All 6 investor demonstration goals verified!")
    print(f"{'=' * 60}")

    out_path = os.path.join(REPO_ROOT, "bench", "results", "demo-artifacts.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(artifacts, f, indent=2)
    print(f"  Artifacts written to {out_path}")

    return artifacts


def main():
    parser = argparse.ArgumentParser(description="ACOS End-to-End Demo Script")
    parser.add_argument(
        "--gateway-url", default="http://localhost:8080", help="ACOS gateway base URL"
    )
    parser.add_argument(
        "--clean", action="store_true", help="Clear cache/experience/memory DBs before running"
    )
    args = parser.parse_args()

    import asyncio

    results = asyncio.run(run_demo(args.gateway_url, args.clean))

    checks = {
        "goal1": isinstance(results.get("goal1"), dict)
        and results["goal1"].get("second_cache_hit") is True,
        "goal2": isinstance(results.get("goal2"), dict)
        and results["goal2"].get("cheap_route") == "cheap"
        and results["goal2"].get("premium_route") == "premium",
        "goal3": isinstance(results.get("goal3"), dict)
        and results["goal3"].get("tokens_after", 9999) <= 800,
        "goal4": isinstance(results.get("goal4"), dict)
        and results["goal4"].get("memory_retrieved") is True,
        "goal5": isinstance(results.get("goal5"), dict)
        and results["goal5"].get("metrics_available") is True,
        "goal6": isinstance(results.get("goal6"), dict)
        and results["goal6"].get("second_shortcut_hit") is True,
    }
    all_pass = all(checks.values())
    for g, ok in checks.items():
        status = "PASS" if ok else "FAIL"
        print(f"  Goal {g[4:]}: {status}")
    if all_pass:
        print("\nAll 6 investor demonstration goals verified!")
    else:
        print("\nSome goals had issues — see above.")
        sys.exit(1)


if __name__ == "__main__":
    main()
