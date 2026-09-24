#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
echo "[+] Pull de imágenes..."
docker compose pull
echo "[+] Aplicando actualización..."
docker compose up -d
./scripts/connect-n8n.sh
./scripts/healthcheck.sh
