import { StatusCodes } from 'http-status-codes';
import { getPrisma } from '../../config/prisma';
import { HttpError } from '../../utils/api-response';

export interface ResolvedEstados {
  activeId: number;
  inactiveId: number;
}

/**
 * Estados activo/inactivo de Altosa. Compartido por el CRUD, el sync y la
 * ingesta externa para que todos creen filas con la misma semántica.
 */
export async function resolveSyncEstados(): Promise<ResolvedEstados> {
  const estados = await getPrisma().estado.findMany({ orderBy: { id: 'asc' } });
  if (estados.length === 0) {
    throw new HttpError(
      StatusCodes.PRECONDITION_FAILED,
      'No hay estados configurados en la base de datos de Altosa.',
      'ALTOSA_ESTADOS_NOT_CONFIGURED'
    );
  }

  const active =
    estados.find((estado) => estado.permiteRag) ??
    estados.find((estado) => /activ|aprob/i.test(estado.estado)) ??
    estados[0]!;
  const inactive =
    estados.find((estado) => /inactiv|desactiv/i.test(estado.estado)) ?? active;

  return { activeId: active.id, inactiveId: inactive.id };
}
