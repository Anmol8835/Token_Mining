# ============================================================
# Shared prep utilities — JSONL writer, seeded sampling,
# deterministic 2:1 train/eval split interleave.
# ============================================================

import argparse
import json
import os
import random
from itertools import islice

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "prompts")


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} rows -> {path}")


def assign_split(i):
    """Deterministic interleaved 2:1 split: eval on every 3rd row."""
    return "eval" if i % 3 == 2 else "train"


def base_parser():
    p = argparse.ArgumentParser()
    p.add_argument("--n", type=int, default=None, help="max rows to emit")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", default=None, help="output jsonl path (default: data/prompts/<name>.jsonl)")
    p.add_argument("--limit", type=int, default=None, help="alias for --n")
    return p


def shuffle_stream(stream, seed, buffer_size=10000):
    """Shuffle a HF streaming dataset with a seeded buffer."""
    return stream.shuffle(buffer_size=buffer_size, seed=seed)


def take(rows, n):
    return list(islice(rows, n)) if n is not None else list(rows)


def shuffle_list(rows, seed):
    r = random.Random(seed)
    r.shuffle(rows)
    return rows
