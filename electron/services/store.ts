// JSON persistence — servers/settings/history/backups in <dataRoot>/app-data.json.
// Mirrors the Rust SQLite rows as camelCase DTOs; see src/tauri.ts ServerDto.
//
// Durability rules (Phase 1, B-06/B-07/B-28):
// - every mutator reloads first, mutates, then saves; all public mutators are synchronous, so a
//   reload→save pair cannot interleave with another handler on the same event loop;
// - a missing file is a fresh store, but an unreadable/corrupt file is NEVER treated as empty:
//   it is quarantined (copy) and a loud `store-corrupt` error is thrown;
// - writes go to a unique temp file, are fsynced, the previous file is kept as `.bak`, then renamed.
//
// WP-2.3 additions:
// - `createServer` validates every field through `validate-args.ts` (name/loader/mcVersion/RAM/port)
//   and rejects duplicate explicit ports (SQLite `port UNIQUE` parity);
// - `allocatePort(preferred?, { probe })` is the async port allocator used by IPC create paths:
//   range check + record uniqueness + injectable OS bind probe (real probe by default);
// - command history is capped at 100 entries per server and read newest-first (lifecycle contract),
//   while `commandHistory` still returns `string[]` for the renderer.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AUTO_PORT_START,
  PORT_MAX,
  normalizeCreateServerInput,
  probePortAvailable,
  validatePortNumber,
  type PortAvailabilityProbe,
} from './validate-args';

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

/** Newest N commands retained per server (Rust `MAX_COMMAND_HISTORY` parity). */
export const MAX_COMMAND_HISTORY_PER_SERVER = 100;
/** Hard cap for the whole history blob (all servers); oldest rows roll off first. */
const MAX_COMMAND_HISTORY_TOTAL = 2000;

export interface AllocatePortOptions {
  /** Injectable OS bind probe (`true` = port free). Defaults to the real 127.0.0.1 probe. */
  probe?: PortAvailabilityProbe;
}

export interface CommandHistoryEntry {
  command: string;
  at: string;
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

