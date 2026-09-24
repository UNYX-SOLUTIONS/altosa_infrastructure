# Altosa Infrastructure V4

V4 publica **pgAdmin a través del Traefik existente**, sin dominio, usando un entrypoint dedicado (por defecto TCP/HTTP 5050).

## Arquitectura

- `http://IP_DEL_VPS:5050` -> Traefik -> pgAdmin
- Traefik existente -> n8n (routing de Hostinger se conserva)
- n8n + pgAdmin + PostgreSQL comparten `altosa_backend`
- PostgreSQL NO publica 5432

> Sin dominio, esta versión usa HTTP para pgAdmin. No envía credenciales de pgAdmin por HTTPS. Úsalo como configuración temporal; para producción se recomienda un hostname con TLS/Let's Encrypt o restringir el puerto 5050 por firewall/VPN.

## Instalación

```bash
cd /docker/altosa_infrastructure
chmod +x install.sh update.sh backup.sh uninstall.sh scripts/*.sh
./install.sh
```

El instalador:
1. conserva `.env`;
2. crea `altosa_backend`;
3. guarda una copia inicial de `/docker/traefik/docker-compose.yml`;
4. añade `--entrypoints.pgadmin.address=:5050`;
5. reinicia Traefik;
6. levanta PostgreSQL/pgvector y pgAdmin;
7. conecta n8n a `altosa_backend`.

## Acceso

```text
http://IP_DEL_VPS:5050
```

En pgAdmin, registrar PostgreSQL con:

- Host: `altosa-postgres`
- Port: `5432`
- Database: `altosa` (o el valor de `POSTGRES_DB`)
- User: valor de `POSTGRES_USER`
- Password: valor de `POSTGRES_PASSWORD`

## Firewall

El VPS/proveedor debe permitir TCP 5050 para poder acceder desde Internet.

## Importante

El Traefik de Hostinger usa `network_mode: host`; por eso el entrypoint escucha directamente en el host. pgAdmin publica un puerto Docker aleatorio solo para que el provider Docker de Traefik pueda alcanzarlo siguiendo el mismo patrón que la instalación actual de n8n.

No ejecutes `docker compose down -v` si quieres conservar la información.
