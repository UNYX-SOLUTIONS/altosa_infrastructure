#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${1:-5050}"
TRAEFIK_DIR="/docker/traefik"
COMPOSE="$TRAEFIK_DIR/docker-compose.yml"
BACKUP="$TRAEFIK_DIR/docker-compose.yml.altosa-backup"

[ -f "$COMPOSE" ] || { echo "ERROR: No existe $COMPOSE"; exit 1; }

# Keep a one-time copy of the original Hostinger config.
if [ ! -f "$BACKUP" ]; then
  cp "$COMPOSE" "$BACKUP"
  echo "[✓] Backup original de Traefik: $BACKUP"
fi

# Add the entrypoint only if it does not already exist.
if ! grep -q -- '--entrypoints.pgadmin.address=' "$COMPOSE"; then
  python3 - "$COMPOSE" "$PORT" <<'PY'
import sys
from pathlib import Path

p = Path(sys.argv[1])
port = sys.argv[2]
s = p.read_text()
needle = "      - --entrypoints.websecure.address=:443\n"
addition = needle + f"      - --entrypoints.pgadmin.address=:{port}\n"
if needle not in s:
    raise SystemExit("ERROR: No se encontró el entrypoint websecure esperado en Traefik.")
p.write_text(s.replace(needle, addition, 1))
PY
  echo "[✓] EntryPoint pgadmin :$PORT añadido a Traefik."
else
  echo "[✓] EntryPoint pgadmin ya existe."
fi

echo "[+] Validando Traefik..."
cd "$TRAEFIK_DIR"
docker compose config >/dev/null

echo "[+] Reiniciando Traefik para aplicar el nuevo entrypoint..."
docker compose up -d
echo "[✓] Traefik actualizado."
