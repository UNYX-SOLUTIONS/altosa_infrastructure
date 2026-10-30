import type { Prisma } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { getPrisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/api-response';
import { buildFlatName } from '../../utils/product-naming';
import { findMetaCatalogItem } from '../meta/meta-client';
import {
  deleteProductMetaItems,
  deleteVariantFromMeta,
  publishVariantById,
  publishVariantToMeta,
  updateVariantInMeta,
} from '../meta/meta-service';
import { resolveSyncEstados } from './catalog-estados';
import {
  createContificoProductForVariant,
  updateContificoProductForVariant,
} from '../contifico/contifico-service';
import type {
  CreateProductBody,
  DocumentsQuery,
  ProductsQuery,
  SimpleListQuery,
  SyncProductBody,
  UpdateProductBody,
  UpdateVariantBody,
  VariantBody,
  WarrantyCreateBody,
  WarrantyListQuery,
  WarrantyUpdateBody,
} from './catalog-schema';

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

function mapEstado(estado: { id: number; estado: string; permiteRag: boolean }) {
  return {
    id: estado.id,
    estado: estado.estado,
    permiteRag: estado.permiteRag,
  };
}

function mapKommoTemplate(template: {
  id: string;
  kommoId: number;
  name: string;
  type: string;
  content: string | null;
  isActive: boolean;
} | null) {
  if (!template) {
    return null;
  }
  return {
    id: template.id,
    kommoId: template.kommoId,
    name: template.name,
    type: template.type,
    content: template.content,
    isActive: template.isActive,
  };
}

async function ensureKommoTemplateExists(id: string) {
  const prisma = getPrisma();
  const template = await prisma.kommoTemplate.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!template) {
    throw new HttpError(
      StatusCodes.UNPROCESSABLE_ENTITY,
      'Plantilla de Kommo no encontrada.',
      'KOMMO_TEMPLATE_NOT_FOUND'
    );
  }
}

function mapGarantia(garantia: {
  idGarantia: number;
  garantiaMeses: number | null;
  garantiaEspecial: string | null;
  observaciones: string | null;
} | null) {
  if (!garantia) {
    return null;
  }
  return {
    id: garantia.idGarantia,
    meses: garantia.garantiaMeses,
    especial: garantia.garantiaEspecial,
    observaciones: garantia.observaciones,
  };
}

function mapCatalogo(catalogo: {
  id: number;
  keyword: string | null;
  archivo: string | null;
  driveUrl: string | null;
  paginas: number | null;
} | null) {
  if (!catalogo) {
    return null;
  }
  return {
    id: catalogo.id,
    keyword: catalogo.keyword,
    archivo: catalogo.archivo,
    driveUrl: catalogo.driveUrl,
    paginas: catalogo.paginas,
  };
}

type VarianteConRelaciones = Prisma.ProductoVarianteGetPayload<{
  include: { garantia: true; catalogo: true; estado: true; kommoTemplate: true };
}>;

function mapVariante(variante: VarianteConRelaciones) {
  return {
    id: variante.idVariante,
    sku: variante.sku,
    metaRetailerId: variante.metaRetailerId,
    metaMappingLocked: variante.metaMappingLocked,
    contificoId: variante.contificoId,
    contificoSku: variante.contificoSku,
    color: variante.color,
    descripcion: variante.descripcion,
    precioUsd: toNumber(variante.precioUsd),
    imagenUrl: variante.imagenUrl,
    urlProducto: variante.urlProducto,
    material: variante.material,
    tapizado: variante.tapizado,
    estructura: variante.estructura,
    usoRecomendado: variante.usoRecomendado,
    especificacionesAdicionales: variante.especificacionesAdicionales,
    apilable: variante.apilable,
    proteccionUv: variante.proteccionUv,
    resistenciaIntemperie: variante.resistenciaIntemperie,
    soporteLumbar: variante.soporteLumbar,
    brazos: variante.brazos,
    cabecera: variante.cabecera,
    mecanismo: variante.mecanismo,
    medidas: {
      anchoTotalCm: toNumber(variante.anchoTotalCm),
      profundidadAsientoCm: toNumber(variante.profundidadAsientoCm),
      alturaTotalCm: variante.alturaTotalCm,
      alturaAsientoCm: variante.alturaAsientoCm,
      anchoAsientoCm: toNumber(variante.anchoAsientoCm),
      pesoKg: toNumber(variante.pesoKg),
    },
    garantia: mapGarantia(variante.garantia),
    catalogo: mapCatalogo(variante.catalogo),
    estado: mapEstado(variante.estado),
    kommoTemplateId: variante.kommoTemplateId,
    kommoTemplate: mapKommoTemplate(variante.kommoTemplate),
    isActive: variante.isActive,
    updatedAt: variante.updatedAt,
  };
}

const VARIANT_RELATIONS = {
  garantia: true,
  catalogo: true,
  estado: true,
  kommoTemplate: true,
} as const;

