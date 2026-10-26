// Backups — real ZIP archives of worlds + server config, restore with safety copy and rollback,
// retention, exports and the simple auto-backup scheduler from the spec.
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

const INTERVAL_MS: Record<BackupSchedule['interval'], number> = {
  Hourly: 60 * 60 * 1000,
  Daily: 24 * 60 * 60 * 1000,
  Weekly: 7 * 24 * 60 * 60 * 1000,
};

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

function slug(value: string): string {
  const out = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out === '' ? 'server' : out;
}

function timestamp(at = new Date()): string {
  return at.toISOString().replace(/[:.]/g, '-');
}

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

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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

export class Backups {
  private timer: NodeJS.Timeout | null = null;
  private busy = new Set<string>();

  constructor(private ctx: IpcContext, private processes: ServerProcesses, private jobs: Jobs) {}

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
      const maxKept = Math.max(1, Math.min(50, schedule.maxKept || 10));
      const rows = store.listBackups(serverId).filter((row) => row.id !== keepId && row.kind !== 'World-delete');
      for (const row of rows.slice(maxKept)) {
        await fsp.rm(row.path, { force: true });
        store.removeBackup(row.id);
      }
    } catch (error) {
      // Retention must never turn a completed backup into a failure.
      console.warn(`[backup] prune failed: ${(error as Error).message}`);
    }
  }

  async create(serverId: string, name: string, kind: BackupRecord['kind'] = 'Manual', jobId = ''): Promise<BackupRecord> {
    if (this.busy.has(serverId)) throw appError('conflict', 'A backup or restore is already running for this server.');
    return this.doCreate(serverId, name, kind, jobId);
  }

  private async doCreate(serverId: string, name: string, kind: BackupRecord['kind'], jobId: string): Promise<BackupRecord> {
    this.busy.add(serverId);
    const progress = (pct: number, stage: string): void => {
      if (jobId) this.jobs.progress(jobId, { progress: pct, stage });
    };
    let saveOff = false;
    try {
      const dto = this.requireServer(serverId);
      const dir = this.serverDir(serverId);
      if (!fs.existsSync(dir)) throw appError('not-found', `Server directory for ${dto.name} does not exist.`);
      const live = this.processes.status(serverId) === 'running' || this.processes.status(serverId) === 'starting';
      if (live) {
        saveOff = true;
        try {
          this.processes.command(serverId, 'save-off');
          this.processes.command(serverId, 'save-all flush');
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch {
          // A server that just stopped is already consistent enough.
        }
      }
      progress(5, 'collecting files');
      const inputs = await collectInputs(dir, backupNames(dir));
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
      const at = new Date();
      const label = name.trim() === '' ? `${dto.name} ${timestamp(at).slice(0, 16)}` : name.trim();
      const file = `${slug(dto.name)}-${timestamp(at)}-${kind.toLowerCase()}.zip`;
      const dest = path.join(destDir, file);
      const bytes = await writeZip(dest, inputs);
      progress(90, 'recording backup');
      const record: BackupRecord = {
        id: randomUUID(),
        serverId,
        name: label,
        path: dest,
        bytes,
        kind,
        note: kind === 'Auto' ? 'Scheduled backup' : live ? 'Taken while the server was running' : 'Taken while stopped',
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
      await this.create(serverId, `pre-restore ${timestamp()}`, 'Pre-restore');
      this.busy.add(serverId);
      progress(20, 'extracting backup');
      fs.mkdirSync(staging, { recursive: true });
      fs.mkdirSync(previous, { recursive: true });
      await extractZip(record.path, staging, { root: '', skipExisting: false, maxTotalBytes: 4 * 1024 ** 3 });
      progress(55, 'swapping files');
      for (const name of fs.readdirSync(staging)) {
        const target = path.join(dir, name);
        if (mode === 'reset' && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          await fsp.rm(target, { recursive: true, force: true });
        } else if (fs.existsSync(target)) {
          await fsp.rename(target, path.join(previous, name));
          moves.push({ kind: 'aside', name });
        }
        await fsp.rename(path.join(staging, name), target);
        moves.push({ kind: 'in', name });
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
      defaultPath: path.join(path.basename(record.path)),
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
    const next: BackupSchedule = {
      auto: patch.auto ?? current.auto,
      interval: patch.interval ?? current.interval,
      maxKept: Math.max(1, Math.min(50, patch.maxKept ?? current.maxKept)),
      lastRunAt: current.lastRunAt,
    };
    return this.store().setBackupSchedule(serverId, next);
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

  private async tick(): Promise<void> {
    const store = this.store();
    for (const dto of store.listServers()) {
      const schedule = store.backupSchedule(dto.id);
      if (!schedule.auto || this.busy.has(dto.id)) continue;
      const last = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : 0;
      if (Date.now() - last < INTERVAL_MS[schedule.interval]) continue;
      try {
        await this.create(dto.id, `auto ${timestamp()}`, 'Auto');
        store.setBackupSchedule(dto.id, { ...schedule, lastRunAt: new Date().toISOString() });
      } catch (error) {
        console.warn(`[backup] scheduled backup for ${dto.name} failed: ${(error as Error).message}`);
      }
    }
  }

  /** World folders are needed by the dashboard; shared with the worlds service. */
  worldNames(dir: string): string[] { return worldNames(dir); }
  directoryBytes(dir: string): Promise<number> { return directoryBytes(dir); }

  handlers(): Record<string, Handler> {
    return {
      backups_list: (a) => this.list(String(a.id)),
      backup_create: async (a) => this.create(String(a.id), String(a.name ?? ''), (a.kind as BackupRecord['kind']) ?? 'Manual', String(a.jobId ?? '')),
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
