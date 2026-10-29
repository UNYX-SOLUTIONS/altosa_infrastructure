import { getPrisma } from '../../config/prisma';
import { env } from '../../config/env';
import { HttpError } from '../../utils/api-response';
import { buildFlatName } from '../../utils/product-naming';
import { importExternalItems } from '../external/external-service';
import {
  createContificoProduct,
  deactivateContificoProduct,
  fetchAllContificoProducts,
  fetchContificoCategories,
  fetchContificoProductById,
  searchContificoProducts,
  updateContificoProduct,
} from './contifico-catalog';
import { mapContificoProduct, resolveContificoSku } from './contifico-mappers';
import type {
  ContificoCatalogItem,
  ContificoImportResult,
  ContificoProductDto,
  ContificoProductSuggestion,
} from './contifico-types';

export function isContificoConfigured(): boolean {
  return Boolean(env.CONTIFICO_API_KEY);
}

function requireConfigured(): void {
  if (!isContificoConfigured()) {
    throw new HttpError(
      503,
      'La integración con Contifico no está configurada en Altosa (falta CONTIFICO_API_KEY).',
      'CONTIFICO_NOT_CONFIGURED'
    );
  }
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function categoryNameById(categories: Awaited<ReturnType<typeof fetchContificoCategories>>) {
  return new Map(categories.map((category) => [category.id, category.nombre]));
}

function canonicalToCatalogItem(
  product: ReturnType<typeof mapContificoProduct>
): ContificoCatalogItem {
  return {
    externalId: product.externalId,
    sku: product.sku,
    name: product.name,
    category: product.category,
    price: product.price,
    stock: product.stock,
    barcode: product.barcode,
    isActive: product.isActive,
  };
}

async function mapProductsWithCategories(products: ContificoProductDto[]) {
  const categories = await fetchContificoCategories();
  const names = categoryNameById(categories);
  return products.map((product) =>
    mapContificoProduct(
      product,
      product.categoria_id ? names.get(product.categoria_id) ?? null : null
    )
  );
}

async function findRawProduct(input: {
  contificoId?: string;
  sku?: string;
}): Promise<ContificoProductDto> {
  if (input.contificoId?.trim()) {
    return fetchContificoProductById(input.contificoId.trim());
  }

  const sku = input.sku?.trim();
  if (!sku) {
    throw new HttpError(
      422,
      'Debes indicar contificoId o sku para importar un producto.',
      'CONTIFICO_ID_REQUIRED'
    );
  }

  const matches = await searchContificoProducts(sku, 20);
  const exact = matches.find(
    (product) => normalize(resolveContificoSku(product)) === normalize(sku)
  );
  if (exact) {
    return exact;
  }

  const all = await fetchAllContificoProducts();
  const found = all.find(
    (product) => normalize(resolveContificoSku(product)) === normalize(sku)
  );
  if (!found) {
    throw new HttpError(
      404,
      `No existe un producto con SKU "${sku}" en Contifico.`,
      'CONTIFICO_PRODUCT_NOT_FOUND'
    );
  }
  return found;
}

export async function getContificoStatus() {
  return {
    configured: isContificoConfigured(),
    apiUrl: env.CONTIFICO_API_URL,
    hasPosToken: Boolean(env.CONTIFICO_API_TOKEN),
  };
}

export async function listContificoCategories() {
  requireConfigured();
  return fetchContificoCategories();
}

export async function listContificoCatalogItems(
  search: string | undefined,
  limit: number
): Promise<ContificoCatalogItem[]> {
  requireConfigured();
  const term = normalize(search);

  // Con búsqueda usamos el filtro server-side de Contifico (rápido). Solo
  // traemos todo el catálogo cuando el selector abre sin término.
  const raw = term
    ? await searchContificoProducts(term, limit)
    : await fetchAllContificoProducts();
  const canonical = await mapProductsWithCategories(raw);
  const filtered = term
    ? canonical.filter((product) => {
        const name = normalize(product.name);
        const sku = normalize(product.sku);
        const barcode = normalize(product.barcode);
        return name.includes(term) || sku.includes(term) || barcode.includes(term);
      })
    : canonical;

  return filtered.slice(0, limit).map(canonicalToCatalogItem);
}

export async function getContificoCatalogItem(id: string): Promise<ContificoCatalogItem> {
  requireConfigured();
  const raw = await fetchContificoProductById(id);
  const categories = await fetchContificoCategories();
  const names = categoryNameById(categories);
  return canonicalToCatalogItem(
    mapContificoProduct(
      raw,
      raw.categoria_id ? names.get(raw.categoria_id) ?? null : null
    )
  );
}

export async function searchContificoProductSuggestions(
  query: string,
  limit: number
): Promise<ContificoProductSuggestion[]> {
  requireConfigured();
  const raw = await searchContificoProducts(query, limit);
  if (raw.length === 0) {
    return [];
  }

  const canonical = await mapProductsWithCategories(raw);
  const prisma = getPrisma();
  const variants = await prisma.productoVariante.findMany({
    where: {
      OR: canonical.flatMap((product) => [
        { contificoId: { equals: product.externalId, mode: 'insensitive' as const } },
        { contificoSku: { equals: product.sku, mode: 'insensitive' as const } },
        { sku: { equals: product.sku, mode: 'insensitive' as const } },
      ]),
    },
    select: {
      idProducto: true,
      sku: true,
      contificoId: true,
      contificoSku: true,
    },
  });

  const byKey = new Map<string, (typeof variants)[number]>();
  for (const variant of variants) {
    for (const key of [variant.contificoId, variant.contificoSku, variant.sku]) {
      if (key) {
        byKey.set(normalize(key), variant);
      }
    }
  }

  return canonical.map((product) => {
    const variant =
      byKey.get(normalize(product.externalId)) ??
      byKey.get(normalize(product.sku)) ??
      null;
    return {
      contificoId: product.externalId,
      sku: product.sku,
      name: product.name,
      category: product.category,
      price: product.price,
      stock: product.stock,
      imageUrl: product.thumbnailUrl,
      barcode: product.barcode,
      alreadyAdded: Boolean(variant),
      localProductId: variant ? String(variant.idProducto) : null,
      altosaProductId: variant?.idProducto ?? null,
    };
  });
}

export async function importContificoProduct(input: {
  contificoId?: string;
  sku?: string;
}): Promise<ContificoImportResult> {
  requireConfigured();

  const raw = await findRawProduct(input);
  const categories = await fetchContificoCategories();
  const names = categoryNameById(categories);
  const canonical = mapContificoProduct(
    raw,
    raw.categoria_id ? names.get(raw.categoria_id) ?? null : null
  );

  const existing = await getPrisma().productoVariante.findFirst({
    where: {
      OR: [
        { contificoId: { equals: canonical.externalId, mode: 'insensitive' } },
        { contificoSku: { equals: canonical.sku, mode: 'insensitive' } },
        { sku: { equals: canonical.sku, mode: 'insensitive' } },
      ],
    },
    select: { idProducto: true },
  });
  if (existing) {
    return {
      localProductId: String(existing.idProducto),
      altosaProductId: existing.idProducto,
      sku: canonical.sku,
      name: canonical.name,
      created: false,
      updated: false,
    };
  }

  const imported = await importExternalItems([
    {
      source: 'contifico',
      externalId: canonical.externalId,
      sku: canonical.sku,
      name: canonical.name,
      price: canonical.price,
      imageUrl: canonical.thumbnailUrl,
      url: canonical.sourceUrl,
      category: canonical.category ?? undefined,
      stock: canonical.stock,
      barcode: canonical.barcode ?? undefined,
      contificoId: canonical.externalId,
      contificoSku: canonical.sku,
    },
  ]);

  const created = imported.created[0];
  if (!created) {
    const skipped = await getPrisma().productoVariante.findFirst({
      where: {
        OR: [
          { contificoId: { equals: canonical.externalId, mode: 'insensitive' } },
          { contificoSku: { equals: canonical.sku, mode: 'insensitive' } },
        ],
      },
      select: { idProducto: true },
    });
    if (!skipped) {
      throw new HttpError(
        409,
        'El producto no se importó: ya existía o no pasó la validación de duplicados.',
        'CONTIFICO_IMPORT_SKIPPED'
      );
    }
    return {
      localProductId: String(skipped.idProducto),
      altosaProductId: skipped.idProducto,
      sku: canonical.sku,
      name: canonical.name,
      created: false,
      updated: false,
    };
  }

  return {
    localProductId: String(created.productId),
    altosaProductId: created.productId,
    sku: created.sku,
    name: canonical.name,
    created: true,
    updated: false,
  };
}

export interface ContificoVariantPayload {
  productName: string;
  sku: string | null;
  color: string | null;
  description: string | null;
  price: number | null;
  isActive: boolean;
  categoryName?: string | null;
}
export async function createContificoProductForVariant(
  input: ContificoVariantPayload
): Promise<{ contificoId: string; contificoSku: string } | null> {
  if (!isContificoConfigured() || !input.isActive || !input.sku?.trim()) {
    return null;
  }

  const sku = input.sku.trim();
  const existing = await searchContificoProducts(sku, 10);
  const match = existing.find(
    (product) => normalize(resolveContificoSku(product)) === normalize(sku)
  );
  if (match) {
    return {
      contificoId: match.id,
      contificoSku: resolveContificoSku(match),
    };
  }

  if (sku.length > 25) {
    throw new HttpError(
      422,
      'El SKU de la variante supera los 25 caracteres que admite Contifico. Ajusta el SKU para poder sincronizarlo.',
      'CONTIFICO_SKU_TOO_LONG'
    );
  }

  const created = await createContificoProduct({
    codigo: sku,
    nombre: buildFlatName(input.productName, input.color),
    descripcion: input.description ?? undefined,
    categoriaNombre: input.categoryName?.trim() || 'General',
    pvp1: input.price ?? 0,
    pvpManual: (input.price ?? 0) <= 0,
    estado: 'A',
  });

  return {
    contificoId: created.id,
    contificoSku: resolveContificoSku(created),
  };
}

/**
 * Actualiza el producto plano de Contifico asociado a una variante.
 * Sin contificoId no hace nada (variante huérfana pendiente de mapeo).
 */
export async function updateContificoProductForVariant(
  contificoId: string | null | undefined,
  input: ContificoVariantPayload
): Promise<void> {
  if (!isContificoConfigured() || !contificoId) {
    return;
  }

  await updateContificoProduct(contificoId, {
    nombre: buildFlatName(input.productName, input.color),
    descripcion: input.description ?? '',
    ...(input.categoryName
      ? { categoriaNombre: input.categoryName }
      : {}),
    ...(input.price !== null
      ? { pvp1: input.price, pvpManual: input.price <= 0 }
      : {}),
    estado: input.isActive ? 'A' : 'I',
  });
}

export async function deactivateContificoProductForVariant(
  contificoId: string | null | undefined
): Promise<void> {
  if (!isContificoConfigured() || !contificoId) {
    return;
  }
  await deactivateContificoProduct(contificoId);
}
