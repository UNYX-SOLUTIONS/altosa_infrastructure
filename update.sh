#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
git pull --ff-only
docker compose pull
docker compose up -d
./scripts/connect-n8n.sh || true
./scripts/healthcheck.sh
