import { rateLimit } from 'express-rate-limit';

/**
 * Límite global para proteger la base del cliente incluso desde dentro
 * de la red Docker (defensa en profundidad ante un servicio comprometido).
 */
export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiadas solicitudes. Intenta de nuevo más tarde.',
    code: 'ALTOSA_API_RATE_LIMITED',
  },
});

export const metaRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiadas búsquedas en el catálogo de Meta. Intenta de nuevo más tarde.',
    code: 'META_RATE_LIMITED',
  },
});
