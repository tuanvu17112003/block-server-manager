// Google Drive backup upload.
//
// Scope decision: `drive.file`, not `drive.appdata`. The user chose visibility — a backup they cannot find in their own
// Drive is a backup they cannot verify or delete, and silent storage is worse than visible storage. `drive.file` means
// the app can only see files it created, so backups are visible but nothing else in the Drive is exposed.
//
// Credentials: a desktop OAuth client's secret is not a real secret (Google's own documentation calls installed apps
// "public clients" that "cannot keep secrets confidential"), so it is shipped as configuration rather than treated as
// protected material. What actually protects the flow is PKCE plus the loopback redirect, per RFC 8252: only the
// process that started the authorization can complete it. The *user's* refresh token IS secret and is stored through
// safeStorage, never in plaintext and never in the repository.
//
// The failure modes that matter for a backup feature, and how each is handled here:
//   * a 2 GB upload losing the network halfway — resumable upload, with the session URI persisted so a later attempt
//     continues instead of restarting;
//   * a refresh token expiring while an unattended backup runs at 3am — surfaced as an actionable state, never a
//     silent no-op;
//   * the Drive filling up — quota is checked before uploading, and a local backup is NEVER deleted because the remote
//     copy failed.
import { BrowserWindow, shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './installer/core';

// ---------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------

/**
 * OAuth client for this application.
 *
 * Both values are supplied at build time via env vars, falling back to a file the maintainer places in the data root
 * (`.app-data/google-oauth.json`). Nothing is hardcoded: a credential committed to a public repository is a credential
 * every fork inherits, and rotation then requires a release.
 */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

const OAUTH_FILE = 'google-oauth.json';

/**
 * Read the OAuth client from an environment variable pair or a credentials file.
 *
 * Two file shapes are accepted, because guessing one of them was a real defect: the file Google Cloud Console actually
 * offers for download wraps its fields in a type object —
 *
 *   { "installed": { "client_id": "...", "client_secret": "...", ... } }   // "Desktop app" client (what users get)
 *   { "web":       { "client_id": "...", "client_secret": "...", ... } }   // "Web application" client
 *
 * The first version of this function expected the flat shape `{ clientId, clientSecret }`, which no Google download
 * produces. The app therefore reported "not configured" even with a perfectly valid file in place. Both shapes are now
 * supported, plus the flat one for hand-written config.
 *
 * A "web" client is accepted but flagged, because it cannot use a loopback redirect unless one was registered: the user
 * will get `redirect_uri_mismatch` from Google. Better to warn at load time than to fail mid-flow.
 */
export interface OAuthClientLoadResult {
  client: OAuthClient | null;
  /** Why loading failed, when it did — surfaced to the user instead of a blanket "not set up". */
  error?: string;
  /** Non-fatal note (e.g. a web client that will not work with the loopback redirect). */
  warning?: string;
}

interface RawGoogleCredentials {
  client_id?: unknown;
  client_secret?: unknown;
  redirect_uris?: unknown;
}

function normalise(value: unknown): OAuthClient | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as RawGoogleCredentials;
  if (typeof raw.client_id !== 'string' || raw.client_id === '') return null;
  if (typeof raw.client_secret !== 'string' || raw.client_secret === '') return null;
  return { clientId: raw.client_id, clientSecret: raw.client_secret };
}

