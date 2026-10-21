import { env } from '../../config/env';
import { HttpError } from '../../utils/api-response';

const PAGE_SIZE = 250;
const MAX_PAGES = 100;
const TIMEOUT_MS = 30_000;

export interface KommoTemplateDto {
  id: number;
  account_id?: number;
  name?: string;
  content?: string;
  type?: string;
  is_editable?: boolean;
  created_at?: number;
  updated_at?: number;
  external_id?: string;
  [key: string]: unknown;
}

interface KommoTemplatesResponse {
  _embedded?: { chat_templates?: KommoTemplateDto[] };
  _links?: { next?: { href?: string } };
}

export function isKommoConfigured(): boolean {
  return Boolean(env.KOMMO_API_URL && env.KOMMO_API_KEY);
}

function requireConfig(): { baseUrl: string; token: string } {
  if (!env.KOMMO_API_URL || !env.KOMMO_API_KEY) {
    throw new HttpError(
      503,
      'Kommo no está configurado (faltan KOMMO_API_URL y KOMMO_API_KEY).',
      'KOMMO_NOT_CONFIGURED'
    );
  }
  return {
    baseUrl: env.KOMMO_API_URL.replace(/\/+$/, ''),
    token: env.KOMMO_API_KEY,
  };
}

async function fetchPage(
  page: number
): Promise<{ items: KommoTemplateDto[]; hasNext: boolean }> {
  const { baseUrl, token } = requireConfig();
  const url = `${baseUrl}/api/v4/chats/templates?page=${page}&limit=${PAGE_SIZE}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (response.status === 204) {
      return { items: [], hasNext: false };
    }

    const body = (await response.json().catch(() => null)) as KommoTemplatesResponse | null;

    if (!response.ok) {
      throw new HttpError(
        502,
        `Kommo respondió con estado ${response.status} (${response.statusText}).`,
        'KOMMO_API_ERROR'
      );
    }

    const items = Array.isArray(body?._embedded?.chat_templates)
      ? body._embedded.chat_templates
      : [];

    return {
      items,
      hasNext: Boolean(body?._links?.next?.href),
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Tiempo de espera agotado consultando Kommo.', 'KOMMO_TIMEOUT');
    }
    throw new HttpError(502, 'No se pudo conectar con la API de Kommo.', 'KOMMO_UNREACHABLE');
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchAllKommoTemplates(): Promise<KommoTemplateDto[]> {
  requireConfig();

  const all: KommoTemplateDto[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, hasNext } = await fetchPage(page);
    all.push(...items);
    if (!hasNext || items.length === 0) {
      break;
    }
  }

  return all;
}
