import type { Prisma } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { getPrisma } from '../../config/prisma';
import { HttpError } from '../../utils/api-response';
import type {
  CreateProductBody,
  DocumentsQuery,
  ProductsQuery,
  SimpleListQuery,
  UpdateProductBody,
  UpdateVariantBody,
  VariantBody,
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
  include: { garantia: true; catalogo: true; estado: true };
}>;

function mapVariante(variante: VarianteConRelaciones) {
  return {
    id: variante.idVariante,
    sku: variante.sku,
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
    isActive: variante.isActive,
    updatedAt: variante.updatedAt,
  };
}

const VARIANT_RELATIONS = {
  garantia: true,
  catalogo: true,
  estado: true,
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

export async function listWarranties(query: SimpleListQuery) {
  const prisma = getPrisma();

  const garantias = await prisma.garantia.findMany({
    where: { isActive: query.active },
    include: { estado: true },
    orderBy: { idGarantia: 'asc' },
  });

  return garantias.map((garantia) => ({
    id: garantia.idGarantia,
    meses: garantia.garantiaMeses,
    especial: garantia.garantiaEspecial,
    observaciones: garantia.observaciones,
    fuenteUrl: garantia.fuenteUrl,
    estado: mapEstado(garantia.estado),
    isActive: garantia.isActive,
  }));
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

async function validateVariantReferences(input: VariantBody | UpdateVariantBody): Promise<void> {
  if (input.estadoId !== undefined) {
    await ensureEstadoExists(input.estadoId);
  }
  if (input.garantiaId !== undefined) {
    await ensureGarantiaExists(input.garantiaId);
  }
  if (input.catalogoId !== undefined) {
    await ensureCatalogoExists(input.catalogoId);
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

  return data;
}

export async function createProduct(input: CreateProductBody) {
  const prisma = getPrisma();

  await ensureSubcategoriaExists(input.subcategoryId);
  await ensureEstadoExists(input.estadoId);

  for (const variante of input.variantes) {
    await ensureSkuAvailable(variante.sku);
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

  return getProductById(created.idProducto);
}

export async function updateProduct(id: number, input: UpdateProductBody) {
  const prisma = getPrisma();

  const existing = await prisma.producto.findUnique({
    where: { idProducto: id },
    select: { idProducto: true },
  });
  if (!existing) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Producto no encontrado.', 'ALTOSA_PRODUCT_NOT_FOUND');
  }

  if (input.subcategoryId !== undefined) {
    await ensureSubcategoriaExists(input.subcategoryId);
  }
  if (input.estadoId !== undefined) {
    await ensureEstadoExists(input.estadoId);
  }

  const data: Prisma.ProductoUncheckedUpdateInput = { updatedAt: new Date() };
  if (input.nombre !== undefined) data.producto = input.nombre;
  if (input.descripcion !== undefined) data.descripcion = input.descripcion || null;
  if (input.usoRecomendado !== undefined) data.usoRecomendado = input.usoRecomendado || null;
  if (input.subcategoryId !== undefined) data.idSubCategoria = input.subcategoryId;
  if (input.estadoId !== undefined) data.estadoId = input.estadoId;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  await prisma.producto.update({ where: { idProducto: id }, data });
  return getProductById(id);
}

export async function deactivateProduct(id: number) {
  return updateProduct(id, { isActive: false });
}

export async function createVariant(productId: number, input: VariantBody) {
  const prisma = getPrisma();

  const producto = await prisma.producto.findUnique({
    where: { idProducto: productId },
    select: { idProducto: true, estadoId: true },
  });
  if (!producto) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Producto no encontrado.', 'ALTOSA_PRODUCT_NOT_FOUND');
  }

  await ensureSkuAvailable(input.sku);
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

  return mapVariante(created);
}

export async function updateVariant(variantId: number, input: UpdateVariantBody) {
  const prisma = getPrisma();

  const existing = await prisma.productoVariante.findUnique({
    where: { idVariante: variantId },
    select: { idVariante: true },
  });
  if (!existing) {
    throw new HttpError(StatusCodes.NOT_FOUND, 'Variante no encontrada.', 'ALTOSA_VARIANT_NOT_FOUND');
  }

  if (input.sku !== undefined) {
    await ensureSkuAvailable(input.sku, variantId);
  }
  await validateVariantReferences(input);

  const data = variantUpdateData(input);
  data.updatedAt = new Date();

  const updated = await prisma.productoVariante.update({
    where: { idVariante: variantId },
    data,
    include: VARIANT_RELATIONS,
  });

  return mapVariante(updated);
}

export async function deactivateVariant(variantId: number) {
  return updateVariant(variantId, { isActive: false });
}
