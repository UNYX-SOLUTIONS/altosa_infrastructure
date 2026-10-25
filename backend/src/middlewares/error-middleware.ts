import type { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { HttpError } from '../utils/api-response';

export function notFoundMiddleware(req: Request, res: Response): void {
  res.status(StatusCodes.NOT_FOUND).json({
    success: false,
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
    code: 'ALTOSA_API_NOT_FOUND',
  });
}

export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error instanceof ZodError) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      message: 'Parámetros inválidos.',
      code: 'ALTOSA_API_VALIDATION_ERROR',
      details: error.flatten().fieldErrors,
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'La imagen supera el tamaño máximo permitido (10 MB).'
        : `Error al subir el archivo: ${error.message}`;
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      message,
      code: 'ALTOSA_UPLOAD_ERROR',
    });
    return;
  }

  // Carrera entre dos asignaciones simultáneas: el índice único de la BD es la
  // última barrera, además de la validación de aplicación.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    res.status(StatusCodes.CONFLICT).json({
      success: false,
      message: 'El valor ya está en uso. Revisa el Retailer ID de Meta o los datos únicos.',
      code: 'ALTOSA_UNIQUE_CONFLICT',
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      success: false,
      message: error.message,
      code: error.code,
    });
    return;
  }

  logger.error({ err: error }, 'Error no controlado en altosa-api');
  res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
    success: false,
    message:
      env.NODE_ENV === 'production' ? 'Error interno del servidor.' : String(error),
    code: 'ALTOSA_API_INTERNAL_ERROR',
  });
}
