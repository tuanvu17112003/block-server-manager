// JSON persistence — servers/settings/history in <dataRoot>/app-data.json, atomic writes.
// Mirrors the Rust SQLite rows (schema v1 servers table) as camelCase DTOs; see src/tauri.ts ServerDto.
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

export class Store {
  private file: string;
  private data!: AppData;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'app-data.json');
    this.reload();
  }

  /** Read-through: handlers construct their own Store instances, so every access
   *  must reflect the latest on-disk state (fixes cross-instance "not found"). */
  private reload(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AppData>;
      if (!Array.isArray(parsed.servers)) throw new Error('bad shape');
      this.data = {
        ...emptyData(),
        ...parsed,
        schemaVersion: 2,
        settings: parsed.settings ?? {},
        consoleCommandHistory: parsed.consoleCommandHistory ?? [],
        backups: parsed.backups ?? [],
        backupSchedules: parsed.backupSchedules ?? {},
        pendingWorlds: parsed.pendingWorlds ?? {},
      };
    } catch {
      this.data = emptyData();
    }
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  listServers(): ServerDto[] {
    this.reload();
    return this.data.servers;
  }

  getServer(id: string): ServerDto | null {
    this.reload();
    return this.data.servers.find(s => s.id === id) ?? null;
  }

  createServer(input: CreateServerInput): ServerDto {
    this.reload();
    if (this.data.servers.some(s => s.name === input.name)) {
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
    this.save();
    return dto;
  }

  deleteServer(id: string): void {
    this.reload();
    this.data.servers = this.data.servers.filter(s => s.id !== id);
    this.data.backups = this.data.backups.filter(b => b.serverId !== id);
    delete this.data.backupSchedules[id];
    delete this.data.pendingWorlds[id];
    this.save();
  }

  getSetting<T>(key: string): T | null {
    this.reload();
    return (this.data.settings[key] as T | undefined) ?? null;
  }

  setSetting(key: string, value: unknown): void {
    this.reload();
    this.data.settings[key] = value;
    this.save();
  }

  listBackups(serverId: string): BackupRecord[] {
    this.reload();
    return this.data.backups
      .filter(b => b.serverId === serverId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getBackup(id: string): BackupRecord | null {
    this.reload();
    return this.data.backups.find(b => b.id === id) ?? null;
  }

  addBackup(record: BackupRecord): BackupRecord {
    this.reload();
    this.data.backups.push(record);
    this.save();
    return record;
  }

  removeBackup(id: string): void {
    this.reload();
    this.data.backups = this.data.backups.filter(b => b.id !== id);
    this.save();
  }

  backupSchedule(serverId: string): BackupSchedule {
    this.reload();
    return this.data.backupSchedules[serverId] ?? { auto: false, interval: 'Daily', maxKept: 10, lastRunAt: null };
  }

  setBackupSchedule(serverId: string, schedule: BackupSchedule): BackupSchedule {
    this.reload();
    this.data.backupSchedules[serverId] = schedule;
    this.save();
    return schedule;
  }

  pendingWorld(serverId: string): PendingWorld | null {
    this.reload();
    return this.data.pendingWorlds[serverId] ?? null;
  }

  setPendingWorld(serverId: string, pending: PendingWorld | null): void {
    this.reload();
    if (pending) this.data.pendingWorlds[serverId] = pending;
    else delete this.data.pendingWorlds[serverId];
    this.save();
  }

  setJavaPath(id: string, javaPath: string | null): ServerDto {
    const s = this.require(id);
    s.javaPath = javaPath;
    this.save();
    return s;
  }

  updateServer(id: string, patch: Partial<ServerDto>): ServerDto {
    const s = this.require(id);
    Object.assign(s, patch);
    this.save();
    return s;
  }

  pushCommand(serverId: string, command: string): void {
    this.data.consoleCommandHistory.push({ serverId, command, at: new Date().toISOString() });
    if (this.data.consoleCommandHistory.length > 500) this.data.consoleCommandHistory.shift();
    this.save();
  }

  commandHistory(serverId: string): string[] {
    this.reload();
    return this.data.consoleCommandHistory.filter(h => h.serverId === serverId).map(h => h.command);
  }

  private require(id: string): ServerDto {
    const s = this.getServer(id);
    if (!s) throw appError('not-found', `Server ${id} not found.`);
    return s;
  }
}

export function appError(code: string, message: string): Error {
  const e = new Error(message);
  (e as Error & { code?: string }).code = code;
  return e;
}
