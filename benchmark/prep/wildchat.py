# ============================================================
# Chat prompts from WildChat-1M
# Filter: language English, not toxic, turn==1, 50..3000 chars.
# Prompt = conversation[0].content (first user utterance).
# ============================================================

import os

from datasets import load_dataset

from common import DATA_DIR, assign_split, base_parser, shuffle_stream, write_jsonl


def main():
    args = base_parser().parse_args()
    n = args.n if args.n is not None else args.limit
    if n is None:
        n = 200

    ds = load_dataset("allenai/WildChat-1M", split="train", streaming=True)
    ds = ds.filter(
        lambda r: r.get("language") == "English"
        and not r.get("toxic")
        and r.get("turn") == 1
    )
    ds = shuffle_stream(ds, args.seed)

    rows = []
    for i, r in enumerate(ds):
        conv = r.get("conversation") or []
        if not conv or conv[0].get("role") != "user":
            continue
        prompt = (conv[0].get("content") or "").strip()
        if not (50 <= len(prompt) <= 3000):
            continue
        rows.append(
            {
                "id": f"chat-{len(rows) + 1:04d}",
                "category": "chat",
                "split": assign_split(len(rows)),
                "prompt": prompt,
                "meta": {"source": "wildchat-1m", "conversation_hash": r.get("conversation_hash")},
            }
        )
        if len(rows) >= n:
            break

    out = args.out or os.path.join(DATA_DIR, "chat.jsonl")
    write_jsonl(out, rows)


if __name__ == "__main__":
    main()
