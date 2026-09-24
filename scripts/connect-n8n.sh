#!/usr/bin/env bash
set -Eeuo pipefail
NETWORK=altosa_backend
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
N8N_CONTAINERS="$(docker ps --filter 'ancestor=docker.n8n.io/n8nio/n8n' --format '{{.Names}}')"
[[ -n "$N8N_CONTAINERS" ]] || { echo "No se encontro n8n en ejecucion"; exit 1; }
while IFS= read -r c; do
  [[ -z "$c" ]] && continue
  docker inspect "$c" --format '{{json .NetworkSettings.Networks}}' | grep -q "$NETWORK" || docker network connect "$NETWORK" "$c"
  echo "$c conectado a $NETWORK"
done <<< "$N8N_CONTAINERS"
