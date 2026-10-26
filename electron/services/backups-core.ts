// Pure backup policy helpers (no fs, no Electron) so node:test can cover retention, schedule,
// flush-acknowledgement, restore planning, naming and ZIP-budget rules without a running app.
import { appError, type BackupRecord, type BackupSchedule } from './store';

export type BackupKind = BackupRecord['kind'];
export const BACKUP_KINDS: readonly BackupKind[] = ['Manual', 'Auto', 'Pre-install', 'Pre-restore', 'World-delete'];

export const SCHEDULE_INTERVALS = ['Hourly', 'Daily', 'Weekly'] as const;
export type ScheduleInterval = (typeof SCHEDULE_INTERVALS)[number];
export const INTERVAL_MS: Record<ScheduleInterval, number> = {
  Hourly: 60 * 60 * 1000,
  Daily: 24 * 60 * 60 * 1000,
  Weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Newest Pre-install / Pre-restore archives kept per kind (safety copies, not capacity). */
export const SAFETY_POOL_SIZE = 2;
/** Newest World-delete safety archives kept (bounded so deletes cannot grow forever). */
export const WORLD_DELETE_POOL_SIZE = 5;
/** Classic (non-ZIP64) archive limit. */
export const ZIP_LIMIT_BYTES = 4 * 1024 ** 3;
export const ZIP_MAX_ENTRIES = 0xffff;

function validation(message: string): Error {
  return appError('validation', message);
}

/** Canonicalise a schedule interval, accepting any casing/blank padding; reject anything else. */
export function normalizeInterval(value: unknown): ScheduleInterval {
  if (typeof value !== 'string') throw validation('Backup interval must be Hourly, Daily or Weekly.');
  const wanted = value.trim().toLowerCase();
  const hit = SCHEDULE_INTERVALS.find((interval) => interval.toLowerCase() === wanted);
  if (!hit) throw validation(`Backup interval must be Hourly, Daily or Weekly (got "${value}").`);
  return hit;
}

/** Validate + clamp `maxKept` (1..50). `undefined` uses the fallback (current value). */
export function normalizeMaxKept(value: unknown, fallback: number): number {
  const base = Number.isFinite(fallback) ? Math.trunc(fallback) : 10;
  if (value === undefined) return Math.max(1, Math.min(50, base));
  if (typeof value !== 'number' || !Number.isFinite(value)) throw validation('maxKept must be a number.');
  return Math.max(1, Math.min(50, Math.trunc(value)));
}

/** Validate a renderer/legacy supplied backup kind. Unknown kinds are a validation error. */
export function normalizeBackupKind(value: unknown): BackupKind {
  if (value === undefined || value === null) return 'Manual';
  if (typeof value !== 'string') throw validation('Backup kind must be a string.');
  const wanted = value.trim().toLowerCase();
  const hit = BACKUP_KINDS.find((kind) => kind.toLowerCase() === wanted);
  if (!hit) throw validation(`Unknown backup kind "${value}" (expected ${BACKUP_KINDS.join(', ')}).`);
  return hit;
}

/** Merge a schedule patch onto the current schedule with validation; `lastRunAt` is preserved. */
export function normalizeSchedulePatch(patch: Partial<BackupSchedule>, current: BackupSchedule): BackupSchedule {
  const auto = patch.auto ?? current.auto;
  if (typeof auto !== 'boolean') throw validation('auto must be a boolean.');
  const interval = patch.interval === undefined ? current.interval : normalizeInterval(patch.interval);
  const maxKept = normalizeMaxKept(patch.maxKept, current.maxKept);
  return { auto, interval, maxKept, lastRunAt: current.lastRunAt };
}

/** True when the scheduler interval has elapsed since the last successful automatic run. */
export function isScheduleDue(schedule: BackupSchedule, nowMs: number): boolean {
  const ms = INTERVAL_MS[schedule.interval];
  if (ms === undefined) return true; // legacy/invalid persisted value: retry immediately, never loop forever
  const last = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : Number.NaN;
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= ms;
}

export interface RetentionOptions {
  maxKept: number;
  /** Never prune this record (the archive just created). */
  keepId?: string;
  safetyPoolSize?: number;
  worldDeletePoolSize?: number;
}

/**
 * Pick the rows retention should delete.
 * - Manual/Auto: newest `maxKept` survive (the just-created id counts toward the limit but is
 *   never returned, so retention cannot keep `maxKept + 1` archives).
 * - Pre-install / Pre-restore: bounded per-kind safety pool (default 2 each).
 * - World-delete: bounded pool (default 5) so delete safety copies cannot grow forever.
 */
export function planRetention(rows: readonly BackupRecord[], options: RetentionOptions): BackupRecord[] {
  const maxKept = Math.max(0, Math.trunc(options.maxKept));
  const safetyPool = Math.max(0, Math.trunc(options.safetyPoolSize ?? SAFETY_POOL_SIZE));
  const worldDeletePool = Math.max(0, Math.trunc(options.worldDeletePoolSize ?? WORLD_DELETE_POOL_SIZE));
  const newestFirst = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const doomed: BackupRecord[] = [];

  doomed.push(...newestFirst.filter((row) => row.kind === 'Manual' || row.kind === 'Auto').slice(maxKept));
  for (const kind of ['Pre-install', 'Pre-restore'] as const) {
    doomed.push(...newestFirst.filter((row) => row.kind === kind).slice(safetyPool));
  }
  doomed.push(...newestFirst.filter((row) => row.kind === 'World-delete').slice(worldDeletePool));

  const keep = new Set(doomed.map((row) => row.id));
  if (options.keepId) keep.delete(options.keepId);
  return doomed.filter((row) => keep.has(row.id));
}

/** Vanilla/Paper/old-Minecraft flush acknowledgement lines. */
export function isSaveAckLine(line: string): boolean {
  return /Saved the (game|world)\b/i.test(line);
}

/** True when a save acknowledgement appears in `lines` at/after `fromIndex`. */
export function hasSaveAck(lines: readonly string[], fromIndex = 0): boolean {
  const start = Math.max(0, Math.trunc(fromIndex));
  return lines.slice(start).some(isSaveAckLine);
}

export interface SaveAckWait {
  lines: () => readonly string[];
  baseline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

/**
 * Wait (bounded) for the server to print its flush acknowledgement. Injectable clock/sleep/line
 * supplier so the service and unit tests can drive it deterministically.
 */
export async function waitForSaveAck(wait: SaveAckWait): Promise<boolean> {
  const started = wait.now();
  const timeout = Math.max(0, wait.timeoutMs);
  for (;;) {
    if (hasSaveAck(wait.lines(), wait.baseline)) return true;
    if (wait.now() - started >= timeout) return false;
    await wait.sleep(Math.max(1, wait.pollMs));
  }
}

export interface BackupNoteInput {
  kind: BackupKind;
  live: boolean;
  flushAck: boolean;
  flushTimedOut: boolean;
  shutdownDuring: boolean;
}

/** Human note persisted on the backup row; explains the consistency level of the archive. */
export function buildBackupNote(input: BackupNoteInput): string {
  if (input.shutdownDuring) return 'Server stopped for a consistent backup';
  if (input.kind === 'Auto' && !input.live) return 'Scheduled backup';
  if (input.live && input.flushAck) return 'Taken while running after flush acknowledged';
  if (input.live && input.flushTimedOut) return 'Taken while running; flush acknowledgement timed out';
  if (input.live) return 'Taken while the server was running';
  return 'Taken while stopped';
}

export function slugify(value: string): string {
  const out = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out === '' ? 'server' : out;
}

export function backupTimestamp(at: Date = new Date()): string {
  return at.toISOString().replace(/[:.]/g, '-');
}

export function backupFileName(serverName: string, at: Date, kind: BackupKind): string {
  return `${slugify(serverName)}-${backupTimestamp(at)}-${kind.toLowerCase()}.zip`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export interface RestoreCandidate {
  name: string;
  existing: boolean;
  isDirectory: boolean;
}

export type RestoreAction = 'remove' | 'aside' | 'none';
export interface RestoreStep {
  name: string;
  action: RestoreAction;
}

/**
 * Plan the pre-swap step for each staged top-level entry.
 * - in-place: existing targets are moved aside (undoable by the restore rollback);
 * - reset: existing *directories* under a staged name are deleted (documented limitation: the
 *   delete is not part of the rollback list; only colliding top-level names are affected, not
 *   arbitrary extra folders that the archive does not contain).
 */
export function planRestoreSwap(
  staged: readonly string[],
  candidates: readonly RestoreCandidate[],
  mode: 'in-place' | 'reset',
): RestoreStep[] {
  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  return staged.map((name) => {
    const candidate = byName.get(name);
    if (!candidate || !candidate.existing) return { name, action: 'none' };
    if (mode === 'reset' && candidate.isDirectory) return { name, action: 'remove' };
    return { name, action: 'aside' };
  });
}

export interface DosTimestamp {
  /** DOS time field (2-second resolution). */
  time: number;
  /** DOS date field. */
  date: number;
}

/** Convert a source mtime into classic ZIP DOS date/time fields (clamped to 1980..2107). */
export function dosDateTime(at: Date | number): DosTimestamp {
  const date = typeof at === 'number' ? new Date(at) : new Date(at.getTime());
  if (Number.isNaN(date.getTime())) return { time: 0, date: (1 << 5) | 1 };
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { time, date: ((year - 1980) << 9) | (month << 5) | day };
}

export interface ZipBudgetEntry {
  name: string;
  size: number;
}

export interface ZipBudget {
  totalBytes: number;
  limit: number;
  maxEntries: number;
}

function zipLimitLabel(limit: number): string {
  const gib = limit / 1024 ** 3;
  return Number.isInteger(gib) ? `${gib} GiB` : `${limit} bytes`;
}

/**
 * Classic-ZIP preflight from metadata only (no file reads): entry count, entry-name length and
 * total uncompressed size. Throws `backup-failed` with a limit-naming message.
 */
export function checkZipBudget(
  entries: readonly ZipBudgetEntry[],
  opts: { limit?: number; maxEntries?: number } = {},
): ZipBudget {
  const limit = opts.limit ?? ZIP_LIMIT_BYTES;
  const maxEntries = opts.maxEntries ?? ZIP_MAX_ENTRIES;
  if (entries.length > maxEntries) {
    throw appError('backup-failed', `too many entries for a classic ZIP: ${entries.length} (maximum ${maxEntries})`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.name, 'utf8');
    if (nameBytes > 0xffff) {
      throw appError('backup-failed', `ZIP entry name is too long for a classic ZIP: ${entry.name} (${nameBytes} bytes)`);
    }
    if (!Number.isFinite(entry.size) || entry.size < 0) {
      throw appError('backup-failed', `invalid file size while planning the ZIP: ${entry.name}`);
    }
    totalBytes += entry.size;
  }
  if (totalBytes > limit) {
    throw appError(
      'backup-failed',
      `archive is too large for a classic ZIP: ${totalBytes} bytes exceeds the ${zipLimitLabel(limit)} limit (${limit} bytes)`,
    );
  }
  return { totalBytes, limit, maxEntries };
}
