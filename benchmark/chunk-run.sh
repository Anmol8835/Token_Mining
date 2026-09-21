#!/bin/bash
# ============================================================
# Chunked serving loop — 15 prompts per invocation so each
# chunk finishes quickly; survives repeated OOM kills via
# --resume (completed prompts are never re-run).
# ============================================================

set -u
cd "$(dirname "$0")"
LOG=/tmp/benchmark-pilot.log

for cat in chat math mcq code; do
  echo "[$(date +%H:%M:%S)] === serving: $cat (chunks) ===" | tee -a "$LOG"
  while true; do
    out=$(node run.js "$cat" --limit 15 --resume --concurrency 1 2>&1)
    echo "$out" >> "$LOG"
    if echo "$out" | grep -q "no prompts to run"; then
      echo "[$(date +%H:%M:%S)] $cat complete" | tee -a "$LOG"
      break
    fi
    sleep 1
  done
done

echo "[$(date +%H:%M:%S)] === all categories served ===" | tee -a "$LOG"
