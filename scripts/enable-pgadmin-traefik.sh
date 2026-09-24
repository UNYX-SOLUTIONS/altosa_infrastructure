#!/usr/bin/env bash
set -Eeuo pipefail
cat <<'EOF'
pgAdmin está configurado deliberadamente SIN host público en V3.

Cuando decidas publicarlo por Traefik:
1. Define el dominio/DNS.
2. Añade las labels de Traefik a pgAdmin.
3. Cambia el esquema de publicación de puerto según la instalación de Traefik del VPS.
4. Ejecuta docker compose up -d.

No se hacen cambios automáticos para evitar publicar pgAdmin accidentalmente.
EOF
