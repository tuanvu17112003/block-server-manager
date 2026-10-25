export interface RuntimeBackendConfig {
  apiBaseUrl: string;
}

const DEFAULT_CONFIG: RuntimeBackendConfig = { apiBaseUrl: '' };
let runtimeConfig = DEFAULT_CONFIG;
let configError: string | null = null;
let initialized = false;

export async function initializeBackendConfig(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // Electron desktop host: the backend is in-process (window.electronAPI); no HTTP config exists
  // and fetch under file:// would fail — resolve empty and let the adapter own the routing.
  if (typeof window !== 'undefined' && window.electronAPI !== undefined) return;

  try {
    const configUrl = new URL(`${import.meta.env.BASE_URL}backend-config.json`, document.baseURI);
    const response = await fetch(configUrl, { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`Could not load backend-config.json (HTTP ${response.status}).`);

    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('apiBaseUrl' in value)) {
      throw new Error('backend-config.json must contain an apiBaseUrl string.');
    }
    const apiBaseUrl = (value as { apiBaseUrl: unknown }).apiBaseUrl;
    if (typeof apiBaseUrl !== 'string') {
      throw new Error('backend-config.json apiBaseUrl must be a string.');
    }
    runtimeConfig = { apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) };
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
    console.error('[backend-config]', configError);
  }
}

export function isHttpBackendConfigured(): boolean {
  return runtimeConfig.apiBaseUrl.length > 0 || configError !== null;
}

export function getBackendConfigError(): string | null {
  return configError;
}

export function backendApiUrl(path: string): string {
  if (configError) throw new Error(configError);
  if (!runtimeConfig.apiBaseUrl) throw new Error('No backend API is configured. Set apiBaseUrl in backend-config.json.');
  const base = runtimeConfig.apiBaseUrl.endsWith('/')
    ? runtimeConfig.apiBaseUrl
    : `${runtimeConfig.apiBaseUrl}/`;
  return new URL(path.replace(/^\//, ''), new URL(base, window.location.href)).toString();
}

function normalizeApiBaseUrl(input: string): string {
  const value = input.trim();
  if (!value) return '';
  const resolved = new URL(value, window.location.href);
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error('Backend API URL must use HTTP or HTTPS.');
  }
  if (resolved.username || resolved.password || resolved.search || resolved.hash) {
    throw new Error('Backend API URL cannot include credentials, a query, or a fragment.');
  }
  return resolved.toString().replace(/\/+$/, '');
}
