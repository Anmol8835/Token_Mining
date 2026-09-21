# ============================================================
# Code prompts from HumanEval-Plus (fallback code set).
# Harness: test field defines check(candidate).
# ============================================================

import os

from datasets import load_dataset

from common import DATA_DIR, assign_split, base_parser, shuffle_list, write_jsonl


def main():
    args = base_parser().parse_args()
    n = args.n if args.n is not None else args.limit
    if n is None:
        n = 120

    ds = load_dataset("evalplus/humanevalplus", split="test")
    rows = shuffle_list(list(ds), args.seed)

    out_rows = []
    for i, r in enumerate(rows[:n]):
        out_rows.append(
            {
                "id": f"codehe-{i + 1:04d}",
                "category": "code",
                "split": assign_split(i),
                "task_id": r["task_id"],
                "prompt": r["prompt"],
                "entry_point": r.get("entry_point"),
                "test": r["test"],
                "libs": [],
                "canonical_solution": r.get("canonical_solution"),
                "source": "humanevalplus",
            }
        )

    out = args.out or os.path.join(DATA_DIR, "code-he.jsonl")
    write_jsonl(out, out_rows)


if __name__ == "__main__":
    main()