export async function listProducts(query: ProductsQuery) {
  const prisma = getPrisma();

  const where: Prisma.ProductoWhereInput = {
    isActive: query.active,
    ...(query.subcategoryId ? { idSubCategoria: query.subcategoryId } : {}),
    ...(query.categoryId ? { subcategoria: { idCategoria: query.categoryId } } : {}),
    ...(query.search
      ? {
          OR: [
            { producto: { contains: query.search, mode: 'insensitive' } },
            { descripcion: { contains: query.search, mode: 'insensitive' } },
            { usoRecomendado: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.producto.count({ where }),
    prisma.producto.findMany({
      where,
      include: {
        estado: true,
        subcategoria: { include: { categoria: true } },
        variants: {
          where: { isActive: true },
          include: VARIANT_RELATIONS,
          orderBy: { idVariante: 'asc' },
        },
      },
      orderBy: { producto: 'asc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  const items = rows.map((producto) => {
    const precios = producto.variants
      .map((variante) => toNumber(variante.precioUsd))
      .filter((precio): precio is number => precio !== null);

    return {
      id: producto.idProducto,
      nombre: producto.producto,
      descripcion: producto.descripcion,
      usoRecomendado: producto.usoRecomendado,
      categoria: {
        id: producto.subcategoria.categoria.id,
        nombre: producto.subcategoria.categoria.nombre,
      },
      subcategoria: {
        id: producto.subcategoria.id,
        nombre: producto.subcategoria.nombre,
      },
      estado: mapEstado(producto.estado),
      isActive: producto.isActive,
      kommoTemplateId: producto.kommoTemplateId,
      updatedAt: producto.updatedAt,
      variantesCount: producto.variants.length,
      precioMin: precios.length > 0 ? Math.min(...precios) : null,
      precioMax: precios.length > 0 ? Math.max(...precios) : null,
      ...(query.withVariants ? { variantes: producto.variants.map(mapVariante) } : {}),
    };
  });

  return { items, total };
}

export async function getProductById(id: number) {
  const prisma = getPrisma();

  const producto = await prisma.producto.findUnique({
    where: { idProducto: id },
    include: {
      estado: true,
      subcategoria: { include: { categoria: true } },
      kommoTemplate: true,
      variants: {
        include: VARIANT_RELATIONS,
        orderBy: { idVariante: 'asc' },
      },
    },
  });

  if (!producto) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Producto no encontrado.', 'ALTOSA_PRODUCT_NOT_FOUND');
  }

  return {
    id: producto.idProducto,
    nombre: producto.producto,
    descripcion: producto.descripcion,
    usoRecomendado: producto.usoRecomendado,
    categoria: {
      id: producto.subcategoria.categoria.id,
      nombre: producto.subcategoria.categoria.nombre,
    },
    subcategoria: {
      id: producto.subcategoria.id,
      nombre: producto.subcategoria.nombre,
    },
    estado: mapEstado(producto.estado),
    isActive: producto.isActive,
    kommoTemplateId: producto.kommoTemplateId,
    kommoTemplate: mapKommoTemplate(producto.kommoTemplate),
    updatedAt: producto.updatedAt,
    variantes: producto.variants.map(mapVariante),
  };
}

export async function getProductByVariantSku(sku: string) {
  const prisma = getPrisma();

  const variante = await prisma.productoVariante.findFirst({
    where: { sku },
    include: {
      ...VARIANT_RELATIONS,
      producto: {
        include: {
          estado: true,
          subcategoria: { include: { categoria: true } },
          kommoTemplate: true,
        },
      },
    },
  });

  if (!variante) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      `Variante con SKU ${sku} no encontrada.`,
      'ALTOSA_VARIANT_NOT_FOUND'
    );
  }

  return {
    producto: {
      id: variante.producto.idProducto,
      nombre: variante.producto.producto,
      descripcion: variante.producto.descripcion,
      usoRecomendado: variante.producto.usoRecomendado,
      categoria: {
        id: variante.producto.subcategoria.categoria.id,
        nombre: variante.producto.subcategoria.categoria.nombre,
      },
      subcategoria: {
        id: variante.producto.subcategoria.id,
        nombre: variante.producto.subcategoria.nombre,
      },
      estado: mapEstado(variante.producto.estado),
      isActive: variante.producto.isActive,
      kommoTemplateId: variante.producto.kommoTemplateId,
      kommoTemplate: mapKommoTemplate(variante.producto.kommoTemplate),
    },
    variante: mapVariante(variante),
  };
}

export async function listCategories() {
  const prisma = getPrisma();

  const categorias = await prisma.categoria.findMany({
    include: {
      subcategorias: { orderBy: { nombre: 'asc' } },
    },
    orderBy: { nombre: 'asc' },
  });

  return categorias.map((categoria) => ({
    id: categoria.id,
    nombre: categoria.nombre,
    subcategorias: categoria.subcategorias.map((subcategoria) => ({
      id: subcategoria.id,
      nombre: subcategoria.nombre,
    })),
  }));
}

export async function listCatalogs(query: SimpleListQuery) {
  const prisma = getPrisma();

  const catalogos = await prisma.catalogo.findMany({
    where: { isActive: query.active },
    include: { estado: true },
    orderBy: { id: 'asc' },
  });

  return catalogos.map((catalogo) => ({
    id: catalogo.id,
    keyword: catalogo.keyword,
    archivo: catalogo.archivo,
    vigenciaDocumento: catalogo.vigenciaDocumento,
    paginas: catalogo.paginas,
    driveUrl: catalogo.driveUrl,
    aprobado: catalogo.aprobado,
    observaciones: catalogo.observaciones,
    estado: mapEstado(catalogo.estado),
    isActive: catalogo.isActive,
  }));
}

export async function listLocations(query: SimpleListQuery) {
  const prisma = getPrisma();

  const ubicaciones = await prisma.ubicacion.findMany({
    where: { isActive: query.active },
    include: { estado: true },
    orderBy: { ciudad: 'asc' },
  });

  return ubicaciones.map((ubicacion) => ({
    id: ubicacion.idUbicacion,
    ciudad: ubicacion.ciudad,
    direccion: ubicacion.direccion,
    mapsUrl: ubicacion.mapsUrl,
    aprobado: ubicacion.aprobado,
    fuente: ubicacion.fuente,
    horario: ubicacion.horario,
    contacto: ubicacion.contacto,
    estado: mapEstado(ubicacion.estado),
    isActive: ubicacion.isActive,
  }));
}

type WarrantyWithEstado = Prisma.GarantiaGetPayload<{ include: { estado: true } }>;

function mapWarranty(garantia: WarrantyWithEstado) {
  return {
    id: garantia.idGarantia,
    meses: garantia.garantiaMeses,
    especial: garantia.garantiaEspecial,
    observaciones: garantia.observaciones,
    fuenteUrl: garantia.fuenteUrl,
    estado: mapEstado(garantia.estado),
    isActive: garantia.isActive,
    createdAt: garantia.createdAt,
    updatedAt: garantia.updatedAt,
  };
}

export async function listWarranties(query: WarrantyListQuery) {
  const prisma = getPrisma();

  const garantias = await prisma.garantia.findMany({
    where: query.active === undefined ? {} : { isActive: query.active },
    include: { estado: true },
    orderBy: { idGarantia: 'asc' },
  });

  return garantias.map(mapWarranty);
}

export async function createWarranty(input: WarrantyCreateBody) {
  const prisma = getPrisma();
  const estados = await resolveSyncEstados();
  const isActive = input.isActive ?? true;

  const garantia = await prisma.garantia.create({
    data: {
      garantiaMeses: input.meses ?? null,
      garantiaEspecial: input.especial?.trim() || null,
      observaciones: input.observaciones?.trim() || null,
      fuenteUrl: input.fuenteUrl?.trim() || null,
      estadoId: isActive ? estados.activeId : estados.inactiveId,
      isActive,
      updatedAt: new Date(),
    },
    include: { estado: true },
  });

  return mapWarranty(garantia);
}

export async function updateWarranty(id: number, input: WarrantyUpdateBody) {
  const prisma = getPrisma();
  const existing = await prisma.garantia.findUnique({
    where: { idGarantia: id },
    select: { idGarantia: true },
  });
  if (!existing) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      'Garantía no encontrada.',
      'ALTOSA_WARRANTY_NOT_FOUND'
    );
  }

  const estados =
    input.isActive !== undefined ? await resolveSyncEstados() : null;
  const data: Prisma.GarantiaUncheckedUpdateInput = { updatedAt: new Date() };

  if (input.meses !== undefined) {
    data.garantiaMeses = input.meses;
  }
  if (input.especial !== undefined) {
    data.garantiaEspecial = input.especial?.trim() || null;
  }
  if (input.observaciones !== undefined) {
    data.observaciones = input.observaciones?.trim() || null;
  }
  if (input.fuenteUrl !== undefined) {
    data.fuenteUrl = input.fuenteUrl?.trim() || null;
  }
  if (input.isActive !== undefined && estados) {
    data.isActive = input.isActive;
    data.estadoId = input.isActive ? estados.activeId : estados.inactiveId;
  }

  const garantia = await prisma.garantia.update({
    where: { idGarantia: id },
    data,
    include: { estado: true },
  });

  return mapWarranty(garantia);
}

export async function deleteWarranty(id: number) {
  const prisma = getPrisma();
  const existing = await prisma.garantia.findUnique({
    where: { idGarantia: id },
    select: { idGarantia: true },
  });
  if (!existing) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      'Garantía no encontrada.',
      'ALTOSA_WARRANTY_NOT_FOUND'
    );
  }

  const usedBy = await prisma.productoVariante.count({
    where: { idGarantia: id },
  });
  if (usedBy > 0) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      `La garantía está asignada a ${usedBy} variante(s). Desactívala en su lugar o reasigna esas variantes.`,
      'ALTOSA_WARRANTY_IN_USE'
    );
  }

  await prisma.garantia.delete({ where: { idGarantia: id } });
  return { id, deleted: true };
}

