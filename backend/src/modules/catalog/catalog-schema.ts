import { z } from 'zod';

const booleanQuery = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const skuParamSchema = z.object({
  sku: z.string().trim().min(1).max(120),
});

export const productsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  subcategoryId: z.coerce.number().int().positive().optional(),
  active: booleanQuery,
  withVariants: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const documentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  source: z.string().trim().max(80).optional(),
  active: booleanQuery,
  includeContent: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const simpleListQuerySchema = z.object({
  active: booleanQuery,
});

const optionalUrl = z.string().trim().url().max(500).optional().or(z.literal(''));

export const variantBodySchema = z.object({
  sku: z.string().trim().max(80).optional(),
  color: z.string().trim().max(80).optional(),
  descripcion: z.string().trim().max(2000).optional(),
  precioUsd: z.coerce.number().min(0).max(1_000_000).optional(),
  material: z.string().trim().max(200).optional(),
  tapizado: z.string().trim().max(200).optional(),
  estructura: z.string().trim().max(200).optional(),
  mecanismo: z.string().trim().max(200).optional(),
  proteccionUv: z.string().trim().max(200).optional(),
  resistenciaIntemperie: z.string().trim().max(200).optional(),
  apilable: z.string().trim().max(100).optional(),
  brazos: z.string().trim().max(200).optional(),
  soporteLumbar: z.string().trim().max(200).optional(),
  cabecera: z.string().trim().max(200).optional(),
  usoRecomendado: z.string().trim().max(500).optional(),
  especificacionesAdicionales: z.string().trim().max(2000).optional(),
  imagenUrl: optionalUrl,
  urlProducto: optionalUrl,
  anchoTotalCm: z.coerce.number().min(0).max(100000).optional(),
  profundidadAsientoCm: z.coerce.number().min(0).max(100000).optional(),
  alturaTotalCm: z.string().trim().max(50).optional(),
  alturaAsientoCm: z.string().trim().max(50).optional(),
  anchoAsientoCm: z.coerce.number().min(0).max(100000).optional(),
  pesoKg: z.coerce.number().min(0).max(100000).optional(),
  garantiaId: z.coerce.number().int().positive().optional(),
  catalogoId: z.coerce.number().int().positive().optional(),
  estadoId: z.coerce.number().int().positive().max(32767).optional(),
  kommoTemplateId: z.string().trim().min(1).max(80).nullable().optional(),
  metaRetailerId: z.string().trim().max(100).nullable().optional(),
  metaMappingLocked: z.boolean().optional(),
});

export const updateVariantBodySchema = variantBodySchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const createProductBodySchema = z.object({
  nombre: z.string().trim().min(1).max(200),
  descripcion: z.string().trim().max(2000).optional(),
  usoRecomendado: z.string().trim().max(500).optional(),
  subcategoryId: z.coerce.number().int().positive(),
  estadoId: z.coerce.number().int().positive().max(32767).optional().default(1),
  kommoTemplateId: z.string().trim().min(1).max(80).nullable().optional(),
  variantes: z.array(variantBodySchema).max(100).optional().default([]),
});

export const updateProductBodySchema = z.object({
  nombre: z.string().trim().min(1).max(200).optional(),
  descripcion: z.string().trim().max(2000).nullable().optional(),
  usoRecomendado: z.string().trim().max(500).nullable().optional(),
  subcategoryId: z.coerce.number().int().positive().optional(),
  estadoId: z.coerce.number().int().positive().max(32767).optional(),
  isActive: z.boolean().optional(),
  kommoTemplateId: z.string().trim().min(1).max(80).nullable().optional(),
});

export const syncVariantBodySchema = z.object({
  sku: z.string().trim().min(1).max(80),
  color: z.string().trim().max(80).nullable().optional(),
  descripcion: z.string().trim().max(2000).nullable().optional(),
  precioUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  imagenUrl: optionalUrl.nullable().optional(),
  especificaciones: z.record(z.unknown()).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const syncProductBodySchema = z.object({
  codigo: z.string().trim().min(1).max(80),
  nombre: z.string().trim().min(1).max(300),
  descripcion: z.string().trim().max(2000).nullable().optional(),
  usoRecomendado: z.string().trim().max(500).nullable().optional(),
  categoria: z.string().trim().min(1).max(300),
  subcategoria: z.string().trim().max(300).nullable().optional(),
  estado: z.enum(['A', 'I']).default('A'),
  updateTaxonomy: z.boolean().optional().default(false),
  variantes: z.array(syncVariantBodySchema).max(100).default([]),
});

export const syncProductsBodySchema = z.object({
  items: z.array(syncProductBodySchema).min(1).max(100),
  matchByName: z.boolean().optional().default(false),
});

export const syncDeactivateBodySchema = z.object({
  skus: z.array(z.string().trim().min(1).max(80)).min(1).max(500),
});

export type SyncVariantBody = z.infer<typeof syncVariantBodySchema>;
export type SyncProductBody = z.infer<typeof syncProductBodySchema>;

export type VariantBody = z.infer<typeof variantBodySchema>;
export type UpdateVariantBody = z.infer<typeof updateVariantBodySchema>;
export type CreateProductBody = z.infer<typeof createProductBodySchema>;
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;

export type ProductsQuery = z.infer<typeof productsQuerySchema>;
export type DocumentsQuery = z.infer<typeof documentsQuerySchema>;
export type SimpleListQuery = z.infer<typeof simpleListQuerySchema>;