// Google Drive backup, wired into the app: token storage, IPC handlers and the connection lifecycle.
//
// Token storage follows the existing CurseForge-key pattern in services/secrets.ts rather than inventing a second
// scheme: `safeStorage` (OS keystore) with a clearly-marked fallback, files written 0600, and no token material ever
// leaving the main process — the renderer only ever receives a status summary.
//
// The refresh token is the sensitive part. The OAuth *client* secret is not: Google documents installed applications as
// public clients that cannot keep secrets, and PKCE plus the loopback redirect is what actually protects the flow.
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { log } from './installer/core';
import {
  authorize,
  loadOAuthClient,
  refreshAccessToken,
  type OAuthClient,
  type Tokens,
} from './gdrive-auth';
import {
  deleteFile,
  driveNameFor,
  getQuota,
  listBackups,
  uploadBackup,
  type DriveFile,
  type QuotaInfo,
} from './gdrive-upload';

const TOKENS_ENCRYPTED = 'gdrive-tokens.enc';
const TOKENS_PLAIN = 'gdrive-tokens.json';

/** What the renderer is allowed to see. Never includes tokens. */
export interface DriveStatus {
  configured: boolean;
  connected: boolean;
  accountLabel?: string;
  needsReauth?: boolean;
  lastError?: string;
  quota?: QuotaInfo;
  remoteBackups?: DriveFile[];
}

let cachedTokens: Tokens | null = null;

// ---------------------------------------------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------------------------------------------

function tokenPaths(dataRoot: string): { encrypted: string; plain: string } {
  return {
    encrypted: path.join(dataRoot, TOKENS_ENCRYPTED),
    plain: path.join(dataRoot, TOKENS_PLAIN),
  };
}

export function saveTokens(dataRoot: string, tokens: Tokens): void {
  cachedTokens = tokens;
  const paths = tokenPaths(dataRoot);
  const json = JSON.stringify(tokens);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.writeFileSync(paths.encrypted, safeStorage.encryptString(json), { mode: 0o600 });
      try { fs.chmodSync(paths.encrypted, 0o600); } catch { /* best effort */ }
      // Remove a stale plaintext copy so the weaker form never lingers beside the stronger one.
      try { fs.rmSync(paths.plain, { force: true }); } catch { /* ignore */ }
      return;
    }
  } catch (error) {
    log(`[gdrive] safeStorage unavailable (${(error as Error).message}); falling back to a protected plain file`);
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(paths.plain, json, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(paths.plain, 0o600); } catch { /* best effort */ }
}

export function loadTokens(dataRoot: string): Tokens | null {
  if (cachedTokens !== null) return cachedTokens;
  const paths = tokenPaths(dataRoot);
  try {
    if (fs.existsSync(paths.encrypted) && safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(fs.readFileSync(paths.encrypted));
      cachedTokens = JSON.parse(decrypted) as Tokens;
      return cachedTokens;
    }
  } catch (error) {
    // A corrupt or undecryptable blob (different OS user, restored profile) means "connect again", not a crash.
    log(`[gdrive] stored tokens could not be decrypted: ${(error as Error).message}`);
  }
  try {
    if (fs.existsSync(paths.plain)) {
      cachedTokens = JSON.parse(fs.readFileSync(paths.plain, 'utf8')) as Tokens;
      return cachedTokens;
    }
  } catch { /* treat as not connected */ }
  return null;
}

