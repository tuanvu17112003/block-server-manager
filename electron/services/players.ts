// Players — roster from the JSON files Minecraft owns, live online list from the `list` reply.
//
// WP-5.4 / M-20 / M-21:
//  * online detection is ring-cap safe: it records `ServerProcesses.lineSeq(id)` before asking the
//    console and scans `entriesSince(...)` for the reply, with a ~2 s budget (never the ring length);
//  * lastSeen/playtime parse vanilla/Fabric, Forge/NeoForge and Paper log prefixes (player-metrics-core);
//  * whitelist/op/ban/unban edit `whitelist.json`/`ops.json`/`banned-players.json` atomically
//    (temp+rename, existing fields preserved) while the server is stopped, and go through the console
//    while it runs; kick/gamemode/teleport/heal stay running-only (`conflict` otherwise);
//  * `players_add_offline` resolves the name from `usercache.json` first, then Mojang (5 s timeout,
//    in-memory cache, 429/404 handling) and works stopped or running;
//  * `maxPlayers` comes from `server.properties` (the file stays authoritative) instead of the stale
//    store field (M-06).
import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type ServerDto } from './store';
import { readProperties } from './properties';
import { parseListReply, parsePlayerLog } from './player-metrics-core';
import type { ServerProcesses } from './server-process';

export interface PlayerDto {
  uuid: string;
  name: string;
  online: boolean;
  op: boolean;
  whitelisted: boolean;
  banned: boolean;
  lastSeen: string;
  playtimeHrs: number;
  gamemode: string;
}

const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
/** Console reply budget: the reply arrives in milliseconds; never block the IPC call longer than this. */
const LIST_TIMEOUT_MS = 2_000;
const LIST_POLL_MS = 50;
const LIST_SCAN_LIMIT = 200;
const MOJANG_TIMEOUT_MS = 5_000;
const UUID_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_OP_LEVEL = 4;
const WHITELIST_FILE = 'whitelist.json';
const OPS_FILE = 'ops.json';
const BANNED_FILE = 'banned-players.json';
const USER_CACHE_FILE = 'usercache.json';

const ROSTER_FILES = {
  whitelist: WHITELIST_FILE,
  ops: OPS_FILE,
  banned: BANNED_FILE,
} as const;
type RosterKind = keyof typeof ROSTER_FILES;

