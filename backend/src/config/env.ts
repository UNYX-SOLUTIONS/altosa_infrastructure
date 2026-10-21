import 'dotenv/config';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  DATABASE_URL: z.string().min(1),
  API_KEY: z.string().min(16),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  PUBLIC_URL_BASE: z.string().url().default('http://localhost:4100'),
  KOMMO_API_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  KOMMO_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Variables de entorno inválidas (altosa-api):', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
