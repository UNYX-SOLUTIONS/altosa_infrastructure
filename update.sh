#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "ERROR: falta .env"; exit 1; }
git pull --ff-only
docker compose pull
docker compose up -d --remove-orphans
docker image prune -f
docker compose ps
