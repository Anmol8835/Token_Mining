# ============================================================
# Math prompts from MATH-500 (gold boxed answers, exact-match).
# Fields: problem, solution, answer (LaTeX), subject, level (1-5).
# ============================================================

import os

from datasets import load_dataset

from common import DATA_DIR, assign_split, base_parser, shuffle_list, write_jsonl


def main():
    args = base_parser().parse_args()
    n = args.n if args.n is not None else args.limit
    if n is None:
        n = 60

    ds = load_dataset("HuggingFaceH4/MATH-500", split="test")
    rows = shuffle_list(list(ds), args.seed)

    out_rows = []
    for i, r in enumerate(rows[:n]):
        out_rows.append(
            {
                "id": f"math-{i + 1:04d}",
                "category": "math",
                "split": assign_split(i),
                "problem": r["problem"],
                "answer": r["answer"],
                "subject": r.get("subject"),
                "level": r.get("level"),
            }
        )

    out = args.out or os.path.join(DATA_DIR, "math.jsonl")
    write_jsonl(out, out_rows)


if __name__ == "__main__":
    main()
