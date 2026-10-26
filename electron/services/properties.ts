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
  'server-port': { kind: 'int', min: 1, max: 65535 },
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

function writeEulaFile(dir: string, accepted: boolean): void {
  const file = path.join(dir, 'eula.txt');
  if (!accepted) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `# Generated by Block Server Manager. Accepted ${new Date().toISOString()}.\n# ${EULA_URL}\neula=true\n`,
    'utf8',
  );
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
      return {
        serverId: id,
        status: dto.status,
        live: dto.status === 'running' || dto.status === 'starting' || dto.status === 'stopping',
        eulaAccepted: fs.existsSync(path.join(dir, 'eula.txt')),
        values,
        entries,
      };
    },

    server_settings_update: async (a) => {
      const id = String(a.id);
      const dto = requireServer(id);
      const dir = serverDir(ctx, id);
      fs.mkdirSync(dir, { recursive: true });
      const values = (a.values ?? {}) as Record<string, string>;
      writePropertyValues(dir, values);

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
      if (typeof a.eulaAccepted === 'boolean') {
        if (dto.status === 'running' || dto.status === 'starting') {
          await stopServer(id);
        }
        writeEulaFile(dir, a.eulaAccepted);
        patch.eulaAccepted = a.eulaAccepted;
      }
      const updated = new Store(ctx.dataRoot).updateServer(id, patch);
      return applySettingsToDto(updated, dir);
    },

    server_open_folder: async (a) => {
      const id = String(a.id);
      requireServer(id);
      const dir = serverDir(ctx, id);
      fs.mkdirSync(dir, { recursive: true });
      const target = typeof a.sub === 'string' && a.sub !== '' ? path.join(dir, a.sub) : dir;
      const { shell } = await import('electron');
      const error = await shell.openPath(target);
      if (error) throw appError('io', error);
      return true;
    },
  };
}
