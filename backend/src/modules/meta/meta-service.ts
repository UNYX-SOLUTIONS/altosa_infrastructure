import { getPrisma } from '../../config/prisma';
import { HttpError } from '../../utils/api-response';
import { buildFlatName } from '../../utils/product-naming';
import {
  createMetaCatalogItem,
  deleteMetaCatalogItem,
  findMetaCatalogItem,
  getMetaCatalog,
  isMetaConfigured,
  searchMetaCatalog,
  updateMetaCatalogItem,
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
): Promise<{ items: MetaCatalogItem[]; total: number }> {  const [catalog, mappedVariants] = await Promise.all([
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

export interface MetaVariantSnapshot {
  productName: string;
  color: string | null;
  description: string | null;
  price: number | null;
  imageUrl: string | null;
  url: string | null;
  isActive: boolean;
}

async function getVariantForMeta(variantId: number) {
  const variant = await getPrisma().productoVariante.findUnique({
    where: { idVariante: variantId },
    select: {
      idVariante: true,
      sku: true,
      color: true,
      descripcion: true,
      precioUsd: true,
      imagenUrl: true,
      urlProducto: true,
      isActive: true,
      metaRetailerId: true,
      producto: { select: { producto: true } },
    },
  });
  if (!variant) {
    throw new HttpError(404, 'Variante no encontrada.', 'ALTOSA_VARIANT_NOT_FOUND');
  }
  return variant;
}

function snapshotFromVariant(
  variant: Awaited<ReturnType<typeof getVariantForMeta>>
): MetaVariantSnapshot {
  return {
    productName: variant.producto.producto,
    color: variant.color,
    description: variant.descripcion,
    price: variant.precioUsd === null ? null : Number(variant.precioUsd),
    imageUrl: variant.imagenUrl,
    url: variant.urlProducto,
    isActive: variant.isActive,
  };
}

/**
 * Publica una variante de Altosa en Meta usando su SKU como retailer_id.
 * Si ya tiene mapping, es idempotente y no crea otro ítem.
 */
export async function publishVariantById(variantId: number): Promise<{
  retailerId: string;
  created: boolean;
} | null> {
  if (!isMetaConfigured()) {
    throw new HttpError(
      503,
      'El catálogo de Meta no está configurado.',
      'META_NOT_CONFIGURED'
    );
  }

  const variant = await getVariantForMeta(variantId);
  if (variant.metaRetailerId) {
    return { retailerId: variant.metaRetailerId, created: false };
  }
  if (!variant.isActive) {
    return null;
  }
  if (!variant.sku?.trim()) {
    throw new HttpError(
      422,
      'La variante necesita SKU para publicarse en Meta.',
      'META_SKU_REQUIRED'
    );
  }

  const snapshot = snapshotFromVariant(variant);
  const published = await publishVariantToMeta({
    retailerId: variant.sku.trim(),
    name: buildFlatName(snapshot.productName, snapshot.color),
    description: snapshot.description,
    price: snapshot.price,
    imageUrl: snapshot.imageUrl,
    url: snapshot.url,
  });

  await getPrisma().productoVariante.update({
    where: { idVariante: variant.idVariante },
    data: {
      metaRetailerId: published.retailerId,
      metaMappingLocked: true,
    },
  });

  return published;
}

/**
 * Actualiza el ítem de Meta mapeado a una variante. Acepta overrides para
 * reflejar el estado que se va a guardar antes de escribir en la DB.
 * Si el ítem ya no existe y la variante sigue activa, lo vuelve a publicar.
 */
export async function updateVariantInMeta(
  variantId: number,
  override: Partial<MetaVariantSnapshot> = {}
): Promise<{ retailerId: string; updated: boolean; created: boolean } | null> {
  if (!isMetaConfigured()) {
    return null;
  }

  const variant = await getVariantForMeta(variantId);
  if (!variant.metaRetailerId) {
    return null;
  }

  const snapshot: MetaVariantSnapshot = {
    ...snapshotFromVariant(variant),
    ...override,
  };
  const retailerId = variant.metaRetailerId;
  const item = await findMetaCatalogItem(retailerId);

  if (!item) {
    if (!snapshot.isActive) {
      return null;
    }
    const published = await publishVariantToMeta({
      retailerId,
      name: buildFlatName(snapshot.productName, snapshot.color),
      description: snapshot.description,
      price: snapshot.price,
      imageUrl: snapshot.imageUrl,
      url: snapshot.url,
    });
    if (published.retailerId !== retailerId) {
      await getPrisma().productoVariante.update({
        where: { idVariante: variant.idVariante },
        data: {
          metaRetailerId: published.retailerId,
          metaMappingLocked: true,
        },
      });
    }
    return { retailerId: published.retailerId, updated: false, created: published.created };
  }

  if (!item.id) {
    throw new HttpError(
      502,
      `Meta no devolvió el id interno del ítem ${retailerId}; no se puede actualizar.`,
      'META_ITEM_ID_MISSING'
    );
  }

  await updateMetaCatalogItem(item.id, {
    name: buildFlatName(snapshot.productName, snapshot.color),
    description: snapshot.description ?? undefined,
    price: snapshot.price,
    imageUrl: snapshot.imageUrl ?? item.imageUrl,
    url: snapshot.url ?? item.url,
    availability: snapshot.isActive ? 'in stock' : 'out of stock',
  });

  return { retailerId, updated: true, created: false };
}

/**
 * Elimina el ítem de Meta mapeado a una variante. Si no está mapeado o ya no
 * existe en Meta, no hace nada.
 */
export async function deleteVariantFromMeta(variantId: number): Promise<boolean> {
  if (!isMetaConfigured()) {
    return false;
  }

  const variant = await getVariantForMeta(variantId);
  if (!variant.metaRetailerId) {
    return false;
  }

  const item = await findMetaCatalogItem(variant.metaRetailerId);
  if (item?.id) {
    await deleteMetaCatalogItem(item.id);
    return true;
  }
  return false;
}

/**
 * Elimina en Meta todos los ítems asociados a las variantes de un producto.
 * Se usa en el DELETE explícito del producto (no en el sync ni en el toggle
 * de isActive, que solo actualiza availability).
 */
export async function deleteProductMetaItems(productId: number): Promise<number> {
  if (!isMetaConfigured()) {
    return 0;
  }

  const variants = await getPrisma().productoVariante.findMany({
    where: { idProducto: productId, metaRetailerId: { not: null } },
    select: { metaRetailerId: true },
  });
  if (variants.length === 0) {
    return 0;
  }

  const catalog = await getMetaCatalog();
  const byRetailer = new Map(
    catalog.map((item) => [item.retailerId.trim().toLowerCase(), item])
  );

  let deleted = 0;
  for (const variant of variants) {
    if (!variant.metaRetailerId) {
      continue;
    }
    const item = byRetailer.get(variant.metaRetailerId.trim().toLowerCase());
    if (item?.id) {
      await deleteMetaCatalogItem(item.id);
      deleted += 1;
    }
  }
  return deleted;
}
