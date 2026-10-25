import { z } from 'zod';

export const metaCatalogSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const metaCatalogItemQuerySchema = z.object({
  retailerId: z.string().trim().min(1).max(100),
});

export type MetaCatalogSearchQuery = z.infer<typeof metaCatalogSearchQuerySchema>;
export type MetaCatalogItemQuery = z.infer<typeof metaCatalogItemQuerySchema>;
