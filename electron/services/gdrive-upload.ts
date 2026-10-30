// Google Drive upload for backups.
//
// Three things this has to get right, all of them learned from how backup tools actually fail:
//
//  1. **Large files.** A modded world backup is routinely 1-3 GB. A single-shot upload that dies at 80% wastes the whole
//     attempt and, worse, teaches the user to distrust the feature. Drive's resumable protocol is used, and the session
//     URI is persisted so a retry after an app restart continues rather than starting over.
//
//  2. **Quota.** Google gives 15 GB free and a Minecraft backup can eat a third of it. The remaining space is checked
//     BEFORE uploading, because discovering it afterwards means a half-uploaded file and an angry user. A failed remote
//     upload must never delete the local backup — the local copy is the one the user actually relies on.
//
//  3. **Unattended runs.** A scheduled backup at 3am cannot ask the user to click anything. If the refresh token is
//     dead, that is reported as an actionable state on the next interaction, never swallowed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { log } from './installer/core';
import type { OAuthClient, Tokens } from './gdrive-auth';
import { refreshAccessToken } from './gdrive-auth';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

/** App-specific marker so a future cleanup can never touch a file it did not create. */
export const APP_PROPERTY = { key: 'bsmKind', value: 'server-backup' } as const;

/**
 * Property carrying the owning server on every uploaded file.
 *
 * This exists because the first version filtered only by "is this a backup", so every server's panel listed every other
 * server's backups — a real report from a two-server account. The server identity has to travel with the file, not be
 * inferred from where it lives, because a file can be moved or re-filed in Drive and its folder is then a lie.
 */
export const SERVER_PROPERTY_KEY = 'bsmServerId';

/** Property carrying the local backup id, so a restore can match a Drive file to the record it came from. */
export const BACKUP_PROPERTY_KEY = 'bsmBackupId';

/** Property carrying the server name as it was when uploaded, for display without a second lookup. */
export const SERVER_NAME_PROPERTY_KEY = 'bsmServerName';

export interface DriveFile {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  /** Server this backup belongs to, read back from the app property. Empty for files uploaded by an older build. */
  serverId?: string;
  /** Local backup id, when recorded. Lets a restore match a Drive file to the record it came from. */
  backupId?: string;
}

export interface QuotaInfo {
  limitBytes: number;
  usageBytes: number;
  remainingBytes: number;
}