const DOCUMENT_BASE_SELECT = {
  id: true,
  externalId: true,
  title: true,
  source: true,
  sourceVersion: true,
  chunkIndex: true,
  embeddingModel: true,
  isActive: true,
  updatedAt: true,
} as const;

function mapDocumentoBase(documento: {
  id: bigint;
  externalId: string | null;
  title: string | null;
  source: string | null;
  sourceVersion: string | null;
  chunkIndex: number;
  embeddingModel: string | null;
  isActive: boolean;
  updatedAt: Date;
}) {
  return {
    id: Number(documento.id),
    externalId: documento.externalId,
    title: documento.title,
    source: documento.source,
    sourceVersion: documento.sourceVersion,
    chunkIndex: documento.chunkIndex,
    embeddingModel: documento.embeddingModel,
    isActive: documento.isActive,
    updatedAt: documento.updatedAt,
  };
}

export async function listDocuments(query: DocumentsQuery) {
  const prisma = getPrisma();

  const where: Prisma.DocumentoWhereInput = {
    isActive: query.active,
    ...(query.source ? { source: query.source } : {}),
    ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
  };

  const skip = (query.page - 1) * query.pageSize;
  const take = query.pageSize;

  if (query.includeContent) {
    const [total, documentos] = await prisma.$transaction([
      prisma.documento.count({ where }),
      prisma.documento.findMany({
        where,
        select: { ...DOCUMENT_BASE_SELECT, content: true },
        orderBy: { id: 'asc' },
        skip,
        take,
      }),
    ]);

    return {
      items: documentos.map((documento) => ({
        ...mapDocumentoBase(documento),
        content: documento.content,
      })),
      total,
    };
  }

  const [total, documentos] = await prisma.$transaction([
    prisma.documento.count({ where }),
    prisma.documento.findMany({
      where,
      select: DOCUMENT_BASE_SELECT,
      orderBy: { id: 'asc' },
      skip,
      take,
    }),
  ]);

  return { items: documentos.map(mapDocumentoBase), total };
}

// ---------------------------------------------------------------------------
// Escritura (CRUD). El estado 1 = "activo" es el default del pipeline.
// ---------------------------------------------------------------------------

async function ensureSubcategoriaExists(id: number): Promise<void> {
  const found = await getPrisma().subcategoria.findUnique({ where: { id } });
  if (!found) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Subcategoría no encontrada.', 'ALTOSA_SUBCATEGORY_NOT_FOUND');
  }
}

async function ensureEstadoExists(id: number): Promise<void> {
  const found = await getPrisma().estado.findUnique({ where: { id } });
  if (!found) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Estado no encontrado.', 'ALTOSA_ESTADO_NOT_FOUND');
  }
}

async function ensureGarantiaExists(id: number): Promise<void> {
  const found = await getPrisma().garantia.findUnique({ where: { idGarantia: id } });
  if (!found) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Garantía no encontrada.', 'ALTOSA_WARRANTY_NOT_FOUND');
  }
}

async function ensureCatalogoExists(id: number): Promise<void> {
  const found = await getPrisma().catalogo.findUnique({ where: { id } });
  if (!found) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Catálogo no encontrado.', 'ALTOSA_CATALOG_NOT_FOUND');
  }
}

async function ensureSkuAvailable(sku: string | undefined, excludeVariantId?: number): Promise<void> {
  const normalized = sku?.trim();
  if (!normalized) {
    return;
  }
  const existing = await getPrisma().productoVariante.findFirst({
    where: {
      sku: normalized,
      ...(excludeVariantId ? { NOT: { idVariante: excludeVariantId } } : {}),
    },
    select: { idVariante: true },
  });
  if (existing) {
    throw new HttpError(StatusCodes.CONFLICT, `El SKU "${normalized}" ya está en uso.`, 'ALTOSA_SKU_TAKEN');
  }
}

function normalizeMetaRetailerId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeContificoId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function ensureMetaRetailerIdAvailable(
  metaRetailerId: string | null | undefined,
  excludeVariantId?: number
): Promise<void> {
  const normalized = normalizeMetaRetailerId(metaRetailerId);
  if (!normalized) {
    return;
  }
  const existing = await getPrisma().productoVariante.findFirst({
    where: {
      metaRetailerId: { equals: normalized, mode: 'insensitive' },
      ...(excludeVariantId ? { NOT: { idVariante: excludeVariantId } } : {}),
    },
    select: { idVariante: true },
  });
  if (existing) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      `El Retailer ID "${normalized}" ya está asignado a otra variante.`,
      'META_RETAILER_ID_DUPLICATED'
    );
  }
}

async function ensureMetaRetailerIdExists(
  metaRetailerId: string | null | undefined
): Promise<void> {  const normalized = normalizeMetaRetailerId(metaRetailerId);
  if (!normalized) {
    return;
  }
  const item = await findMetaCatalogItem(normalized);
  if (!item) {
    throw new HttpError(
      StatusCodes.NOT_FOUND,
      `El Retailer ID "${normalized}" no existe en el catálogo de Meta.`,
      'META_ITEM_NOT_FOUND'
    );
  }
}

async function ensureContificoIdAvailable(
  contificoId: string | null | undefined,
  excludeVariantId?: number
): Promise<void> {
  const normalized = normalizeContificoId(contificoId);
  if (!normalized) {
    return;
  }
  const existing = await getPrisma().productoVariante.findFirst({
    where: {
      contificoId: { equals: normalized, mode: 'insensitive' },
      ...(excludeVariantId ? { NOT: { idVariante: excludeVariantId } } : {}),
    },
    select: { idVariante: true },
  });
  if (existing) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      `El producto de Contifico "${normalized}" ya está asignado a otra variante.`,
      'CONTIFICO_ID_DUPLICATED'
    );
  }
}

function ensureUniqueMetaRetailerIdsInBatch(variants: VariantBody[]): void {
  const seen = new Set<string>();
  for (const variant of variants) {
    const normalized = normalizeMetaRetailerId(variant.metaRetailerId);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      throw new HttpError(
        StatusCodes.CONFLICT,
        `El Retailer ID "${normalized}" está repetido en el mismo producto.`,
        'META_RETAILER_ID_DUPLICATED'
      );
    }
    seen.add(key);
  }
}

async function validateVariantReferences(input: VariantBody | UpdateVariantBody): Promise<void> {
  if (input.estadoId !== undefined) {
    await ensureEstadoExists(input.estadoId);
  }
  if (input.garantiaId !== undefined && input.garantiaId !== null) {
    await ensureGarantiaExists(input.garantiaId);
  }
  if (input.catalogoId !== undefined) {
    await ensureCatalogoExists(input.catalogoId);
  }
  if (input.kommoTemplateId) {
    await ensureKommoTemplateExists(input.kommoTemplateId);
  }
}

