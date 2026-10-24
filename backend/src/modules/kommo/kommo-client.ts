import { env } from '../../config/env';
import { HttpError } from '../../utils/api-response';

const PAGE_SIZE = 250;
const MAX_PAGES = 100;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface KommoPageAttempt {
  status: number;
  statusText: string;
  body: KommoTemplatesResponse | null;
  retryAfterMs: number | null;
}

async function fetchPageAttempt(url: string, token: string): Promise<KommoPageAttempt> {
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
      return {
        status: 204,
        statusText: response.statusText,
        body: null,
        retryAfterMs: null,
      };
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const body = (await response.json().catch(() => null)) as KommoTemplatesResponse | null;

    return {
      status: response.status,
      statusText: response.statusText,
      body,
      retryAfterMs:
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10_000)
          : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPage(
  page: number
): Promise<{ items: KommoTemplateDto[]; hasNext: boolean }> {
  const { baseUrl, token } = requireConfig();
  const url = `${baseUrl}/api/v4/chats/templates?page=${page}&limit=${PAGE_SIZE}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const result = await fetchPageAttempt(url, token);

      if (result.status === 204) {
        return { items: [], hasNext: false };
      }

      if (result.status === 401 || result.status === 403) {
        throw new HttpError(
          502,
          'Kommo rechazó el token o la integración no tiene permisos para listar plantillas.',
          'KOMMO_UNAUTHORIZED'
        );
      }

      if (result.status === 429 || result.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const delay = result.retryAfterMs ?? RETRY_BASE_MS * 2 ** attempt;
          await sleep(delay);
          continue;
        }
        throw new HttpError(
          502,
          `Kommo respondió con estado ${result.status} (${result.statusText}).`,
          'KOMMO_API_ERROR'
        );
      }

      if (result.status < 200 || result.status >= 300) {
        throw new HttpError(
          502,
          `Kommo respondió con estado ${result.status} (${result.statusText}).`,
          'KOMMO_API_ERROR'
        );
      }

      const items = Array.isArray(result.body?._embedded?.chat_templates)
        ? result.body._embedded.chat_templates
        : [];

      return {
        items,
        hasNext: Boolean(result.body?._links?.next?.href),
      };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HttpError(504, 'Tiempo de espera agotado consultando Kommo.', 'KOMMO_TIMEOUT');
      }
      throw new HttpError(502, 'No se pudo conectar con la API de Kommo.', 'KOMMO_UNREACHABLE');
    }
  }

  throw new HttpError(502, 'No se pudo consultar Kommo.', 'KOMMO_UNREACHABLE');
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
