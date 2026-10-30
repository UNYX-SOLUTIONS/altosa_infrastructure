#!/usr/bin/env bash
# Reconciliación de mapeos externos: valida Meta/Contifico contra Altosa y
# devuelve un JSON con las incidencias. No modifica datos.
#
# Salida:
#   0 = todos los mapeos sanos
#   2 = hay incidencias o alguna fuente no se pudo validar
#   1 = error de ejecución/API
set -Eeuo pipefail
cd "$(dirname "$0")/.."

# Opcional: ALERT_WEBHOOK_URL en .env para enviar la alerta (Slack/Discord/n8n).
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi

docker exec -e ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}" altosa-api node -e '
fetch("http://127.0.0.1:4100/api/v1/external/health?refresh=true", {
  headers: { "x-api-key": process.env.API_KEY },
})
  .then(async (response) => {
    const text = await response.text();
    console.log(text);
    if (!response.ok) {
      process.exit(1);
    }
    const body = JSON.parse(text);
    const issues = body?.data?.counts?.totalIssues ?? 0;
    const warnings = body?.data?.warnings?.length ?? 0;
    const hasIssues = issues > 0 || warnings > 0;

    if (hasIssues && process.env.ALERT_WEBHOOK_URL) {
      try {
        await fetch(process.env.ALERT_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `Altosa: ${issues} incidencia(s) de mapeo externo y ${warnings} advertencia(s).`,
            checkedAt: body?.data?.checkedAt,
            counts: body?.data?.counts,
            items: body?.data?.items,
            warnings: body?.data?.warnings,
          }),
        });
      } catch (alertError) {
        console.error("No se pudo enviar la alerta:", alertError);
      }
    }

    process.exit(hasIssues ? 2 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
'