function variantCreateData(input: VariantBody) {
  return {
    sku: input.sku?.trim() || null,
    color: input.color || null,
    descripcion: input.descripcion || null,
    precioUsd: input.precioUsd ?? null,
    material: input.material || null,
    tapizado: input.tapizado || null,
    estructura: input.estructura || null,
    mecanismo: input.mecanismo || null,
    proteccionUv: input.proteccionUv || null,
    resistenciaIntemperie: input.resistenciaIntemperie || null,
    apilable: input.apilable || null,
    brazos: input.brazos || null,
    soporteLumbar: input.soporteLumbar || null,
    cabecera: input.cabecera || null,
    usoRecomendado: input.usoRecomendado || null,
    especificacionesAdicionales: input.especificacionesAdicionales || null,
    imagenUrl: input.imagenUrl || null,
    urlProducto: input.urlProducto || null,
    anchoTotalCm: input.anchoTotalCm ?? null,
    profundidadAsientoCm: input.profundidadAsientoCm ?? null,
    alturaTotalCm: input.alturaTotalCm || null,
    alturaAsientoCm: input.alturaAsientoCm || null,
    anchoAsientoCm: input.anchoAsientoCm ?? null,
    pesoKg: input.pesoKg ?? null,
    idGarantia: input.garantiaId ?? null,
    idCatalogo: input.catalogoId ?? null,
    kommoTemplateId: input.kommoTemplateId || null,
    metaRetailerId: normalizeMetaRetailerId(input.metaRetailerId),
    metaMappingLocked:
      normalizeMetaRetailerId(input.metaRetailerId) !== null
        ? input.metaMappingLocked ?? true
        : input.metaMappingLocked ?? false,
    contificoId: normalizeContificoId(input.contificoId),
    contificoSku: input.contificoSku?.trim() || null,
  };
}

function variantUpdateData(input: UpdateVariantBody): Prisma.ProductoVarianteUncheckedUpdateInput {
  const data: Prisma.ProductoVarianteUncheckedUpdateInput = {};

  if (input.sku !== undefined) data.sku = input.sku.trim() || null;
  if (input.color !== undefined) data.color = input.color || null;
  if (input.descripcion !== undefined) data.descripcion = input.descripcion || null;
  if (input.precioUsd !== undefined) data.precioUsd = input.precioUsd;
  if (input.material !== undefined) data.material = input.material || null;
  if (input.tapizado !== undefined) data.tapizado = input.tapizado || null;
  if (input.estructura !== undefined) data.estructura = input.estructura || null;
  if (input.mecanismo !== undefined) data.mecanismo = input.mecanismo || null;
  if (input.proteccionUv !== undefined) data.proteccionUv = input.proteccionUv || null;
  if (input.resistenciaIntemperie !== undefined) data.resistenciaIntemperie = input.resistenciaIntemperie || null;
  if (input.apilable !== undefined) data.apilable = input.apilable || null;
  if (input.brazos !== undefined) data.brazos = input.brazos || null;
  if (input.soporteLumbar !== undefined) data.soporteLumbar = input.soporteLumbar || null;
  if (input.cabecera !== undefined) data.cabecera = input.cabecera || null;
  if (input.usoRecomendado !== undefined) data.usoRecomendado = input.usoRecomendado || null;
  if (input.especificacionesAdicionales !== undefined) data.especificacionesAdicionales = input.especificacionesAdicionales || null;
  if (input.imagenUrl !== undefined) data.imagenUrl = input.imagenUrl || null;
  if (input.urlProducto !== undefined) data.urlProducto = input.urlProducto || null;
  if (input.anchoTotalCm !== undefined) data.anchoTotalCm = input.anchoTotalCm;
  if (input.profundidadAsientoCm !== undefined) data.profundidadAsientoCm = input.profundidadAsientoCm;
  if (input.alturaTotalCm !== undefined) data.alturaTotalCm = input.alturaTotalCm || null;
  if (input.alturaAsientoCm !== undefined) data.alturaAsientoCm = input.alturaAsientoCm || null;
  if (input.anchoAsientoCm !== undefined) data.anchoAsientoCm = input.anchoAsientoCm;
  if (input.pesoKg !== undefined) data.pesoKg = input.pesoKg;
  if (input.garantiaId !== undefined) data.idGarantia = input.garantiaId;
  if (input.catalogoId !== undefined) data.idCatalogo = input.catalogoId;
  if (input.estadoId !== undefined) data.estadoId = input.estadoId;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.kommoTemplateId !== undefined) {
    data.kommoTemplateId = input.kommoTemplateId || null;
  }
  if (input.metaRetailerId !== undefined) {
    data.metaRetailerId = normalizeMetaRetailerId(input.metaRetailerId);
    data.metaMappingLocked = input.metaMappingLocked === false ? false : true;
  } else if (input.metaMappingLocked !== undefined) {
    data.metaMappingLocked = input.metaMappingLocked;
  }
  if (input.contificoId !== undefined) {
    data.contificoId = normalizeContificoId(input.contificoId);
  }
  if (input.contificoSku !== undefined) {
    data.contificoSku = input.contificoSku?.trim() || null;
  }

  return data;
}

export async function createProduct(input: CreateProductBody) {
  const prisma = getPrisma();

  await ensureSubcategoriaExists(input.subcategoryId);
  await ensureEstadoExists(input.estadoId);
  if (input.kommoTemplateId) {
    await ensureKommoTemplateExists(input.kommoTemplateId);
  }

  ensureUniqueMetaRetailerIdsInBatch(input.variantes);

  for (const variante of input.variantes) {
    await ensureSkuAvailable(variante.sku);
    await ensureMetaRetailerIdExists(variante.metaRetailerId);
    await ensureMetaRetailerIdAvailable(variante.metaRetailerId);
    await ensureContificoIdAvailable(variante.contificoId);
    await validateVariantReferences(variante);
  }

  const now = new Date();
  const created = await prisma.producto.create({
    data: {
      idSubCategoria: input.subcategoryId,
      producto: input.nombre,
      descripcion: input.descripcion || null,
      usoRecomendado: input.usoRecomendado || null,
      estadoId: input.estadoId,
      isActive: true,
      kommoTemplateId: input.kommoTemplateId || null,
      createdAt: now,
      updatedAt: now,
      variants: {
        create: input.variantes.map((variante) => ({
          ...variantCreateData(variante),
          estadoId: variante.estadoId ?? input.estadoId,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })),
      },
    },
  });

  if (input.writeThroughContifico) {
    const taxonomy = await prisma.subcategoria.findUnique({
      where: { id: input.subcategoryId },
      select: { categoria: { select: { nombre: true } } },
    });
    const categoryName = taxonomy?.categoria?.nombre ?? null;
    const variants = await prisma.productoVariante.findMany({
      where: { idProducto: created.idProducto },
      select: {
        idVariante: true,
        sku: true,
        color: true,
        descripcion: true,
        precioUsd: true,
        isActive: true,
        contificoId: true,
      },
    });
    for (const variant of variants) {
      if (!variant.isActive || variant.contificoId) {
        continue;
      }
      try {
        const mapping = await createContificoProductForVariant({
          productName: input.nombre,
          sku: variant.sku,
          color: variant.color,
          description: variant.descripcion,
          price: variant.precioUsd === null ? null : Number(variant.precioUsd),
          isActive: variant.isActive,
          categoryName,
        });
        if (mapping) {
          await prisma.productoVariante.update({
            where: { idVariante: variant.idVariante },
            data: mapping,
          });
        }
      } catch (error) {
        logger.warn(
          { err: error, productId: created.idProducto, variantId: variant.idVariante },
          'No se pudo crear el producto plano en Contifico; queda pendiente de mapeo'
        );
      }
    }
  }

  if (input.writeThroughMeta) {
    const variants = await prisma.productoVariante.findMany({
      where: { idProducto: created.idProducto },
      select: { idVariante: true, isActive: true, metaRetailerId: true },
    });
    for (const variant of variants) {
      if (!variant.isActive || variant.metaRetailerId) {
        continue;
      }
      try {
        await publishVariantById(variant.idVariante);
      } catch (error) {
        logger.warn(
          { err: error, productId: created.idProducto, variantId: variant.idVariante },
          'No se pudo publicar la variante en Meta; queda pendiente de mapeo'
        );
      }
    }
  }

  return getProductById(created.idProducto);
}

