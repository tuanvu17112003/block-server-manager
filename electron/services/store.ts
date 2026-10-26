// JSON persistence — servers/settings/history/backups in <dataRoot>/app-data.json.
// Mirrors the Rust SQLite rows as camelCase DTOs; see src/tauri.ts ServerDto.
//
// Durability rules (Phase 1, B-06/B-07/B-28):
// - every mutator reloads first, mutates, then saves; all public mutators are synchronous, so a
//   reload→save pair cannot interleave with another handler on the same event loop;
// - a missing file is a fresh store, but an unreadable/corrupt file is NEVER treated as empty:
//   it is quarantined (copy) and a loud `store-corrupt` error is thrown;
// - writes go to a unique temp file, are fsynced, the previous file is kept as `.bak`, then renamed.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ServerDto {
  id: string;
  name: string;
  loader: string;
  mcVersion: string;
  loaderVersion?: string | null;
  modpackId?: string | null;
  port: number;
  ramMb: number;
  javaPath?: string | null;
  eulaAccepted: boolean;
  status: string;
  createdAt: string;
  // Display cache of the server.properties 7-field subset (file remains authoritative).
  motd?: string;
  maxPlayers?: number;
  difficulty?: string;
  gamemode?: string;
  onlineMode?: boolean;
  worldName?: string;
}

export interface BackupRecord {
  id: string;
  serverId: string;
  name: string;
  path: string;
  bytes: number;
  kind: 'Manual' | 'Auto' | 'Pre-install' | 'Pre-restore' | 'World-delete';
  note: string;
  createdAt: string;
}

export interface BackupSchedule {
  auto: boolean;
  interval: 'Hourly' | 'Daily' | 'Weekly';
  maxKept: number;
  lastRunAt: string | null;
}

export interface PendingWorld {
  name: string;
  seed: string;
  levelType: string;
  createdAt: string;
}

export interface CreateServerInput {
  name: string;
  loader: string;
  mcVersion: string;
  loaderVersion?: string;
  modpackId?: string;
  port?: number;
  ramMb: number;
  javaPath?: string;
  eulaAccepted?: boolean;
}

interface AppData {
  schemaVersion: number;
  servers: ServerDto[];
  settings: Record<string, unknown>;
  consoleCommandHistory: { serverId: string; command: string; at: string }[];
  backups: BackupRecord[];
  backupSchedules: Record<string, BackupSchedule>;
  pendingWorlds: Record<string, PendingWorld>;
}

let tmpSeq = 0;

