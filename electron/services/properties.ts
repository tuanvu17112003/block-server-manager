// server.properties — typed parse/merge/validate, plus the server-settings command surface.
// The file stays the source of truth; the JSON store only caches the display fields.
import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type ServerDto } from './store';

export type PropertyKind = 'int' | 'bool' | 'enum' | 'string';
export interface PropertyRule {
  kind: PropertyKind;
  options?: string[];
  min?: number;
  max?: number;
}
export interface ServerPropertyEntry {
  key: string;
  value: string;
  known: boolean;
  kind: PropertyKind;
  options?: string[];
  min?: number;
  max?: number;
}

export const PROPERTY_RULES: Record<string, PropertyRule> = {
  'server-port': { kind: 'int', min: 1024, max: 65535 },
  'max-players': { kind: 'int', min: 1, max: 1000 },
  'view-distance': { kind: 'int', min: 3, max: 32 },
  'simulation-distance': { kind: 'int', min: 3, max: 32 },
  'spawn-protection': { kind: 'int', min: 0, max: 1000 },
  'query.port': { kind: 'int', min: 1, max: 65535 },
  'rcon.port': { kind: 'int', min: 1, max: 65535 },
  'difficulty': { kind: 'enum', options: ['peaceful', 'easy', 'normal', 'hard'] },
  'gamemode': { kind: 'enum', options: ['survival', 'creative', 'adventure', 'spectator'] },
  'level-type': { kind: 'enum', options: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'normal', 'flat', 'large_biomes', 'amplified'] },
  'online-mode': { kind: 'bool' },
  'pvp': { kind: 'bool' },
  'allow-flight': { kind: 'bool' },
  'white-list': { kind: 'bool' },
  'enforce-whitelist': { kind: 'bool' },
  'hardcore': { kind: 'bool' },
  'enable-command-block': { kind: 'bool' },
  'allow-nether': { kind: 'bool' },
  'spawn-animals': { kind: 'bool' },
  'spawn-monsters': { kind: 'bool' },
  'spawn-npcs': { kind: 'bool' },
  'generate-structures': { kind: 'bool' },
  'motd': { kind: 'string', max: 300 },
  'level-name': { kind: 'string', max: 128 },
  'level-seed': { kind: 'string', max: 256 },
};

export function parseProperties(text: string): {
  entries: ServerPropertyEntry[];
  values: Record<string, string>;
} {
  const entries: ServerPropertyEntry[] = [];
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '' || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (key === '') continue;
    const value = line.slice(equals + 1);
    const rule = PROPERTY_RULES[key];
    values[key] = value;
    entries.push({
      key,
      value,
      known: rule !== undefined,
      kind: rule?.kind ?? 'string',
      ...(rule?.options === undefined ? {} : { options: rule.options }),
      ...(rule?.min === undefined ? {} : { min: rule.min }),
      ...(rule?.max === undefined ? {} : { max: rule.max }),
    });
  }
  return { entries, values };
}

/** Replace only the given keys; comments, blanks and unknown keys keep their bytes. */
export function mergeProperties(text: string, values: Record<string, string>): string {
  if (text === '') {
    return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  }
  const replaced = new Set<string>();
  const out = text.split('\n').map((raw) => {
    const eol = raw.endsWith('\r') ? '\r' : '';
    const line = eol === '' ? raw : raw.slice(0, -1);
    if (line.trim() === '' || line.startsWith('#')) return raw;
    const equals = line.indexOf('=');
    if (equals <= 0) return raw;
    const key = line.slice(0, equals).trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) return raw;
    replaced.add(key);
    return `${key}=${values[key]}${eol}`;
  });
  const missing = Object.keys(values).filter((key) => !replaced.has(key));
  if (missing.length === 0) return out.join('\n');
  const endsWithNewline = text.endsWith('\n');
  const body = endsWithNewline ? out.slice(0, -1) : out;
  for (const key of missing) body.push(`${key}=${values[key]}`);
  return `${body.join('\n')}${endsWithNewline ? '\n' : ''}`;
}

/** `level-name` is one safe path segment; anything that could escape falls back to `world`. */
export function safeLevelName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes(':')) {
    return 'world';
  }
  return name;
}

/**
 * Resolve a caller-supplied sub-path inside a server folder and reject escapes.
 * Pure (no filesystem access): rejects `..` components, absolute paths, drive-qualified
 * (`C:foo`) and UNC (`\\\\host\\share`) paths, then double-checks the resolved prefix.
 */
