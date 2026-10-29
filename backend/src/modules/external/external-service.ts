import type { Prisma } from '@prisma/client';
import { getPrisma } from '../../config/prisma';
import { HttpError } from '../../utils/api-response';
import { resolveSyncEstados } from '../catalog/catalog-service';
import { listPendingMetaItems } from '../meta/meta-service';
import type { ExternalItemInput, ExternalMetaPendingQuery } from './external-schema';

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function inferBaseName(item: ExternalItemInput): string {
  const explicit = item.baseName?.trim();
  if (explicit) {
    return explicit;
  }
  const tokens = item.name.trim().split(/\s+/);
  return tokens.length >= 3 ? tokens.slice(0, -1).join(' ') : item.name.trim();
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

      const baseName = inferBaseName(item);
      const inferredColor =
        item.color?.trim() ||
        (item.name.toLowerCase().startsWith(baseName.toLowerCase())
          ? item.name.slice(baseName.length).trim()
          : item.name);
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
