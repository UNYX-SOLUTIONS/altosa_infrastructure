# Altosa Infrastructure v2

Infraestructura Docker para PostgreSQL 16 + pgvector + pgAdmin, integrada con el n8n y Traefik existentes de Hostinger.

## Arquitectura

- Traefik existente: publica HTTPS.
- pgAdmin: descubierto por Traefik mediante labels Docker.
- n8n existente: el instalador lo detecta y lo conecta a `altosa_backend`.
- PostgreSQL: solo en `altosa_backend`, sin puerto 5432 publicado al host.

## Instalacion / reinstalacion

```bash
cd /docker
git clone <REPO> altosa_infrastructure
cd altosa_infrastructure
chmod +x install.sh update.sh backup.sh uninstall.sh scripts/*.sh
./install.sh
```

En la primera ejecucion se crea `.env`. Edite `PGADMIN_HOST` y vuelva a ejecutar `./install.sh`.

```bash
nano .env
./install.sh
```

Antes de usar el dominio, cree el registro DNS A de `PGADMIN_HOST` apuntando al VPS.

## Conexion desde n8n a PostgreSQL

- Host: `altosa-postgres`
- Port: `5432`
- Database: valor de `POSTGRES_DB`
- User: valor de `POSTGRES_USER`
- Password: valor de `POSTGRES_PASSWORD`

## pgAdmin

Dentro de pgAdmin use `altosa-postgres` como hostname de PostgreSQL, nunca la IP publica del VPS.

## Reinstalacion segura

`docker compose down` no borra los volumenes. No use `docker compose down -v` salvo que quiera eliminar permanentemente PostgreSQL y pgAdmin.

## Comandos

```bash
./scripts/healthcheck.sh
./backup.sh
./update.sh
./uninstall.sh
```

## Seguridad

`.env` y `backups/` estan excluidos de Git. PostgreSQL no publica 5432. pgAdmin sale por HTTPS usando el Traefik existente.
