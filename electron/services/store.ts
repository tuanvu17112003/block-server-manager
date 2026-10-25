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
}

const EMPTY: AppData = { schemaVersion: 1, servers: [], settings: {}, consoleCommandHistory: [] };

export class Store {
  private file: string;
  private data: AppData;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'app-data.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(this.data.servers)) throw new Error('bad shape');
    } catch {
      this.data = { ...EMPTY };
    }
  }

  private save(): void {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  listServers(): ServerDto[] {
    return this.data.servers;
  }

  getServer(id: string): ServerDto | null {
    return this.data.servers.find(s => s.id === id) ?? null;
  }

  createServer(input: CreateServerInput): ServerDto {
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
    };
    this.data.servers.push(dto);
    this.save();
    return dto;
  }

  deleteServer(id: string): void {
    this.data.servers = this.data.servers.filter(s => s.id !== id);
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
