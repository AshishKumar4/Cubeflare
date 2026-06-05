export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    let code: string | undefined;
    let detail: unknown;
    try {
      const body = JSON.parse(text) as { error?: { message?: string; code?: string; detail?: unknown } };
      message = body.error?.message ?? text;
      code = body.error?.code;
      detail = body.error?.detail;
    } catch {
      // Keep raw text.
    }
    throw new ApiError(message, response.status, code, detail);
  }
  return response.json() as Promise<T>;
}

export function wsUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
