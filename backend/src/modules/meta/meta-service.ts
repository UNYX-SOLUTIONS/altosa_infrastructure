import { getPrisma } from '../../config/prisma';
import { HttpError } from '../../utils/api-response';
import {
  createMetaCatalogItem,
  findMetaCatalogItem,
  getMetaCatalog,
  isMetaConfigured,
  searchMetaCatalog,
  type MetaCatalogItem,
} from './meta-client';

function normalizeCatalogText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export async function searchCatalog(
  query: string,
  limit: number
): Promise<{ items: MetaCatalogItem[] }> {
  const items = await searchMetaCatalog(query, limit);
  return { items };
}

export async function getCatalogItem(retailerId: string): Promise<MetaCatalogItem> {
  const item = await findMetaCatalogItem(retailerId);
  if (!item) {
    throw new HttpError(
      404,
      `El Retailer ID "${retailerId}" no existe en el catálogo de Meta.`,
      'META_ITEM_NOT_FOUND'
    );
  }
  return item;
}

export interface PublishVariantInput {
  retailerId: string;
  name: string;
  description?: string | null;
  price: number | null;
  imageUrl?: string | null;
  url?: string | null;
}

export interface PublishVariantResult {
  retailerId: string;
  created: boolean;
}

/**
 * Publica (o reutiliza) el ítem plano de una variante en Meta.
 *
 * Es idempotente por Retailer ID y por nombre exacto: si el ítem ya existe se
 * reutiliza y solo se devuelve su ID para guardarlo en Altosa. Los errores de
 * Meta se propagan para que el sync del ERP los registre como advertencia sin
 * bloquear el alta del producto.
 */
export async function publishVariantToMeta(
  input: PublishVariantInput
): Promise<PublishVariantResult> {
  if (!isMetaConfigured()) {
    throw new HttpError(
      503,
      'El catálogo de Meta no está configurado.',
      'META_NOT_CONFIGURED'
    );
  }

  const retailerId = input.retailerId.trim();
  if (!retailerId) {
    throw new HttpError(
      422,
      'La variante no tiene SKU/Retailer ID para publicar en Meta.',
      'META_RETAILER_ID_REQUIRED'
    );
  }

  const existingByRetailer = await findMetaCatalogItem(retailerId);
  if (existingByRetailer) {
    return { retailerId: existingByRetailer.retailerId, created: false };
  }

  const normalizedName = normalizeCatalogText(input.name);
  if (normalizedName) {
    const matches = await searchMetaCatalog(input.name, 10);
    const exact = matches.find(
      (item) => normalizeCatalogText(item.name) === normalizedName
    );
    if (exact) {
      return { retailerId: exact.retailerId, created: false };
    }
  }

  if (!input.imageUrl?.trim()) {
    throw new HttpError(
      422,
      'La variante no tiene imagen; Meta la exige para publicar el producto.',
      'META_IMAGE_REQUIRED'
    );
  }
  if (input.price === null || input.price <= 0) {
    throw new HttpError(
      422,
      'La variante no tiene precio mayor a 0; Meta lo exige para publicar el producto.',
      'META_PRICE_REQUIRED'
    );
  }

  const created = await createMetaCatalogItem({
    retailerId,
    name: input.name.trim(),
    description: input.description ?? null,
    price: input.price,
    imageUrl: input.imageUrl.trim(),
    url: input.url ?? null,
  });

  return { retailerId: created.retailerId, created: true };
}

export async function listPendingMetaItems(
  limit: number,
  search?: string
): Promise<{ items: MetaCatalogItem[]; total: number }> {
  const [catalog, mappedVariants] = await Promise.all([
    getMetaCatalog(),
    getPrisma().productoVariante.findMany({
      select: {
        metaRetailerId: true,
        sku: true,
        color: true,
        producto: { select: { producto: true } },
      },
    }),
  ]);

  const mappedIds = new Set(
    mappedVariants
      .map((variant) => variant.metaRetailerId?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value))
  );
  const mappedSkus = new Set(
    mappedVariants
      .map((variant) => variant.sku?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value))
  );
  // Si el ítem plano ya existe en Altosa (aunque no tenga ID de Meta), no debe
  // aparecer como pendiente de ingesta: se mapea desde la variante (escenario 1).
  const existingNames = new Set<string>();
  for (const variant of mappedVariants) {
    const productName = variant.producto?.producto?.trim();
    if (!productName) {
      continue;
    }
    existingNames.add(normalizeCatalogText(productName));
    const color = variant.color?.trim();
    if (color && !/^est[aá]ndar$/i.test(color)) {
      existingNames.add(normalizeCatalogText(`${productName} ${color}`));
    }
  }

  const term = search?.trim().toLowerCase();
  const pending = catalog.filter((item) => {
    const retailer = item.retailerId.trim().toLowerCase();
    if (mappedIds.has(retailer) || mappedSkus.has(retailer)) {
      return false;
    }
    if (existingNames.has(normalizeCatalogText(item.name))) {
      return false;
    }
    if (!term) {
      return true;
    }
    return (
      item.name.toLowerCase().includes(term) ||
      retailer.includes(term)
    );
  });

  return {
    items: pending.slice(0, limit),
    total: pending.length,
  };
}
