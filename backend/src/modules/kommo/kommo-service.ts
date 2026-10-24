import type { Prisma } from '@prisma/client';
import { getPrisma } from '../../config/prisma';
import { HttpError } from '../../utils/api-response';
import {
  fetchAllKommoTemplates,
  isKommoConfigured,
  type KommoTemplateDto,
} from './kommo-client';

export interface KommoTemplateItem {
  id: string;
  kommoId: number;
  name: string;
  type: string;
  content: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface KommoSyncResult {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
}

export async function searchTemplates(
  search: string | undefined,
  limit: number
): Promise<KommoTemplateItem[]> {
  const prisma = getPrisma();
  const term = search?.trim();

  const numericTerm = Number(term);
  const where: Prisma.KommoTemplateWhereInput = {
    isActive: true,
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { content: { contains: term, mode: 'insensitive' } },
            ...(Number.isInteger(numericTerm) && numericTerm > 0
              ? [{ kommoId: numericTerm }]
              : []),
          ],
        }
      : {}),
  };

  return prisma.kommoTemplate.findMany({
    where,
    orderBy: { name: 'asc' },
    take: limit,
  });
}

function normalizeTemplate(template: KommoTemplateDto): {
  kommoId: number;
  name: string;
  type: string;
  content: string | null;
} | null {
  const kommoId = Number(template.id);
  if (!Number.isInteger(kommoId)) {
    return null;
  }

  return {
    kommoId,
    name: template.name?.trim() || `Plantilla ${kommoId}`,
    type: template.type?.trim() || 'amocrm',
    content: template.content ?? null,
  };
}

async function runSync(): Promise<KommoSyncResult> {
  if (!isKommoConfigured()) {
    throw new HttpError(
      503,
      'Kommo no está configurado (faltan KOMMO_API_URL y KOMMO_API_KEY).',
      'KOMMO_NOT_CONFIGURED'
    );
  }

  const fetched = await fetchAllKommoTemplates();
  const templates = new Map<
    number,
    { kommoId: number; name: string; type: string; content: string | null }
  >();

  for (const template of fetched) {
    const normalized = normalizeTemplate(template);
    if (normalized) {
      templates.set(normalized.kommoId, normalized);
    }
  }

  const values = Array.from(templates.values());

  if (values.length === 0) {
    return {
      fetched: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
    };
  }

  const prisma = getPrisma();
  const kommoIds = values.map((template) => template.kommoId);
  const existing = await prisma.kommoTemplate.findMany({
    where: { kommoId: { in: kommoIds } },
    select: {
      id: true,
      kommoId: true,
      name: true,
      type: true,
      content: true,
      isActive: true,
    },
  });
  const existingByKommoId = new Map(
    existing.map((template) => [template.kommoId, template])
  );

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const template of values) {
        const current = existingByKommoId.get(template.kommoId);

        if (!current) {
          await tx.kommoTemplate.create({ data: template });
          created += 1;
          continue;
        }

        const isUnchanged =
          current.name === template.name &&
          current.type === template.type &&
          current.content === template.content &&
          current.isActive;

        if (isUnchanged) {
          unchanged += 1;
          continue;
        }

        await tx.kommoTemplate.update({
          where: { kommoId: template.kommoId },
          data: { ...template, isActive: true },
        });
        updated += 1;
      }
    },
    { timeout: 120_000, maxWait: 10_000 }
  );

  return {
    fetched: values.length,
    created,
    updated,
    unchanged,
    // No se desactivan automáticamente plantillas ausentes: la API de Kommo
    // puede devolver solo las creadas por una integración concreta.
    deactivated: 0,
  };
}

let syncInFlight: Promise<KommoSyncResult> | null = null;

/**
 * Evita sincronizaciones concurrentes (doble clic, varios usuarios) y devuelve
 * el mismo resultado a las llamadas que lleguen mientras corre.
 */
export function syncTemplates(): Promise<KommoSyncResult> {
  if (!isKommoConfigured()) {
    return Promise.reject(
      new HttpError(
        503,
        'Kommo no está configurado (faltan KOMMO_API_URL y KOMMO_API_KEY).',
        'KOMMO_NOT_CONFIGURED'
      )
    );
  }

  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = runSync().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}
