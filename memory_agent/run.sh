#!/usr/bin/env bash
# Loads the pre-built images (memory-agent + redis, both linux/amd64) from images.tar
# and starts both containers — no internet access needed on this machine at any point.
set -euo pipefail
cd "$(dirname "$0")"

echo "Loading pre-built images from images.tar (memory-agent + redis)..."
docker load -i images.tar

echo "Starting services (docker compose up -d)..."
docker compose up -d

echo ""
echo "Started. The memory agent should be reachable shortly at http://localhost:5090/"
echo "  Check status: docker compose ps"
echo "  Follow logs:  docker compose logs -f memory-agent"
echo "  Stop:         docker compose down          (add -v to also wipe the Redis volume)"
