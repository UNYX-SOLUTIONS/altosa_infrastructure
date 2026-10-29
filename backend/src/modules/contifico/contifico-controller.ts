import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { asyncHandler } from '../../utils/async-handler';
import { sendSuccess } from '../../utils/api-response';
import * as contificoService from './contifico-service';
import { syncContificoCatalog } from './contifico-sync';
import {
  contificoImportBodySchema,
  contificoProductIdParamSchema,
  contificoProductsQuerySchema,
  contificoSearchQuerySchema,
  contificoSyncBodySchema,
  type ContificoImportBody,
  type ContificoProductIdParam,
  type ContificoProductsQuery,
  type ContificoSearchQuery,
  type ContificoSyncBody,
} from './contifico-schema';

export const status = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, await contificoService.getContificoStatus());
});

export const search = asyncHandler(async (req: Request, res: Response) => {
  const query = contificoSearchQuerySchema.parse(req.query) as ContificoSearchQuery;
  sendSuccess(
    res,
    await contificoService.searchContificoProductSuggestions(query.q, query.limit)
  );
});

export const listProducts = asyncHandler(async (req: Request, res: Response) => {
  const query = contificoProductsQuerySchema.parse(
    req.query
  ) as ContificoProductsQuery;
  sendSuccess(
    res,
    await contificoService.listContificoCatalogItems(query.search, query.limit)
  );
});

export const getProduct = asyncHandler(async (req: Request, res: Response) => {
  const params = contificoProductIdParamSchema.parse(
    req.params
  ) as ContificoProductIdParam;
  sendSuccess(res, await contificoService.getContificoCatalogItem(params.id));
});

export const listCategories = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, await contificoService.listContificoCategories());
});

export const importProduct = asyncHandler(async (req: Request, res: Response) => {
  const input = contificoImportBodySchema.parse(req.body) as ContificoImportBody;
  const result = await contificoService.importContificoProduct(input);
  sendSuccess(res, result, undefined, result.created ? StatusCodes.CREATED : StatusCodes.OK);
});

export const sync = asyncHandler(async (req: Request, res: Response) => {
  const body = contificoSyncBodySchema.parse(req.body ?? {}) as ContificoSyncBody;
  sendSuccess(res, await syncContificoCatalog(body));
});
