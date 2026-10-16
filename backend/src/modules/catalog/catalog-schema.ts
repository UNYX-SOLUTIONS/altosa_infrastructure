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

export type ProductsQuery = z.infer<typeof productsQuerySchema>;
export type DocumentsQuery = z.infer<typeof documentsQuerySchema>;
export type SimpleListQuery = z.infer<typeof simpleListQuerySchema>;