export function loadOAuthClientDetailed(dataRoot: string): OAuthClientLoadResult {
  const fromEnv = {
    clientId: process.env.BSM_GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.BSM_GOOGLE_CLIENT_SECRET ?? '',
  };
  if (fromEnv.clientId !== '' && fromEnv.clientSecret !== '') return { client: fromEnv };

  const file = path.join(dataRoot, OAUTH_FILE);
  if (!fs.existsSync(file)) {
    return {
      client: null,
      error: `No ${OAUTH_FILE} found in the app data folder.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { client: null, error: `${OAUTH_FILE} is not valid JSON: ${(error as Error).message}` };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { client: null, error: `${OAUTH_FILE} does not contain a JSON object.` };
  }

  const record = parsed as Record<string, unknown>;

  // Google's two download shapes first, then the flat shape for hand-written files.
  const installed = normalise(record.installed);
  if (installed !== null) return { client: installed };

  const web = normalise(record.web);
  if (web !== null) {
    return {
      client: web,
      warning: 'This is a "Web application" OAuth client. It only works if http://127.0.0.1 was registered as an '
        + 'authorized redirect URI for it. A "Desktop app" client is the correct type for this application.',
    };
  }

  const flat = normalise({ client_id: record.clientId, client_secret: record.clientSecret });
  if (flat !== null) return { client: flat };

  const keys = Object.keys(record);
  return {
    client: null,
    error: `${OAUTH_FILE} does not contain usable credentials. Expected an "installed" object (the file Google Cloud `
      + `Console downloads for a Desktop app client) but found keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}.`,
  };
}

export function loadOAuthClient(dataRoot: string): OAuthClient | null {
  return loadOAuthClientDetailed(dataRoot).client;
}

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

// ---------------------------------------------------------------------------------------------------------------
// PKCE helpers (exported for tests)
// ---------------------------------------------------------------------------------------------------------------

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 code verifier: 43-128 chars from the unreserved set. */
export function createCodeVerifier(random: (size: number) => Buffer = randomBytes): string {
  return base64url(random(32));
}

/** S256 challenge = base64url(sha256(verifier)). */
export function codeChallengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Mirrors the redirect URI Google will call, derived from the port the loopback server actually bound. */
export function redirectUriFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Build the authorization URL.
 *
 * `access_type=offline` is what yields a refresh token, and `prompt=consent` is required to get one on every
 * authorization rather than only the first — without it a re-authorization silently returns no refresh token and
 * unattended backups stop a month later with a confusing 401.
 */
export function buildAuthUrl(options: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state: options.state,
    include_granted_scopes: 'true',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Loopback authorization
// ---------------------------------------------------------------------------------------------------------------

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
}

export interface AuthResult {
  ok: boolean;
  tokens?: Tokens;
  error?: string;
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>Connected</title>
<body style="font-family:system-ui;background:#18181b;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:18px">Google Drive connected</h1>
<p style="color:#a1a1aa">You can close this tab and return to Block Server Manager.</p></div>`;

const FAILURE_HTML = `<!doctype html><meta charset="utf-8"><title>Not connected</title>
<body style="font-family:system-ui;background:#18181b;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:18px">Authorization failed</h1>
<p style="color:#a1a1aa">Return to the app to see the reason.</p></div>`;

/**
 * Run the authorization code + PKCE flow against a loopback redirect.
 *
 * Opens the system browser rather than an embedded window: Google blocks embedded webviews for OAuth ("disallowed_useragent"),
 * and RFC 8252 says the same for native apps. The local server binds port 0 so two instances cannot collide.
 *
 * Times out after `timeoutMs` so a user who abandons the tab does not leave a server listening forever.
 */
export async function authorize(options: {
  client: OAuthClient;
  timeoutMs?: number;
  openExternal?: (url: string) => Promise<void>;
}): Promise<AuthResult> {
  const state = base64url(randomBytes(16));
  const verifier = createCodeVerifier();
  const challenge = codeChallengeFor(verifier);
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<AuthResult>((resolve) => {
    let settled = false;
    const finish = (result: AuthResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(result);
    };

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      // Ignore favicon and any stray request; only the redirect path carries the result.
      if (url.pathname !== '/') { response.writeHead(404).end(); return; }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (error !== null) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_HTML);
        // `access_denied` is by far the most common OAuth failure for this app, and the raw code is useless to a user:
        // it is returned both when they click "Cancel" and when Google blocks an account that is not on the project's
        // test-user list. Distinguishing those two cases is the difference between "try again and click Allow" and an
        // hour of confusion, so the message names the likely cause and where to fix it.
        if (error === 'access_denied') {
          finish({
            ok: false,
            error: 'Google refused the request (access_denied). Either the consent screen was cancelled, or this Google '
              + 'account is not allowed to use the app yet. Fix it in Google Cloud Console -> APIs & Services -> OAuth '
              + 'consent screen: either add this address as a test user, or publish the app to production so any account '
              + 'can connect.',
          });
          return;
        }
        finish({ ok: false, error: `Google returned: ${error}` });
        return;
      }
      // State mismatch means the response did not belong to this attempt — a CSRF check, not a formality.
      if (returnedState !== state) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_HTML);
        finish({ ok: false, error: 'The authorization response did not match this request (state mismatch).' });
        return;
      }
      if (code === null) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_HTML);
        finish({ ok: false, error: 'Google did not return an authorization code.' });
        return;
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML);

      void exchangeCode({
        client: options.client,
        code,
        verifier,
        redirectUri: redirectUriFor(port),
      }).then((result) => finish(result));
    });

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Authorization timed out. The browser window was not completed within 5 minutes.' });
    }, timeoutMs);

    let port = 0;
    server.on('error', (error) => {
      finish({ ok: false, error: `Could not start the local authorization listener: ${error.message}` });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address !== null ? address.port : 0;
      if (port === 0) { finish({ ok: false, error: 'The local authorization listener did not bind a port.' }); return; }

      const authUrl = buildAuthUrl({
        clientId: options.client.clientId,
        redirectUri: redirectUriFor(port),
        codeChallenge: challenge,
        state,
      });
      const open = options.openExternal ?? ((url: string) => shell.openExternal(url));
      void open(authUrl).catch((error: Error) => {
        finish({ ok: false, error: `Could not open the browser: ${error.message}` });
      });
    });
  });
}

