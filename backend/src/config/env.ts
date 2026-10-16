import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  DATABASE_URL: z.string().min(1),
  API_KEY: z.string().min(16),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  PUBLIC_URL_BASE: z.string().url().default('http://localhost:4100'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Variables de entorno inválidas (altosa-api):', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
