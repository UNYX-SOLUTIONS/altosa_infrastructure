import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { sendSuccess } from '../../utils/api-response';
import {
  externalHealthQuerySchema,
  externalImportBodySchema,
  externalMetaPendingQuerySchema,
  externalPendingQuerySchema,
  externalRepairBodySchema,
  type ExternalHealthQuery,
  type ExternalItemInput,
  type ExternalMetaPendingQuery,
  type ExternalPendingQuery,
  type ExternalRepairBody,
} from './external-schema';
import * as externalService from './external-service';

export async function getHealth(req: Request, res: Response): Promise<void> {
  const query = externalHealthQuerySchema.parse(req.query) as ExternalHealthQuery;
  sendSuccess(res, await externalService.getExternalHealth(query));
}

export async function repair(req: Request, res: Response): Promise<void> {
  const body = externalRepairBodySchema.parse(req.body) as ExternalRepairBody;
  sendSuccess(res, await externalService.repairExternalMapping(body));
}

export async function listPending(req: Request, res: Response): Promise<void> {
  const query = externalPendingQuerySchema.parse(req.query) as ExternalPendingQuery;
  sendSuccess(res, await externalService.listPendingExternalItems(query));
}

export async function listMetaPending(req: Request, res: Response): Promise<void> {
  const query = externalMetaPendingQuerySchema.parse(
    req.query
  ) as ExternalMetaPendingQuery;
  sendSuccess(res, await externalService.listMetaPending(query));
}

export async function listLinks(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await externalService.listExternalLinks());
}

export async function importItems(req: Request, res: Response): Promise<void> {
  const body = externalImportBodySchema.parse(req.body);
  const result = await externalService.importExternalItems(body.items as ExternalItemInput[]);
  sendSuccess(res, result, undefined, StatusCodes.CREATED);
}
