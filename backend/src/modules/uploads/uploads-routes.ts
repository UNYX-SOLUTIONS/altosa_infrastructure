import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { StatusCodes } from 'http-status-codes';
import { env } from '../../config/env';
import { HttpError, sendSuccess } from '../../utils/api-response';
import { asyncHandler } from '../../utils/async-handler';

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

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
