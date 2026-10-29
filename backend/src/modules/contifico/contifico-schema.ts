import { z } from 'zod';

export const contificoSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export const contificoProductsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const contificoProductIdParamSchema = z.object({
  id: z.string().trim().min(1).max(100),
});

export const contificoImportBodySchema = z
  .object({
    contificoId: z.string().trim().min(1).max(100).optional(),
    sku: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => Boolean(value.contificoId || value.sku), {
    message: 'Debes indicar contificoId o sku.',
  });

export const contificoSyncBodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
  onlySku: z.string().trim().max(120).optional(),
  matchByName: z.boolean().optional().default(false),
  prune: z.boolean().optional().default(false),
  createMissing: z.boolean().optional().default(false),
});

export type ContificoSearchQuery = z.infer<typeof contificoSearchQuerySchema>;
export type ContificoProductsQuery = z.infer<typeof contificoProductsQuerySchema>;
export type ContificoProductIdParam = z.infer<typeof contificoProductIdParamSchema>;
export type ContificoImportBody = z.infer<typeof contificoImportBodySchema>;
export type ContificoSyncBody = z.infer<typeof contificoSyncBodySchema>;
