import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/api-response';
import { kommoTemplatesQuerySchema } from './kommo-schema';
import * as kommoService from './kommo-service';

export async function listTemplates(req: Request, res: Response): Promise<void> {
  const query = kommoTemplatesQuerySchema.parse(req.query);
  const templates = await kommoService.searchTemplates(query.search, query.limit);
  sendSuccess(res, templates);
}

export async function syncTemplates(_req: Request, res: Response): Promise<void> {
  const result = await kommoService.syncTemplates();
  sendSuccess(res, result);
}
