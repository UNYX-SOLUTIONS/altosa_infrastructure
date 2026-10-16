import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { env } from '../config/env';

function safeCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Autenticación servicio-a-servicio mediante API key.
 * Este API es interno: solo el backend del ERP (u otros servicios de la red
 * altosa_backend) deben llamarlo. No hay usuarios finales ni JWT aquí.
 */
export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-api-key');

  if (!provided || !safeCompare(provided, env.API_KEY)) {
    res.status(StatusCodes.UNAUTHORIZED).json({
      success: false,
      message: 'API key inválida o ausente.',
      code: 'ALTOSA_API_UNAUTHORIZED',
    });
    return;
  }

  next();
}
