import type {
  ContificoCanonicalProduct,
  ContificoCanonicalVariant,
  ContificoProductDto,
} from './contifico-types';

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = typeof value === 'string' ? value.replace(',', '.').trim() : value;
  if (normalized === '') {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * v2 documenta `imagen` como objeto Foto, pero en la práctica también
 * devuelve string/URL vacío. Soportamos ambos formatos.
 */
export function extractContificoImageUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    return isValidUrl(value.trim() || null);
  }
  if (value && typeof value === 'object') {
    const candidate = value as { url?: unknown; foto?: unknown };
    const raw = candidate.url ?? candidate.foto;
    if (typeof raw === 'string') {
      return isValidUrl(raw.trim() || null);
    }
  }
  return null;
}

function isValidUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function resolveContificoSku(product: ContificoProductDto): string {
  return clean(product.codigo) ?? `CONF-${product.id}`;
}

export function mapContificoProduct(
  product: ContificoProductDto,
  categoryName: string | null
): ContificoCanonicalProduct {
  const sku = resolveContificoSku(product);
  const name = clean(product.nombre) ?? sku;
  const description = clean(product.descripcion);
  const price = toNumber(product.pvp1);
  const stock = toNumber(product.cantidad_stock) ?? 0;
  const minStock = toNumber(product.minimo);
  const taxRate = toNumber(product.porcentaje_iva);
  const category = clean(categoryName);
  const keywords = Array.from(
    new Set(
      [name, category, clean(product.marca_nombre), description]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
    )
  );

  const variant: ContificoCanonicalVariant = {
    sku,
    name: 'Estándar',
    color: null,
    colorHex: null,
    price,
    stock,
    imageUrl: extractContificoImageUrl(product.imagen),
    description,
    isActive: product.estado !== 'I',
    sortOrder: 0,
    especificaciones: {
      contifico_id: product.id,
      contifico_codigo: sku,
      codigo_barra: clean(product.codigo_barra),
      categoria_id: clean(product.categoria_id),
      marca_id: clean(product.marca_id),
      marca: clean(product.marca_nombre),
      porcentaje_iva: taxRate,
      minimo: minStock,
      stock,
      pvp1: price,
      pvp2: toNumber(product.pvp2),
      pvp3: toNumber(product.pvp3),
      pvp4: toNumber(product.pvp4),
      pvp_manual: product.pvp_manual ?? null,
      para_pos: product.para_pos ?? null,
      tipo: clean(product.tipo),
      tipo_producto: clean(product.tipo_producto),
      unidad: clean(product.unidad),
      fecha_creacion: clean(product.fecha_creacion),
      costo_maximo: toNumber(product.costo_maximo),
      codigo_proveedor: clean(product.codigo_proveedor),
      lead_time: product.lead_time ?? null,
      generacion_automatica: product.generacion_automatica ?? null,
      id_integracion_proveedor: clean(product.id_integracion_proveedor),
      producto_base_id: clean(product.producto_base_id),
      nombre_producto_base: clean(product.nombre_producto_base),
      personalizado1: clean(product.personalizado1),
      personalizado2: clean(product.personalizado2),
      cuenta_venta_id: clean(product.cuenta_venta_id),
      cuenta_compra_id: clean(product.cuenta_compra_id),
      cuenta_costo_id: clean(product.cuenta_costo_id),
      pvp_peso: toNumber(product.pvp_peso),
      peso_desde: toNumber(product.peso_desde),
      peso_hasta: toNumber(product.peso_hasta),
      detalle_variantes: product.detalle_variantes ?? [],
    },
  };

  return {
    externalId: product.id,
    sku,
    name,
    description,
    commercialDescription: description,
    line: category,
    category,
    // Contifico solo maneja categorías; la subcategoría es enriquecimiento
    // del ERP/Altosa y se preserva al actualizar.
    subcategory: null,
    keywords,
    thumbnailUrl: variant.imageUrl,
    sourceUrl: null,
    isActive: product.estado !== 'I',
    price,
    stock,
    barcode: clean(product.codigo_barra),
    taxRate,
    minStock,
    raw: product,
    variants: [variant],
  };
}