export function resolveContainedPath(base: string, sub: string): string {
  if (typeof sub !== 'string') throw appError('validation', 'Folder path must be a string.');
  if (sub.includes('\0')) throw appError('validation', 'Folder path contains an invalid character.');
  const segments = sub.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw appError('validation', `Folder path escapes the server folder: "${sub}"`);
  }
  if (path.isAbsolute(sub) || /^[A-Za-z]:/.test(sub) || /^[\\/]/.test(sub)) {
    throw appError('validation', `Folder path must be relative to the server folder: "${sub}"`);
  }
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, sub);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw appError('validation', `Folder path escapes the server folder: "${sub}"`);
  }
  return target;
}

export function validateProperties(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    const rule = PROPERTY_RULES[key];
    if (rule === undefined) continue;
    if (rule.kind === 'int') {
      if (!/^-?\d+$/.test(value)) throw appError('validation', `${key}: must be an integer`);
      const number = Number(value);
      if (rule.min !== undefined && number < rule.min) throw appError('validation', `${key}: must be at least ${rule.min}`);
      if (rule.max !== undefined && number > rule.max) throw appError('validation', `${key}: must be at most ${rule.max}`);
      continue;
    }
    if (rule.kind === 'bool') {
      if (value !== 'true' && value !== 'false') throw appError('validation', `${key}: must be true or false`);
      continue;
    }
    if (rule.kind === 'enum') {
      if (!rule.options?.includes(value)) throw appError('validation', `${key}: must be one of ${rule.options?.join(', ') ?? ''}`);
      continue;
    }
    if (rule.max !== undefined && value.length > rule.max) {
      throw appError('validation', `${key}: must be at most ${rule.max} characters`);
    }
  }
}

export function propertiesPath(dir: string): string {
  return path.join(dir, 'server.properties');
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '';
  }
}

export function readProperties(dir: string): { entries: ServerPropertyEntry[]; values: Record<string, string> } {
  return parseProperties(readOrEmpty(propertiesPath(dir)));
}

export function writePropertyValues(dir: string, values: Record<string, string>): void {
  validateProperties(values);
  const file = propertiesPath(dir);
  const current = readOrEmpty(file);
  const merged = mergeProperties(current, values);
  if (merged === current) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, merged, 'utf8');
  fs.renameSync(temp, file);
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Fills the persisted DTO with the 7-field subset read from server.properties. */
export function applySettingsToDto(dto: ServerDto, dir: string): ServerDto {
  const { values } = readProperties(dir);
  const maxPlayers = Number(values['max-players']);
  const port = Number(values['server-port']);
  return {
    ...dto,
    motd: values['motd'] ?? dto.motd ?? '',
    maxPlayers: Number.isInteger(maxPlayers) && maxPlayers > 0 ? maxPlayers : dto.maxPlayers ?? 20,
    difficulty: titleCase(values['difficulty'] ?? dto.difficulty ?? 'Normal'),
    gamemode: titleCase(values['gamemode'] ?? dto.gamemode ?? 'Survival'),
    onlineMode: bool(values['online-mode'], dto.onlineMode ?? true),
    worldName: safeLevelName(values['level-name'] ?? dto.worldName ?? 'world'),
    port: Number.isInteger(port) && port > 0 ? port : dto.port,
  };
}

export function serverDir(ctx: IpcContext, id: string): string {
  return path.join(ctx.dataRoot, 'servers', id);
}

const EULA_URL = 'https://aka.ms/MinecraftEULA';

export interface EulaState {
  /** True only when the file itself contains an accepting `eula=true` line. */
  accepted: boolean;
  fileExists: boolean;
  /** Raw file text, or null when the file is missing/unreadable. */
  raw: string | null;
}

/**
 * Parse `eula.txt`. Acceptance is a file fact: only a `eula=true` line (case-insensitive,
 * surrounding blanks ignored) counts. A stale JSON flag can never make this true.
 */
export function readEulaState(dir: string): EulaState {
  const file = path.join(dir, 'eula.txt');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // Unreadable (not just missing) must fail closed: fileExists keeps the distinction visible.
    return { accepted: false, fileExists: (error as NodeJS.ErrnoException).code !== 'ENOENT', raw: null };
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const accepted = text.split(/\r?\n/).some((line) => /^\s*eula\s*=\s*true\s*$/i.test(line));
  return { accepted, fileExists: true, raw };
}

/**
 * Write or remove `eula.txt` atomically (temp + rename; removal for `false`).
 * Only an explicit user acceptance may call this with `true` — never auto-accept on start.
 */
export function writeEulaFile(dir: string, accepted: boolean): void {
  const file = path.join(dir, 'eula.txt');
  if (!accepted) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(
    temp,
    `# Generated by Block Server Manager. Accepted ${new Date().toISOString()}.\n# ${EULA_URL}\neula=true\n`,
    'utf8',
  );
  fs.renameSync(temp, file);
}

