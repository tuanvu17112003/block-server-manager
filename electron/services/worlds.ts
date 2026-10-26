// Worlds — discovery from level.dat (NBT seed + corruption warning), activate with auto-backup,
// duplicate/copy/delete/import/export of a whole world unit (overworld + nether + end), the
// "new empty world" pending flow, and the delete safety archive. Async copies emit
// `job://progress/{jobId}` stages; browsers/dialogs stay at the handler edge.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog } from 'electron';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type BackupRecord, type ServerDto } from './store';
import { readProperties, safeLevelName, writePropertyValues } from './properties';
import { collectInputs, writeZip } from './zip';
import { extractZip } from './installer/core';
import type { Backups } from './backups';
import type { ServerProcesses } from './server-process';
import { readLevelDat } from './world-nbt';
import {
  dimensionSuffixOf,
  isDimensionFolderName,
  planWorldDeleteBackup,
  planWorldDuplicate,
  planWorldExport,
  planWorldImport,
  unitTargetName,
  worldDeleteBackupFileName,
  worldUnitFolderNames,
  type DimensionSuffix,
  type ImportArchiveDirectory,
} from './worlds-core';

export interface WorldDto {
  name: string;
  sizeBytes: number;
  lastModified: string;
  active: boolean;
  pending?: boolean;
  /** Overworld seed parsed from level.dat (decimal string, additive optional field). */
  seed?: string | null;
  /** Set when level.dat exists but could not be parsed; the world is still manageable. */
  warning?: string | null;
}

const SAFE_WORLD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IMPORT_MAX_BYTES = 4 * 1024 ** 3;

