import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { StatusCodes } from 'http-status-codes';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import { getPrisma } from './config/prisma';
import { apiKeyMiddleware } from './middlewares/api-key-middleware';
import { errorMiddleware, notFoundMiddleware } from './middlewares/error-middleware';
import { globalRateLimiter } from './middlewares/rate-limit-middleware';
import { apiRouter } from './routes';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', false);

// Seguridad base: el servicio es interno (solo red Docker altosa_backend).
app.use(helmet());
app.use(compression());
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '100kb' }));

// Imágenes subidas (URLs públicas por diseño; se exponen vía Traefik en el VPS).
app.use(
  '/uploads',
  express.static(env.UPLOAD_DIR, {
    maxAge: '30d',
    immutable: true,
    index: false,
    fallthrough: true,
  })
);

app.get('/health', async (_req, res) => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    res.json({ success: true, data: { status: 'ok', database: 'up' } });
  } catch (error) {
    logger.error({ err: error }, 'Healthcheck de base de datos falló');
    res.status(StatusCodes.SERVICE_UNAVAILABLE).json({
      success: false,
      data: { status: 'degraded', database: 'down' },
    });
  }
});

// API privada: rate limit + API key servicio-a-servicio (sin CORS, sin navegador).
app.use('/api/v1', globalRateLimiter, apiKeyMiddleware, apiRouter);

app.use(notFoundMiddleware);
app.use(errorMiddleware);
