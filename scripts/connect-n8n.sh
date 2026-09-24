#!/usr/bin/env bash
set -Eeuo pipefail

NETWORK="altosa_backend"

mapfile -t N8N_CONTAINERS < <(
  docker ps --format '{{.Names}} {{.Image}}' |
  awk '$2 ~ /(^|\/)n8n(\/n8n)?:|docker\.n8n\.io\/n8nio\/n8n/ {print $1}'
)

if [ "${#N8N_CONTAINERS[@]}" -eq 0 ]; then
  echo "AVISO: No se encontró un contenedor n8n en ejecución."
  echo "La infraestructura queda instalada; ejecuta este script cuando n8n esté activo."
  exit 0
fi

if [ "${#N8N_CONTAINERS[@]}" -gt 1 ]; then
  echo "ERROR: Se encontraron varios contenedores n8n:"
  printf ' - %s\n' "${N8N_CONTAINERS[@]}"
  echo "Conecta manualmente el correcto con: docker network connect altosa_backend <contenedor>"
  exit 1
fi

N8N="${N8N_CONTAINERS[0]}"

if docker inspect "$N8N" --format '{{json .NetworkSettings.Networks}}' | grep -q "\"${NETWORK}\""; then
  echo "[✓] $N8N ya está conectado a $NETWORK."
else
  docker network connect "$NETWORK" "$N8N"
  echo "[✓] $N8N conectado a $NETWORK."
fi
