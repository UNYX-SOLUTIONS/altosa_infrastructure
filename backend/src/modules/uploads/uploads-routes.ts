import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { StatusCodes } from 'http-status-codes';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { HttpError, sendSuccess } from '../../utils/api-response';
import { asyncHandler } from '../../utils/async-handler';

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 82;
const OPTIMIZE_THRESHOLD_BYTES = 400 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function hasValidImageSignature(filePath: string, mimetype: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    if (bytesRead < 4) {
      return false;
    }
    if (mimetype === 'image/png') {
      return bytesRead >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
    }
    if (mimetype === 'image/jpeg') {
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (mimetype === 'image/gif') {
      return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
    }
    if (mimetype === 'image/webp') {
      return (
        bytesRead >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Normaliza la imagen almacenada: corrige orientación EXIF, redimensiona a
 * máx. 1600px y re-codifica a JPEG (elimina metadatos). Si el resultado no es
 * más pequeño, conserva el original. Los GIF se dejan intactos (animación).
 */
async function optimizeStoredImage(file: Express.Multer.File): Promise<void> {
  if (file.mimetype === 'image/gif') {
    return;
  }

  try {
    const metadata = await sharp(file.path).metadata();
    const longestSide = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    const needsResize = longestSide > MAX_DIMENSION;
    const needsReencode = file.mimetype !== 'image/jpeg' || file.size > OPTIMIZE_THRESHOLD_BYTES;

    if (!needsResize && !needsReencode) {
      return;
    }

    const tempPath = `${file.path}.tmp.jpg`;
    await sharp(file.path)
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#FFFFFF' })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toFile(tempPath);

    const optimized = await stat(tempPath);
    if (optimized.size >= file.size && !needsResize) {
      await unlink(tempPath).catch(() => undefined);
      return;
    }

    const finalFilename = `${file.filename.replace(/\.[^.]+$/, '')}.jpg`;
    const finalPath = join(variantsDir, finalFilename);
    await rename(tempPath, finalPath);
    if (finalPath !== file.path) {
      await unlink(file.path).catch(() => undefined);
    }

    file.filename = finalFilename;
    file.path = finalPath;
    file.mimetype = 'image/jpeg';
    file.size = optimized.size;
  } catch (error) {
    logger.warn(
      { err: error, file: file.filename },
      'No se pudo optimizar la imagen subida; se conserva el original'
    );
  }
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const variantsDir = join(env.UPLOAD_DIR, 'variants');
mkdirSync(variantsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, variantsDir);
  },
  filename: (_req, file, callback) => {
    const extension = ALLOWED_MIME[file.mimetype] ?? extname(file.originalname) ?? '.bin';
    callback(null, `${randomUUID()}${extension}`);
  },
});

export const imageUpload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME[file.mimetype]) {
      callback(
        new HttpError(
          StatusCodes.BAD_REQUEST,
          'Formato no permitido. Usa JPG, PNG, WEBP o GIF.',
          'ALTOSA_UPLOAD_INVALID_TYPE'
        )
      );
      return;
    }
    callback(null, true);
  },
});

export const uploadsRouter = Router();

uploadsRouter.post(
  '/variants',
  imageUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new HttpError(
        StatusCodes.BAD_REQUEST,
        'Archivo requerido (campo "file").',
        'ALTOSA_UPLOAD_MISSING_FILE'
      );
    }

    // Defensa en profundidad: verifica la firma binaria real del archivo,
    // no solo el MIME declarado por el cliente.
    const validSignature = await hasValidImageSignature(req.file.path, req.file.mimetype);
    if (!validSignature) {
      await unlink(req.file.path).catch(() => undefined);
      throw new HttpError(
        StatusCodes.BAD_REQUEST,
        'El archivo no es una imagen válida (JPG, PNG, WEBP o GIF).',
        'ALTOSA_UPLOAD_INVALID_CONTENT'
      );
    }

    // Optimización final en servidor (garantiza que nada pesado llegue a la DB
    // ni a los flujos externos: n8n, Kommo, Meta, catálogos).
    await optimizeStoredImage(req.file);

    const relativePath = `/uploads/variants/${req.file.filename}`;
    sendSuccess(
      res,
      {
        url: `${env.PUBLIC_URL_BASE.replace(/\/+$/, '')}${relativePath}`,
        path: relativePath,
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
      undefined,
      StatusCodes.CREATED
    );
  })
);
