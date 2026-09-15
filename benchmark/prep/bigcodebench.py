# ============================================================
# Code prompts from BigCodeBench (split v0.1.4).
# Prompt = instruct_prompt (natural-language instruction).
# Lib preflight: drop tasks whose libraries can't run locally
# (GUI/network/framework side-effect libs skipped outright).
# ============================================================

import ast
import importlib.util
import os

from datasets import load_dataset

from common import DATA_DIR, assign_split, base_parser, shuffle_list, write_jsonl

# GUI / network / heavyweight-framework libs that can't (or mustn't)
# run in a plain subprocess on this machine.
HARD_SKIP = {
    "tkinter", "turtle", "django", "flask", "fastapi", "aiohttp", "requests",
    "tensorflow", "torch", "kafka", "kafka-python", "selenium", "playwright",
    "dash", "scrapy", "websockets", "socket", "pymongo", "redis", "psycopg2",
    "sqlalchemy", "transformers", "opencv", "cv2",
}


def lib_available(lib):
    try:
        return importlib.util.find_spec(lib) is not None
    except (ImportError, ValueError):
        return False


def main():
    args = base_parser().parse_args()
    n = args.n if args.n is not None else args.limit
    if n is None:
        n = 120

    ds = load_dataset("bigcode/bigcodebench", split="v0.1.4")
    all_rows = list(ds)

    runnable = []
    skipped = {"hard": 0, "missing_lib": 0, "bad_libs": 0}
    for r in all_rows:
        try:
            libs = ast.literal_eval(r["libs"]) if isinstance(r["libs"], str) else r["libs"]
        except Exception:
            skipped["bad_libs"] += 1
            continue
        if any(lib in HARD_SKIP for lib in libs):
            skipped["hard"] += 1
            continue
        missing = [lib for lib in libs if not lib_available(lib)]
        if missing:
            skipped["missing_lib"] += 1
            continue
        runnable.append(r)

    print(f"preflight: {len(all_rows)} total -> {len(runnable)} runnable "
          f"(hard-skip {skipped['hard']}, missing-lib {skipped['missing_lib']}, bad-libs {skipped['bad_libs']})")

    rows = shuffle_list(runnable, args.seed)
    out_rows = []
    for i, r in enumerate(rows[:n]):
        out_rows.append(
            {
                "id": f"code-{i + 1:04d}",
                "category": "code",
                "split": assign_split(i),
                "task_id": r["task_id"],
                "prompt": r["instruct_prompt"],
                "entry_point": r.get("entry_point"),
                "test": r["test"],
                "libs": ast.literal_eval(r["libs"]) if isinstance(r["libs"], str) else r["libs"],
                # canonical_solution is only the function BODY — the
                # signature lives in complete_prompt. Store both so the
                # canonical harness check can reconstruct the full fn.
                "canonical_solution": r.get("canonical_solution"),
                "complete_prompt": r.get("complete_prompt"),
                "source": "bigcodebench",
            }
        )

    out = args.out or os.path.join(DATA_DIR, "code.jsonl")
    write_jsonl(out, out_rows)


if __name__ == "__main__":
    main()
