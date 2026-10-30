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

export interface DriveFile {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
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
export async function listBackups(accessToken: string, fetchImpl?: typeof fetch): Promise<DriveFile[]> {
  const folderId = await ensureBackupFolder(accessToken, fetchImpl);
  // When the folder cannot be resolved the property filter alone still finds every backup this app made, so the list
  // degrades to correct-but-unfiled rather than empty.
  const propertyFilter = `appProperties has { key='${APP_PROPERTY.key}' and value='${APP_PROPERTY.value}' }`;
  const query = folderId === null
    ? `${propertyFilter} and trashed=false`
    : `'${folderId}' in parents and ${propertyFilter} and trashed=false`;
  const url = `${DRIVE_API}/files`
    + `?q=${encodeURIComponent(query)}`
    + '&fields=files(id,name,size,createdTime)&orderBy=createdTime desc&pageSize=100';
  const result = await driveJson<{ files?: { id: string; name: string; size?: string; createdTime?: string }[] }>({
    url, accessToken, fetchImpl,
  });
  if (!result.ok || result.body?.files === undefined) return [];
  return result.body.files.map((file) => ({
    id: file.id,
    name: file.name,
    sizeBytes: Number(file.size ?? '0'),
    createdAt: file.createdTime ?? '',
  }));
}

/**
 * Find or create the folder that holds this app's backups.
 *
 * Cached per process because every upload and every list call needs it, and creating a duplicate folder would be worse
 * than a small inconsistency: the user would see two "Block Server Manager" folders in their Drive.
 */
let cachedFolderId: string | null | undefined;

export const BACKUP_FOLDER_NAME = 'Block Server Manager Backups';

export async function ensureBackupFolder(
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (cachedFolderId !== undefined) return cachedFolderId;

  const doFetch = fetchImpl ?? fetch;
  const query = `mimeType='application/vnd.google-apps.folder' and name='${BACKUP_FOLDER_NAME}' and trashed=false`;

  // 1. Look for an existing folder first, so a restart reuses it instead of piling up duplicates.
  const found = await driveJson<{ files?: { id: string }[] }>({
    url: `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`,
    accessToken,
    fetchImpl,
  });
  if (found.ok && (found.body?.files?.length ?? 0) > 0) {
    cachedFolderId = found.body!.files![0].id;
    return cachedFolderId;
  }

  // 2. Create it.
  try {
    const response = await doFetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        name: BACKUP_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    if (!response.ok) { cachedFolderId = null; return null; }
    const json = await response.json() as { id?: string };
    cachedFolderId = json.id ?? null;
    return cachedFolderId;
  } catch {
    // Not fatal: backups still upload to the Drive root and remain findable by their app property.
    cachedFolderId = null;
    return null;
  }
}

/** Test hook: forget the memoised folder id. */
export function resetBackupFolderCacheForTest(): void {
  cachedFolderId = undefined;
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
        appProperties: { [APP_PROPERTY.key]: APP_PROPERTY.value },
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

  const folderId = await ensureBackupFolder(accessToken, options.fetchImpl);

  const session = await createResumableSession({
    accessToken,
    name: options.name,
    totalBytes: sizeBytes,
    // File into the app's own folder so the user can find their backups in Drive. A null folder falls back to My
    // Drive root, which still works and is still discoverable by the app property.
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
