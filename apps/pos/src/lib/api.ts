import { useAuth } from '../store/auth';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: any,
  ) {
    super(typeof body?.message === 'string' ? body.message : body?.message?.message ?? `HTTP ${status}`);
  }
  get code(): string | undefined {
    return this.body?.code ?? this.body?.message?.code;
  }
}
export class OfflineError extends Error {
  constructor() {
    super('offline');
  }
}

const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api';

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { override?: string; timeoutMs?: number } = {}): Promise<T> {
  const { token, overrideToken } = useAuth.getState();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const ov = opts.override ?? overrideToken;
  if (ov) headers['x-override-token'] = ov;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(t);
    throw new OfflineError();
  }
  clearTimeout(t);
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (res.status === 401 && path !== '/auth/login') useAuth.getState().logout();
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
