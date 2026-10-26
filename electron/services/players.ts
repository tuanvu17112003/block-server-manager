// Players — roster from the JSON files Minecraft owns, live online list from the `list` reply,
// and actions through stdin commands (never by editing JSON while the server runs).
import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type ServerDto } from './store';
import { fetchOk } from './installer/core';
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
const LIST_REPLY = /There are (\d+) of a max of (\d+) players online:?\s*(.*)$/;
const LOG_LINE = /\[(\d{2}:\d{2}:\d{2})\] \[[^\]]+\]: ([A-Za-z0-9_]{1,16}) (joined|left) the game/;

type Named = { uuid?: string; name?: string; level?: number; expires?: string };

function readJson<T>(file: string, fallback: T): T {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return text.trim() === '' ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

function dashed(uuid: string | undefined): string {
  if (!uuid) return '';
  if (uuid.includes('-')) return uuid;
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

function parseLog(dir: string): { lastSeen: Map<string, string>; playtime: Map<string, number> } {
  const lastSeen = new Map<string, string>();
  const playtime = new Map<string, number>();
  const file = path.join(dir, 'logs', 'latest.log');
  let text = '';
  try {
    const stat = fs.statSync(file);
    if (stat.size > 4 * 1024 * 1024) {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(4 * 1024 * 1024);
      fs.readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length);
      fs.closeSync(fd);
      text = buffer.toString('utf8');
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
  } catch {
    return { lastSeen, playtime };
  }
  const open = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const match = LOG_LINE.exec(raw);
    if (!match) continue;
    const [, time, name, kind] = match;
    const seconds = Number(time!.slice(0, 2)) * 3600 + Number(time!.slice(3, 5)) * 60 + Number(time!.slice(6, 8));
    if (kind === 'joined') {
      open.set(name!, seconds);
      lastSeen.set(name!, time!);
    } else if (kind === 'left') {
      const joined = open.get(name!);
      if (joined !== undefined && seconds >= joined) {
        playtime.set(name!, (playtime.get(name!) ?? 0) + (seconds - joined) / 3600);
      }
      open.delete(name!);
      lastSeen.set(name!, time!);
    }
  }
  return { lastSeen, playtime };
}

export class Players {
  constructor(private ctx: IpcContext, private processes: ServerProcesses) {}

  private store(): Store { return new Store(this.ctx.dataRoot); }
  private serverDir(id: string): string { return path.join(this.ctx.dataRoot, 'servers', id); }

  private requireServer(id: string): ServerDto {
    const dto = this.store().getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    return dto;
  }

  private roster(id: string, onlineNames: Set<string>, maxPlayers: number): PlayerDto[] {
    const dir = this.serverDir(id);
    const ops = readJson<Named[]>(path.join(dir, 'ops.json'), []);
    const whitelist = readJson<Named[]>(path.join(dir, 'whitelist.json'), []);
    const banned = readJson<Named[]>(path.join(dir, 'banned-players.json'), []);
    const usercache = readJson<Named[]>(path.join(dir, 'usercache.json'), []);
    void maxPlayers;
    const { lastSeen, playtime } = parseLog(dir);

    const byKey = new Map<string, PlayerDto>();
    const keyOf = (entry: { uuid?: string; name?: string }): string =>
      (entry.uuid ? dashed(entry.uuid) : '') || (entry.name ?? '').toLowerCase();

    const upsert = (entry: { uuid?: string; name?: string }): PlayerDto | null => {
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
          lastSeen: lastSeen.get(entry.name) ?? '—',
          playtimeHrs: Math.round((playtime.get(entry.name) ?? 0) * 10) / 10,
          gamemode: '—',
        };
        byKey.set(key, player);
      }
      return player;
    };

    for (const entry of usercache) upsert(entry);
    for (const entry of whitelist) { const p = upsert(entry); if (p) p.whitelisted = true; }
    for (const entry of ops) { const p = upsert(entry); if (p) p.op = true; }
    for (const entry of banned) { const p = upsert(entry); if (p) p.banned = true; }
    for (const name of onlineNames) {
      const existing = [...byKey.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing) existing.online = true;
      else byKey.set(name.toLowerCase(), {
        uuid: '', name, online: true, op: false, whitelisted: false, banned: false,
        lastSeen: 'now', playtimeHrs: 0, gamemode: '—',
      });
    }
    return [...byKey.values()]
      .filter((p) => p.name !== '')
      .sort((a, b) => (a.online === b.online ? a.name.localeCompare(b.name) : a.online ? -1 : 1));
  }

  async list(id: string): Promise<{ players: PlayerDto[]; running: boolean; maxPlayers: number }> {
    const dto = this.requireServer(id);
    const running = this.processes.status(id) === 'running';
    const online = new Set<string>();
    let maxPlayers = dto.maxPlayers ?? 20;
    if (running) {
      const baseline = this.processes.history(id).length;
      this.processes.command(id, 'list');
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const lines = this.processes.history(id).slice(baseline);
        const reply = lines.map((line) => LIST_REPLY.exec(line)).find((match) => match !== null);
        if (reply) {
          maxPlayers = Number(reply[2]);
          const names = (reply[3] ?? '').trim();
          if (names !== '') for (const name of names.split(/,\s*/)) online.add(name.trim());
          break;
        }
      }
    }
    return { players: this.roster(id, online, maxPlayers), running, maxPlayers };
  }

  async act(id: string, action: string, name: string, value?: string): Promise<void> {
    if (this.processes.status(id) !== 'running') throw appError('conflict', 'The server must be running for player actions.');
    if (!PLAYER_NAME.test(name)) throw appError('validation', `Invalid player name: ${name}`);
    const safeValue = (value ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
    let command: string;
    switch (action) {
      case 'kick': command = `kick ${name}${safeValue ? ` ${safeValue}` : ''}`; break;
      case 'ban': command = `ban ${name}${safeValue ? ` ${safeValue}` : ''}`; break;
      case 'unban': command = `pardon ${name}`; break;
      case 'op': command = `op ${name}`; break;
      case 'deop': command = `deop ${name}`; break;
      case 'whitelistAdd': command = `whitelist add ${name}`; break;
      case 'whitelistRemove': command = `whitelist remove ${name}`; break;
      case 'gamemode': {
        const mode = (safeValue || 'survival').toLowerCase();
        if (!['survival', 'creative', 'adventure', 'spectator'].includes(mode)) throw appError('validation', 'Unknown gamemode.');
        command = `gamemode ${mode} ${name}`;
        break;
      }
      case 'teleport': command = `tp ${name}${safeValue ? ` ${safeValue}` : ''}`; break;
      case 'heal': command = `effect give ${name} minecraft:instant_health 1 255 true`; break;
      default: throw appError('validation', `Unsupported player action: ${action}`);
    }
    this.processes.sendCommand(id, command);
  }

  async addOffline(id: string, name: string): Promise<PlayerDto> {
    this.requireServer(id);
    const clean = name.trim();
    if (!PLAYER_NAME.test(clean)) throw appError('validation', 'Enter a valid Minecraft name (1-16 letters, digits or underscores).');
    if (this.processes.status(id) !== 'running') throw appError('conflict', 'Start the server before adding a player to the whitelist.');
    const response = await fetchOk(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(clean)}`);
    if (response.status === 204 || response.status === 404) throw appError('not-found', `Mojang has no player named "${clean}".`);
    if (!response.ok) throw appError('internal', `Mojang lookup failed (HTTP ${response.status}).`);
    const profile = await response.json() as { id?: string; name?: string };
    const resolved = profile.name ?? clean;
    this.processes.sendCommand(id, `whitelist add ${resolved}`);
    return {
      uuid: dashed(profile.id), name: resolved, online: false, op: false, whitelisted: true,
      banned: false, lastSeen: '—', playtimeHrs: 0, gamemode: '—',
    };
  }

  handlers(): Record<string, Handler> {
    return {
      players_list: (a) => this.list(String(a.id)),
      player_action: async (a) => {
        await this.act(String(a.id), String(a.action), String(a.name), a.value === undefined ? undefined : String(a.value));
        return true;
      },
      players_add_offline: (a) => this.addOffline(String(a.id), String(a.name)),
    };
  }
}
