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
  loadOAuthClientDetailed,
  refreshAccessToken,
  type OAuthClient,
  type Tokens,
} from './gdrive-auth';
import {
  deleteFile,
  downloadBackup,
  getFileMetadata,
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
  /** Why the app cannot use Drive, when `configured` is false. Shown verbatim so the user can fix it themselves. */
  configError?: string;
  /** Non-fatal setup note, e.g. a web-type OAuth client that will not redirect correctly. */
  configWarning?: string;
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
  // Load the credential first, so a configuration problem is reported with its cause rather than as "not set up".
  const config = loadOAuthClientDetailed(dataRoot);
  if (config.client === null) {
    return {
      configured: false,
      connected: false,
      ...(config.error !== undefined ? { configError: config.error } : {}),
      ...(config.warning !== undefined ? { configWarning: config.warning } : {}),
    };
  }
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
    ...(config.warning !== undefined ? { configWarning: config.warning } : {}),
    ...(quota !== null ? { quota } : {}),
  };
}

export async function driveListBackups(
  dataRoot: string,
  serverId: string,
  serverName = '',
): Promise<{ ok: boolean; files?: DriveFile[]; error?: string }> {
  const auth = await validAccessToken(dataRoot);
  if (!auth.ok) return { ok: false, error: auth.error };
  // Scoped by id AND name. The id keeps two live servers apart; the name is what makes a backup recoverable after a
  // server is deleted and recreated, because the new record has a different UUID but the same name.
  return { ok: true, files: await listBackups(auth.tokens.accessToken, { serverId, serverName }) };
}

/**
 * Uploads in progress, keyed by `${serverId}:${backupId}`.
 *
 * De-duplication by listing Drive is not enough on its own, and the reported duplicate proves it. The automatic mirror
 * runs in the background right after a backup is written; if the user presses "To Drive" a few seconds later, the first
 * upload may still be streaming (measured: a 4.6 MB file took ~9 seconds end-to-end, and the two duplicate timestamps in
 * the report were 9 seconds apart). A listing at that moment returns nothing, so both paths decided "not uploaded yet" and
 * both uploaded.
 *
 * Holding the in-flight promise means the second caller AWAITS the first and receives its result instead of starting a
 * second transfer.
 */
const uploadsInFlight = new Map<string, Promise<{ ok: boolean; file?: DriveFile; error?: string; needsReauth?: boolean }>>();

export async function driveUploadBackup(options: {
  dataRoot: string;
  serverId: string;
  serverName: string;
  backupName: string;
  /** Local backup record id, recorded on the file so a restore can match it back. */
  backupId?: string;
  filePath: string;
  onProgress?: (percent: number) => void;
}): Promise<{ ok: boolean; file?: DriveFile; error?: string; needsReauth?: boolean }> {
  if (!fs.existsSync(options.filePath)) {
    return { ok: false, error: `Backup file is missing: ${options.filePath}` };
  }

  // One upload per backup id at a time. Every caller — the automatic mirror and the manual button — goes through this
  // function, so this is the only place the guarantee needs to hold.
  const key = `${options.serverId}:${options.backupId ?? options.filePath}`;
  const inFlight = uploadsInFlight.get(key);
  if (inFlight !== undefined) {
    log(`[gdrive] upload already in progress for ${key}; joining it instead of starting a second one`);
    return inFlight;
  }

  const work = (async (): Promise<{ ok: boolean; file?: DriveFile; error?: string; needsReauth?: boolean }> => {
    const auth = await validAccessToken(options.dataRoot);
    if (!auth.ok) return { ok: false, error: auth.error, ...(auth.needsReauth ? { needsReauth: true } : {}) };

    // If this backup is already in Drive, return that file rather than uploading a copy. Matching is on the recorded
    // backup id, not the Drive name, because two different backups can share a display name and a name match would skip a
    // genuine upload.
    if (options.backupId !== undefined && options.backupId !== '') {
      try {
        const existing = await listBackups(auth.tokens.accessToken, {
          serverId: options.serverId,
          serverName: options.serverName,
        });
        const already = existing.find((file) => file.backupId === options.backupId);
        if (already !== undefined) {
          log(`[gdrive] backup ${options.backupId} is already in Drive as ${already.id}; not uploading again`);
          return { ok: true, file: already };
        }
      } catch { /* a listing failure must not block an upload the user asked for */ }
    }

    return uploadBackup({
      tokens: auth.tokens,
      client: auth.client,
      filePath: options.filePath,
      name: driveNameFor(options.serverName, options.backupName),
      serverId: options.serverId,
      serverName: options.serverName,
      ...(options.backupId !== undefined ? { backupId: options.backupId } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  })();

  uploadsInFlight.set(key, work);
  try {
    return await work;
  } finally {
    uploadsInFlight.delete(key);
  }
}

export async function driveDeleteBackup(dataRoot: string, fileId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await validAccessToken(dataRoot);
  if (!auth.ok) return { ok: false, error: auth.error };
  return deleteFile(auth.tokens.accessToken, fileId);
}

/**
 * Restore a backup that exists only in Drive.
 *
 * The path this unlocks: the local ZIP is gone — deleted by retention, lost with the machine, or the whole app data
 * folder was rebuilt — and the only surviving copy is remote. Without this the Drive copies were write-only, which makes
 * the backup feature decorative rather than protective.
 *
 * Downloads into the app's own backup staging directory, verifies the byte count, then hands the file to the SAME
 * restore routine a local backup uses. Reusing `restore` matters: it takes a pre-restore safety snapshot, refuses to run
 * against a live server, and handles the in-place/reset distinction — none of which should be reimplemented for the
 * remote path, and all of which the user already trusts.
 */
export async function driveRestoreBackup(options: {
  dataRoot: string;
  fileId: string;
  /** Directory to download into. Caller supplies the app's backup folder so the result is a normal local backup. */
  downloadDir: string;
  /** Local filename to use once downloaded. */
  fileName: string;
  onProgress?: (percent: number) => void;
}): Promise<{ ok: boolean; path?: string; error?: string; needsReauth?: boolean }> {
  const auth = await validAccessToken(options.dataRoot);
  if (!auth.ok) return { ok: false, error: auth.error, ...(auth.needsReauth ? { needsReauth: true } : {}) };

  const meta = await getFileMetadata({ accessToken: auth.tokens.accessToken, fileId: options.fileId });
  if (!meta.ok) return { ok: false, error: meta.error ?? 'Could not read the remote backup.' };

  const destination = path.join(options.downloadDir, options.fileName);
  const result = await downloadBackup({
    accessToken: auth.tokens.accessToken,
    fileId: options.fileId,
    destinationPath: destination,
    ...(meta.sizeBytes !== undefined ? { expectedBytes: meta.sizeBytes } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  if (!result.ok) return result;
  log(`[gdrive] downloaded remote backup ${options.fileId} to ${destination}`);
  return result;
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
  record: { id: string; serverId: string; name: string; path: string },
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
      serverId: record.serverId,
      serverName,
      backupName: record.name,
      backupId: record.id,
      filePath: record.path,
    });
    if (!result.ok) return { ok: false, error: result.error ?? 'Upload failed.' };
    return { ok: true, ...(result.file !== undefined ? { fileId: result.file.id } : {}) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
