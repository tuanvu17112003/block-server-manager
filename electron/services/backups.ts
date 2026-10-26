// Backups — real ZIP archives of worlds + server config, restore with safety copy and rollback,
// retention pools, exports and the interval auto-backup scheduler from the spec.
// WP-5.2/5.5: validated schedule, pooled retention (never the just-created archive), bounded
// flush-acknowledgement wait with save-on in finally, optional shutdown-during backup, and
// ZIP writer hardening (see zip.ts/backups-core.ts).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog } from 'electron';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type BackupRecord, type BackupSchedule, type ServerDto } from './store';
import { Jobs } from './jobs';
import { collectInputs, writeZip } from './zip';
import { readProperties, safeLevelName } from './properties';
import { extractZip } from './installer/core';
import type { ServerProcesses } from './server-process';
import {
  buildBackupNote,
  backupFileName,
  backupTimestamp,
  humanBytes,
  isScheduleDue,
  normalizeBackupKind,
  normalizeMaxKept,
  normalizeSchedulePatch,
  planRestoreSwap,
  planRetention,
  waitForSaveAck,
  ZIP_LIMIT_BYTES,
  type BackupKind,
  type RestoreCandidate,
} from './backups-core';

const CONFIG_NAMES = [
  'server.properties',
  'config',
  'defaultconfigs',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
  'eula.txt',
];

/** Bounded wait for the server's flush acknowledgement before files are collected. */
export const FLUSH_ACK_TIMEOUT_MS = 10_000;
const FLUSH_POLL_MS = 100;

function worldNames(dir: string): string[] {
  let level = 'world';
  try {
    level = safeLevelName(readProperties(dir).values['level-name']);
  } catch {
    // A server that has not started yet has no server.properties.
  }
  return [level, `${level}_nether`, `${level}_the_end`];
}

function backupNames(dir: string): string[] {
  return [...new Set([...worldNames(dir), ...CONFIG_NAMES])];
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === 'session.lock') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else if (entry.isFile()) total += (await fsp.stat(full)).size;
  }
  return total;
}

export interface CreateBackupOptions {
  /** Stop the server for a consistent snapshot, then restart it if it was running. */
  shutdownDuring?: boolean;
}

export interface BackupsRuntimeDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  lines: (serverId: string) => readonly string[];
  /** Monotonic log sequence; avoids missing a flush ack when the ring is saturated (M-20 pattern). */
  lineSeq: (serverId: string) => number;
  entriesSince: (serverId: string, fromSeq: number, limit?: number) => readonly { seq: number; text: string }[];
  flushTimeoutMs: number;
  flushPollMs: number;
}

export class Backups {
  private timer: NodeJS.Timeout | null = null;
  private busy = new Set<string>();
  private readonly deps: BackupsRuntimeDeps;