function emptyData(): AppData {
  return {
    schemaVersion: 2,
    servers: [],
    settings: {},
    consoleCommandHistory: [],
    backups: [],
    backupSchedules: {},
    pendingWorlds: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Store {
  private file: string;
  private data!: AppData;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'app-data.json');
    // Do not read in the constructor: a corrupt store must surface as a loud, retryable
    // handler error (UI banner) instead of aborting app startup while wiring services.
    this.data = emptyData();
  }

  /** Absolute path of the backing JSON file (tests/diagnostics). */
  get filePath(): string { return this.file; }

  /**
   * Read-through: handlers construct their own Store instances, so every access must reflect the
   * latest on-disk state. A missing file is a fresh store; anything else that fails is corruption.
   */
  private reload(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = emptyData();
        return;
      }
      throw appError('store-unreadable', `Cannot read ${this.file}: ${(error as Error).message}`);
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.servers)) throw new Error('invalid app-data shape');
      const record = parsed as Partial<AppData> & { servers: unknown[] };
      const data: AppData = {
        ...emptyData(),
        ...record,
        schemaVersion: 2,
        servers: [],
        settings: isRecord(record.settings) ? record.settings as Record<string, unknown> : {},
        consoleCommandHistory: Array.isArray(record.consoleCommandHistory) ? record.consoleCommandHistory : [],
        backups: Array.isArray(record.backups) ? record.backups : [],
        backupSchedules: isRecord(record.backupSchedules) ? record.backupSchedules as Record<string, BackupSchedule> : {},
        pendingWorlds: isRecord(record.pendingWorlds) ? record.pendingWorlds as Record<string, PendingWorld> : {},
      };
      const dropped = { servers: 0, backups: 0, history: 0 };
      for (const row of record.servers) {        if (!isRecord(row) || typeof row.id !== 'string' || row.id === '' || typeof row.name !== 'string' || row.name === '') {
          dropped.servers += 1;
          continue;
        }
        data.servers.push(row as unknown as ServerDto);
      }
      data.backups = data.backups.filter((row) => {
        const valid = isRecord(row) && typeof row.id === 'string' && typeof row.serverId === 'string' && typeof row.path === 'string';
        if (!valid) dropped.backups += 1;
        return valid;
      });
      data.consoleCommandHistory = data.consoleCommandHistory.filter((row) => {
        const valid = isRecord(row) && typeof row.serverId === 'string' && typeof row.command === 'string';
        if (!valid) dropped.history += 1;
        return valid;
      });
      if (dropped.servers + dropped.backups + dropped.history > 0) {
        console.warn(`[store] dropped invalid rows on load: ${JSON.stringify(dropped)}`);
      }
      this.data = data;
    } catch (error) {
      this.quarantine(text);
      throw appError(
        'store-corrupt',
        `app-data.json is unreadable (${(error as Error).message}). The original file is preserved; ` +
        'a quarantine copy was written next to it. Fix or restore it, then retry.',
      );
    }
  }

  private quarantine(text: string): void {
    try {
      const target = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
    } catch {
      // Quarantine is best effort; the original file is never overwritten by reload.
    }
  }

  private save(): void {
    const json = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.${process.pid}.${++tmpSeq}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.copyFileSync(this.file, `${this.file}.bak`); } catch { /* first write or unreadable */ }
    fs.renameSync(tmp, this.file);
  }

  /** Reload → mutate → save. The single mutation primitive: no async gap can lose a field. */
  private mutate<T>(fn: () => T): T {
    this.reload();
    const result = fn();
    this.save();
    return result;
  }

  listServers(): ServerDto[] {
    this.reload();
    return this.data.servers;
  }

  getServer(id: string): ServerDto | null {
    this.reload();
    return this.data.servers.find((server) => server.id === id) ?? null;
  }

  createServer(input: CreateServerInput): ServerDto {
    return this.mutate(() => {
      if (this.data.servers.some((server) => server.name === input.name)) {
        throw appError('conflict', `A server named "${input.name}" already exists.`);
      }
      const dto: ServerDto = {
        id: randomUUID(),
        name: input.name,
        loader: input.loader,
        mcVersion: input.mcVersion,
        loaderVersion: input.loaderVersion ?? null,
        modpackId: input.modpackId ?? null,
        port: input.port && input.port > 0 ? input.port : 25565,
        ramMb: input.ramMb,
        javaPath: input.javaPath ?? null,
        eulaAccepted: input.eulaAccepted ?? false,
        status: 'stopped',
        createdAt: new Date().toISOString(),
        motd: '',
        maxPlayers: 20,
        difficulty: 'Normal',
        gamemode: 'Survival',
        onlineMode: true,
        worldName: 'world',
      };
      this.data.servers.push(dto);
      return dto;
    });
  }

  deleteServer(id: string): void {
    this.mutate(() => {
      this.data.servers = this.data.servers.filter((server) => server.id !== id);
      this.data.backups = this.data.backups.filter((backup) => backup.serverId !== id);
      this.data.consoleCommandHistory = this.data.consoleCommandHistory.filter((row) => row.serverId !== id);
      delete this.data.backupSchedules[id];
      delete this.data.pendingWorlds[id];
      delete this.data.settings[`content:${id}`];
    });
  }

  getSetting<T>(key: string): T | null {
    this.reload();
    return (this.data.settings[key] as T | undefined) ?? null;
  }

  setSetting(key: string, value: unknown): void {
    this.mutate(() => { this.data.settings[key] = value; });
  }

  listBackups(serverId: string): BackupRecord[] {
    this.reload();
    return this.data.backups
      .filter((backup) => backup.serverId === serverId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getBackup(id: string): BackupRecord | null {
    this.reload();
    return this.data.backups.find((backup) => backup.id === id) ?? null;
  }

  addBackup(record: BackupRecord): BackupRecord {
    return this.mutate(() => {
      this.data.backups.push(record);
      return record;
    });
  }

  removeBackup(id: string): void {
    this.mutate(() => {
      this.data.backups = this.data.backups.filter((backup) => backup.id !== id);
    });
  }

  backupSchedule(serverId: string): BackupSchedule {
    this.reload();
    return this.data.backupSchedules[serverId] ?? { auto: false, interval: 'Daily', maxKept: 10, lastRunAt: null };
  }

  setBackupSchedule(serverId: string, schedule: BackupSchedule): BackupSchedule {
    return this.mutate(() => {
      this.data.backupSchedules[serverId] = schedule;
      return schedule;
    });
  }

  pendingWorld(serverId: string): PendingWorld | null {
    this.reload();
    return this.data.pendingWorlds[serverId] ?? null;
  }

  setPendingWorld(serverId: string, pending: PendingWorld | null): void {
    this.mutate(() => {
      if (pending) this.data.pendingWorlds[serverId] = pending;
      else delete this.data.pendingWorlds[serverId];
    });
  }

  setJavaPath(id: string, javaPath: string | null): ServerDto {
    return this.mutate(() => {
      const server = this.requireInData(id);
      server.javaPath = javaPath;
      return server;
    });
  }

  updateServer(id: string, patch: Partial<ServerDto>): ServerDto {
    return this.mutate(() => {
      const server = this.requireInData(id);
      Object.assign(server, patch);
      return server;
    });
  }

  pushCommand(serverId: string, command: string): void {
    this.mutate(() => {
      this.data.consoleCommandHistory.push({ serverId, command, at: new Date().toISOString() });
      if (this.data.consoleCommandHistory.length > 2000) this.data.consoleCommandHistory.shift();
    });
  }

  commandHistory(serverId: string): string[] {
    this.reload();
    return this.data.consoleCommandHistory.filter((row) => row.serverId === serverId).map((row) => row.command);
  }

  private requireInData(id: string): ServerDto {
    const server = this.data.servers.find((row) => row.id === id);
    if (!server) throw appError('not-found', `Server ${id} not found.`);
    return server;
  }
}

export function appError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}
