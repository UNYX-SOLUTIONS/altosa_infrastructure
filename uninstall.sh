#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

echo "Este script detendrá PostgreSQL y pgAdmin."
echo "NO eliminará los volúmenes de datos ni la red altosa_backend."
read -r -p "Escribe SI para continuar: " ANSWER
[ "$ANSWER" = "SI" ] || { echo "Cancelado."; exit 0; }

docker compose down
echo "Servicios detenidos. Datos conservados."
