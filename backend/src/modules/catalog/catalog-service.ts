import type { Prisma } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { getPrisma } from '../../config/prisma';
import { HttpError } from '../../utils/api-response';
import type { DocumentsQuery, ProductsQuery, SimpleListQuery } from './catalog-schema';

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