  /**
   * Create a server row. Input is normalised/validated first (WP-2.3): name ≤64 with no newline/`=`,
   * loader allowlist (Quilt rejected per ADR-0005), Minecraft version syntax, RAM 512–65536 MB and an
   * explicit port in 1024–65535. Loader spelling is preserved for legacy-friendly callers while new
   * IPC/UI paths canonicalise before calling (see `normalizeCreateServerInput`).
   *
   * Explicit ports must be unique across records (SQLite `port UNIQUE` parity). Auto ports
   * (`undefined`/`0`) are assigned synchronously from 25565+ skipping recorded ports; the async
   * OS-probing allocator is {@link allocatePort} (used by the `servers_create` IPC handler).
   */
  createServer(input: CreateServerInput): ServerDto {
    const normalized = normalizeCreateServerInput(input, { preserveLoaderCase: true });
    return this.mutate(() => {
      if (this.data.servers.some((server) => server.name === normalized.name)) {
        throw appError('conflict', `A server named "${normalized.name}" already exists.`);
      }
      let port: number;
      if (normalized.port !== undefined) {
        port = validatePortNumber(normalized.port);
        const owner = this.data.servers.find((server) => server.port === port);
        if (owner) {
          throw appError('conflict', `Port ${port} is already assigned to server "${owner.name}".`);
        }
      } else {
        port = this.nextRecordFreePort();
      }
      const dto: ServerDto = {
        id: randomUUID(),
        name: normalized.name,
        loader: normalized.loader,
        mcVersion: normalized.mcVersion,
        loaderVersion: normalized.loaderVersion ?? null,
        modpackId: normalized.modpackId ?? null,
        port,
        ramMb: normalized.ramMb,
        javaPath: normalized.javaPath ?? null,
        eulaAccepted: normalized.eulaAccepted ?? false,
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

  /**
   * Allocate a game port (WP-2.3).
   *
   * - `preferred` given: must be an integer in 1024–65535 (`validation`), not assigned to another
   *   record and currently bindable (`conflict`); the *same* port is returned — never rewritten.
   * - no preferred (null/undefined/0): first free port ≥25565, skipping recorded ports and probing
   *   each candidate; fails closed with `conflict` when the range is exhausted.
   *
   * The OS probe is injectable for deterministic tests; production uses
   * {@link probePortAvailable} (127.0.0.1 bind).
   */
  async allocatePort(preferred?: number | null, options: AllocatePortOptions = {}): Promise<number> {
    this.reload();
    const probe = options.probe ?? probePortAvailable;
    if (typeof probe !== 'function') throw appError('validation', 'Port probe must be a function.');
    const used = new Map<number, string>();
    for (const server of this.data.servers) {
      if (Number.isInteger(server.port) && server.port >= 1 && server.port <= PORT_MAX) {
        used.set(server.port, server.name);
      }
    }

    const request = preferred === undefined || preferred === null || preferred === 0
      ? null
      : validatePortNumber(preferred);
    const probePort = async (port: number): Promise<boolean> => {
      try {
        return await probe(port);
      } catch (error) {
        throw appError('io', `Could not verify port ${port}: ${(error as Error).message}`);
      }
    };

    if (request !== null) {
      const owner = used.get(request);
      if (owner !== undefined) {
        throw appError('conflict', `Port ${request} is already assigned to server "${owner}".`);
      }
      if (!(await probePort(request))) {
        throw appError('conflict', `Port ${request} is already in use on this machine. Choose another port.`);
      }
      return request;
    }

    for (let port = AUTO_PORT_START; port <= PORT_MAX; port += 1) {
      if (used.has(port)) continue;
      if (await probePort(port)) return port;
    }
    throw appError('conflict', `No free game port is available between ${AUTO_PORT_START} and ${PORT_MAX}.`);
  }

  /** Synchronous record-only allocation for direct Store callers; the OS probe runs in allocatePort. */
  private nextRecordFreePort(): number {
    const used = new Set<number>();
    for (const server of this.data.servers) {
      if (Number.isInteger(server.port) && server.port >= 1 && server.port <= PORT_MAX) used.add(server.port);
    }
    for (let port = AUTO_PORT_START; port <= PORT_MAX; port += 1) {
      if (!used.has(port)) return port;
    }
    throw appError('conflict', `No free game port is available between ${AUTO_PORT_START} and ${PORT_MAX}.`);
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

  /**
   * Insert a record for a server folder that already exists on disk, keeping that folder's id.
   *
   * Needed because `createServer` mints a fresh random id, which would orphan `servers/<existing-id>`. Recovery of a lost
   * record must attach to the directory that holds the data, so the id is supplied by the caller and validated here.
   *
   * Rejects a duplicate id or name, and a non-positive port, because those would produce a record the app cannot use.
   */
  adoptServer(record: ServerDto): ServerDto {
    return this.mutate(() => {
      if (record.id === '' || !/^[0-9a-zA-Z-]+$/.test(record.id)) {
        throw appError('validation', `Cannot adopt a server with an invalid id: "${record.id}".`);
      }
      if (this.data.servers.some((server) => server.id === record.id)) {
        throw appError('conflict', `A server with id "${record.id}" already exists.`);
      }
      if (this.data.servers.some((server) => server.name === record.name)) {
        throw appError('conflict', `A server named "${record.name}" already exists.`);
      }
      if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
        throw appError('validation', `Cannot adopt a server with an invalid port: ${record.port}.`);
      }
      if (this.data.servers.some((server) => server.port === record.port)) {
        throw appError('conflict', `Port ${record.port} is already assigned to another server.`);
      }
      this.data.servers.push(record);
      return record;
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

  /**
   * Record a successful console command send. Retention (WP-2.3 / Rust `MAX_COMMAND_HISTORY`):
   * newest `MAX_COMMAND_HISTORY_PER_SERVER` entries per server, with a whole-file safety cap.
   * The row stores `{ serverId, command, at }` so timestamps survive a restart.
   */
  pushCommand(serverId: string, command: string): void {
    this.mutate(() => {
      this.data.consoleCommandHistory.push({ serverId, command, at: new Date().toISOString() });
      const forServer = this.data.consoleCommandHistory.filter((row) => row.serverId === serverId);
      const excess = forServer.length - MAX_COMMAND_HISTORY_PER_SERVER;
      if (excess > 0) {
        const drop = new Set(forServer.slice(0, excess));
        this.data.consoleCommandHistory = this.data.consoleCommandHistory.filter((row) => !drop.has(row));
      }
      if (this.data.consoleCommandHistory.length > MAX_COMMAND_HISTORY_TOTAL) {
        this.data.consoleCommandHistory = this.data.consoleCommandHistory.slice(-MAX_COMMAND_HISTORY_TOTAL);
      }
    });
  }

  /**
   * Per-server command history, NEWEST FIRST (the renderer sends the newest command on Arrow-Up;
   * Rust `console::command_history` also ordered newest-first). Returns `string[]` for
   * `server_command_history`; use {@link commandHistoryEntries} when the timestamp is needed.
   */
  commandHistory(serverId: string, limit = MAX_COMMAND_HISTORY_PER_SERVER): string[] {
    return this.commandHistoryEntries(serverId, limit).map((entry) => entry.command);
  }

  /** Per-server command history as `{ command, at }`, newest first, capped at 100 per server. */
  commandHistoryEntries(serverId: string, limit = MAX_COMMAND_HISTORY_PER_SERVER): CommandHistoryEntry[] {
    this.reload();
    const rows = this.data.consoleCommandHistory.filter((row) => row.serverId === serverId);
    const max = Math.max(0, Math.min(Math.trunc(limit), MAX_COMMAND_HISTORY_PER_SERVER));
    const count = Math.min(max, rows.length);
    if (count === 0) return [];
    return rows.slice(rows.length - count).reverse().map((row) => ({ command: row.command, at: row.at }));
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