type NamedEntry = {
  uuid?: string;
  name?: string;
  level?: number;
  bypassesPlayerLimit?: boolean;
  created?: string;
  source?: string;
  expires?: string;
  reason?: string;
  [key: string]: unknown;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readJson<T>(file: string, fallback: T): T {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return text.trim() === '' ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

/** Atomic JSON write (temp+rename) that preserves every field of the entries it is given. */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function dashed(uuid: string | undefined): string {
  if (!uuid) return '';
  if (uuid.includes('-')) return uuid.toLowerCase();
  const raw = uuid.replace(/-/g, '').toLowerCase();
  if (raw.length !== 32) return uuid;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function entryUuid(entry: NamedEntry): string {
  return dashed(entry.uuid);
}

function samePlayer(entry: NamedEntry, nameOrUuid: string): boolean {
  const wanted = nameOrUuid.trim();
  if (entry.name && entry.name.toLowerCase() === wanted.toLowerCase()) return true;
  const wantedUuid = dashed(wanted);
  return wantedUuid !== '' && entryUuid(entry) === wantedUuid;
}

export class Players {
  private uuidCache = new Map<string, { uuid: string; name: string; at: number }>();
  private logCache = new Map<string, { stamp: string; lastSeen: Map<string, string>; playtime: Map<string, number> }>();

  constructor(private ctx: IpcContext, private processes: ServerProcesses) {}

  private store(): Store { return new Store(this.ctx.dataRoot); }
  private serverDir(id: string): string { return path.join(this.ctx.dataRoot, 'servers', id); }

  private requireServer(id: string): ServerDto {
    const dto = this.store().getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    return dto;
  }


  private fileFor(id: string, kind: RosterKind): string {
    return path.join(this.serverDir(id), ROSTER_FILES[kind]);
  }

  private readEntries(id: string, kind: RosterKind): NamedEntry[] {
    const rows = readJson<NamedEntry[]>(this.fileFor(id, kind), []);
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  }

  private writeEntries(id: string, kind: RosterKind, entries: NamedEntry[]): void {
    writeJsonAtomic(this.fileFor(id, kind), entries);
  }

  /** `server.properties` is the authority for the player cap (M-06); the store field is a fallback. */
  private propertyMaxPlayers(dto: ServerDto): number {
    try {
      const value = Number(readProperties(this.serverDir(dto.id)).values['max-players']);
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      /* unreadable properties: fall back to the DTO */
    }
    return Number.isInteger(dto.maxPlayers) && (dto.maxPlayers ?? 0) > 0 ? dto.maxPlayers! : 20;
  }

  /** `latest.log` parse cached by (mtime,size) so roster refreshes do not re-scan multi-MB files. */
  private parseLog(dir: string): { lastSeen: Map<string, string>; playtime: Map<string, number> } {
    const file = path.join(dir, 'logs', 'latest.log');
    let stamp = 'missing';
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return { lastSeen: new Map(), playtime: new Map() };
    }
    const cached = this.logCache.get(dir);
    if (cached && cached.stamp === stamp) return cached;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { lastSeen: new Map(), playtime: new Map() };
    }
    const parsed = parsePlayerLog(text);
    const entry = { stamp, lastSeen: parsed.lastSeen, playtime: parsed.playtime };
    this.logCache.set(dir, entry);
    return entry;
  }

  private roster(id: string, onlineNames: Set<string>): PlayerDto[] {
    const dir = this.serverDir(id);
    const whitelist = this.readEntries(id, 'whitelist');
    const ops = this.readEntries(id, 'ops');
    const banned = this.readEntries(id, 'banned');
    const usercache = readJson<NamedEntry[]>(path.join(dir, USER_CACHE_FILE), []);
    const { lastSeen, playtime } = this.parseLog(dir);

    const byKey = new Map<string, PlayerDto>();
    const keyOf = (entry: { uuid?: string; name?: string }): string =>
      (entry.uuid ? dashed(entry.uuid) : '') || (entry.name ?? '').toLowerCase();

    const upsert = (entry: NamedEntry): PlayerDto | null => {
      if (!entry.name) return null;
      const key = keyOf(entry);
      let player = byKey.get(key);
      if (!player) {
        player = {
          uuid: dashed(entry.uuid),
          name: entry.name,
          online: false,
          op: false,
          whitelisted: false,
          banned: false,
          lastSeen: lastSeen.get(entry.name.toLowerCase()) ?? '—',
          playtimeHrs: Math.round((playtime.get(entry.name.toLowerCase()) ?? 0) * 10) / 10,
          gamemode: '—',
        };
        byKey.set(key, player);
      }
      return player;
    };

    for (const entry of Array.isArray(usercache) ? usercache : []) upsert(entry);
    for (const entry of whitelist) { const p = upsert(entry); if (p) p.whitelisted = true; }
    for (const entry of ops) { const p = upsert(entry); if (p) p.op = true; }
    for (const entry of banned) { const p = upsert(entry); if (p) p.banned = true; }
    const byName = new Map([...byKey.values()].map((player) => [player.name.toLowerCase(), player]));
    for (const name of onlineNames) {
      const existing = byName.get(name.toLowerCase());
      if (existing) existing.online = true;
      else {
        const created: PlayerDto = {
          uuid: '', name, online: true, op: false, whitelisted: false, banned: false,
          lastSeen: 'now', playtimeHrs: 0, gamemode: '—',
        };
        byKey.set(name.toLowerCase(), created);
        byName.set(name.toLowerCase(), created);
      }
    }
    return [...byKey.values()]
      .filter((player) => player.name !== '')
      .sort((a, b) => (a.online === b.online ? a.name.localeCompare(b.name) : a.online ? -1 : 1));
  }

  /**
   * Ring-safe `list` reply capture: snapshot the monotonic sequence first, then scan only entries
   * appended after it. Works identically for an empty ring and a saturated 5000-line ring (M-20).
   */
  private async queryOnline(id: string): Promise<Set<string>> {
    const names = new Set<string>();
    try {
      const baseline = this.processes.lineSeq(id);
      this.processes.command(id, 'list');
      const deadline = Date.now() + LIST_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(LIST_POLL_MS);
        for (const entry of this.processes.entriesSince(id, baseline, LIST_SCAN_LIMIT)) {
          const reply = parseListReply(entry.text);
          if (!reply) continue;
          for (const name of reply.names) names.add(name);
          return names;
        }
        if (this.processes.status(id) !== 'running') break; // stopped while waiting: disk roster only
      }
    } catch {
      // Server stopped between the status check and the console write: fall back to the disk roster.
    }
    return names;
  }

  async list(id: string): Promise<{ players: PlayerDto[]; running: boolean; maxPlayers: number }> {
    const dto = this.requireServer(id);
    const running = this.processes.status(id) === 'running';
    // server.properties is authoritative for the cap (M-06); the console reply is not needed for it.
    const maxPlayers = this.propertyMaxPlayers(dto);
    const online = running ? await this.queryOnline(id) : new Set<string>();
    return { players: this.roster(id, online), running, maxPlayers };
  }

  private readUsercache(id: string): NamedEntry[] {
    const rows = readJson<NamedEntry[]>(path.join(this.serverDir(id), USER_CACHE_FILE), []);
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  }

  /** Local-only lookup (usercache + this service's cache); never touches the network. */
  private localUuid(id: string, name: string): { uuid: string; name: string } | null {
    const cached = this.uuidCache.get(name.toLowerCase());
    if (cached && Date.now() - cached.at < UUID_CACHE_TTL_MS) return { uuid: cached.uuid, name: cached.name };
    for (const entry of this.readUsercache(id)) {
      if (entry.name && entry.uuid && entry.name.toLowerCase() === name.toLowerCase()) {
        return { uuid: dashed(entry.uuid), name: entry.name };
      }
    }
    return null;
  }

  /**
   * Name -> UUID: `usercache.json` / in-memory cache first, then Mojang with a 5 s timeout.
   * 204/404 => not-found; 429 => actionable internal error; network failure => offline message.
   */
  private async resolveUuid(id: string, name: string): Promise<{ uuid: string; name: string }> {
    const local = this.localUuid(id, name);
    if (local) return local;
    let response: Response;
    try {
      response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(MOJANG_TIMEOUT_MS),
        headers: { 'User-Agent': 'mc-server-manager' },
      });
    } catch {
      throw appError(
        'internal',
        `Could not reach Mojang to resolve "${name}". The player is not in this server's usercache; ` +
          'start the server once or retry when the network is available.',
      );
    }
    if (response.status === 204 || response.status === 404) {
      throw appError('not-found', `Mojang has no player named "${name}".`);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw appError(
        'internal',
        `Mojang is rate-limiting player lookups${retryAfter ? ` (retry after ${retryAfter}s)` : ''}. Try again shortly.`,
      );
    }
    if (!response.ok) {
      throw appError('internal', `Mojang lookup failed (HTTP ${response.status}).`);
    }
    let profile: { id?: string; name?: string };
    try {
      profile = await response.json() as { id?: string; name?: string };
    } catch {
      throw appError('internal', `Mojang returned an unreadable profile for "${name}".`);
    }
    if (!profile.id) throw appError('internal', `Mojang returned no UUID for "${name}".`);
    const resolved = { uuid: dashed(profile.id), name: profile.name ?? name };
    this.uuidCache.set(name.toLowerCase(), { ...resolved, at: Date.now() });
    return resolved;
  }

  private findEntry(entries: NamedEntry[], nameOrUuid: string): NamedEntry | undefined {
    return entries.find((entry) => samePlayer(entry, nameOrUuid));
  }

  /** Roster DTO reflecting the on-disk JSON files (used as the offline-action return value). */
  private playerDto(id: string, name: string, directory: string): PlayerDto {
    const wanted = name.toLowerCase();
    const whitelist = this.readEntries(id, 'whitelist');
    const ops = this.readEntries(id, 'ops');
    const banned = this.readEntries(id, 'banned');
    const usercache = this.readUsercache(id);
    const foundWhitelist = whitelist.find((entry) => (entry.name ?? '').toLowerCase() === wanted);
    const foundOps = ops.find((entry) => (entry.name ?? '').toLowerCase() === wanted);
    const foundBanned = banned.find((entry) => (entry.name ?? '').toLowerCase() === wanted);
    const foundCache = usercache.find((entry) => (entry.name ?? '').toLowerCase() === wanted);
    const local = this.localUuid(id, name);
    const { lastSeen, playtime } = this.parseLog(directory);
    return {
      uuid: foundWhitelist?.uuid ? dashed(foundWhitelist.uuid)
        : foundOps?.uuid ? dashed(foundOps.uuid)
          : foundBanned?.uuid ? dashed(foundBanned.uuid)
            : foundCache?.uuid ? dashed(foundCache.uuid)
              : local?.uuid ?? '',
      name: foundCache?.name ?? foundWhitelist?.name ?? foundOps?.name ?? foundBanned?.name ?? name,
      online: false,
      op: foundOps !== undefined,
      whitelisted: foundWhitelist !== undefined,
      banned: foundBanned !== undefined,
      lastSeen: lastSeen.get(wanted) ?? '—',
      playtimeHrs: Math.round((playtime.get(wanted) ?? 0) * 10) / 10,
      gamemode: '—',
    };
  }

  private requireRunning(id: string): void {
    if (this.processes.status(id) !== 'running') throw appError('conflict', 'The server must be running for this action.');
  }

  async act(id: string, action: string, name: string, value?: string): Promise<PlayerDto | true> {
    this.requireServer(id);
    const playerName = name.trim();
    if (!PLAYER_NAME.test(playerName)) throw appError('validation', `Invalid player name: ${name}`);
    const safeValue = (value ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
    const running = this.processes.status(id) === 'running';
    const directory = this.serverDir(id);
    const offlineOrCommand = async (
      command: string,
      applyFile: (resolved: { uuid: string; name: string }) => void,
      requireUuid: boolean,
    ): Promise<PlayerDto | true> => {
      if (running) {
        this.processes.command(id, command);
        return true;
      }
      if (requireUuid) {
        const resolved = await this.resolveUuid(id, playerName);
        applyFile(resolved);
        return this.playerDto(id, resolved.name, directory);
      }
      applyFile({ uuid: this.localUuid(id, playerName)?.uuid ?? '', name: this.localUuid(id, playerName)?.name ?? playerName });
      return this.playerDto(id, playerName, directory);
    };

    switch (action) {
      case 'kick':
        this.requireRunning(id);
        this.processes.command(id, `kick ${playerName}${safeValue ? ` ${safeValue}` : ''}`);
        return true;
      case 'gamemode': {
        this.requireRunning(id);
        const mode = (safeValue || 'survival').toLowerCase();
        if (!['survival', 'creative', 'adventure', 'spectator'].includes(mode)) throw appError('validation', 'Unknown gamemode.');
        this.processes.command(id, `gamemode ${mode} ${playerName}`);
        return true;
      }
      case 'teleport':
        this.requireRunning(id);
        this.processes.command(id, `tp ${playerName}${safeValue ? ` ${safeValue}` : ''}`);
        return true;
      case 'heal':
        this.requireRunning(id);
        this.processes.command(id, `effect give ${playerName} minecraft:instant_health 1 255 true`);
        return true;
      case 'whitelistAdd':
        return offlineOrCommand(`whitelist add ${playerName}`, (resolved) => {
          const entries = this.readEntries(id, 'whitelist');
          const existing = this.findEntry(entries, resolved.uuid) ?? this.findEntry(entries, resolved.name);
          if (existing) {
            if (existing.uuid === undefined) existing.uuid = resolved.uuid;
            if (existing.name === undefined) existing.name = resolved.name;
          } else {
            entries.push({ uuid: resolved.uuid, name: resolved.name });
          }
          this.writeEntries(id, 'whitelist', entries);
        }, true);
      case 'whitelistRemove':
        return offlineOrCommand(`whitelist remove ${playerName}`, () => {
          const entries = this.readEntries(id, 'whitelist').filter((entry) => !samePlayer(entry, playerName));
          this.writeEntries(id, 'whitelist', entries);
        }, false);
      case 'op':
        return offlineOrCommand(`op ${playerName}`, (resolved) => {
          const entries = this.readEntries(id, 'ops');
          const existing = this.findEntry(entries, resolved.uuid) ?? this.findEntry(entries, resolved.name);
          if (existing) {
            existing.uuid = existing.uuid ?? resolved.uuid;
            existing.name = resolved.name;
            if (typeof existing.level !== 'number') existing.level = DEFAULT_OP_LEVEL;
            if (typeof existing.bypassesPlayerLimit !== 'boolean') existing.bypassesPlayerLimit = false;
          } else {
            entries.push({ uuid: resolved.uuid, name: resolved.name, level: DEFAULT_OP_LEVEL, bypassesPlayerLimit: false });
          }
          this.writeEntries(id, 'ops', entries);
        }, true);
      case 'deop':
        return offlineOrCommand(`deop ${playerName}`, () => {
          this.writeEntries(id, 'ops', this.readEntries(id, 'ops').filter((entry) => !samePlayer(entry, playerName)));
        }, false);
      case 'ban':
        return offlineOrCommand(`ban ${playerName}${safeValue ? ` ${safeValue}` : ''}`, (resolved) => {
          const entries = this.readEntries(id, 'banned');
          const existing = this.findEntry(entries, resolved.uuid) ?? this.findEntry(entries, resolved.name);
          const record: NamedEntry = {
            uuid: resolved.uuid,
            name: resolved.name,
            created: new Date().toISOString(),
            source: 'Block Server Manager',
            expires: 'forever',
            reason: safeValue || 'Banned by an operator',
          };
          if (existing) Object.assign(existing, record);
          else entries.push(record);
          this.writeEntries(id, 'banned', entries);
        }, true);
      case 'unban':
        return offlineOrCommand(`pardon ${playerName}`, () => {
          this.writeEntries(id, 'banned', this.readEntries(id, 'banned').filter((entry) => !samePlayer(entry, playerName)));
        }, false);
      default:
        throw appError('validation', `Unsupported player action: ${action}`);
    }
  }

  /**
   * Add a whitelisted player by name: works while stopped (atomic whitelist.json edit) and while
   * running (console `whitelist add`). The name resolves through usercache first, then Mojang.
   */
  async addOffline(id: string, name: string): Promise<PlayerDto> {
    this.requireServer(id);
    const clean = name.trim();
    if (!PLAYER_NAME.test(clean)) throw appError('validation', 'Enter a valid Minecraft name (1-16 letters, digits or underscores).');
    const resolved = await this.resolveUuid(id, clean);
    if (this.processes.status(id) === 'running') {
      this.processes.command(id, `whitelist add ${resolved.name}`);
      return {
        uuid: resolved.uuid, name: resolved.name, online: false, op: false, whitelisted: true,
        banned: false, lastSeen: '—', playtimeHrs: 0, gamemode: '—',
      };
    }
    const entries = this.readEntries(id, 'whitelist');
    const existing = this.findEntry(entries, resolved.uuid) ?? this.findEntry(entries, resolved.name);
    if (!existing) {
      entries.push({ uuid: resolved.uuid, name: resolved.name });
      this.writeEntries(id, 'whitelist', entries);
    }
    return this.playerDto(id, resolved.name, this.serverDir(id));
  }

  handlers(): Record<string, Handler> {
    return {
      players_list: (a) => this.list(String(a.id)),
      player_action: (a) => this.act(String(a.id), String(a.action), String(a.name), a.value === undefined ? undefined : String(a.value)),
      players_add_offline: (a) => this.addOffline(String(a.id), String(a.name)),
    };
  }
}
