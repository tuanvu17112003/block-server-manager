// Worlds — discovery from level.dat, activate with auto-backup, duplicate/delete/import/export,
// and the "new empty world" flow that writes level-name/seed/type for the next start.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dialog } from 'electron';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type ServerDto } from './store';
import { readProperties, safeLevelName, writePropertyValues } from './properties';
import { collectInputs, writeZip } from './zip';
import { extractZip } from './installer/core';
import type { Backups } from './backups';
import type { ServerProcesses } from './server-process';

export interface WorldDto {
  name: string;
  sizeBytes: number;
  lastModified: string;
  active: boolean;
  pending?: boolean;
}

const DIMENSION_SUFFIXES = ['_nether', '_the_end'] as const;
const SAFE_WORLD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function sameWorld(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeWorldName(value: string): string {
  const name = value.replace(/[<>:"/\\|?*\p{Cc}]/gu, '-').replace(/^[.\s-]+|[.\s-]+$/g, '');
  return name === '' ? 'world' : name;
}

export class Worlds {
  constructor(private ctx: IpcContext, private processes: ServerProcesses, private backups: Backups) {}

  private store(): Store { return new Store(this.ctx.dataRoot); }
  private serverDir(id: string): string { return path.join(this.ctx.dataRoot, 'servers', id); }

  private requireServer(id: string): ServerDto {
    const dto = this.store().getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    return dto;
  }

  private requireIdle(id: string): ServerDto {
    const dto = this.requireServer(id);
    const status = this.processes.status(id);
    if (status !== 'stopped' && status !== 'crashed') {
      throw appError('conflict', `The server is ${status}; stop it before changing worlds.`);
    }
    return dto;
  }

  private activeLevel(dir: string): string {
    try {
      return safeLevelName(readProperties(dir).values['level-name']);
    } catch {
      return 'world';
    }
  }

  private uniqueName(dir: string, base: string): string {
    let name = base;
    for (let suffix = 2; fs.existsSync(path.join(dir, name)); suffix += 1) name = `${base}-${suffix}`;
    return name;
  }

  async list(serverId: string): Promise<WorldDto[]> {
    this.requireServer(serverId);
    const dir = this.serverDir(serverId);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const candidates = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.mcsm-') && fs.existsSync(path.join(dir, entry.name, 'level.dat')))
      .map((entry) => entry.name);
    const listed = new Set(candidates);
    const isDimension = (name: string): boolean =>
      DIMENSION_SUFFIXES.some((suffix) => name.endsWith(suffix) && listed.has(name.slice(0, -suffix.length)));

    const active = this.activeLevel(dir);
    const worlds: WorldDto[] = [];
    for (const name of candidates.filter((candidate) => !isDimension(candidate))) {
      const worldDir = path.join(dir, name);
      worlds.push({
        name,
        sizeBytes: await this.backups.directoryBytes(worldDir),
        lastModified: fs.statSync(path.join(worldDir, 'level.dat')).mtime.toISOString(),
        active: sameWorld(name, active),
      });
    }

    const pending = this.store().pendingWorld(serverId);
    if (pending && !fs.existsSync(path.join(dir, pending.name))) {
      worlds.push({
        name: pending.name,
        sizeBytes: 0,
        lastModified: pending.createdAt,
        active: sameWorld(pending.name, active),
        pending: true,
      });
    }
    return worlds.sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1));
  }

  async activate(serverId: string, name: string): Promise<{ backupId: string }> {
    this.requireIdle(serverId);
    const worlds = await this.list(serverId);
    const world = worlds.find((entry) => sameWorld(entry.name, name));
    if (!world) throw appError('validation', `Not a world folder: ${name}`);
    if (world.pending) {
      throw appError('conflict', 'The pending world is created the next time the server starts. Start the server first.');
    }
    const backup = await this.backups.create(serverId, `before activate ${world.name}`, 'Manual');
    writePropertyValues(this.serverDir(serverId), { 'level-name': world.name });
    this.store().setPendingWorld(serverId, null);
    return { backupId: backup.id };
  }

  async create(serverId: string, name: string, seed: string, levelType: string): Promise<WorldDto> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const clean = name.trim();
    if (!SAFE_WORLD.test(clean)) {
      throw appError('validation', 'World name must be 1-64 letters, digits, dots, underscores or hyphens.');
    }
    if (clean.endsWith('_nether') || clean.endsWith('_the_end')) {
      throw appError('validation', 'That name is reserved for a dimension folder.');
    }
    if (fs.existsSync(path.join(dir, clean))) throw appError('conflict', `A folder named "${clean}" already exists.`);
    writePropertyValues(dir, {
      'level-name': clean,
      'level-seed': seed.trim(),
      'level-type': levelType,
    });
    const pending = { name: clean, seed: seed.trim(), levelType, createdAt: new Date().toISOString() };
    this.store().setPendingWorld(serverId, pending);
    return { name: clean, sizeBytes: 0, lastModified: pending.createdAt, active: true, pending: true };
  }

  async duplicate(serverId: string, name: string): Promise<WorldDto> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const source = path.join(dir, name);
    if (!fs.existsSync(path.join(source, 'level.dat'))) throw appError('validation', `Not a world folder: ${name}`);
    const targetName = this.uniqueName(dir, `${name}-copy`);
    fs.cpSync(source, path.join(dir, targetName), { recursive: true });
    return {
      name: targetName,
      sizeBytes: await this.backups.directoryBytes(path.join(dir, targetName)),
      lastModified: new Date().toISOString(),
      active: false,
    };
  }

  async remove(serverId: string, name: string): Promise<void> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const worlds = await this.list(serverId);
    const world = worlds.find((entry) => sameWorld(entry.name, name));
    if (!world) throw appError('validation', `Not a world folder: ${name}`);
    if (world.active) throw appError('conflict', `Refusing to delete the active world: ${name}`);
    const names = [world.name, ...DIMENSION_SUFFIXES.map((suffix) => `${world.name}${suffix}`).filter((dimension) => fs.existsSync(path.join(dir, dimension)))];
    await this.backups.create(serverId, `before delete ${world.name}`, 'World-delete');
    for (const target of names) fs.rmSync(path.join(dir, target), { recursive: true, force: true });
  }

  async export(serverId: string, name: string): Promise<{ path: string } | { cancelled: true }> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const worlds = await this.list(serverId);
    const world = worlds.find((entry) => sameWorld(entry.name, name));
    if (!world) throw appError('validation', `Not a world folder: ${name}`);
    const picked = await dialog.showSaveDialog({
      title: 'Export world',
      defaultPath: `${world.name}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    const inputs = await collectInputs(dir, [world.name, `${world.name}_nether`, `${world.name}_the_end`]);
    if (inputs.length === 0) throw appError('backup-failed', 'That world folder has no files to export.');
    await writeZip(picked.filePath, inputs);
    return { path: picked.filePath };
  }

  async import(serverId: string): Promise<{ name: string } | { cancelled: true }> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'World ZIP', extensions: ['zip'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'msm-world-import-'));
    try {
      await extractZip(picked.filePaths[0], staging, { root: '', skipExisting: false, maxTotalBytes: 4 * 1024 ** 3 });
      const entries = await fsp.readdir(staging, { withFileTypes: true });
      const atRoot = entries.some((entry) => entry.isFile() && entry.name === 'level.dat');
      const folders = entries.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(staging, entry.name, 'level.dat')));
      let source: string;
      let base: string;
      if (atRoot && folders.length === 0) {
        source = staging;
        base = safeWorldName(path.basename(picked.filePaths[0]).replace(/\.zip$/i, ''));
      } else if (!atRoot && folders.length === 1) {
        source = path.join(staging, folders[0]!.name);
        base = safeWorldName(folders[0]!.name);
      } else {
        throw appError('validation', 'The archive must hold level.dat at its root or in exactly one folder.');
      }
      const name = this.uniqueName(dir, base);
      fs.cpSync(source, path.join(dir, name), { recursive: true });
      return { name };
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }

  handlers(): Record<string, Handler> {
    return {
      worlds_list: (a) => this.list(String(a.id)),
      world_activate: (a) => this.activate(String(a.id), String(a.name)),
      world_create: (a) => this.create(String(a.id), String(a.name), String(a.seed ?? ''), String(a.levelType ?? 'minecraft:normal')),
      world_duplicate: (a) => this.duplicate(String(a.id), String(a.name)),
      world_delete: async (a) => { await this.remove(String(a.id), String(a.name)); return true; },
      world_export: (a) => this.export(String(a.id), String(a.name)),
      world_import: (a) => this.import(String(a.id)),
    };
  }
}
