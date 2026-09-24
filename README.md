# Altosa Infrastructure V3

Infraestructura base para el VPS de Altosa.

## Objetivo

- PostgreSQL 16 + pgvector.
- pgAdmin disponible solo localmente en el VPS (`127.0.0.1:5050`).
- Red Docker compartida `altosa_backend`.
- Detección automática del n8n existente y conexión a `altosa_backend`.
- No reinstala ni modifica Traefik.
- No requiere dominio/host para pgAdmin.
- PostgreSQL no publica el puerto 5432.
- Volúmenes persistentes para PostgreSQL y pgAdmin.

## Arquitectura

Internet -> Traefik existente -> n8n existente

`altosa_backend`:
- n8n
- altosa-pgadmin
- altosa-postgres

pgAdmin queda en `127.0.0.1:5050` hasta que se decida publicar mediante Traefik.

## Instalación

```bash
cd /docker
git clone <REPOSITORIO> altosa_infrastructure
cd altosa_infrastructure
chmod +x install.sh update.sh backup.sh uninstall.sh scripts/*.sh
./install.sh
```

El primer arranque crea `.env` automáticamente. `.env` no debe subirse a Git.

## Reinstalación / actualización desde GitHub

Si GitHub debe ser la fuente de verdad y no quieres conservar cambios locales de código:

```bash
cd /docker/altosa_infrastructure
git status
git reset --hard origin/main
git pull
chmod +x install.sh update.sh backup.sh uninstall.sh scripts/*.sh
./install.sh
```

**Esto no elimina los volúmenes Docker**, pero `git reset --hard` sí elimina cambios locales en archivos versionados. El `.env` está ignorado y se conserva.

## Conexión desde n8n a PostgreSQL

Usar:

- Host: `altosa-postgres`
- Port: `5432`
- Database: valor de `POSTGRES_DB`
- User: valor de `POSTGRES_USER`
- Password: valor de `POSTGRES_PASSWORD`

## pgAdmin

Desde el propio VPS escucha en:

`127.0.0.1:5050`

Para acceder remotamente sin dominio se puede usar un túnel SSH desde el PC:

```bash
ssh -L 5050:127.0.0.1:5050 root@IP_DEL_VPS
```

y abrir `http://127.0.0.1:5050` en el navegador local.

## Backups

```bash
./backup.sh
```

## Restore

```bash
./scripts/restore-postgres.sh backups/archivo.dump
```

## Healthcheck

```bash
./scripts/healthcheck.sh
```

## Datos persistentes

Los volúmenes son:

- `altosa_postgres_data`
- `altosa_pgadmin_data`

`docker compose down` no los elimina. No ejecutar `docker compose down -v` salvo que realmente se quiera borrar la información.