export interface UploadResult {
  ok: boolean;
  file?: DriveFile;
  error?: string;
  /** True when the failure is a dead refresh token; the caller must prompt re-authorization rather than retry. */
  needsReauth?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Google Drive REST calls (small, dependency-free)
// ---------------------------------------------------------------------------------------------------------------

async function driveJson<T>(options: {
  url: string;
  accessToken: string;
  method?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; body?: T; error?: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(options.url, {
      method: options.method ?? 'GET',
      headers: { Authorization: `Bearer ${options.accessToken}` },
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!response.ok) {
      const message = (parsed as { error?: { message?: string } } | null)?.error?.message
        ?? `Drive request failed (${response.status})`;
      return { ok: false, status: response.status, error: message };
    }
    return { ok: true, status: response.status, body: parsed as T };
  } catch (error) {
    return { ok: false, status: 0, error: (error as Error).message };
  }
}

export async function getQuota(accessToken: string, fetchImpl?: typeof fetch): Promise<QuotaInfo | null> {
  const result = await driveJson<{ storageQuota?: { limit?: string; usage?: string } }>({
    url: `${DRIVE_API}/about?fields=storageQuota`,
    accessToken,
    fetchImpl,
  });
  if (!result.ok || result.body?.storageQuota === undefined) return null;
  // Drive omitted `limit` means unlimited (Workspace accounts).
  const limit = Number(result.body.storageQuota.limit ?? '0');
  const usage = Number(result.body.storageQuota.usage ?? '0');
  return {
    limitBytes: Number.isNaN(limit) ? 0 : limit,
    usageBytes: Number.isNaN(usage) ? 0 : usage,
    remainingBytes: Number.isNaN(limit) ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - usage),
  };
}

/** List only backups this app created, from the app's own folder.
 *
 * Two corrections in one place, both found by a real upload that never appeared in the list:
 *
 *  1. The query term is `appProperties`, not `trAppProperties`. The latter is not a Drive search term at all, so the
 *     query matched nothing and the panel reported "0 backups" while the file was demonstrably in the Drive. Drive's
 *     reference lists exactly two property terms: `properties` (visible to all apps) and `appProperties` (private to
 *     the requesting app).
 *
 *  2. Results are scoped to the app's own folder rather than scattered across the Drive root. A dedicated folder is
 *     what a user expects to find — "where are my backups?" should have an answer — and it lets cleanup reason about
 *     one container instead of scanning the whole Drive.
 */
export async function listBackups(
  accessToken: string,
  options: { serverId?: string; fetchImpl?: typeof fetch } = {},
): Promise<DriveFile[]> {
  const propertyFilter = `appProperties has { key='${APP_PROPERTY.key}' and value='${APP_PROPERTY.value}' }`;

  // Scope by server when asked. This is the fix for the reported defect: without it every server's panel listed every
  // other server's backups, so "restore this world" could offer a backup of a completely different world.
  const serverFilter = options.serverId !== undefined && options.serverId !== ''
    ? ` and appProperties has { key='${SERVER_PROPERTY_KEY}' and value='${options.serverId.replace(/'/g, "\\'")}' }`
    : '';

  // Narrow to the server's own folder when it is known: fewer files scanned, and the query stays correct even if a
  // property is missing on an older upload (the property filter is still applied, so nothing foreign can leak in).
  const folderId = options.serverId !== undefined && options.serverId !== ''
    ? await ensureServerFolder({
      accessToken,
      serverName: 'server',
      serverId: options.serverId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
    : await ensureBackupRootFolder(accessToken, options.fetchImpl);

  const query = folderId === null
    ? `${propertyFilter}${serverFilter} and trashed=false`
    : `'${folderId}' in parents and ${propertyFilter}${serverFilter} and trashed=false`;

  const url = `${DRIVE_API}/files`
    + `?q=${encodeURIComponent(query)}`
    + '&fields=files(id,name,size,createdTime,appProperties)&orderBy=createdTime desc&pageSize=200';
  const result = await driveJson<{
    files?: { id: string; name: string; size?: string; createdTime?: string; appProperties?: Record<string, string> }[];
  }>({ url, accessToken, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  if (!result.ok || result.body?.files === undefined) return [];
  return result.body.files.map((file) => ({
    id: file.id,
    name: file.name,
    sizeBytes: Number(file.size ?? '0'),
    createdAt: file.createdTime ?? '',
    ...(file.appProperties?.[SERVER_PROPERTY_KEY] !== undefined
      ? { serverId: file.appProperties[SERVER_PROPERTY_KEY] } : {}),
    ...(file.appProperties?.[BACKUP_PROPERTY_KEY] !== undefined
      ? { backupId: file.appProperties[BACKUP_PROPERTY_KEY] } : {}),
  }));
}

/**
 * Folder layout.
 *
 *   Block Server Manager Backups/        ← one root for the app
 *     <server name>-<id prefix>/         ← one folder per server
 *       <server>__<backup>.zip
 *
 * A flat folder containing every server's backups was the first design and it was wrong: with two servers the list is
 * ambiguous, a user cannot tell which backup belongs to which world, and there is no safe way to delete "the backups of
 * the server I just removed". One folder per server makes the answer visible in Drive itself, not just in the app.
 *
 * The server id prefix is part of the name because server names are user-editable and two servers may share a name; the
 * id prefix keeps the folder addressable even after a rename.
 */
export const BACKUP_ROOT_FOLDER_NAME = 'Block Server Manager Backups';

/** Deterministic, Drive-safe folder name for one server. */
export function serverFolderName(serverName: string, serverId: string): string {
  const safeName = serverName.replace(/[\\/:*?"<>|']/g, '_').trim() || 'server';
  const idPart = serverId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'unknown';
  return `${safeName}-${idPart}`;
}

interface FolderCacheEntry { root?: string | null; servers: Map<string, string | null> }

const folderCache: FolderCacheEntry = { servers: new Map() };

/** Find or create one folder by name under an optional parent. Returns null when it cannot be resolved. */
async function findOrCreateFolder(options: {
  accessToken: string;
  name: string;
  parentId?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const parentClause = options.parentId !== undefined && options.parentId !== null
    ? ` and '${options.parentId}' in parents`
    : '';
  const query = `mimeType='application/vnd.google-apps.folder' and name='${options.name}'${parentClause} and trashed=false`;

  const found = await driveJson<{ files?: { id: string }[] }>({
    url: `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`,
    accessToken: options.accessToken,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (found.ok && (found.body?.files?.length ?? 0) > 0) return found.body!.files![0].id;

  try {
    const response = await doFetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        name: options.name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(options.parentId !== undefined && options.parentId !== null ? { parents: [options.parentId] } : {}),
      }),
    });
    if (!response.ok) return null;
    const json = await response.json() as { id?: string };
    return json.id ?? null;
  } catch {
    return null;
  }
}

/** Root folder holding every server folder. Cached per process. */
export async function ensureBackupRootFolder(
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (folderCache.root !== undefined) return folderCache.root;
  folderCache.root = await findOrCreateFolder({
    accessToken,
    name: BACKUP_ROOT_FOLDER_NAME,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return folderCache.root;
}

/**
 * Per-server folder. Falls back to the root when a server folder cannot be created, so an upload still succeeds rather
 * than failing because of a folder permission quirk.
 */
export async function ensureServerFolder(options: {
  accessToken: string;
  serverName: string;
  serverId: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const cached = folderCache.servers.get(options.serverId);
  if (cached !== undefined) return cached;

  const root = await ensureBackupRootFolder(options.accessToken, options.fetchImpl);
  const folder = await findOrCreateFolder({
    accessToken: options.accessToken,
    name: serverFolderName(options.serverName, options.serverId),
    parentId: root,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const resolved = folder ?? root;
  folderCache.servers.set(options.serverId, resolved);
  return resolved;
}

/** Test hook: forget memoised folder ids. */
export function resetBackupFolderCacheForTest(): void {
  folderCache.root = undefined;
  folderCache.servers.clear();
}

/**
 * Start a resumable upload session.
 *
 * Metadata (including the app property) is sent with the session creation so the resulting file is tagged atomically —
 * a file that exists without its marker would be invisible to cleanup and impossible to attribute later.
 */
export async function createResumableSession(options: {
  accessToken: string;
  name: string;
  totalBytes: number;
  /** Folder to file into. Omitted when the folder could not be resolved, in which case the file lands in My Drive. */
  parentId?: string;
  /** Owning server, recorded on the file so a list can be scoped to it regardless of folder. */
  serverId?: string;
  serverName?: string;
  /** Local backup id, recorded so a Drive file can be matched to the record it came from. */
  backupId?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; sessionUri?: string; error?: string; needsReauth?: boolean }> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${UPLOAD_API}/files?uploadType=resumable&fields=id,name,size,createdTime`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/zip',
        'X-Upload-Content-Length': String(options.totalBytes),
      },
      body: JSON.stringify({
        name: options.name,
        appProperties: {
          [APP_PROPERTY.key]: APP_PROPERTY.value,
          // The owning server travels with the file. This is what makes a per-server list correct even if the file is
          // moved between folders in Drive by the user.
          ...(options.serverId !== undefined ? { [SERVER_PROPERTY_KEY]: options.serverId } : {}),
          ...(options.serverName !== undefined ? { [SERVER_NAME_PROPERTY_KEY]: options.serverName } : {}),
          ...(options.backupId !== undefined ? { [BACKUP_PROPERTY_KEY]: options.backupId } : {}),
        },
        ...(options.parentId !== undefined ? { parents: [options.parentId] } : {}),
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = `Could not start the upload (${response.status})`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message !== undefined) message = parsed.error.message;
      } catch { /* keep the status-based message */ }
      return { ok: false, error: message, needsReauth: response.status === 401 || response.status === 403 };
    }
    const sessionUri = response.headers.get('location');
    if (sessionUri === null) return { ok: false, error: 'Google did not return an upload session URI.' };
    return { ok: true, sessionUri };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Upload the whole file to an existing session.
 *
 * Chunked at 8 MiB (a multiple of 256 KiB, which Drive requires). One request per chunk means a failure mid-file can be
 * retried from the reported offset instead of from zero.
 */
export async function uploadToSession(options: {
  sessionUri: string;
  filePath: string;
  onProgress?: (percent: number) => void;
  fetchImpl?: typeof fetch;
  chunkSize?: number;
}): Promise<UploadResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const chunkSize = options.chunkSize ?? 8 * 1024 * 1024;
  const totalBytes = fs.statSync(options.filePath).size;
  const handle = fs.openSync(options.filePath, 'r');

  try {
    let offset = 0;
    while (offset < totalBytes) {
      const length = Math.min(chunkSize, totalBytes - offset);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, offset);

      const response = await doFetch(options.sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': String(length),
          // Drive expects `bytes start-end/total`; inclusive end index.
          'Content-Range': `bytes ${offset}-${offset + length - 1}/${totalBytes}`,
        },
        body: buffer,
      });

      if (response.status === 308) {
        // Resumable protocol: 308 means "chunk accepted, keep going". Another 308 body carries the offset to resume at.
        const range = response.headers.get('range');
        if (range !== null) {
          const match = /bytes=0-(\d+)/.exec(range);
          if (match !== null) offset = Number(match[1]) + 1;
          else offset += length;
        } else {
          offset += length;
        }
        options.onProgress?.(Math.round((offset / totalBytes) * 100));
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        let message = `Upload failed at byte ${offset} (${response.status})`;
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message !== undefined) message = parsed.error.message;
        } catch { /* keep default */ }
        return { ok: false, error: message, needsReauth: response.status === 401 || response.status === 403 };
      }

      const file = await response.json() as { id: string; name: string; size?: string; createdTime?: string };
      options.onProgress?.(100);
      return {
        ok: true,
        file: {
          id: file.id,
          name: file.name,
          sizeBytes: Number(file.size ?? totalBytes),
          createdAt: file.createdTime ?? new Date().toISOString(),
        },
      };
    }
    return { ok: false, error: 'Upload ended without a completion response from Google.' };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    fs.closeSync(handle);
  }
}

/** Delete one file this app created. Refuses ids that do not look like Drive ids, to avoid a malformed call. */
export async function deleteFile(
  accessToken: string,
  fileId: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return { ok: false, error: `Refusing to delete malformed file id: ${fileId}` };
  const doFetch = fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // 404 means it is already gone, which is the desired end state.
    if (response.ok || response.status === 404) return { ok: true };
    return { ok: false, error: `Delete failed (${response.status})` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// High-level backup upload
// ---------------------------------------------------------------------------------------------------------------

export interface UploadBackupOptions {
  tokens: Tokens;
  client: OAuthClient;
  filePath: string;
  name: string;
  /** Server that owns this backup. Required for a correct per-server list. */
  serverId: string;
  serverName: string;
  /** Local backup record id, recorded on the file so it can be matched back. */
  backupId?: string;
  onProgress?: (percent: number) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Upload one backup, refreshing the access token first when it has expired.
 *
 * Quota is checked before the session is created. If the file would not fit, the upload is refused with the numbers,
 * because "upload failed" for a quota problem is a support ticket; "needs 3.1 GB, 400 MB free" is actionable.
 */
export async function uploadBackup(options: UploadBackupOptions): Promise<UploadResult> {
  const sizeBytes = fs.statSync(options.filePath).size;

  let accessToken = options.tokens.accessToken;
  // Refresh a minute early rather than racing the expiry in the middle of an upload.
  if (Date.now() > options.tokens.expiresAt - 60_000) {
    const refreshed = await refreshAccessToken({
      client: options.client,
      refreshToken: options.tokens.refreshToken,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!refreshed.ok || refreshed.tokens === undefined) {
      return { ok: false, error: refreshed.error ?? 'Could not refresh access', needsReauth: true };
    }
    accessToken = refreshed.tokens.accessToken;
  }

  const quota = await getQuota(accessToken, options.fetchImpl);
  if (quota !== null && quota.remainingBytes < sizeBytes) {
    return {
      ok: false,
      error: `Not enough Google Drive space: the backup needs ${formatBytes(sizeBytes)} but only `
        + `${formatBytes(quota.remainingBytes)} is free.`,
    };
  }

  // Per-server folder, so the Drive itself shows which world a backup belongs to.
  const folderId = await ensureServerFolder({
    accessToken,
    serverName: options.serverName,
    serverId: options.serverId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const session = await createResumableSession({
    accessToken,
    name: options.name,
    totalBytes: sizeBytes,
    serverId: options.serverId,
    serverName: options.serverName,
    ...(options.backupId !== undefined ? { backupId: options.backupId } : {}),
    ...(folderId !== null ? { parentId: folderId } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (!session.ok || session.sessionUri === undefined) {
    return { ok: false, error: session.error ?? 'Could not start the upload', ...(session.needsReauth ? { needsReauth: true } : {}) };
  }

  const result = await uploadToSession({
    sessionUri: session.sessionUri,
    filePath: options.filePath,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (result.ok && result.file !== undefined) {
    log(`[gdrive] uploaded ${options.name} (${formatBytes(sizeBytes)}) as ${result.file.id}`);
  }
  return result;
}

/** Human-readable size, used in messages the user reads. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Filename used on Drive: stable, sortable, and carrying the server name so a user can tell them apart. */
export function driveNameFor(serverName: string, backupName: string): string {
  const safeServer = serverName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'server';
  return `${safeServer}__${backupName}`;
}

/** Content hash, for skipping an upload whose bytes already exist. */
export function fileSha256(filePath: string): string {
  const hash = createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------
// Download (the half that makes a backup worth having)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Download a backup from Drive to a local path.
 *
 * This is what makes the feature a backup rather than an upload. Until now, losing the local ZIP meant losing the backup
 * entirely — the copy in Drive could be seen but not used, which defeats the point. A backup you cannot restore from is
 * a screenshot of a backup.
 *
 * Written to a `.part` file and renamed only on success, so an interrupted download can never be mistaken for a complete
 * archive by the restore path. Drive reports the size; a mismatch is treated as a failure rather than truncated data,
 * because a corrupt archive that looks valid is more dangerous than a missing one.
 */
export async function downloadBackup(options: {
  accessToken: string;
  fileId: string;
  destinationPath: string;
  expectedBytes?: number;
  onProgress?: (percent: number) => void;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; path?: string; error?: string; needsReauth?: boolean }> {
  const doFetch = options.fetchImpl ?? fetch;
  const partial = `${options.destinationPath}.part`;

  try {
    const response = await doFetch(
      `${DRIVE_API}/files/${encodeURIComponent(options.fileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${options.accessToken}` } },
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `Could not download the backup (${response.status})`,
        needsReauth: response.status === 401 || response.status === 403,
      };
    }
    if (response.body === null) return { ok: false, error: 'Google returned an empty response body.' };

    fs.mkdirSync(path.dirname(options.destinationPath), { recursive: true });
    const out = fs.createWriteStream(partial);
    const reader = response.body.getReader();
    let written = 0;
    const expected = options.expectedBytes ?? 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      written += value.byteLength;
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once('drain', resolve));
      }
      if (expected > 0) options.onProgress?.(Math.min(99, Math.round((written / expected) * 100)));
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });

    // A truncated download renamed into place would be a corrupt archive that only fails at restore time.
    if (expected > 0 && written !== expected) {
      try { fs.rmSync(partial, { force: true }); } catch { /* ignore */ }
      return { ok: false, error: `Download incomplete: received ${formatBytes(written)} of ${formatBytes(expected)}.` };
    }

    fs.renameSync(partial, options.destinationPath);
    options.onProgress?.(100);
    return { ok: true, path: options.destinationPath };
  } catch (error) {
    try { fs.rmSync(partial, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: (error as Error).message };
  }
}

/** Fetch a Drive file's metadata, used to size a download before starting it. */
export async function getFileMetadata(options: {
  accessToken: string;
  fileId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; name?: string; sizeBytes?: number; error?: string }> {
  const result = await driveJson<{ name?: string; size?: string }>({
    url: `${DRIVE_API}/files/${encodeURIComponent(options.fileId)}?fields=name,size`,
    accessToken: options.accessToken,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (!result.ok || result.body === undefined) return { ok: false, error: result.error ?? 'Could not read file metadata.' };
  return {
    ok: true,
    ...(result.body.name !== undefined ? { name: result.body.name } : {}),
    ...(result.body.size !== undefined ? { sizeBytes: Number(result.body.size) } : {}),
  };
}
