import { env } from '../../config/env';
import { HttpError } from '../../utils/api-response';

const DEFAULT_TIMEOUT_MS = 30_000;

export function isContificoConfigured(): boolean {
  return Boolean(env.CONTIFICO_API_KEY);
}

function requireApiKey(): string {
  if (!env.CONTIFICO_API_KEY) {
    throw new HttpError(
      503,
      'La integración con Contifico no está configurada (falta CONTIFICO_API_KEY).',
      'CONTIFICO_NOT_CONFIGURED'
    );
  }
  return env.CONTIFICO_API_KEY;
}

function buildUrl(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
  baseUrl?: string
): URL {
  const configuredBase = baseUrl ?? env.CONTIFICO_API_URL;
  const base = configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`;
  const url = new URL(path.replace(/^\/+/, ''), base);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

interface ContificoErrorBody {
  message?: string;
  mensaje?: string;
  error?: string;
  errors?: unknown;
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const candidate = body as ContificoErrorBody;
  return candidate.message ?? candidate.mensaje ?? candidate.error ?? null;
}

export async function contificoRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options?: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    includePosToken?: boolean;
    baseUrl?: string;
  }
): Promise<T> {
  const apiKey = requireApiKey();
  const query = { ...options?.query };
  if (options?.includePosToken && env.CONTIFICO_API_TOKEN) {
    query.pos = env.CONTIFICO_API_TOKEN;
  }

  const url = buildUrl(path, query, options?.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: apiKey,
        Accept: 'application/json',
        ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      throw new HttpError(
        502,
        extractErrorMessage(body) ??
          `Contifico respondió con estado ${response.status} (${response.statusText}).`,
        'CONTIFICO_API_ERROR'
      );
    }

    return body as T;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Tiempo de espera agotado consultando Contifico.', 'CONTIFICO_TIMEOUT');
    }
    throw new HttpError(502, 'No se pudo conectar con la API de Contifico.', 'CONTIFICO_UNREACHABLE');
  } finally {
    clearTimeout(timeout);
  }
}

export function contificoGet<T>(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
  baseUrl?: string
): Promise<T> {
  return contificoRequest<T>('GET', path, { query, baseUrl });
}

export function contificoPost<T>(path: string, body: unknown): Promise<T> {
  return contificoRequest<T>('POST', path, { body });
}

export function contificoPatch<T>(path: string, body: unknown): Promise<T> {
  return contificoRequest<T>('PATCH', path, { body });
}

export function contificoPut<T>(path: string, body: unknown): Promise<T> {
  return contificoRequest<T>('PUT', path, { body });
}
