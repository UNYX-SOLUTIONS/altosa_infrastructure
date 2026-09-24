#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
echo "Esto detendra PostgreSQL y pgAdmin, pero CONSERVARA los volumenes de datos."
docker compose down
