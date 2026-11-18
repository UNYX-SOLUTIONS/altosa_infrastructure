import 'dotenv/config';
import { getPrisma } from '../config/prisma';
import { logger } from '../config/logger';
import { updateContificoProduct } from '../modules/contifico/contifico-catalog';

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => {
  const raw = process.argv.find((arg) => arg.startsWith('--limit='));
  if (!raw) return null;
  const value = Number(raw.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
})();

const DELAY_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const prisma = getPrisma();
  const variants = await prisma.productoVariante.findMany({
    where: {
      contificoId: { not: null },
      OR: [{ descripcionContifico: null }, { descripcionContifico: '' }],
    },
    select: {
      idVariante: true,
      sku: true,
      contificoId: true,
    },
    orderBy: { idVariante: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  logger.info(
    {
      apply: APPLY,
      total: variants.length,
      limit: LIMIT,
    },
    APPLY
      ? 'Vaciando descripciones en Contifico'
      : 'Dry-run: no se escribirá en Contifico (usa --apply para aplicar)'
  );

  let ok = 0;
  let failed = 0;

  for (const variant of variants) {
    if (!variant.contificoId) {
      continue;
    }
    if (!APPLY) {
      logger.info(
        { variantId: variant.idVariante, sku: variant.sku, contificoId: variant.contificoId },
        'Se vaciaría la descripción en Contifico'
      );
      continue;
    }
    try {
      await updateContificoProduct(variant.contificoId, { descripcion: ' ' });
      ok += 1;
      logger.info(
        { variantId: variant.idVariante, sku: variant.sku },
        'Descripción vaciada en Contifico'
      );
    } catch (error) {
      failed += 1;
      logger.warn(
        { err: error, variantId: variant.idVariante, sku: variant.sku },
        'No se pudo vaciar la descripción en Contifico'
      );
    }
    await sleep(DELAY_MS);
  }

  logger.info(
    { apply: APPLY, total: variants.length, ok, failed },
    'Proceso de descripciones de Contifico finalizado'
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'Falló el proceso de descripciones de Contifico');
  process.exitCode = 1;
});
