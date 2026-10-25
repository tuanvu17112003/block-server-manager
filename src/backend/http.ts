import { backendApiUrl } from './config';

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: string; message?: string };
}

export class BackendApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'BackendApiError';
    this.code = code;
    this.status = status;
  }
}

export async function invokeHttp<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(backendApiUrl('rpc'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  return readEnvelope<T>(response);
}

export async function uploadHttp<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await fetch(backendApiUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    body: form,
  });
  return readEnvelope<T>(response);
}

export function subscribeHttp<T>(topic: string, callback: (payload: T) => void): () => void {
  const url = new URL(backendApiUrl('events'));
  url.searchParams.set('topic', topic);
  const stream = new EventSource(url.toString(), { withCredentials: true });
  stream.onmessage = (event) => {
    try {
      callback(JSON.parse(event.data) as T);
    } catch (error) {
      console.error(`[backend-event] Invalid JSON on ${topic}.`, error);
    }
  };
  stream.onerror = () => {
    // EventSource reconnects automatically. Do not flood the UI while a
    // backend is restarting or a network is temporarily unavailable.
    console.warn(`[backend-event] Connection interrupted for ${topic}; reconnecting.`);
  };
  return () => stream.close();
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text();
  if (!response.ok) {
    const error = extractError(payload);
    throw new BackendApiError(error.message, error.code, response.status);
  }
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = extractError(payload);
    throw new BackendApiError(error.message, error.code, response.status);
  }
  if (payload && typeof payload === 'object' && 'result' in payload) {
    return (payload as RpcEnvelope<T>).result as T;
  }
  if (response.status === 204 || payload === '') return undefined as T;
  throw new BackendApiError('Backend returned a response without a result envelope.', 'invalid-response', response.status);
}

function extractError(payload: unknown): { code: string; message: string } {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const candidate = error as { code?: unknown; message?: unknown };
      return {
        code: typeof candidate.code === 'string' ? candidate.code : 'backend-error',
        message: typeof candidate.message === 'string' ? candidate.message : 'Backend request failed.',
      };
    }
  }
  if (typeof payload === 'string' && payload.trim()) {
    return { code: 'http-error', message: payload };
  }
  return { code: 'http-error', message: 'Backend request failed.' };
}
