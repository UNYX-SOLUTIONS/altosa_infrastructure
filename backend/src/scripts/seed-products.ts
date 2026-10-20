/**
 * Seed offline de productos para la base de Altosa.
 *
 * Uso:
 *   pnpm seed:products -- ../ruta/contifico-products.json
 *   pnpm seed:products -- ../ruta/contifico-products.json --match-by-name
 *
 * El JSON puede ser el export generado por el ERP:
 *   pnpm --dir backend sync:contifico -- --export ../altosa_infrastructure/backend/data/contifico-products.json
 * o un arreglo directo de productos. `--match-by-name` enlaza productos ya
 * existentes por nombre (migración desde el ETL de Altosa).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { disconnectPrisma } from '../config/prisma';
import { syncProductsBodySchema } from '../modules/catalog/catalog-schema';
import { syncProducts } from '../modules/catalog/catalog-service';

const BATCH_SIZE = 100;

interface SeedResult {
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
}

function emptyResult(): SeedResult {
  return { productsCreated: 0, productsUpdated: 0, variantsCreated: 0, variantsUpdated: 0 };
}

async function main(): Promise<void> {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Uso: pnpm seed:products -- <archivo.json>');
    process.exitCode = 1;
    return;
  }

  const matchByName = process.argv.includes('--match-by-name');
  const filePath = resolve(process.cwd(), fileArg);
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items)
      : null;

  if (!items) {
    console.error('El JSON debe ser un arreglo de productos o un objeto con la propiedad "items".');
    process.exitCode = 1;
    return;
  }

  const result = emptyResult();
  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    const chunk = items.slice(index, index + BATCH_SIZE);
    const parsed = syncProductsBodySchema.safeParse({ items: chunk, matchByName });
    if (!parsed.success) {
      console.error(`JSON inválido en el lote ${index / BATCH_SIZE + 1}:`, parsed.error.flatten());
      process.exitCode = 1;
      return;
    }

    const batchResult = await syncProducts(parsed.data.items, {
      matchByName: parsed.data.matchByName,
    });
    result.productsCreated += batchResult.productsCreated;
    result.productsUpdated += batchResult.productsUpdated;
    result.variantsCreated += batchResult.variantsCreated;
    result.variantsUpdated += batchResult.variantsUpdated;
    console.log(
      `Lote ${index / BATCH_SIZE + 1}: ${chunk.length} productos procesados.`
    );
  }

  console.log(
    `Seed completado: ${result.productsCreated} productos creados, ` +
      `${result.productsUpdated} productos actualizados, ` +
      `${result.variantsCreated} variantes creadas, ${result.variantsUpdated} variantes actualizadas.`
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
