import type { Prisma } from '@prisma/client';
import { getPrisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/api-response';
import {
  buildFlatName,
  inferBaseName,
  inferVariantColor,
} from '../../utils/product-naming';
import { resolveSyncEstados } from '../catalog/catalog-estados';
import {
  createContificoProduct,
  fetchAllContificoProducts,
  fetchContificoCategories,
  searchContificoProducts,
  updateContificoProduct,
} from '../contifico/contifico-catalog';
import {
  mapContificoProduct,
  resolveContificoSku,
} from '../contifico/contifico-mappers';
import { getMetaCatalog, type MetaCatalogItem } from '../meta/meta-client';
import {
  listPendingMetaItems,
  republishVariantInMeta,
} from '../meta/meta-service';
import type {
  ExternalHealthQuery,
  ExternalItemInput,
  ExternalMetaPendingQuery,
  ExternalPendingQuery,
  ExternalRepairBody,
} from './external-schema';
import type { ContificoProductDto } from '../contifico/contifico-types';

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

async function findMappedVariant(item: ExternalItemInput) {
  const prisma = getPrisma();
  const or: Prisma.ProductoVarianteWhereInput[] = [];

  const metaRetailerId =
    item.metaRetailerId ?? (item.source === 'meta' ? item.externalId : null);
  const contificoId =
    item.contificoId ?? (item.source === 'contifico' ? item.externalId : null);
  const contificoSku =
    item.contificoSku ??
    (item.source === 'contifico' ? item.sku ?? item.externalId : null);

  if (metaRetailerId) {
    or.push({ metaRetailerId: { equals: metaRetailerId, mode: 'insensitive' } });
  }
  if (contificoId) {
    or.push({ contificoId: { equals: contificoId, mode: 'insensitive' } });
  }
  if (contificoSku) {
    or.push({ contificoSku: { equals: contificoSku, mode: 'insensitive' } });
  }
  if (item.sku?.trim()) {
    or.push({ sku: item.sku.trim() });
  }

  return prisma.productoVariante.findFirst({
    where: { OR: or },
    select: { idVariante: true, idProducto: true, sku: true },
  });
}

async function resolveUniqueSku(base: string): Promise<string> {
  const prisma = getPrisma();
  const clean = base.trim().slice(0, 120) || `EXT-${Date.now()}`;
  let candidate = clean;
  let suffix = 2;

  while (
    await prisma.productoVariante.findFirst({
      where: { sku: candidate },
      select: { idVariante: true },
    })
  ) {
    const suffixText = `-${suffix}`;
    candidate = `${clean.slice(0, Math.max(1, 120 - suffixText.length))}${suffixText}`;
    suffix += 1;
  }

  return candidate;
}

async function resolveTaxonomy(item: ExternalItemInput): Promise<number> {
  const prisma = getPrisma();
  const categoryName = item.category?.trim() || 'Catálogo externo';
  const subcategoryName =
    item.subcategory?.trim() || (item.source === 'meta' ? 'Meta' : 'Contifico');

  const categoria =
    (await prisma.categoria.findFirst({
      where: { nombre: { equals: categoryName, mode: 'insensitive' } },
    })) ??
    (await prisma.categoria.create({
      data: { nombre: categoryName },
    }));

  const subcategoria =
    (await prisma.subcategoria.findFirst({
      where: {
        idCategoria: categoria.id,
        nombre: { equals: subcategoryName, mode: 'insensitive' },
      },
    })) ??
    (await prisma.subcategoria.create({
      data: { idCategoria: categoria.id, nombre: subcategoryName },
    }));

  return subcategoria.id;
}

export interface ExternalImportResult {
  productsCreated: number;
  productsReused: number;
  variantsCreated: number;
  variantsSkipped: number;
  created: Array<{
    productId: number;
    productName: string;
    variantId: number;
    sku: string;
  }>;
  errors: string[];
}

export async function importExternalItems(
  items: ExternalItemInput[]
): Promise<ExternalImportResult> {
  const prisma = getPrisma();
  const estados = await resolveSyncEstados();
  const result: ExternalImportResult = {
    productsCreated: 0,
    productsReused: 0,
    variantsCreated: 0,
    variantsSkipped: 0,
    created: [],
    errors: [],
  };
  const seen = new Set<string>();

  for (const item of items) {
    const batchKey = `${item.source}:${normalize(item.externalId)}`;
    if (seen.has(batchKey)) {
      result.variantsSkipped += 1;
      continue;
    }
    seen.add(batchKey);

    try {
      const alreadyMapped = await findMappedVariant(item);
      if (alreadyMapped) {
        result.variantsSkipped += 1;
        continue;
      }

      const baseName = item.baseName?.trim() || inferBaseName(item.name);
      const inferredColor =
        item.color?.trim() || inferVariantColor(item.name, baseName);
      let product = await prisma.producto.findFirst({
        where: { producto: { equals: baseName, mode: 'insensitive' } },
        select: { idProducto: true, producto: true },
      });

      if (product) {
        result.productsReused += 1;
      } else {
        const idSubCategoria = await resolveTaxonomy(item);
        product = await prisma.producto.create({
          data: {
            idSubCategoria,
            producto: baseName,
            descripcion: item.name,
            estadoId: estados.inactiveId,
            isActive: false,
          },
          select: { idProducto: true, producto: true },
        });
        result.productsCreated += 1;
      }

      const baseSku =
        item.sku?.trim() ||
        item.contificoSku?.trim() ||
        `${item.source === 'meta' ? 'META' : 'CON'}-${item.externalId}`;
      const sku = await resolveUniqueSku(baseSku);
      const metaRetailerId =
        item.metaRetailerId ?? (item.source === 'meta' ? item.externalId : null);
      const contificoId =
        item.contificoId ?? (item.source === 'contifico' ? item.externalId : null);
      const contificoSku =
        item.contificoSku ??
        (item.source === 'contifico' ? item.sku ?? item.externalId : null);
      const variant = await prisma.productoVariante.create({
        data: {
          idProducto: product.idProducto,
          sku,
          color: inferredColor || item.name,
          descripcion: item.name,
          precioUsd: item.price ?? null,
          imagenUrl: item.imageUrl || null,
          urlProducto: item.url || null,
          estadoId: estados.inactiveId,
          // Regla de ingesta: nada entra aprobado; un humano lo revisa en el ERP.
          isActive: false,
          ...(metaRetailerId
            ? {
                metaRetailerId,
                metaMappingLocked: true,
              }
            : {}),
          ...(contificoId
            ? {
                contificoId,
                contificoSku: contificoSku || item.externalId,
              }
            : {}),
          especificacionesAdicionales: JSON.stringify({
            origen: item.source,
            external_id: item.externalId,
            ...(metaRetailerId ? { meta_retailer_id: metaRetailerId } : {}),
            ...(contificoId ? { contifico_id: contificoId } : {}),
            ...(item.barcode ? { codigo_barra: item.barcode } : {}),
            ...(item.stock !== undefined && item.stock !== null
              ? { stock: item.stock }
              : {}),
          }),
        },
        select: { idVariante: true, sku: true },
      });

      result.variantsCreated += 1;
      result.created.push({
        productId: product.idProducto,
        productName: product.producto,
        variantId: variant.idVariante,
        sku: variant.sku ?? sku,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido importando ítem externo';
      result.errors.push(`${item.source}:${item.externalId} (${item.name}): ${message}`);
    }
  }

  if (result.variantsCreated === 0 && result.errors.length > 0) {
    throw new HttpError(
      422,
      `No se pudo importar ningún ítem externo: ${result.errors[0]}`,
      'EXTERNAL_IMPORT_FAILED'
    );
  }

  return result;
}

export async function listMetaPending(query: ExternalMetaPendingQuery) {
  return listPendingMetaItems(query.limit, query.search);
}

export type ExternalSource = 'meta' | 'contifico';

export interface ExternalPendingItem {
  source: ExternalSource;
  sources: ExternalSource[];
  externalId: string;
  sku: string | null;
  metaRetailerId: string | null;
  contificoId: string | null;
  contificoSku: string | null;
  name: string;
  price: number | null;
  imageUrl: string | null;
  url: string | null;
  stock: number | null;
  category: string | null;
  barcode: string | null;
  availability: string | null;
}

export interface ExternalPendingResult {
  items: ExternalPendingItem[];
  counts: { meta: number; contifico: number; total: number };
  warnings: string[];
}

function parseMetaPrice(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function mergePendingItems(
  meta: ExternalPendingItem[],
  contifico: ExternalPendingItem[]
): ExternalPendingItem[] {
  const groups = new Map<string, ExternalPendingItem>();

  const add = (item: ExternalPendingItem) => {
    const groupKey = normalize(item.name);
    const existing = groups.get(groupKey);
    if (!existing) {
      groups.set(groupKey, { ...item, sources: [...item.sources] });
      return;
    }
    if (!existing.sources.includes(item.source)) {
      existing.sources.push(item.source);
    }
    if (item.source === 'meta') {
      existing.metaRetailerId = item.metaRetailerId ?? item.externalId;
    } else {
      existing.contificoId = item.contificoId ?? item.externalId;
      existing.contificoSku = item.contificoSku ?? item.sku;
    }
    existing.sku ??= item.sku;
    existing.price ??= item.price;
    existing.imageUrl ??= item.imageUrl;
    existing.url ??= item.url;
    existing.stock ??= item.stock;
    existing.category ??= item.category;
    existing.barcode ??= item.barcode;
    existing.availability ??= item.availability;
  };

  meta.forEach(add);
  contifico.forEach(add);
  return Array.from(groups.values());
}

async function loadPendingContificoItems(): Promise<ExternalPendingItem[]> {
  const prisma = getPrisma();
  const [products, categories, variants] = await Promise.all([
    fetchAllContificoProducts(),
    fetchContificoCategories(),
    prisma.productoVariante.findMany({
      select: {
        contificoId: true,
        contificoSku: true,
        sku: true,
        color: true,
        producto: { select: { producto: true } },
      },
    }),
  ]);

  const categoryNames = new Map(
    categories.map((category) => [category.id, category.nombre])
  );
  const mappedIds = new Set(
    variants
      .map((variant) => normalize(variant.contificoId))
      .filter((value): value is string => Boolean(value))
  );
  const mappedSkus = new Set(
    variants
      .map((variant) => normalize(variant.contificoSku ?? variant.sku))
      .filter((value): value is string => Boolean(value))
  );
  const existingNames = new Set<string>();
  for (const variant of variants) {
    const productName = variant.producto?.producto?.trim();
    if (!productName) {
      continue;
    }
    existingNames.add(normalize(productName));
    const color = variant.color?.trim();
    if (color && !/^est[aá]ndar$/i.test(color)) {
      existingNames.add(normalize(`${productName} ${color}`));
    }
  }

  return products
    .map((product) =>
      mapContificoProduct(
        product,
        product.categoria_id
          ? categoryNames.get(product.categoria_id) ?? null
          : null
      )
    )
    .filter((product) => product.isActive)
    .filter((product) => {
      const id = normalize(product.externalId);
      const sku = normalize(product.sku);
      return (
        !mappedIds.has(id) &&
        !mappedSkus.has(sku) &&
        !existingNames.has(normalize(product.name))
      );
    })
    .map((product) => ({
      source: 'contifico' as const,
      sources: ['contifico' as const],
      externalId: product.externalId,
      sku: product.sku,
      metaRetailerId: null,
      contificoId: product.externalId,
      contificoSku: product.sku,
      name: product.name,
      price: product.price,
      imageUrl: product.thumbnailUrl,
      url: product.sourceUrl,
      stock: product.stock,
      category: product.category,
      barcode: product.barcode,
      availability: 'in stock',
    }));
}

export async function listPendingExternalItems(
  query: ExternalPendingQuery
): Promise<ExternalPendingResult> {
  const warnings: string[] = [];

  const [meta, contifico] = await Promise.all([
    listPendingMetaItems(500).catch((error) => {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      warnings.push(`No se pudieron consultar los pendientes de Meta: ${message}`);
      logger.warn({ err: error }, 'No se pudieron cargar los pendientes de Meta');
      return { items: [], total: 0 };
    }),
    loadPendingContificoItems().catch((error) => {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      warnings.push(`No se pudieron consultar los pendientes de Contifico: ${message}`);
      logger.warn({ err: error }, 'No se pudieron cargar los pendientes de Contifico');
      return [] as ExternalPendingItem[];
    }),
  ]);

  const metaItems: ExternalPendingItem[] = meta.items.map((item) => ({
    source: 'meta',
    sources: ['meta'],
    externalId: item.retailerId,
    sku: null,
    metaRetailerId: item.retailerId,
    contificoId: null,
    contificoSku: null,
    name: item.name || item.retailerId,
    price: parseMetaPrice(item.price),
    imageUrl: item.imageUrl,
    url: item.url,
    stock: null,
    category: null,
    barcode: null,
    availability: item.availability,
  }));

  const merged = mergePendingItems(metaItems, contifico);
  const term = normalize(query.search);
  const filtered = merged
    .filter((item) => {
      if (query.source !== 'all' && !item.sources.includes(query.source)) {
        return false;
      }
      if (!term) {
        return true;
      }
      return [
        item.name,
        item.sku,
        item.externalId,
        item.metaRetailerId,
        item.contificoId,
        item.contificoSku,
        item.category,
      ].some((value) => normalize(value).includes(term));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, query.limit);

  return {
    items: filtered,
    counts: {
      meta: meta.total,
      contifico: contifico.length,
      total: merged.length,
    },
    warnings,
  };
}

export async function listExternalLinks() {
  const variants = await getPrisma().productoVariante.findMany({
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      metaRetailerId: true,
      contificoId: true,
      contificoSku: true,
      producto: { select: { producto: true } },
    },
    orderBy: { idVariante: 'asc' },
  });

  return { items: variants };
}

export type ExternalHealthStatus =
  | 'ok'
  | 'inactive'
  | 'missing'
  | 'mismatch'
  | 'unmapped'
  | 'unknown';

export interface ExternalHealthItem {
  variantId: number;
  productId: number;
  productName: string;
  variantName: string | null;
  sku: string | null;
  contifico: ExternalHealthStatus;
  meta: ExternalHealthStatus;
  contificoId: string | null;
  metaRetailerId: string | null;
}

export interface ExternalHealthResult {
  checkedAt: string;
  counts: {
    contificoMissing: number;
    contificoInactive: number;
    contificoMismatch: number;
    metaMissing: number;
    totalIssues: number;
    warnings: number;
  };
  items: ExternalHealthItem[];
  warnings: string[];
}

const HEALTH_CACHE_TTL_MS = 2 * 60 * 1000;
let healthCache: { expiresAt: number; data: ExternalHealthResult } | null = null;

function clearHealthCache(): void {
  healthCache = null;
}

/**
 * Verifica que las variantes mapeadas sigan existiendo en Meta/Contifico.
 * No escribe nada: devuelve incidencias y advertencias para que el ERP
 * muestre el warning y ofrezca reparación.
 */
export async function getExternalHealth(
  query: ExternalHealthQuery
): Promise<ExternalHealthResult> {
  if (!query.refresh && healthCache && healthCache.expiresAt > Date.now()) {
    return healthCache.data;
  }

  const prisma = getPrisma();
  const variants = await prisma.productoVariante.findMany({
    where: {
      isActive: true,
      OR: [{ contificoId: { not: null } }, { metaRetailerId: { not: null } }],
    },
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      contificoId: true,
      contificoSku: true,
      metaRetailerId: true,
      producto: { select: { producto: true } },
    },
    orderBy: { idVariante: 'asc' },
  });

  const warnings: string[] = [];
  let contificoProducts: ContificoProductDto[] | null = null;
  let metaCatalog: MetaCatalogItem[] | null = null;

  try {
    contificoProducts = await fetchAllContificoProducts();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    warnings.push(`No se pudo validar Contifico: ${message}`);
    logger.warn({ err: error }, 'Health de mapeos: falló la lectura de Contifico');
  }

  try {
    metaCatalog = await getMetaCatalog();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    warnings.push(`No se pudo validar Meta: ${message}`);
    logger.warn({ err: error }, 'Health de mapeos: falló la lectura de Meta');
  }

  const contificoById = new Map<string, ContificoProductDto>();
  const contificoByCode = new Map<string, ContificoProductDto>();
  for (const product of contificoProducts ?? []) {
    contificoById.set(normalize(product.id), product);
    contificoByCode.set(normalize(resolveContificoSku(product)), product);
  }

  const metaRetailerIds = new Set(
    (metaCatalog ?? []).map((item) => normalize(item.retailerId))
  );

  const items: ExternalHealthItem[] = [];

  for (const variant of variants) {
    let contifico: ExternalHealthStatus = 'unmapped';
    if (variant.contificoId) {
      if (!contificoProducts) {
        contifico = 'unknown';
      } else {
        const byId = contificoById.get(normalize(variant.contificoId));
        if (byId) {
          contifico = normalize(byId.estado) === 'i' ? 'inactive' : 'ok';
        } else {
          const byCode = contificoByCode.get(
            normalize(variant.contificoSku ?? variant.sku)
          );
          contifico = byCode ? 'mismatch' : 'missing';
        }
      }
    }

    let meta: ExternalHealthStatus = 'unmapped';
    if (variant.metaRetailerId) {
      if (!metaCatalog) {
        meta = 'unknown';
      } else {
        meta = metaRetailerIds.has(normalize(variant.metaRetailerId))
          ? 'ok'
          : 'missing';
      }
    }

    const hasIssue =
      contifico === 'missing' ||
      contifico === 'inactive' ||
      contifico === 'mismatch' ||
      meta === 'missing';

    if (!hasIssue) {
      continue;
    }

    items.push({
      variantId: variant.idVariante,
      productId: variant.idProducto,
      productName: variant.producto.producto,
      variantName: variant.color,
      sku: variant.sku,
      contifico,
      meta,
      contificoId: variant.contificoId,
      metaRetailerId: variant.metaRetailerId,
    });
  }

  const data: ExternalHealthResult = {
    checkedAt: new Date().toISOString(),
    counts: {
      contificoMissing: items.filter((item) => item.contifico === 'missing').length,
      contificoInactive: items.filter((item) => item.contifico === 'inactive').length,
      contificoMismatch: items.filter((item) => item.contifico === 'mismatch').length,
      metaMissing: items.filter((item) => item.meta === 'missing').length,
      totalIssues: items.length,
      warnings: warnings.length,
    },
    items,
    warnings,
  };

  healthCache = { expiresAt: Date.now() + HEALTH_CACHE_TTL_MS, data };
  return data;
}

/**
 * Repara una incidencia de mapeo desde la bandeja de salud.
 * - Meta: republish | unmap
 * - Contifico: recreate | reactivate | unmap
 */
export async function repairExternalMapping(
  input: ExternalRepairBody
): Promise<Record<string, unknown>> {
  const prisma = getPrisma();
  const variant = await prisma.productoVariante.findUnique({
    where: { idVariante: input.variantId },
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      descripcion: true,
      precioUsd: true,
      imagenUrl: true,
      urlProducto: true,
      isActive: true,
      contificoId: true,
      contificoSku: true,
      metaRetailerId: true,
      producto: {
        select: {
          producto: true,
          subcategoria: {
            select: { categoria: { select: { nombre: true } } },
          },
        },
      },
    },
  });
  if (!variant) {
    throw new HttpError(404, 'Variante no encontrada.', 'ALTOSA_VARIANT_NOT_FOUND');
  }

  if (input.source === 'meta') {
    if (input.action === 'unmap') {
      await prisma.productoVariante.update({
        where: { idVariante: variant.idVariante },
        data: { metaRetailerId: null, metaMappingLocked: false },
      });
      clearHealthCache();
      return { variantId: variant.idVariante, source: 'meta', action: 'unmap' };
    }
    if (input.action !== 'republish') {
      throw new HttpError(
        422,
        'La acción indicada no aplica a Meta.',
        'EXTERNAL_REPAIR_ACTION_INVALID'
      );
    }
    const result = await republishVariantInMeta(variant.idVariante);
    clearHealthCache();
    return {
      variantId: variant.idVariante,
      source: 'meta',
      action: 'republish',
      ...result,
    };
  }

  if (input.action === 'unmap') {
    await prisma.productoVariante.update({
      where: { idVariante: variant.idVariante },
      data: { contificoId: null, contificoSku: null },
    });
    clearHealthCache();
    return {
      variantId: variant.idVariante,
      source: 'contifico',
      action: 'unmap',
    };
  }

  if (input.action === 'reactivate') {
    if (!variant.contificoId) {
      throw new HttpError(
        422,
        'La variante no tiene un producto de Contifico mapeado.',
        'CONTIFICO_NOT_MAPPED'
      );
    }
    await updateContificoProduct(variant.contificoId, { estado: 'A' });
    clearHealthCache();
    return {
      variantId: variant.idVariante,
      source: 'contifico',
      action: 'reactivate',
      contificoId: variant.contificoId,
    };
  }

  if (input.action !== 'recreate') {
    throw new HttpError(
      422,
      'La acción indicada no aplica a Contifico.',
      'EXTERNAL_REPAIR_ACTION_INVALID'
    );
  }

  if (!variant.isActive) {
    throw new HttpError(
      422,
      'La variante debe estar activa para recrearse en Contifico.',
      'CONTIFICO_VARIANT_INACTIVE'
    );
  }
  const sku = variant.sku?.trim();
  if (!sku) {
    throw new HttpError(
      422,
      'La variante necesita SKU para recrearse en Contifico.',
      'CONTIFICO_SKU_REQUIRED'
    );
  }

  const matches = await searchContificoProducts(sku, 10);
  const existing = matches.find(
    (product) => normalize(resolveContificoSku(product)) === normalize(sku)
  );

  let contificoId: string;
  let contificoSku: string;
  let created = false;

  if (existing) {
    contificoId = existing.id;
    contificoSku = resolveContificoSku(existing);
  } else {
    const product = await createContificoProduct({
      codigo: sku,
      nombre: buildFlatName(variant.producto.producto, variant.color),
      descripcion: variant.descripcion ?? undefined,
      categoriaNombre:
        variant.producto.subcategoria?.categoria?.nombre ?? 'General',
      pvp1: variant.precioUsd === null ? 0 : Number(variant.precioUsd),
      pvpManual:
        variant.precioUsd === null || Number(variant.precioUsd) <= 0,
      estado: 'A',
    });
    contificoId = product.id;
    contificoSku = resolveContificoSku(product);
    created = true;
  }

  await prisma.productoVariante.update({
    where: { idVariante: variant.idVariante },
    data: { contificoId, contificoSku },
  });
  clearHealthCache();

  return {
    variantId: variant.idVariante,
    source: 'contifico',
    action: 'recreate',
    contificoId,
    contificoSku,
    created,
  };
}