export async function updateProduct(
  id: number,
  input: UpdateProductBody,
  options: { skipMeta?: boolean } = {}
) {
  const prisma = getPrisma();

  const existing = await prisma.producto.findUnique({
    where: { idProducto: id },
    select: {
      idProducto: true,
      producto: true,
      descripcion: true,
      subcategoria: { select: { categoria: { select: { nombre: true } } } },
      variants: {
        select: {
          idVariante: true,
          sku: true,
          color: true,
          descripcion: true,
          precioUsd: true,
          isActive: true,
          imagenUrl: true,
          urlProducto: true,
          contificoId: true,
          metaRetailerId: true,
        },
      },
    },
  });
  if (!existing) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Producto no encontrado.', 'ALTOSA_PRODUCT_NOT_FOUND');
  }

  const taxonomy = input.subcategoryId
    ? await prisma.subcategoria.findUnique({
        where: { id: input.subcategoryId },
        select: { categoria: { select: { nombre: true } } },
      })
    : existing.subcategoria;
  const categoryName =
    taxonomy?.categoria?.nombre ?? existing.subcategoria?.categoria?.nombre ?? null;

  if (
    input.nombre !== undefined ||
    input.descripcion !== undefined ||
    input.isActive !== undefined
  ) {
    for (const variant of existing.variants) {
      if (!variant.contificoId) {
        continue;
      }
      await updateContificoProductForVariant(variant.contificoId, {
        productName: input.nombre ?? existing.producto,
        sku: variant.sku,
        color: variant.color,
        description:
          input.descripcion !== undefined
            ? input.descripcion
            : variant.descripcion,
        price: variant.precioUsd === null ? null : Number(variant.precioUsd),
        isActive: input.isActive ?? variant.isActive,
        categoryName,
      });
    }

    for (const variant of existing.variants) {
      if (options.skipMeta || !variant.metaRetailerId) {
        continue;
      }
      await updateVariantInMeta(variant.idVariante, {
        productName: input.nombre ?? existing.producto,
        color: variant.color,
        description:
          input.descripcion !== undefined
            ? input.descripcion
            : variant.descripcion,
        price: variant.precioUsd === null ? null : Number(variant.precioUsd),
        imageUrl: variant.imagenUrl,
        url: variant.urlProducto,
        isActive: input.isActive ?? variant.isActive,
      });
    }
  }

  if (input.subcategoryId !== undefined) {
    await ensureSubcategoriaExists(input.subcategoryId);
  }
  if (input.estadoId !== undefined) {
    await ensureEstadoExists(input.estadoId);
  }
  if (input.kommoTemplateId) {
    await ensureKommoTemplateExists(input.kommoTemplateId);
  }

  const data: Prisma.ProductoUncheckedUpdateInput = { updatedAt: new Date() };
  if (input.nombre !== undefined) data.producto = input.nombre;
  if (input.descripcion !== undefined) data.descripcion = input.descripcion || null;
  if (input.usoRecomendado !== undefined) data.usoRecomendado = input.usoRecomendado || null;
  if (input.subcategoryId !== undefined) data.idSubCategoria = input.subcategoryId;
  if (input.estadoId !== undefined) data.estadoId = input.estadoId;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.kommoTemplateId !== undefined) {
    data.kommoTemplateId = input.kommoTemplateId || null;
  }

  await prisma.producto.update({ where: { idProducto: id }, data });
  return getProductById(id);
}

export async function deactivateProduct(id: number) {
  // DELETE explícito: se eliminan los ítems de Meta del producto. El toggle
  // de isActive (updateProduct) solo actualiza availability.
  await deleteProductMetaItems(id);
  return updateProduct(id, { isActive: false }, { skipMeta: true });
}

export async function createVariant(productId: number, input: VariantBody) {
  const prisma = getPrisma();

  const producto = await prisma.producto.findUnique({
    where: { idProducto: productId },
    select: {
      idProducto: true,
      estadoId: true,
      producto: true,
      subcategoria: { select: { categoria: { select: { nombre: true } } } },
    },
  });
  if (!producto) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Producto no encontrado.', 'ALTOSA_PRODUCT_NOT_FOUND');
  }

  await ensureSkuAvailable(input.sku);
  await ensureMetaRetailerIdExists(input.metaRetailerId);
  await ensureMetaRetailerIdAvailable(input.metaRetailerId);
  await ensureContificoIdAvailable(input.contificoId);
  await validateVariantReferences(input);

  const now = new Date();
  const created = await prisma.productoVariante.create({
    data: {
      idProducto: productId,
      ...variantCreateData(input),
      estadoId: input.estadoId ?? producto.estadoId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    include: VARIANT_RELATIONS,
  });

  if (input.writeThroughContifico) {
    try {
      const mapping = await createContificoProductForVariant({
        productName: producto.producto,
        sku: created.sku,
        color: created.color,
        description: created.descripcion,
        price: created.precioUsd === null ? null : Number(created.precioUsd),
        isActive: created.isActive,
        categoryName: producto.subcategoria?.categoria?.nombre ?? null,
      });
      if (mapping) {
        await prisma.productoVariante.update({
          where: { idVariante: created.idVariante },
          data: mapping,
        });
      }
    } catch (error) {
      logger.warn(
        { err: error, productId, variantId: created.idVariante },
        'Variante creada en Altosa, pero no se pudo crear su producto en Contifico'
      );
    }
  }

  if (input.writeThroughMeta) {
    try {
      await publishVariantById(created.idVariante);
    } catch (error) {
      logger.warn(
        { err: error, productId, variantId: created.idVariante },
        'Variante creada en Altosa, pero no se pudo publicar en Meta'
      );
    }
  }

  const saved = await prisma.productoVariante.findUniqueOrThrow({
    where: { idVariante: created.idVariante },
    include: VARIANT_RELATIONS,
  });
  return mapVariante(saved);
}

