import { z } from 'zod';

const optionalExternalUrl = z.string().trim().max(1000).nullable().optional();

export const externalMetaPendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  search: z.string().trim().max(120).optional(),
});

export const externalPendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  search: z.string().trim().max(120).optional(),
  source: z.enum(['all', 'meta', 'contifico']).default('all'),
});

export const externalItemSchema = z.object({
  source: z.enum(['meta', 'contifico']),
  externalId: z.string().trim().min(1).max(150),
  sku: z.string().trim().max(120).nullable().optional(),
  name: z.string().trim().min(1).max(300),
  baseName: z.string().trim().max(300).nullable().optional(),
  color: z.string().trim().max(120).nullable().optional(),
  price: z.number().min(0).max(1_000_000).nullable().optional(),
  imageUrl: optionalExternalUrl,
  url: optionalExternalUrl,
  category: z.string().trim().max(200).nullable().optional(),
  subcategory: z.string().trim().max(200).nullable().optional(),
  stock: z.number().int().min(0).max(10_000_000).nullable().optional(),
  barcode: z.string().trim().max(120).nullable().optional(),
  metaRetailerId: z.string().trim().max(100).nullable().optional(),
  contificoId: z.string().trim().max(100).nullable().optional(),
  contificoSku: z.string().trim().max(120).nullable().optional(),
});

export const externalImportBodySchema = z.object({
  items: z.array(externalItemSchema).min(1).max(100),
});

export const externalHealthQuerySchema = z.object({
  refresh: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const externalRepairBodySchema = z.object({
  variantId: z.coerce.number().int().positive(),
  source: z.enum(['meta', 'contifico']),
  action: z.enum(['republish', 'recreate', 'reactivate', 'unmap']),
});

export type ExternalMetaPendingQuery = z.infer<typeof externalMetaPendingQuerySchema>;
export type ExternalPendingQuery = z.infer<typeof externalPendingQuerySchema>;
export type ExternalItemInput = z.infer<typeof externalItemSchema>;
export type ExternalHealthQuery = z.infer<typeof externalHealthQuerySchema>;
export type ExternalRepairBody = z.infer<typeof externalRepairBodySchema>;