export function clearTokens(dataRoot: string): void {
  cachedTokens = null;
  const paths = tokenPaths(dataRoot);
  for (const file of [paths.encrypted, paths.plain]) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

/** Test hook: forget the in-memory token so a test can re-read from disk. */
export function resetTokensForTest(): void {
  cachedTokens = null;
}

// ---------------------------------------------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------------------------------------------

export function driveConfigured(dataRoot: string): boolean {
  return loadOAuthClient(dataRoot) !== null;
}

export async function connect(dataRoot: string): Promise<{ ok: boolean; error?: string }> {
  const client = loadOAuthClient(dataRoot);
  if (client === null) {
    return {
      ok: false,
      error: 'No Google OAuth client is configured. Place a google-oauth.json in the app data folder, or set '
        + 'BSM_GOOGLE_CLIENT_ID and BSM_GOOGLE_CLIENT_SECRET.',
    };
  }
  const result = await authorize({ client });
  if (!result.ok || result.tokens === undefined) return { ok: false, error: result.error ?? 'Authorization failed.' };
  saveTokens(dataRoot, result.tokens);
  log('[gdrive] connected');
  return { ok: true };
}

export function disconnect(dataRoot: string): void {
  clearTokens(dataRoot);
  log('[gdrive] disconnected; stored tokens removed');
}

/**
 * Produce an access token, refreshing when needed.
 *
 * Returns a discriminated result so callers can distinguish "retry later" from "the user must reconnect" — an expired
 * refresh token can only be fixed by the user, and retrying it forever is how a scheduler burns quota at 3am.
 */
async function validAccessToken(dataRoot: string): Promise<
  { ok: true; client: OAuthClient; tokens: Tokens } | { ok: false; error: string; needsReauth?: boolean }
> {
  const client = loadOAuthClient(dataRoot);
  if (client === null) return { ok: false, error: 'Google Drive is not configured.' };
  const tokens = loadTokens(dataRoot);
  if (tokens === null) return { ok: false, error: 'Not connected to Google Drive.', needsReauth: true };

  if (Date.now() < tokens.expiresAt - 60_000) return { ok: true, client, tokens };

  const refreshed = await refreshAccessToken({ client, refreshToken: tokens.refreshToken });
  if (!refreshed.ok || refreshed.tokens === undefined) {
    return { ok: false, error: refreshed.error ?? 'Could not refresh Google access.', needsReauth: true };
  }
  const merged: Tokens = { ...refreshed.tokens, refreshToken: tokens.refreshToken };
  saveTokens(dataRoot, merged);
  return { ok: true, client, tokens: merged };
}

// ---------------------------------------------------------------------------------------------------------------
// Status + operations (called by IPC)
// ---------------------------------------------------------------------------------------------------------------

export async function driveStatus(dataRoot: string): Promise<DriveStatus> {
  if (!driveConfigured(dataRoot)) return { configured: false, connected: false };
  const tokens = loadTokens(dataRoot);
  if (tokens === null) return { configured: true, connected: false };

  // Reading quota doubles as a liveness check: if the token is dead, this is where it surfaces.
  const auth = await validAccessToken(dataRoot);
  if (!auth.ok) {
    return { configured: true, connected: false, needsReauth: auth.needsReauth === true, lastError: auth.error };
  }
  const quota = await getQuota(auth.tokens.accessToken);
  return {
    configured: true,
    connected: true,
    ...(quota !== null ? { quota } : {}),
  };
}

export async function driveListBackups(dataRoot: string): Promise<{ ok: boolean; files?: DriveFile[]; error?: string }> {
  const auth = await validAccessToken(dataRoot);
  if (!auth.ok) return { ok: false, error: auth.error };
  return { ok: true, files: await listBackups(auth.tokens.accessToken) };
}

export async function driveUploadBackup(options: {
  dataRoot: string;
  serverName: string;
  backupName: string;
  filePath: string;
  onProgress?: (percent: number) => void;
}): Promise<{ ok: boolean; file?: DriveFile; error?: string; needsReauth?: boolean }> {
  if (!fs.existsSync(options.filePath)) {
    return { ok: false, error: `Backup file is missing: ${options.filePath}` };
  }
  const auth = await validAccessToken(options.dataRoot);
  if (!auth.ok) return { ok: false, error: auth.error, ...(auth.needsReauth ? { needsReauth: true } : {}) };

  return uploadBackup({
    tokens: auth.tokens,
    client: auth.client,
    filePath: options.filePath,
    name: driveNameFor(options.serverName, options.backupName),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

export async function driveDeleteBackup(dataRoot: string, fileId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await validAccessToken(dataRoot);
  if (!auth.ok) return { ok: false, error: auth.error };
  return deleteFile(auth.tokens.accessToken, fileId);
}

/**
 * Mirror one freshly created backup to Drive, if the user has connected an account.
 *
 * Called automatically after every backup. Three properties are deliberate:
 *
 *  - **Silent when not connected.** A user who never set up Drive should not see an error after every backup. Returning
 *    `{ skipped: true }` rather than `{ ok: false }` keeps "not configured" out of the failure path.
 *  - **Never throws.** The backup it mirrors already exists on disk; an exception here would report a successful backup
 *    as failed. Errors are returned and logged by the caller.
 *  - **No retry loop.** A dead token or full Drive is a state the user must resolve; retrying it automatically at every
 *    scheduled backup would produce a wall of identical failures instead of one clear message.
 */
export async function mirrorBackupToDrive(
  dataRoot: string,
  record: { serverId: string; name: string; path: string },
): Promise<{ ok: boolean; skipped?: boolean; error?: string; fileId?: string }> {
  if (!driveConfigured(dataRoot)) return { ok: false, skipped: true, error: 'Google Drive is not configured.' };
  if (loadTokens(dataRoot) === null) return { ok: false, skipped: true, error: 'Google Drive is not connected.' };
  if (!fs.existsSync(record.path)) return { ok: false, error: `Backup file is missing: ${record.path}` };

  // The server name is only used for the Drive filename; fall back to the id when the record cannot resolve a name.
  let serverName = 'server';
  try {
    const { Store } = await import('./store');
    const server = new Store(dataRoot).getServer(record.serverId);
    if (server !== null) serverName = server.name;
  } catch { /* name is cosmetic */ }

  try {
    const result = await driveUploadBackup({
      dataRoot,
      serverName,
      backupName: record.name,
      filePath: record.path,
    });
    if (!result.ok) return { ok: false, error: result.error ?? 'Upload failed.' };
    return { ok: true, ...(result.file !== undefined ? { fileId: result.file.id } : {}) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