export async function updateVariant(
  variantId: number,
  input: UpdateVariantBody,
  options: { skipMeta?: boolean } = {}
) {
  const prisma = getPrisma();

  const existing = await prisma.productoVariante.findUnique({
    where: { idVariante: variantId },
    select: {
      idVariante: true,
      idProducto: true,
      sku: true,
      color: true,
      descripcion: true,
      precioUsd: true,
      isActive: true,
      imagenUrl: true,
      urlProducto: true,
      contificoId: true,
      metaRetailerId: true,
      producto: {
        select: {
          producto: true,
          subcategoria: { select: { categoria: { select: { nombre: true } } } },
        },
      },
    },
  });
  if (!existing) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Variante no encontrada.', 'ALTOSA_VARIANT_NOT_FOUND');
  }

  if (
    (existing.contificoId || existing.metaRetailerId) &&
    input.sku !== undefined &&
    input.sku !== existing.sku
  ) {
    throw new HttpError(
      StatusCodes.CONFLICT,
      'El SKU de una variante mapeada a Contifico/Meta no se puede cambiar desde Altosa. Actualízalo en el catálogo externo o quita el mapeo primero.',
      'EXTERNAL_VARIANT_SKU_LOCKED'
    );
  }

  if (
    existing.contificoId &&
    (input.color !== undefined ||
      input.descripcion !== undefined ||
      input.precioUsd !== undefined ||
      input.isActive !== undefined)
  ) {
    await updateContificoProductForVariant(existing.contificoId, {
      productName: existing.producto.producto,
      sku: existing.sku,
      color: input.color ?? existing.color,
      description:
        input.descripcion !== undefined
          ? input.descripcion
          : existing.descripcion,
      price:
        input.precioUsd !== undefined
          ? input.precioUsd
          : existing.precioUsd === null
            ? null
            : Number(existing.precioUsd),
      isActive: input.isActive ?? existing.isActive,
      categoryName: existing.producto.subcategoria?.categoria?.nombre ?? null,
    });
  }

  if (
    !options.skipMeta &&
    existing.metaRetailerId &&
    (input.color !== undefined ||
      input.descripcion !== undefined ||
      input.precioUsd !== undefined ||
      input.imagenUrl !== undefined ||
      input.isActive !== undefined)
  ) {
    await updateVariantInMeta(variantId, {
      productName: existing.producto.producto,
      color: input.color ?? existing.color,
      description:
        input.descripcion !== undefined
          ? input.descripcion
          : existing.descripcion,
      price:
        input.precioUsd !== undefined
          ? input.precioUsd
          : existing.precioUsd === null
            ? null
            : Number(existing.precioUsd),
      imageUrl:
        input.imagenUrl !== undefined ? input.imagenUrl : existing.imagenUrl,
      url: existing.urlProducto,
      isActive: input.isActive ?? existing.isActive,
    });
  }

  if (input.sku !== undefined) {
    await ensureSkuAvailable(input.sku, variantId);
  }
  if (input.metaRetailerId !== undefined) {
    await ensureMetaRetailerIdExists(input.metaRetailerId);
    await ensureMetaRetailerIdAvailable(input.metaRetailerId, variantId);
  }
  if (input.contificoId !== undefined) {
    await ensureContificoIdAvailable(input.contificoId, variantId);
  }
  await validateVariantReferences(input);

  const data = variantUpdateData(input);
  data.updatedAt = new Date();

  const updated = await prisma.productoVariante.update({
    where: { idVariante: variantId },
    data,
    include: VARIANT_RELATIONS,
  });

  // Si la variante aún no está mapeada y se guarda desde el ERP, intentamos
  // publicarla en Meta y crearla en Contifico. Es best-effort: si faltan
  // precio/imagen/SKU o permisos, el guardado en Altosa no se bloquea.
  let mappingChanged = false;
  if (
    input.writeThroughMeta &&
    !existing.metaRetailerId &&
    input.metaRetailerId === undefined &&
    updated.isActive
  ) {
    try {
      const published = await publishVariantById(updated.idVariante);
      mappingChanged = Boolean(published) || mappingChanged;
    } catch (error) {
      logger.warn(
        { err: error, variantId: updated.idVariante, sku: updated.sku },
        'La variante se guardó en Altosa, pero no se pudo publicar en Meta'
      );
    }
  }

  if (
    input.writeThroughContifico &&
    !existing.contificoId &&
    input.contificoId === undefined &&
    updated.isActive
  ) {
    try {
      const mapping = await createContificoProductForVariant({
        productName: existing.producto.producto,
        sku: updated.sku,
        color: updated.color,
        description: updated.descripcion,
        price: updated.precioUsd === null ? null : Number(updated.precioUsd),
        isActive: updated.isActive,
        categoryName: existing.producto.subcategoria?.categoria?.nombre ?? null,
      });
      if (mapping) {
        await prisma.productoVariante.update({
          where: { idVariante: updated.idVariante },
          data: mapping,
        });
        mappingChanged = true;
      }
    } catch (error) {
      logger.warn(
        { err: error, variantId: updated.idVariante, sku: updated.sku },
        'La variante se guardó en Altosa, pero no se pudo crear en Contifico'
      );
    }
  }

  if (mappingChanged) {
    const refreshed = await prisma.productoVariante.findUniqueOrThrow({
      where: { idVariante: updated.idVariante },
      include: VARIANT_RELATIONS,
    });
    return mapVariante(refreshed);
  }

  return mapVariante(updated);
}

export async function deactivateVariant(variantId: number) {
  // DELETE explícito: se elimina el ítem de Meta. Si el toggle isActive lo
  // desactiva (sin borrar), updateVariant solo actualiza availability.
  await deleteVariantFromMeta(variantId);
  return updateVariant(variantId, { isActive: false }, { skipMeta: true });
}

// ---------------------------------------------------------------------------
// Sincronización desde Contifico (ERP -> Altosa)
// ---------------------------------------------------------------------------

interface SyncProductsResult {
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  meta?: {
    mapped: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    warnings: string[];
  };
  contifico?: {
    mapped: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    warnings: string[];
  };
}

function normalizeSyncVariant(input: SyncProductBody['variantes'][number]) {
  return {
    sku: input.sku,
    color: input.color?.trim() || null,
    descripcion: input.descripcion?.trim() || null,
    precioUsd: input.precioUsd ?? null,
    imagenUrl: input.imagenUrl?.trim() || null,
    especificaciones: input.especificaciones ?? {},
    isActive: input.isActive,
    contificoId: input.contificoId?.trim() || null,
    contificoSku: input.contificoSku?.trim() || null,
  };
}

/**
 * Conserva especificaciones que ya existían en Altosa (texto plano o JSON de
 * enriquecimiento) y agrega/actualiza las claves que vienen de Contifico.
 */
function mergeSyncSpecs(
  existing: string | null | undefined,
  incoming: Record<string, unknown>
): string | null {
  if (Object.keys(incoming).length === 0 && !existing) {
    return null;
  }

  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      } else {
        base = { especificaciones_originales: existing };
      }
    } catch {
      base = { especificaciones_originales: existing };
    }
  }

  return JSON.stringify({ ...base, ...incoming });
}

/**
 * Upsert idempotente por SKU de variante. Es la contraparte del endpoint
 * POST /api/v1/sync/products y también lo usa el seed offline.
 */
