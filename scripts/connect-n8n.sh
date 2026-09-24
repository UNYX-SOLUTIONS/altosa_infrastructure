#!/usr/bin/env bash
set -Eeuo pipefail
NETWORK="altosa_backend"

mapfile -t C < <(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /docker\.n8n\.io\/n8nio\/n8n|(^|\/)n8n(\/n8n)?:/ {print $1}')
if [ "${#C[@]}" -eq 0 ]; then
  echo "AVISO: No se encontró n8n activo."
  exit 0
fi
if [ "${#C[@]}" -gt 1 ]; then
  printf 'ERROR: varios n8n detectados:\n'; printf ' - %s\n' "${C[@]}"; exit 1
fi
N8N="${C[0]}"
if docker inspect "$N8N" --format '{{json .NetworkSettings.Networks}}' | grep -q "\"$NETWORK\""; then
  echo "[✓] $N8N ya está conectado a $NETWORK."
else
  docker network connect "$NETWORK" "$N8N"
  echo "[✓] $N8N conectado a $NETWORK."
fi