/** Bytes of a file, or null when it does not exist (other read errors propagate). */
function readFileBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Best-effort restore of a file to bytes captured before a multi-step save. */
function restoreFileBytes(file: string, previous: Buffer | null): void {
  try {
    if (previous === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, previous);
  } catch {
    // Rollback is best effort; the original error is the one the caller sees.
  }
}

export function settingsHandlers(ctx: IpcContext, stopServer: (id: string) => Promise<void>): Record<string, Handler> {
  const requireServer = (id: string): ServerDto => {
    const dto = new Store(ctx.dataRoot).getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    return dto;
  };

  return {
    server_settings_get: (a) => {
      const id = String(a.id);
      const dto = requireServer(id);
      const dir = serverDir(ctx, id);
      const { entries, values } = readProperties(dir);
      // EULA authority: the file must say true AND the persisted flag must agree; a stale
      // `eulaAccepted: true` flag with a missing/false file can never report consent (M-12).
      const eula = readEulaState(dir);
      return {
        serverId: id,
        status: dto.status,
        live: dto.status === 'running' || dto.status === 'starting' || dto.status === 'stopping',
        eulaAccepted: eula.accepted && dto.eulaAccepted,
        values,
        entries,
      };
    },

    server_settings_update: async (a) => {
      const id = String(a.id);
      const dto = requireServer(id);
      const dir = serverDir(ctx, id);
      const values = (a.values ?? {}) as Record<string, string>;

      // 1) Validate every input before touching the filesystem or the store: a rejected save
      // must leave server.properties, eula.txt and the DTO untouched (M-11 atomicity).
      validateProperties(values);
      const patch: Partial<ServerDto> = {};
      if (typeof a.name === 'string' && a.name.trim() !== '' && a.name !== dto.name) {
        const name = a.name.trim();
        const clash = new Store(ctx.dataRoot).listServers().some((s) => s.id !== id && s.name === name);
        if (clash) throw appError('conflict', `A server named "${name}" already exists.`);
        patch.name = name;
      }
      if (a.ramMb !== undefined) {
        const ram = Number(a.ramMb);
        if (!Number.isInteger(ram) || ram < 512 || ram > 65536) throw appError('validation', 'RAM must be between 512 and 65536 MB.');
        patch.ramMb = ram;
      }
      const eula = readEulaState(dir);
      let nextEula: boolean | undefined;
      let eulaFlagChanged = false;
      if (typeof a.eulaAccepted === 'boolean') {
        nextEula = a.eulaAccepted;
        // Change is relative to the persisted flag the renderer saw. This keeps the old
        // "always sends eulaAccepted" UI from revoking a legacy file-true/flag-false EULA on
        // an unrelated save, while an explicit accept/revoke still goes through.
        eulaFlagChanged = nextEula !== dto.eulaAccepted;
        if (eulaFlagChanged) patch.eulaAccepted = nextEula;
      }

      // 2) Only an effective EULA change stops a live server (M-05). Stop before writing so a
      // failed stop changes nothing; the stop itself is owned by the process manager.
      if (eulaFlagChanged && (dto.status === 'running' || dto.status === 'starting')) {
        await stopServer(id);
      }

      // 3) Write properties (+ EULA on explicit change) then the record; roll file bytes back
      // if a later step throws so the IPC error and the filesystem agree.
      const propsFile = propertiesPath(dir);
      const eulaFile = path.join(dir, 'eula.txt');
      const previousProps = readFileBytes(propsFile);
      const previousEula = readFileBytes(eulaFile);
      try {
        fs.mkdirSync(dir, { recursive: true });
        writePropertyValues(dir, values);
        if (nextEula !== undefined && nextEula !== eula.accepted) writeEulaFile(dir, nextEula);
        const updated = Object.keys(patch).length > 0
          ? new Store(ctx.dataRoot).updateServer(id, patch)
          : dto;
        return applySettingsToDto(updated, dir);
      } catch (error) {
        restoreFileBytes(propsFile, previousProps);
        restoreFileBytes(eulaFile, previousEula);
        try { fs.rmSync(`${propsFile}.tmp`, { force: true }); } catch { /* best effort */ }
        try { fs.rmSync(`${eulaFile}.tmp`, { force: true }); } catch { /* best effort */ }
        throw error;
      }
    },

    server_open_folder: async (a) => {
      const id = String(a.id);
      requireServer(id);
      const dir = serverDir(ctx, id);
      // Contain every caller-supplied sub-path inside this server's folder.
      const target = resolveContainedPath(dir, typeof a.sub === 'string' ? a.sub : '');
      fs.mkdirSync(dir, { recursive: true });
      const { shell } = await import('electron');
      const error = await shell.openPath(target);
      if (error) throw appError('io', error);
      return true;
    },
  };
}
