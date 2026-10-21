import { z } from 'zod';

export const kommoTemplatesQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type KommoTemplatesQuery = z.infer<typeof kommoTemplatesQuerySchema>;