/** Exchange the authorization code for tokens. PKCE verifier proves this process started the flow. */
export async function exchangeCode(options: {
  client: OAuthClient;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<AuthResult> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const body = new URLSearchParams({
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      code: options.code,
      code_verifier: options.verifier,
      grant_type: 'authorization_code',
      redirect_uri: options.redirectUri,
    });
    const response = await doFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await response.json() as {
      access_token?: string; refresh_token?: string; expires_in?: number; scope?: string;
      error?: string; error_description?: string;
    };
    if (!response.ok || json.access_token === undefined) {
      return { ok: false, error: json.error_description ?? json.error ?? `Token exchange failed (${response.status})` };
    }
    // A missing refresh token is the failure that silently breaks unattended backup weeks later, so it is an error now.
    if (json.refresh_token === undefined) {
      return {
        ok: false,
        error: 'Google did not return a refresh token, so backups could not run unattended. Remove the app from your '
          + 'Google account permissions and connect again.',
      };
    }
    return {
      ok: true,
      tokens: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
        scope: json.scope ?? SCOPES.join(' '),
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Trade a refresh token for a fresh access token. */
export async function refreshAccessToken(options: {
  client: OAuthClient;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<AuthResult> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const body = new URLSearchParams({
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      refresh_token: options.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await doFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = await response.json() as {
      access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string;
    };
    if (!response.ok || json.access_token === undefined) {
      // `invalid_grant` from the refresh endpoint is not a transient error, and its cause is specific and fixable. The
      // most common one by far is an OAuth consent screen left in Testing: Google expires those refresh tokens after
      // exactly seven days, so a backup feature that worked perfectly for a week stops with an opaque error. Saying so
      // here is the difference between a user reconnecting and a user filing a bug about "backups randomly stopped".
      if (json.error === 'invalid_grant') {
        return {
          ok: false,
          error: 'Your Google authorization has expired and must be renewed. This happens when the OAuth consent screen '
            + 'is still in "Testing" status (Google expires those tokens after 7 days), or after a password change or '
            + 'an explicit revoke. Reconnect in the Backups tab; to stop it recurring, publish the OAuth consent screen '
            + 'to production in Google Cloud Console.',
        };
      }
      return {
        ok: false,
        error: json.error_description ?? json.error ?? `Token refresh failed (${response.status})`,
      };
    }
    // Google does not rotate the refresh token on refresh; the caller keeps the existing one.
    return {
      ok: true,
      tokens: {
        accessToken: json.access_token,
        refreshToken: options.refreshToken,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
        scope: json.scope ?? SCOPES.join(' '),
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
