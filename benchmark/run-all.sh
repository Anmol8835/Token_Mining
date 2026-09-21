#!/bin/bash
# ============================================================
# Full pilot pipeline — restartable at any point (every stage
# supports --resume). Logs to /tmp/benchmark-pilot.log.
#
#   benchmark/run-all.sh          # full pilot
#   benchmark/run-all.sh serve    # serving stage only
#   benchmark/run-all.sh judge    # judging stage only
# ============================================================

set -u
cd "$(dirname "$0")"
LOG=/tmp/benchmark-pilot.log
STAGE="${1:-all}"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

serve() {
  # Serving: router path + cheap/middle/flagship per prompt.
  # Proxy must be running on :8002 for the router path.
  log "=== serving: chat ==="
  node run.js chat --resume --concurrency 2 >> "$LOG" 2>&1
  log "=== serving: math ==="
  node run.js math --resume --concurrency 2 >> "$LOG" 2>&1
  log "=== serving: mcq ==="
  node run.js mcq --resume --concurrency 2 >> "$LOG" 2>&1
  log "=== serving: code ==="
  node run.js code --resume --concurrency 2 >> "$LOG" 2>&1
}

judge() {
  log "=== judging: chat pairs ==="
  node judge.js --resume >> "$LOG" 2>&1
}

grade() {
  log "=== grading: math ==="
  node grade.js math --resume >> "$LOG" 2>&1
  log "=== grading: mcq ==="
  node grade.js mcq --resume >> "$LOG" 2>&1
  log "=== grading: code ==="
  node grade.js code --resume >> "$LOG" 2>&1
}

fit_report() {
  log "=== labels + fit + report ==="
  node label.js >> "$LOG" 2>&1
  node fit-policy.js >> "$LOG" 2>&1
  node report.js >> "$LOG" 2>&1
  node report.js --after-policy >> "$LOG" 2>&1
}

case "$STAGE" in
  serve) serve ;;
  judge) judge ;;
  grade) grade ;;
  fit) fit_report ;;
  all) serve && judge && grade && fit_report ;;
  *) echo "usage: run-all.sh [serve|judge|grade|fit|all]"; exit 1 ;;
esac

log "=== done ==="
