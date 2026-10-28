// User-selectable download location (Settings → Downloads & storage).
//
// The manager writes provider downloads (Modrinth/CurseForge archives, loader installers, Java
// runtime zips, caches) into a single cache directory. Its default is `<dataRoot>/cache`; users can
// point it at another drive/folder (worlds and server folders stay in the app data root).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, Store } from './store';

export const DOWNLOADS_PATH_SETTING = 'storage:downloadsPath';
const MAX_PATH_LENGTH = 2048;

export interface StorageInfo {
  /** Manager data root (servers, worlds, backups, app-data.json). */
  dataRoot: string;
  /** Persisted override, or null when the default is in effect. */
  downloadsPath: string | null;
  /** Directory actually used for downloads/caches right now. */
  effectiveDownloadsPath: string;
  /** Default used when no override is configured. */
  defaultDownloadsPath: string;
  isDefault: boolean;
  /** True when the persisted override no longer exists / is not writable (UI shows a warning). */
  overrideUnavailable: boolean;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Validate a user-supplied absolute download folder; returns null for "use the default". */
export function normalizeDownloadsPath(raw: unknown, dataRoot: string): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value === '') return null;
  if (value.length > MAX_PATH_LENGTH) throw appError('validation', `Folder path is too long (maximum ${MAX_PATH_LENGTH} characters).`);
  if (value.includes('\0')) throw appError('validation', 'Folder path contains an invalid character.');
  if (!path.isAbsolute(value)) throw appError('validation', 'Choose an absolute folder path (e.g. D:\\MSM Downloads).');
  const resolved = path.resolve(value);
  const root = path.resolve(dataRoot);
  const managed = ['servers', 'backups', 'runtime', 'installer-staging', 'metrics', 'logs', 'diagnostics']
    .map((name) => path.join(root, name));
  if (managed.some((folder) => isPathInside(resolved, folder))) {
    throw appError('validation', 'The download folder cannot be inside a manager-managed server/backup/runtime folder.');
  }
  if (isPathInside(root, resolved) && resolved !== root) {
    // e.g. ancestor of the data root: the cache would swallow the manager data folder.
    throw appError('validation', 'The download folder cannot contain the manager data folder.');
  }
  return resolved;
}

/** Create + write a probe file so an unwritable/network folder fails in Settings, not mid-install. */
export function assertWritableDownloadsFolder(folder: string): void {
  try {
    fs.mkdirSync(folder, { recursive: true });
    const probe = path.join(folder, `.msm-write-test-${randomUUID()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
  } catch (error) {
    throw appError('io', `Cannot write to the download folder "${folder}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getStorageInfo(dataRoot: string): StorageInfo {
  const store = new Store(dataRoot);
  const raw = store.getSetting<string | null>(DOWNLOADS_PATH_SETTING);
  const defaultDownloadsPath = path.join(dataRoot, 'cache');
  let downloadsPath: string | null = null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try { downloadsPath = normalizeDownloadsPath(raw, dataRoot); } catch { downloadsPath = raw.trim(); }
  }
  const effectiveDownloadsPath = downloadsPath ?? defaultDownloadsPath;
  const overrideUnavailable = downloadsPath !== null && !fs.existsSync(downloadsPath);
  return {
    dataRoot,
    downloadsPath,
    effectiveDownloadsPath,
    defaultDownloadsPath,
    isDefault: downloadsPath === null,
    overrideUnavailable,
  };
}

/** Directory used for downloaded archives/installers/Java zips; auto-created. */
export function effectiveCacheDir(dataRoot: string): string {
  const info = getStorageInfo(dataRoot);
  try { fs.mkdirSync(info.effectiveDownloadsPath, { recursive: true }); } catch { /* downloads will surface their own error */ }
  return info.effectiveDownloadsPath;
}

export function setDownloadsPath(dataRoot: string, raw: unknown): StorageInfo {
  const normalized = normalizeDownloadsPath(raw, dataRoot);
  if (normalized !== null) assertWritableDownloadsFolder(normalized);
  const store = new Store(dataRoot);
  store.setSetting(DOWNLOADS_PATH_SETTING, normalized);
  return getStorageInfo(dataRoot);
}
