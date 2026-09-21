# ============================================================
# MCQ prompts from MMLU-Pro (10 options A-J, gold letter).
# ============================================================

import os

from datasets import load_dataset

from common import DATA_DIR, assign_split, base_parser, shuffle_list, write_jsonl


def main():
    args = base_parser().parse_args()
    n = args.n if args.n is not None else args.limit
    if n is None:
        n = 40

    ds = load_dataset("TIGER-Lab/MMLU-Pro", split="test")
    rows = shuffle_list(list(ds), args.seed)

    out_rows = []
    for i, r in enumerate(rows[:n]):
        out_rows.append(
            {
                "id": f"mcq-{i + 1:04d}",
                "category": "mcq",
                "split": assign_split(i),
                "question": r["question"],
                "options": r["options"],
                "answer": r["answer"],
                "answer_index": r.get("answer_index"),
                "subject": r.get("category"),
            }
        )

    out = args.out or os.path.join(DATA_DIR, "mcq.jsonl")
    write_jsonl(out, out_rows)


if __name__ == "__main__":
    main()
