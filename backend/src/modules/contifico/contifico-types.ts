/**
 * DTOs de la API de Contifico (inventario).
 *
 * Contifico devuelve los valores monetarios y de stock como strings
 * (ej. "5.6", "485.0"), por eso el mapper los normaliza a number.
 */
export interface ContificoCategoryDto {
  id: string;
  nombre: string;
  padre_id?: string | null;
  tipo_producto?: string | null;
  para_supereasy?: boolean | null;
  para_comisariato?: boolean | null;
  agrupar?: boolean | null;
  cuenta_compra?: string | null;
  cuenta_venta?: string | null;
  cuenta_inventario?: string | null;
}

export interface ContificoProductVariantRefDto {
  valor_id?: string | null;
  variante_id?: string | null;
}

export interface ContificoProductDto {
  id: string;
  codigo: string | null;
  nombre: string;
  descripcion: string | null;
  codigo_barra: string | null;
  categoria_id: string | null;
  marca_id: string | null;
  marca_nombre: string | null;
  porcentaje_iva: number | null;
  pvp1: string | number | null;
  pvp2: string | number | null;
  pvp3: string | number | null;
  pvp4: string | number | null;
  minimo: string | number | null;
  cantidad_stock: string | number | null;
  estado: string | null;
  pvp_manual: boolean | null;
  imagen: unknown;
  tipo: string | null;
  tipo_producto: string | null;
  fecha_creacion: string | null;
  producto_base_id: string | null;
  nombre_producto_base: string | null;
  detalle_variantes?: ContificoProductVariantRefDto[] | null;
  variantes?: unknown;
  cuenta_venta_id?: string | null;
  cuenta_compra_id?: string | null;
  cuenta_costo_id?: string | null;
  costo_maximo?: string | number | null;
  codigo_proveedor?: string | null;
  lead_time?: number | null;
  generacion_automatica?: boolean | null;
  id_integracion_proveedor?: string | null;
  para_pos?: boolean | null;
  personalizado1?: string | null;
  personalizado2?: string | null;
  pvp_peso?: string | number | null;
  peso_desde?: string | number | null;
  peso_hasta?: string | number | null;
  unidad?: string | null;
}

export interface ContificoInventoryMovementDetailDto {
  producto_id: string;
  cantidad: string | number;
  precio?: string | number | null;
  serie?: string | null;
  edicion?: boolean | null;
}

export interface ContificoInventoryMovementDto {
  id: string;
  codigo: string;
  tipo: 'ING' | 'EGR' | 'TRA' | 'AJU' | string;
  fecha: string;
  bodega_id: string;
  bodega_destino_id?: string | null;
  estado: string;
  descripcion?: string | null;
  detalles: ContificoInventoryMovementDetailDto[];
}

/**
 * Modelo canónico que usa el ERP para sincronizar hacia la DB local y Altosa.
 */
export interface ContificoCanonicalVariant {
  sku: string;
  name: string;
  color: string | null;
  colorHex: string | null;
  price: number | null;
  stock: number;
  imageUrl: string | null;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  especificaciones: Record<string, unknown>;
}

export interface ContificoCanonicalProduct {
  externalId: string;
  sku: string;
  name: string;
  description: string | null;
  commercialDescription: string | null;
  line: string | null;
  category: string | null;
  subcategory: string | null;
  keywords: string[];
  thumbnailUrl: string | null;
  sourceUrl: string | null;
  isActive: boolean;
  price: number | null;
  stock: number;
  barcode: string | null;
  taxRate: number | null;
  minStock: number | null;
  raw: ContificoProductDto;
  variants: ContificoCanonicalVariant[];
}

export interface ContificoCreateProductInput {
  codigo: string;
  nombre: string;
  descripcion?: string;
  categoriaNombre?: string;
  pvp1?: number | null;
  pvpManual?: boolean;
  estado?: 'A' | 'I';
  codigoBarra?: string | null;
  porcentajeIva?: number | null;
  minimo?: number | null;
  tipo?: 'PRO' | 'SER';
  tipoProducto?: 'SIM' | 'COM' | 'COP' | 'PRO';
}

export interface ContificoUpdateProductInput {
  nombre?: string;
  descripcion?: string | null;
  categoriaNombre?: string;
  pvp1?: number | null;
  pvpManual?: boolean;
  estado?: 'A' | 'I';
  codigoBarra?: string | null;
  porcentajeIva?: number | null;
  minimo?: number | null;
}

export interface ContificoSyncOptions {
  dryRun?: boolean;
  onlySku?: string;
  /**
   * Enlaza por nombre plano (producto padre + color) cuando no hay match por
   * ID/SKU. Útil para catálogos que ya venían de Meta/ETL.
   */
  matchByName?: boolean;
  /**
   * Desactiva en Altosa las variantes mapeadas a Contifico que ya no vinieron
   * en el catálogo. No borra filas.
   */
  prune?: boolean;
  /**
   * Si es false (default), solo actualiza variantes que ya existen en Altosa.
   * Los ítems nuevos entran por la bandeja de ingesta o con este flag.
   */
  createMissing?: boolean;
}

export interface ContificoSyncCounters {
  source: 'contifico';
  dryRun: boolean;
  durationMs: number;
  categoriesFetched: number;
  products: {
    fetched: number;
    created: number;
    updated: number;
    ignored: number;
    skipped: number;
    pruned: number;
  };
  variants: {
    created: number;
    updated: number;
    skipped: number;
    deactivated: number;
  };
  prunedSkuSample?: string[];
}

export interface ContificoProductSuggestion {
  contificoId: string;
  sku: string;
  name: string;
  category: string | null;
  price: number | null;
  stock: number;
  imageUrl: string | null;
  barcode: string | null;
  alreadyAdded: boolean;
  localProductId: string | null;
  altosaProductId: number | null;
}

export interface ContificoCatalogItem {
  externalId: string;
  sku: string;
  name: string;
  category: string | null;
  price: number | null;
  stock: number;
  barcode: string | null;
  isActive: boolean;
}

export interface ContificoImportResult {
  localProductId: string;
  altosaProductId?: number;
  sku: string;
  name: string;
  created: boolean;
  updated: boolean;
}
