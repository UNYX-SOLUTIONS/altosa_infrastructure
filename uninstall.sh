#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
echo "Detiene PostgreSQL y pgAdmin. NO elimina volúmenes."
echo "No revierte automáticamente Traefik para evitar sobrescribir cambios posteriores."
read -r -p "Escribe SI para continuar: " A
[ "$A" = "SI" ] || exit 0
docker compose down
echo "Servicios detenidos; datos conservados."
