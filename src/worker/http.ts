export function json<T>(data: T, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function problem(
  status: number,
  code: string,
  message: string,
  detail?: unknown
): Response {
  return json(
    {
      error: {
        code,
        message,
        detail
      }
    },
    { status }
  );
}

const DEFAULT_JSON_BODY_LIMIT_BYTES = 256 * 1024;

export async function parseJson<T>(
  request: Request,
  options: { maxBytes?: number } = {}
): Promise<T> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Expected JSON body');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES;
  try {
    return JSON.parse(await readLimitedText(request, maxBytes)) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, 'body_too_large', `JSON body must be at most ${maxBytes} bytes`);
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'body_too_large', `JSON body must be at most ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    detail?: unknown
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function isSafeOrigin(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  const origin = request.headers.get('Origin');
  if (!origin) {
    return false;
  }
  const originUrl = new URL(origin);
  const requestUrl = new URL(request.url);
  return originUrl.hostname === requestUrl.hostname;
}

export function strictSecurityHeaders(response: Response): Response {
  const upgradeResponse = response as unknown as { webSocket?: WebSocket | null };
  if (response.status === 101 || upgradeResponse.webSocket) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' wss: https:",
      "frame-src 'self' https:",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'self'"
    ].join('; ')
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function dynmapSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.delete('X-Frame-Options');
  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self' data: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function getClientIpPrefix(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (!ip) return '';
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':');
  }
  return ip.split('.').slice(0, 3).join('.');
}

export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

export function nowIso(): string {
  return new Date().toISOString();
}