function sameWorld(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

interface TreeFile { rel: string; size: number }
interface TreeListing { dirs: string[]; files: TreeFile[]; totalBytes: number }

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

  /** `job://progress/{jobId}` event (same payload shape as the backup/install jobs). */
  private progress(jobId: string, progress: number, stage: string): void {
    if (jobId === '') return;
    this.ctx.send(`job://progress/${jobId}`, { progress, stage });
  }

  private async directoryNames(dir: string): Promise<string[]> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** Unique folder/unit base; `fs.existsSync` keeps Windows case-insensitivity honest. */
  private uniqueFolderBase(dir: string, base: string, unitAware: boolean): string {
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      const names = unitAware ? worldUnitFolderNames(candidate) : [candidate];
      if (names.every((name) => !fs.existsSync(path.join(dir, name)))) return candidate;
    }
    throw appError('conflict', `Could not allocate a unique world name based on "${base}".`);
  }

  private async listTree(root: string): Promise<TreeListing> {
    const dirs: string[] = [];
    const files: TreeFile[] = [];
    let totalBytes = 0;
    const visit = async (absolute: string, relative: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const childAbsolute = path.join(absolute, entry.name);
        const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          dirs.push(childRelative);
          await visit(childAbsolute, childRelative);
        } else if (entry.isFile()) {
          const stat = await fsp.stat(childAbsolute);
          totalBytes += stat.size;
          files.push({ rel: childRelative, size: stat.size });
        }
      }
    };
    await visit(root, '');
    return { dirs, files, totalBytes };
  }

  /**
   * Copy one folder tree. Without a progress callback this uses async `fs.promises.cp` (fast
   * recursive copy, never the synchronous variant); with one it copies file-by-file and reports
   * copied bytes so duplicate/import can emit a size-based percentage.
   */
  private async copyTree(
    source: string,
    target: string,
    onBytes?: (copiedBytes: number, file: string) => void,
  ): Promise<void> {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (onBytes === undefined) {
      await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true });
      return;
    }
    const listing = await this.listTree(source);
    await fsp.mkdir(target, { recursive: true });
    for (const dir of listing.dirs) await fsp.mkdir(path.join(target, dir), { recursive: true });
    for (const file of listing.files) {
      const destination = path.join(target, file.rel);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(path.join(source, file.rel), destination);
      onBytes(file.size, file.rel);
    }
  }

  private async treeSize(root: string): Promise<number> {
    return (await this.listTree(root)).totalBytes;
  }

  async list(serverId: string): Promise<WorldDto[]> {
    this.requireServer(serverId);
    const dir = this.serverDir(serverId);
    const store = this.store();
    // The pending world is generated by the next server start; once its folder exists the
    // pending marker is stale and must be cleared so the world is listed normally (no ghost).
    let pending = store.pendingWorld(serverId);
    if (pending && fs.existsSync(path.join(dir, pending.name))) {
      store.setPendingWorld(serverId, null);
      pending = null;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const folderNames = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.mcsm-'))
      .map((entry) => entry.name);
    const candidates = folderNames.filter((name) => fs.existsSync(path.join(dir, name, 'level.dat')));
    const listed = new Set(candidates);
    const isDimension = (name: string): boolean => {
      const suffix = dimensionSuffixOf(name);
      if (suffix === null) return false;
      const baseName = name.slice(0, -suffix.length);
      return [...listed].some((candidate) => sameWorld(candidate, baseName));
    };

    const active = this.activeLevel(dir);
    const worlds: WorldDto[] = [];
    for (const name of candidates.filter((candidate) => !isDimension(candidate))) {
      const worldDir = path.join(dir, name);
      const levelDat = path.join(worldDir, 'level.dat');
      const info = readLevelDat(levelDat);
      const row: WorldDto = {
        name,
        sizeBytes: await this.backups.directoryBytes(worldDir),
        lastModified: fs.statSync(levelDat).mtime.toISOString(),
        active: sameWorld(name, active),
        seed: info?.seed ?? null,
      };
      if (info === null) row.warning = 'level.dat is corrupt or unreadable';
      worlds.push(row);
    }

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
    if (isDimensionFolderName(clean)) {
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

  async duplicate(serverId: string, name: string, jobId = ''): Promise<WorldDto> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const folderNames = await this.directoryNames(dir);
    const plan = planWorldDuplicate(folderNames, name);
    const targetBase = this.uniqueFolderBase(dir, plan.targetBase, true);
    const copies = plan.copies.map((copy) => {
      const suffixPart = copy.target.slice(plan.targetBase.length);
      const suffix = suffixPart === '' ? null : (suffixPart as DimensionSuffix);
      return { source: copy.source, target: unitTargetName(targetBase, suffix) };
    });
    this.progress(jobId, 3, `planning duplicate of ${copies.length} folder(s)`);
    const totals: number[] = [];
    for (const copy of copies) totals.push(await this.treeSize(path.join(dir, copy.source)));
    const totalBytes = totals.reduce((sum, value) => sum + value, 0);
    const created: string[] = [];
    let copiedBytes = 0;
    let lastPercent = -1;
    try {
      for (let index = 0; index < copies.length; index += 1) {
        const copy = copies[index]!;
        const source = path.join(dir, copy.source);
        const target = path.join(dir, copy.target);
        created.push(target);
        const onBytes = jobId === ''
          ? undefined
          : (delta: number): void => {
            copiedBytes += delta;
            const percent = 10 + Math.floor(85 * Math.min(1, copiedBytes / Math.max(1, totalBytes)));
            if (percent !== lastPercent) {
              lastPercent = percent;
              this.progress(jobId, percent, `copying "${copy.source}"`);
            }
          };
        await this.copyTree(source, target, onBytes);
      }
    } catch (error) {
      for (const target of created) {
        try { await fsp.rm(target, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      throw error;
    }
    this.progress(jobId, 100, 'duplicate complete');
    return {
      name: targetBase,
      sizeBytes: totalBytes,
      lastModified: new Date().toISOString(),
      active: false,
    };
  }

  /** Safety archive of the world being deleted (explicit paths — never the active world). */
  private async createWorldDeleteBackup(serverId: string, worldName: string, names: string[]): Promise<BackupRecord> {
    const dto = this.requireServer(serverId);
    const dir = this.serverDir(serverId);
    const inputs = await collectInputs(dir, names);
    if (inputs.length === 0) {
      throw appError('backup-failed', `World "${worldName}" has no files to archive before deletion.`);
    }
    const at = new Date();
    const backupsDir = path.join(this.ctx.dataRoot, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const baseFile = worldDeleteBackupFileName(dto.name, at);
    let dest = path.join(backupsDir, baseFile);
    for (let attempt = 2; fs.existsSync(dest); attempt += 1) {
      if (attempt > 100) throw appError('backup-failed', `Could not allocate a backup file name for "${worldName}".`);
      dest = path.join(backupsDir, baseFile.replace(/\.zip$/i, `-${attempt}.zip`));
    }
    const bytes = await writeZip(dest, inputs);
    const record: BackupRecord = {
      id: randomUUID(),
      serverId,
      name: `before delete ${worldName}`,
      path: dest,
      bytes,
      kind: 'World-delete',
      note: `Safety snapshot of world "${worldName}" (overworld + dimensions) before deletion.`,
      createdAt: at.toISOString(),
    };
    this.store().addBackup(record);
    return record;
  }

  async remove(serverId: string, name: string): Promise<void> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const worlds = await this.list(serverId);
    const world = worlds.find((entry) => sameWorld(entry.name, name));
    if (!world) throw appError('validation', `Not a world folder: ${name}`);
    if (world.pending) {
      throw appError(
        'conflict',
        `The pending world "${name}" has not been generated yet. Start the server to create it, then delete the generated world.`,
      );
    }
    if (world.active) throw appError('conflict', `Refusing to delete the active world: ${name}`);
    const folderNames = await this.directoryNames(dir);
    const names = planWorldDeleteBackup(folderNames, world.name);
    await this.createWorldDeleteBackup(serverId, world.name, names);
    for (const target of names) {
      await fsp.rm(path.join(dir, target), { recursive: true, force: true });
    }
  }

  /** Explicit destination variant of `export`, usable without the save dialog (tests/automation). */
  async exportTo(serverId: string, name: string, destPath: string, jobId = ''): Promise<{ path: string }> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const folderNames = await this.directoryNames(dir);
    const names = planWorldExport(folderNames, name);
    this.progress(jobId, 5, `collecting ${names.length} folder(s)`);
    const inputs = await collectInputs(dir, names);
    if (inputs.length === 0) throw appError('backup-failed', 'That world folder has no files to export.');
    this.progress(jobId, 20, `archiving ${inputs.length} file(s)`);
    await writeZip(destPath, inputs);
    this.progress(jobId, 100, 'export complete');
    return { path: destPath };
  }

  async export(serverId: string, name: string, jobId = ''): Promise<{ path: string } | { cancelled: true }> {
    this.requireIdle(serverId);
    const worlds = await this.list(serverId);
    const world = worlds.find((entry) => sameWorld(entry.name, name));
    if (!world) throw appError('validation', `Not a world folder: ${name}`);
    if (world.pending) throw appError('conflict', 'The pending world has not been generated yet; nothing to export.');
    const picked = await dialog.showSaveDialog({
      title: 'Export world',
      defaultPath: `${world.name}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePath) return { cancelled: true };
    return this.exportTo(serverId, name, picked.filePath, jobId);
  }

  private async inspectArchiveLayout(staging: string, zipFileName: string) {
    const entries = await fsp.readdir(staging, { withFileTypes: true });
    const rootHasLevelDat = entries.some(
      (entry) => entry.isFile() && entry.name.toLowerCase() === 'level.dat',
    );
    const directories: ImportArchiveDirectory[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let childNames: string[] = [];
      try {
        childNames = await fsp.readdir(path.join(staging, entry.name));
      } catch {
        childNames = [];
      }
      directories.push({
        name: entry.name,
        hasLevelDat: childNames.some((child) => child.toLowerCase() === 'level.dat' && fs.statSync(path.join(staging, entry.name, child)).isFile()),
      });
    }
    return planWorldImport({ zipFileName, rootHasLevelDat, directories });
  }

  /** Explicit archive-path variant of `import`, usable without the open dialog (tests/automation). */
  async importFrom(serverId: string, zipPath: string, jobId = ''): Promise<{ name: string }> {
    this.requireIdle(serverId);
    const dir = this.serverDir(serverId);
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'msm-world-import-'));
    const created: string[] = [];
    try {
      this.progress(jobId, 5, 'extracting archive');
      await extractZip(zipPath, staging, { root: '', skipExisting: false, maxTotalBytes: IMPORT_MAX_BYTES });
      this.progress(jobId, 20, 'inspecting world layout');
      const plan = await this.inspectArchiveLayout(staging, path.basename(zipPath));
      let targetBase: string;
      let copies: { source: string; target: string; label: string }[];
      if (plan.mode === 'root') {
        targetBase = this.uniqueFolderBase(dir, plan.targetBaseHint, false);
        copies = [{ source: staging, target: path.join(dir, targetBase), label: targetBase }];
      } else {
        targetBase = this.uniqueFolderBase(dir, plan.targetBaseHint, true);
        copies = plan.parts.map((part) => ({
          source: path.join(staging, part.sourceName),
          target: path.join(dir, unitTargetName(targetBase, part.suffix)),
          label: part.sourceName,
        }));
      }
      this.progress(jobId, 30, `copying ${copies.length} folder(s) as "${targetBase}"`);
      const totals: number[] = [];
      for (const copy of copies) totals.push(await this.treeSize(copy.source));
      const totalBytes = totals.reduce((sum, value) => sum + value, 0);
      let copiedBytes = 0;
      let lastPercent = -1;
      for (const copy of copies) {
        created.push(copy.target);
        const onBytes = jobId === ''
          ? undefined
          : (delta: number): void => {
            copiedBytes += delta;
            const percent = 30 + Math.floor(65 * Math.min(1, copiedBytes / Math.max(1, totalBytes)));
            if (percent !== lastPercent) {
              lastPercent = percent;
              this.progress(jobId, percent, `copying "${copy.label}"`);
            }
          };
        await this.copyTree(copy.source, copy.target, onBytes);
      }
      this.progress(jobId, 100, 'import complete');
      return { name: targetBase };
    } catch (error) {
      for (const target of created) {
        try { await fsp.rm(target, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      throw error;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }

  async import(serverId: string, jobId = ''): Promise<{ name: string } | { cancelled: true }> {
    this.requireIdle(serverId);
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'World ZIP', extensions: ['zip'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
    return this.importFrom(serverId, picked.filePaths[0], jobId);
  }

  handlers(): Record<string, Handler> {
    return {
      worlds_list: (a) => this.list(String(a.id)),
      world_activate: (a) => this.activate(String(a.id), String(a.name)),
      world_create: (a) => this.create(String(a.id), String(a.name), String(a.seed ?? ''), String(a.levelType ?? 'minecraft:normal')),
      world_duplicate: (a) => this.duplicate(String(a.id), String(a.name), a.jobId === undefined ? '' : String(a.jobId)),
      world_delete: async (a) => { await this.remove(String(a.id), String(a.name)); return true; },
      world_export: (a) => this.export(String(a.id), String(a.name), a.jobId === undefined ? '' : String(a.jobId)),
      world_import: (a) => this.import(String(a.id), a.jobId === undefined ? '' : String(a.jobId)),
    };
  }
}