export async function syncProducts(
  items: SyncProductBody[],
  options: {
    matchByName?: boolean;
    syncExternals?: boolean;
    writeThroughMeta?: boolean;
    writeThroughContifico?: boolean;
  } = {}
): Promise<SyncProductsResult> {
  const prisma = getPrisma();
  const matchByName = options.matchByName ?? false;
  const syncExternals = options.syncExternals ?? false;
  const writeThroughMeta = options.writeThroughMeta ?? false;
  const writeThroughContifico = options.writeThroughContifico ?? false;
  const estados = await resolveSyncEstados();
  const now = new Date();
  const result: SyncProductsResult = {
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    ...(syncExternals || writeThroughMeta
      ? {
          meta: {
            mapped: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
            warnings: [],
          },
        }
      : {}),
    ...(writeThroughContifico
      ? {
          contifico: {
            mapped: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
            warnings: [],
          },
        }
      : {}),
  };

  for (const item of items) {
    const categoria =
      (await prisma.categoria.findFirst({
        where: { nombre: { equals: item.categoria.trim(), mode: 'insensitive' } },
      })) ??
      (await prisma.categoria.create({
        data: { nombre: item.categoria.trim(), updatedAt: now },
      }));

    const subcategoriaNombre = item.subcategoria?.trim() || 'General';
    const subcategoria =
      (await prisma.subcategoria.findFirst({
        where: {
          idCategoria: categoria.id,
          nombre: { equals: subcategoriaNombre, mode: 'insensitive' },
        },
      })) ??
      (await prisma.subcategoria.create({
        data: {
          idCategoria: categoria.id,
          nombre: subcategoriaNombre,
          updatedAt: now,
        },
      }));

    const estadoId =
      item.estado === 'I' ? estados.inactiveId : estados.activeId;
    const isActive = item.estado !== 'I';
    const variantes =
      item.variantes.length > 0
        ? item.variantes.map(normalizeSyncVariant)
        : [
            {
              sku: item.codigo,
              color: 'Estándar',
              descripcion: item.descripcion?.trim() || null,
              precioUsd: null,
              imagenUrl: null,
              especificaciones: {},
              isActive,
              contificoId: null,
              contificoSku: null,
            },
          ];

    const primarySku = variantes[0]!.sku;
    const existingVariant = await prisma.productoVariante.findFirst({
      where: { sku: primarySku },
      select: {
        idProducto: true,
        producto: { select: { isActive: true } },
      },
    });

    let productId = existingVariant?.idProducto ?? null;
    let existingProductIsActive = existingVariant?.producto.isActive ?? false;
    let mergePrimaryVariant: {
      idVariante: number;
      color: string | null;
      descripcion: string | null;
      imagenUrl: string | null;
      especificacionesAdicionales: string | null;
      isActive: boolean;
    } | null = null;

    if (productId === null) {
      const existingProduct = await prisma.producto.findFirst({
        where: {
          producto: { equals: item.nombre.trim(), mode: 'insensitive' },
          ...(matchByName ? {} : { subcategoria: { idCategoria: categoria.id } }),
        },
        select: {
          idProducto: true,
          isActive: true,
          variants: {
            select: {
              idVariante: true,
              color: true,
              descripcion: true,
              imagenUrl: true,
              especificacionesAdicionales: true,
              isActive: true,
            },
          },
        },
        orderBy: { idProducto: 'asc' },
      });
      productId = existingProduct?.idProducto ?? null;
      existingProductIsActive = existingProduct?.isActive ?? false;

      // Migración inicial desde Altosa: si el producto existe por nombre y
      // tiene una sola variante, reutilizamos esa variante cambiándole el SKU
      // en lugar de crear una variante duplicada.
      if (existingProduct && existingProduct.variants.length === 1) {
        mergePrimaryVariant = existingProduct.variants[0]!;
      }
    }

    if (productId === null) {
      const created = await prisma.producto.create({
        data: {
          idSubCategoria: subcategoria.id,
          producto: item.nombre.trim(),
          descripcion: item.descripcion?.trim() || null,
          usoRecomendado: item.usoRecomendado?.trim() || null,
          estadoId,
          isActive,
          updatedAt: now,
        },
      });
      productId = created.idProducto;
      result.productsCreated += 1;
    } else {
      await prisma.producto.update({
        where: { idProducto: productId },
        data: existingProductIsActive
          ? {
              // Un producto aprobado es maestro en Altosa/ERP: el sync de
              // Contifico no debe cambiar nombre, descripción ni uso. Solo se
              // permite mover la taxonomía con un update explícito del ERP.
              ...(item.updateTaxonomy
                ? { idSubCategoria: subcategoria.id }
                : {}),
              updatedAt: now,
            }
          : {
              producto: item.nombre.trim(),
              // La taxonomía de Altosa es curada por el equipo de IA: el sync
              // masivo de Contifico conserva categoría/subcategoría. Solo un
              // update explícito del ERP (updateTaxonomy) puede mover el producto.
              ...(item.updateTaxonomy ? { idSubCategoria: subcategoria.id } : {}),
              // Si Contifico no trae descripción, no borramos el enriquecimiento
              // que ya existía en Altosa.
              ...(item.descripcion?.trim()
                ? { descripcion: item.descripcion.trim() }
                : {}),
              ...(item.usoRecomendado?.trim()
                ? { usoRecomendado: item.usoRecomendado.trim() }
                : {}),
              updatedAt: now,
            },
      });
      result.productsUpdated += 1;
    }

    for (const [variantIndex, variante] of variantes.entries()) {
      const existingBySku = await prisma.productoVariante.findFirst({
        where: { sku: variante.sku },
        select: {
          idVariante: true,
          color: true,
          descripcion: true,
          imagenUrl: true,
          especificacionesAdicionales: true,
          isActive: true,
          metaRetailerId: true,
          metaMappingLocked: true,
        },
      });
      const existing =
        existingBySku ?? (variantIndex === 0 ? mergePrimaryVariant : null);

      const variantIsActive = variante.isActive ?? isActive;
      const variantEstadoId = variantIsActive ? estados.activeId : estados.inactiveId;
      const existingIsActive = existing?.isActive ?? false;

      const data = existingIsActive
        ? {
            // Variante aprobada: conservar color, descripción e imagen. El
            // sync solo actualiza precio/stock (especificaciones) y los IDs
            // externos que vengan del ERP.
            idProducto: productId,
            sku: variante.sku,
            precioUsd: variante.precioUsd,
            especificacionesAdicionales: mergeSyncSpecs(
              existing?.especificacionesAdicionales,
              variante.especificaciones
            ),
            ...(variante.contificoId
              ? {
                  contificoId: variante.contificoId,
                  contificoSku: variante.contificoSku ?? variante.sku,
                }
              : {}),
            updatedAt: now,
          }
        : {
            idProducto: productId,
            sku: variante.sku,
            color: variante.color ?? existing?.color ?? null,
            descripcion: variante.descripcion ?? existing?.descripcion ?? null,
            precioUsd: variante.precioUsd,
            imagenUrl: variante.imagenUrl ?? existing?.imagenUrl ?? null,
            especificacionesAdicionales: mergeSyncSpecs(
              existing?.especificacionesAdicionales,
              variante.especificaciones
            ),
            ...(variante.contificoId
              ? {
                  contificoId: variante.contificoId,
                  contificoSku: variante.contificoSku ?? variante.sku,
                }
              : {}),
            updatedAt: now,
          };

      let savedVariant;
      if (existing) {
        savedVariant = await prisma.productoVariante.update({
          where: { idVariante: existing.idVariante },
          data,
        });
        result.variantsUpdated += 1;
      } else {
        savedVariant = await prisma.productoVariante.create({
          data: {
            ...data,
            estadoId: variantEstadoId,
            isActive: variantIsActive,
          },
        });
        result.variantsCreated += 1;
      }

      if (writeThroughMeta && result.meta && savedVariant.metaRetailerId) {
        try {
          await updateVariantInMeta(savedVariant.idVariante, {
            productName: item.nombre,
            color: savedVariant.color,
            description: savedVariant.descripcion,
            price:
              savedVariant.precioUsd === null
                ? null
                : Number(savedVariant.precioUsd),
            imageUrl: savedVariant.imagenUrl,
            url: savedVariant.urlProducto,
            isActive: savedVariant.isActive,
          });
          result.meta.updated += 1;
        } catch (error) {
          result.meta.failed += 1;
          const message =
            error instanceof Error ? error.message : 'Error desconocido actualizando Meta';
          result.meta.warnings.push(
            `Variante ${savedVariant.sku ?? savedVariant.idVariante}: ${message}`
          );
          logger.warn(
            { err: error, variantId: savedVariant.idVariante, sku: savedVariant.sku },
            'No se pudo actualizar la variante en Meta'
          );
        }
      }

      if (
        syncExternals &&
        result.meta &&
        savedVariant.isActive &&
        !savedVariant.metaRetailerId
      ) {
        try {
          const published = await publishVariantToMeta({
            retailerId: savedVariant.sku?.trim() || `ALT-${savedVariant.idVariante}`,
            name: buildFlatName(item.nombre, savedVariant.color),
            description: savedVariant.descripcion,
            price:
              savedVariant.precioUsd === null ? null : Number(savedVariant.precioUsd),
            imageUrl: savedVariant.imagenUrl,
            url: savedVariant.urlProducto,
          });
          await prisma.productoVariante.update({
            where: { idVariante: savedVariant.idVariante },
            data: {
              metaRetailerId: published.retailerId,
              metaMappingLocked: true,
            },
          });
          if (published.created) {
            result.meta.created += 1;
          } else {
            result.meta.mapped += 1;
          }
        } catch (error) {
          result.meta.failed += 1;
          const message =
            error instanceof Error ? error.message : 'Error desconocido publicando en Meta';
          result.meta.warnings.push(
            `Variante ${savedVariant.sku ?? savedVariant.idVariante}: ${message}`
          );
          logger.warn(
            { err: error, variantId: savedVariant.idVariante, sku: savedVariant.sku },
            'No se pudo publicar la variante en Meta; queda pendiente de mapeo'
          );
        }
      }

      if (writeThroughContifico && result.contifico) {
        if (savedVariant.contificoId) {
          try {
            await updateContificoProductForVariant(savedVariant.contificoId, {
              productName: item.nombre,
              sku: savedVariant.sku,
              color: savedVariant.color,
              description: savedVariant.descripcion,
              price:
                savedVariant.precioUsd === null
                  ? null
                  : Number(savedVariant.precioUsd),
              isActive: savedVariant.isActive,
              categoryName: item.categoria,
            });
            result.contifico.updated += 1;
          } catch (error) {
            result.contifico.failed += 1;
            const message =
              error instanceof Error
                ? error.message
                : 'Error desconocido actualizando Contifico';
            result.contifico.warnings.push(
              `Variante ${savedVariant.sku ?? savedVariant.idVariante}: ${message}`
            );
            logger.warn(
              { err: error, variantId: savedVariant.idVariante, sku: savedVariant.sku },
              'No se pudo actualizar el producto plano en Contifico'
            );
          }
        } else if (savedVariant.isActive) {
          try {
            const mapping = await createContificoProductForVariant({
              productName: item.nombre,
              sku: savedVariant.sku,
              color: savedVariant.color,
              description: savedVariant.descripcion,
              price:
                savedVariant.precioUsd === null
                  ? null
                  : Number(savedVariant.precioUsd),
              isActive: savedVariant.isActive,
              categoryName: item.categoria,
            });
            if (mapping) {
              await prisma.productoVariante.update({
                where: { idVariante: savedVariant.idVariante },
                data: mapping,
              });
              savedVariant.contificoId = mapping.contificoId;
              savedVariant.contificoSku = mapping.contificoSku;
              result.contifico.created += 1;
            } else {
              result.contifico.skipped += 1;
            }
          } catch (error) {
            result.contifico.failed += 1;
            const message =
              error instanceof Error
                ? error.message
                : 'Error desconocido creando en Contifico';
            result.contifico.warnings.push(
              `Variante ${savedVariant.sku ?? savedVariant.idVariante}: ${message}`
            );
            logger.warn(
              { err: error, variantId: savedVariant.idVariante, sku: savedVariant.sku },
              'No se pudo crear el producto plano en Contifico; queda pendiente de mapeo'
            );
          }
        } else {
          result.contifico.skipped += 1;
        }
      }

      if (variantIndex === 0) {
        mergePrimaryVariant = null;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reconciliación: desactivar SKUs que ya no existen en Contifico
// ---------------------------------------------------------------------------

export interface DeactivateProductsResult {
  variantsDeactivated: number;
  productsDeactivated: number;
}

/**
 * Desactiva variantes por SKU y, si un producto se queda sin variantes
 * activas, desactiva también el producto. Es idempotente.
 */
export async function deactivateProductsBySku(
  skus: string[]
): Promise<DeactivateProductsResult> {
  const prisma = getPrisma();
  const normalized = Array.from(
    new Set(skus.map((sku) => sku.trim()).filter((sku) => sku.length > 0))
  );
  if (normalized.length === 0) {
    return { variantsDeactivated: 0, productsDeactivated: 0 };
  }

  const estados = await resolveSyncEstados();
  const now = new Date();
  const variants = await prisma.productoVariante.findMany({
    where: { sku: { in: normalized } },
    select: { idVariante: true, idProducto: true },
  });

  if (variants.length === 0) {
    return { variantsDeactivated: 0, productsDeactivated: 0 };
  }

  await prisma.productoVariante.updateMany({
    where: { idVariante: { in: variants.map((variant) => variant.idVariante) } },
    data: { isActive: false, estadoId: estados.inactiveId, updatedAt: now },
  });

  let productsDeactivated = 0;
  const productIds = Array.from(new Set(variants.map((variant) => variant.idProducto)));
  for (const idProducto of productIds) {
    const activeVariants = await prisma.productoVariante.count({
      where: { idProducto, isActive: true },
    });
    if (activeVariants === 0) {
      const result = await prisma.producto.updateMany({
        where: { idProducto, isActive: true },
        data: { isActive: false, estadoId: estados.inactiveId, updatedAt: now },
      });
      productsDeactivated += result.count;
    }
  }

  return { variantsDeactivated: variants.length, productsDeactivated };
}
