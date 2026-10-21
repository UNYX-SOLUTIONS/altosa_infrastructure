import type { Prisma } from '@prisma/client';
import { getPrisma } from '../../config/prisma';
import { HttpError } from '../../utils/api-response';
import { fetchAllKommoTemplates, isKommoConfigured } from './kommo-client';

export interface KommoTemplateItem {
  id: string;
  kommoId: number;
  name: string;
  type: string;
  content: string | null;
  isActive: boolean;
  updatedAt: Date;
}

export interface KommoSyncResult {
  fetched: number;
  created: number;
  updated: number;
  deactivated: number;
}

function mapTemplate(template: KommoTemplateItem): KommoTemplateItem {
  return template;
}

export async function searchTemplates(
  search: string | undefined,
  limit: number
): Promise<KommoTemplateItem[]> {
  const prisma = getPrisma();
  const term = search?.trim();

  const where: Prisma.KommoTemplateWhereInput = {
    isActive: true,
    ...(term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { content: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const templates = await prisma.kommoTemplate.findMany({
    where,
    orderBy: { name: 'asc' },
    take: limit,
  });

  return templates.map(mapTemplate);
}

export async function syncTemplates(): Promise<KommoSyncResult> {
  if (!isKommoConfigured()) {
    throw new HttpError(
      503,
      'Kommo no está configurado (faltan KOMMO_API_URL y KOMMO_API_KEY).',
      'KOMMO_NOT_CONFIGURED'
    );
  }

  const fetched = await fetchAllKommoTemplates();
  const prisma = getPrisma();

  let created = 0;
  let updated = 0;
  const seen: number[] = [];

  for (const template of fetched) {
    const kommoId = Number(template.id);
    if (!Number.isInteger(kommoId)) {
      continue;
    }

    const name = template.name?.trim() || `Plantilla ${kommoId}`;
    const type = template.type?.trim() || 'amocrm';
    const content = template.content ?? null;
    const data = { name, type, content, isActive: true };

    const existing = await prisma.kommoTemplate.findUnique({
      where: { kommoId },
      select: { id: true },
    });

    if (existing) {
      await prisma.kommoTemplate.update({ where: { kommoId }, data });
      updated += 1;
    } else {
      await prisma.kommoTemplate.create({ data: { kommoId, ...data } });
      created += 1;
    }

    seen.push(kommoId);
  }

  let deactivated = 0;
  if (seen.length > 0) {
    const result = await prisma.kommoTemplate.updateMany({
      where: { isActive: true, kommoId: { notIn: seen } },
      data: { isActive: false },
    });
    deactivated = result.count;
  }

  return { fetched: fetched.length, created, updated, deactivated };
}
