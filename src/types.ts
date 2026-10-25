export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface Server {
  id: string;
  name: string;
  status: ServerStatus;
  mcVersion: string;
  javaPath?: string;
  loader: string; // Vanilla | Paper | Forge | Fabric | NeoForge | Quilt
  loaderVersion?: string;
  modpack?: string;
  playersOnline: number;
  maxPlayers: number;
  port: number;
  ramMb: number;
  ramRecommendedMb: number;
  uptimeSec: number;
  cpuPct: number;
  ramPct: number; // % of allocated RAM used
  tps: number | null; // null => needs RCON hint
  mspt: number | null;
  address: string;
  eulaAccepted: boolean;
  motd: string;
  difficulty: 'Peaceful' | 'Easy' | 'Normal' | 'Hard';
  gamemode: 'Survival' | 'Creative' | 'Adventure' | 'Spectator';
  onlineMode: boolean;
  seed: string;
  worldName: string;
  worldSizeMb: number;
  worldLastPlayed: string;
  version: string; // display e.g. "1.20.4 Paper"
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'CMD';

export interface LogLine {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  msg: string;
}

export interface Player {
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

export interface WorldEntry {
  id: string;
  name: string;
  sizeMb: number;
  lastPlayed: string;
  seed: string;
  shared: boolean;
  active: boolean;
}

export interface Backup {
  id: string;
  name: string;
  created: string;
  sizeMb: number;
  kind: 'Manual' | 'Auto' | 'Pre-install';
  note: string;
}

export type ModpackSource = 'curseforge' | 'modrinth';

export interface Modpack {
  id: string;
  source: ModpackSource;
  name: string;
  author: string;
  downloads: number;
  mcVersions: string[];
  loaders: string[];
  icon: string; // emoji placeholder for real icon art
  summary: string;
  packVersions: { v: string; mc: string; loader: string; changelog: string }[];
}

export type TabId =
  | 'overview'
  | 'console'
  | 'players'
  | 'worlds'
  | 'backups'
  | 'metrics'
  | 'settings';