  constructor(
    private ctx: IpcContext,
    private processes: ServerProcesses,
    private jobs: Jobs,
    deps: Partial<BackupsRuntimeDeps> = {},
  ) {
    this.deps = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      lines: (serverId) => processes.history(serverId),
      lineSeq: (serverId) => processes.lineSeq(serverId),
      entriesSince: (serverId, fromSeq, limit) => processes.entriesSince(serverId, fromSeq, limit),
      flushTimeoutMs: FLUSH_ACK_TIMEOUT_MS,
      flushPollMs: FLUSH_POLL_MS,
      ...deps,
    };
  }

  private store(): Store { return new Store(this.ctx.dataRoot); }
  private serverDir(id: string): string { return path.join(this.ctx.dataRoot, 'servers', id); }
  private backupsDir(): string { return path.join(this.ctx.dataRoot, 'backups'); }

  private requireServer(id: string): ServerDto {
    const dto = this.store().getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    return dto;
  }

  private requireIdle(id: string): ServerDto {
    const dto = this.requireServer(id);
    const status = this.processes.status(id);
    if (status === 'running' || status === 'starting' || status === 'stopping') {
      throw appError('conflict', `The server is ${status}; stop it before restoring or changing worlds.`);
    }
    return dto;
  }

  private async prune(serverId: string, keepId?: string): Promise<void> {
    try {
      const store = this.store();
      const schedule = store.backupSchedule(serverId);
      const maxKept = normalizeMaxKept(schedule.maxKept, 10);
      const rows = store.listBackups(serverId);
      const doomed = planRetention(rows, { maxKept, keepId });
      for (const row of doomed) {
        await fsp.rm(row.path, { force: true });
        store.removeBackup(row.id);
      }
    } catch (error) {
      // Retention must never turn a completed backup into a failure.
      console.warn(`[backup] prune failed: ${(error as Error).message}`);
    }
  }

  async create(
    serverId: string,
    name: string,
    kind: BackupKind = 'Manual',
    jobId = '',
    options: CreateBackupOptions = {},
  ): Promise<BackupRecord> {
    if (this.busy.has(serverId)) throw appError('conflict', 'A backup or restore is already running for this server.');
    return this.doCreate(serverId, name, normalizeBackupKind(kind), jobId, options);
  }

  private async doCreate(
    serverId: string,
    name: string,
    kind: BackupKind,
    jobId: string,
    options: CreateBackupOptions,
  ): Promise<BackupRecord> {
    this.busy.add(serverId);
    const progress = (pct: number, stage: string): void => {
      if (jobId) this.jobs.progress(jobId, { progress: pct, stage });
    };
    let saveOff = false;
    let restartedAfterShutdown = false;
    try {
      const dto = this.requireServer(serverId);
      const dir = this.serverDir(serverId);
      if (!fs.existsSync(dir)) throw appError('not-found', `Server directory for ${dto.name} does not exist.`);

      const status = this.processes.status(serverId);
      if (status === 'stopping') {
        throw appError('conflict', 'The server is stopping; wait until it is stopped before taking a backup.');
      }
      const shutdownDuring = options.shutdownDuring === true;
      const wasRunning = status === 'running' || status === 'starting';
      if (status === 'starting' && !shutdownDuring) {
        throw appError('conflict', 'The server is still starting; wait for it to finish or use shutdownDuring.');
      }

      if (shutdownDuring && wasRunning) {
        progress(2, 'stopping server for backup');
        await this.processes.stop(serverId);
        restartedAfterShutdown = true;
      }

      let live = this.processes.status(serverId) === 'running';
      let flushAck = false;
      let flushTimedOut = false;
      if (live) {
        const baselineSeq = this.deps.lineSeq(serverId);
        try {
          this.processes.command(serverId, 'save-off');
          saveOff = true;
          this.processes.command(serverId, 'save-all flush');
        } catch {
          // The server vanished between the status check and the commands: archive stopped anyway.
          // Keep saveOff set if save-off already went through so the finally block still resumes saves.
          live = false;
        }
        if (saveOff) {
          progress(4, 'waiting for flush acknowledgement');
          flushAck = await waitForSaveAck({
            // Sequence-based: a saturated 5000-line ring cannot hide the new ack line.
            lines: () => this.deps.entriesSince(serverId, baselineSeq, 500).map((entry) => entry.text),
            baseline: 0,
            now: this.deps.now,
            sleep: this.deps.sleep,
            timeoutMs: this.deps.flushTimeoutMs,
            pollMs: this.deps.flushPollMs,
          });
          flushTimedOut = !flushAck;
          if (flushTimedOut) {
            console.warn(`[backup] ${dto.name}: save-all flush not acknowledged within ${this.deps.flushTimeoutMs}ms; archiving anyway`);
          }
        }
      }

      progress(8, 'collecting files');
      const inputs = (await collectInputs(dir, backupNames(dir)))
        // `session.lock` is held open by a running JVM (RandomAccessFile) on Windows: reading it
        // yields EBUSY and it must not be restored anyway (Minecraft recreates it). Phase 8 soak
        // finding: every live backup failed on this file until it was excluded.
        .filter((input) => !/(^|\/)session\.lock$/i.test(input.name));
      if (inputs.length === 0) throw appError('backup-failed', 'There are no world or config files to archive yet.');
      const destDir = this.backupsDir();
      fs.mkdirSync(destDir, { recursive: true });

      let estimate = 0;
      for (const input of inputs) estimate += (await fsp.stat(input.path)).size;
      const free = fs.statfsSync(destDir);
      if (free.bavail * free.bsize < estimate * 2) {
        throw appError('backup-failed', `Not enough free disk space for a ${humanBytes(estimate)} backup (needs 2×).`);
      }
      progress(20, `archiving ${inputs.length} files`);
      const at = new Date(this.deps.now());
      const label = name.trim() === '' ? `${dto.name} ${backupTimestamp(at).slice(0, 16)}` : name.trim();
      const dest = path.join(destDir, backupFileName(dto.name, at, kind));
      const bytes = await writeZip(dest, inputs);
      progress(90, 'recording backup');
      const record: BackupRecord = {
        id: randomUUID(),
        serverId,
        name: label,
        path: dest,
        bytes,
        kind,
        note: buildBackupNote({
          kind,
          live,
          flushAck,
          flushTimedOut,
          shutdownDuring: shutdownDuring && wasRunning,
        }),
        createdAt: at.toISOString(),
      };
      this.store().addBackup(record);
      await this.prune(serverId, record.id);
      progress(100, 'backup complete');
      return record;
    } catch (error) {
      if (jobId) this.jobs.progress(jobId, { progress: 100, stage: 'backup failed' });
      throw error;
    } finally {
      if (saveOff) {
        try { this.processes.command(serverId, 'save-on'); } catch { /* server gone */ }
      }
      if (restartedAfterShutdown) {
        try {
          await this.processes.start(serverId);
        } catch (error) {
          console.warn(`[backup] restart after shutdown-during backup failed: ${(error as Error).message}`);
        }
      }
      this.busy.delete(serverId);
    }
  }

  list(serverId: string): BackupRecord[] {
    this.requireServer(serverId);
    return this.store().listBackups(serverId);
  }

  async restore(serverId: string, backupId: string, mode: 'in-place' | 'reset' = 'in-place', jobId = ''): Promise<void> {
    this.requireIdle(serverId);
    const store = this.store();
    const record = store.getBackup(backupId);
    if (!record || record.serverId !== serverId) throw appError('not-found', 'Backup not found for this server.');
    if (!fs.existsSync(record.path)) throw appError('not-found', 'The backup archive is missing.');
    if (this.busy.has(serverId)) throw appError('conflict', 'A backup or restore is already running for this server.');

    const progress = (pct: number, stage: string): void => {
      if (jobId) this.jobs.progress(jobId, { progress: pct, stage });
    };
    const dir = this.serverDir(serverId);
    const staging = path.join(this.ctx.dataRoot, 'cache', `restore-${randomUUID()}`);
    const previous = path.join(this.ctx.dataRoot, 'cache', `restore-old-${randomUUID()}`);
    const moves: { kind: 'aside' | 'in'; name: string }[] = [];
    const unrecovered: string[] = [];
    try {
      progress(5, 'safety copy');
      // The safety archive is what makes a failed restore recoverable (specs §11).
      await this.create(serverId, `pre-restore ${backupTimestamp()}`, 'Pre-restore');
      this.busy.add(serverId);
      progress(20, 'extracting backup');
      fs.mkdirSync(staging, { recursive: true });
      fs.mkdirSync(previous, { recursive: true });
      await extractZip(record.path, staging, { root: '', skipExisting: false, maxTotalBytes: ZIP_LIMIT_BYTES });
      progress(55, 'swapping files');
      // Reset removes colliding top-level *directories* only; folders the archive does not contain
      // are left alone and are not part of the rollback list (documented limitation).
      const staged = fs.readdirSync(staging);
      const candidates: RestoreCandidate[] = staged.map((name) => {
        const target = path.join(dir, name);
        try {
          const stats = fs.statSync(target);
          return { name, existing: true, isDirectory: stats.isDirectory() };
        } catch {
          return { name, existing: false, isDirectory: false };
        }
      });
      for (const step of planRestoreSwap(staged, candidates, mode)) {
        const target = path.join(dir, step.name);
        if (step.action === 'remove') {
          await fsp.rm(target, { recursive: true, force: true });
        } else if (step.action === 'aside') {
          await fsp.rename(target, path.join(previous, step.name));
          moves.push({ kind: 'aside', name: step.name });
        }
        await fsp.rename(path.join(staging, step.name), target);
        moves.push({ kind: 'in', name: step.name });
      }
      progress(100, 'restore complete');
    } catch (error) {
      for (const move of [...moves].reverse()) {
        try {
          if (move.kind === 'in') await fsp.rename(path.join(dir, move.name), path.join(staging, move.name));
          else await fsp.rename(path.join(previous, move.name), path.join(dir, move.name));
        } catch {
          unrecovered.push(move.name);
        }
      }
      const cause = error instanceof Error ? error.message : String(error);
      throw appError('restore-failed', unrecovered.length === 0 ? cause : `${cause}; originals kept in ${previous}: ${unrecovered.join(', ')}`);
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
      if (unrecovered.length === 0) await fsp.rm(previous, { recursive: true, force: true });
      this.busy.delete(serverId);
    }
  }

  async remove(backupId: string): Promise<void> {
    const store = this.store();
    const record = store.getBackup(backupId);
    if (!record) throw appError('not-found', 'Backup not found.');
    if (this.busy.has(record.serverId)) throw appError('conflict', 'A backup or restore is already running for this server.');
    await fsp.rm(record.path, { force: true });
    store.removeBackup(backupId);
  }

  async export(backupId: string): Promise<{ path: string } | { cancelled: true }> {
    const record = this.store().getBackup(backupId);
    if (!record) throw appError('not-found', 'Backup not found.');
    const picked = await dialog.showSaveDialog({
      title: 'Export backup',
      defaultPath: path.basename(record.path),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    await fsp.copyFile(record.path, picked.filePath);
    return { path: picked.filePath };
  }

  schedule(serverId: string): BackupSchedule {
    this.requireServer(serverId);
    return this.store().backupSchedule(serverId);
  }

  setSchedule(serverId: string, patch: Partial<BackupSchedule>): BackupSchedule {
    this.requireServer(serverId);
    const current = this.store().backupSchedule(serverId);
    return this.store().setBackupSchedule(serverId, normalizeSchedulePatch(patch, current));
  }

  startScheduler(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref?.();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Public for the injectable-clock scheduler tests; also called by the 60 s timer. */
  async tick(): Promise<void> {
    try {
      const store = this.store();
      const now = this.deps.now();
      for (const dto of store.listServers()) {
        const schedule = store.backupSchedule(dto.id);
        if (!schedule.auto || this.busy.has(dto.id)) continue;
        if (!isScheduleDue(schedule, now)) continue;
        try {
          await this.create(dto.id, `auto ${backupTimestamp(new Date(now))}`, 'Auto');
          store.setBackupSchedule(dto.id, { ...schedule, lastRunAt: new Date(now).toISOString() });
        } catch (error) {
          console.warn(`[backup] scheduled backup for ${dto.name} failed: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      // A corrupt store must not crash the main process from an interval callback.
      console.warn(`[backup] scheduler tick failed: ${(error as Error).message}`);
    }
  }

  /** World folders are needed by the dashboard; shared with the worlds service. */
  worldNames(dir: string): string[] { return worldNames(dir); }
  directoryBytes(dir: string): Promise<number> { return directoryBytes(dir); }

  handlers(): Record<string, Handler> {
    return {
      backups_list: (a) => this.list(String(a.id)),
      backup_create: async (a) => this.create(
        String(a.id),
        String(a.name ?? ''),
        a.kind === undefined ? 'Manual' : normalizeBackupKind(a.kind),
        String(a.jobId ?? ''),
        { shutdownDuring: a.shutdownDuring === true },
      ),
      backup_restore: async (a) => {
        await this.restore(String(a.id), String(a.backupId), a.mode === 'reset' ? 'reset' : 'in-place', String(a.jobId ?? ''));
        return true;
      },
      backup_delete: async (a) => { await this.remove(String(a.backupId)); return true; },
      backup_export: (a) => this.export(String(a.backupId)),
      backup_schedule_get: (a) => this.schedule(String(a.id)),
      backup_schedule_set: (a) => this.setSchedule(String(a.id), {
        auto: a.auto as boolean | undefined,
        interval: a.interval as BackupSchedule['interval'] | undefined,
        maxKept: a.maxKept as number | undefined,
      }),
    };
  }
}
