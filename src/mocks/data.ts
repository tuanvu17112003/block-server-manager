import type { Backup, LogLine, Modpack, Player, Server, WorldEntry } from '../types';

export const FREE_RAM_MB = 12288;

export const initialServers: Server[] = [
  {
    id: 'srv-vanilla',
    name: 'Survival Vanilla',
    status: 'running',
    mcVersion: '1.20.4',
    loader: 'Vanilla',
    playersOnline: 3,
    maxPlayers: 20,
    port: 25565,
    ramMb: 4096,
    ramRecommendedMb: 4096,
    uptimeSec: 7325,
    cpuPct: 18,
    ramPct: 54,
    tps: 20.0,
    mspt: 12.4,
    address: '127.0.0.1',
    eulaAccepted: true,
    motd: 'A vanilla survival world — be nice!',
    difficulty: 'Normal',
    gamemode: 'Survival',
    onlineMode: true,
    seed: '8675309',
    worldName: 'world',
    worldSizeMb: 842,
    worldLastPlayed: '2026-10-08 08:12',
    version: '1.20.4 Vanilla',
  },
  {
    id: 'srv-atm',
    name: 'ATM9 Modded',
    status: 'stopped',
    mcVersion: '1.20.1',
    loader: 'Forge',
    loaderVersion: '47.2.0',
    modpack: 'All the Mods 9',
    playersOnline: 0,
    maxPlayers: 10,
    port: 25566,
    ramMb: 8192,
    ramRecommendedMb: 8192,
    uptimeSec: 0,
    cpuPct: 0,
    ramPct: 0,
    tps: null,
    mspt: null,
    address: '127.0.0.1',
    eulaAccepted: false,
    motd: 'ATM9 — bring lots of RAM',
    difficulty: 'Normal',
    gamemode: 'Survival',
    onlineMode: true,
    seed: '-123456789',
    worldName: 'world',
    worldSizeMb: 2310,
    worldLastPlayed: '2026-10-05 21:40',
    version: '1.20.1 Forge',
  },
  {
    id: 'srv-events',
    name: 'Paper Events',
    status: 'crashed',
    mcVersion: '1.20.6',
    loader: 'Paper',
    loaderVersion: '147',
    playersOnline: 0,
    maxPlayers: 50,
    port: 25567,
    ramMb: 4096,
    ramRecommendedMb: 4096,
    uptimeSec: 0,
    cpuPct: 0,
    ramPct: 0,
    tps: null,
    mspt: null,
    address: '127.0.0.1',
    eulaAccepted: true,
    motd: 'Weekly build events!',
    difficulty: 'Easy',
    gamemode: 'Adventure',
    onlineMode: true,
    seed: 'events-2026',
    worldName: 'event_world',
    worldSizeMb: 512,
    worldLastPlayed: '2026-10-07 19:02',
    version: '1.20.6 Paper',
  },
];

let logId = 1;
function line(ts: string, level: LogLine['level'], source: string, msg: string): LogLine {
  return { id: logId++, ts, level, source, msg };
}

export const initialLogs: Record<string, LogLine[]> = {
  'srv-vanilla': [
    line('08:01:12', 'INFO', 'Server', 'Starting minecraft server version 1.20.4'),
    line('08:01:14', 'INFO', 'Server', 'Loading level "world" (seed 8675309)'),
    line('08:01:18', 'INFO', 'Server', 'Preparing spawn area: 100%'),
    line('08:01:19', 'INFO', 'Server', 'Done (6.2s)! For help, type "help"'),
    line('08:04:02', 'INFO', 'Auth', 'Steve[/127.0.0.1] logged in (UUID 1111-aaaa)'),
    line('08:04:02', 'INFO', 'Server', 'Steve joined the game'),
    line('08:07:44', 'WARN', 'Server', "Can't keep up! Is the server overloaded? Running 2143ms behind"),
    line('08:09:31', 'INFO', 'Server', 'Alex joined the game'),
    line('08:11:05', 'ERROR', 'Server', 'Player Herobrine_99 lost connection: Timed out'),
    line('08:12:40', 'INFO', 'Server', 'Saved the game (412 chunks)'),
  ],
  'srv-atm': [
    line('21:38:00', 'INFO', 'Forge', 'Mod loading: 412 mods found, attempting load'),
    line('21:38:44', 'INFO', 'Server', 'Done — remove this line after first run'),
    line('21:40:11', 'INFO', 'Server', 'Stopping server...'),
  ],
  'srv-events': [
    line('19:00:02', 'INFO', 'Paper', 'Starting Paper 1.20.6 build 147'),
    line('19:01:57', 'ERROR', 'Server', 'Encountered an unexpected exception: java.lang.OutOfMemoryError: Java heap space'),
    line('19:01:57', 'ERROR', 'Server', 'Server crashed — see crash-reports/crash-2026-10-07.txt'),
  ],
};

export const tickLogPool: { level: LogLine['level']; source: string; msg: string }[] = [
  { level: 'INFO', source: 'Server', msg: 'Steve mined Deepslate Diamond Ore' },
  { level: 'INFO', source: 'Server', msg: 'Alex [~12 64 -44] teleported home' },
  { level: 'INFO', source: 'Server', msg: 'Saved the game (418 chunks)' },
  { level: 'INFO', source: 'Auth', msg: 'Notch_2[/127.0.0.1] logged in' },
  { level: 'WARN', source: 'Server', msg: "Can't keep up! Is the server overloaded?" },
  { level: 'INFO', source: 'Chat', msg: '<Steve> anyone up for the nether?' },
];

export const initialPlayers: Player[] = [
  { uuid: '1111-aaaa-0001', name: 'Steve', online: true, op: true, whitelisted: true, banned: false, lastSeen: 'now', playtimeHrs: 214, gamemode: 'Survival' },
  { uuid: '2222-bbbb-0002', name: 'Alex', online: true, op: false, whitelisted: true, banned: false, lastSeen: 'now', playtimeHrs: 176, gamemode: 'Survival' },
  { uuid: '3333-cccc-0003', name: 'Notch_2', online: true, op: false, whitelisted: false, banned: false, lastSeen: 'now', playtimeHrs: 12, gamemode: 'Creative' },
  { uuid: '4444-dddd-0004', name: 'Herobrine_99', online: false, op: false, whitelisted: false, banned: true, lastSeen: '2026-10-07 22:10', playtimeHrs: 41, gamemode: 'Survival' },
  { uuid: '5555-eeee-0005', name: 'crafter_kid', online: false, op: false, whitelisted: true, banned: false, lastSeen: '2026-10-06 18:44', playtimeHrs: 88, gamemode: 'Adventure' },
  { uuid: '6666-ffff-0006', name: '村民Steve', online: false, op: false, whitelisted: false, banned: false, lastSeen: '2026-09-30 12:00', playtimeHrs: 5, gamemode: 'Survival' },
];

export const initialWorlds: WorldEntry[] = [
  { id: 'w1', name: 'world', sizeMb: 842, lastPlayed: '2026-10-08 08:12', seed: '8675309', shared: false, active: true },
  { id: 'w2', name: 'world_nether_hub', sizeMb: 210, lastPlayed: '2026-10-01 20:00', seed: '8675309', shared: false, active: false },
  { id: 'w3', name: 'creative_plots', sizeMb: 96, lastPlayed: '2026-09-20 15:30', seed: 'plots-44', shared: true, active: false },
  { id: 'w4', name: 'hardcore_run3', sizeMb: 388, lastPlayed: '2026-08-11 09:12', seed: '-555', shared: true, active: false },
];

export const initialBackups: Backup[] = [
  { id: 'b1', name: 'pre-atm-install', created: '2026-10-05 21:35', sizeMb: 1980, kind: 'Pre-install', note: 'Auto snapshot before modpack install' },
  { id: 'b2', name: 'nightly-2026-10-07', created: '2026-10-07 03:00', sizeMb: 812, kind: 'Auto', note: 'Scheduled nightly' },
  { id: 'b3', name: 'before-nether-hub', created: '2026-10-01 19:52', sizeMb: 790, kind: 'Manual', note: 'Before hub rebuild' },
  { id: 'b4', name: 'nightly-2026-10-06', created: '2026-10-06 03:00', sizeMb: 801, kind: 'Auto', note: 'Scheduled nightly' },
];

export function makeSeries(n: number, base: number, spread: number, seed = 1): number[] {
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    const pseudo = Math.abs(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1;
    v = base + (pseudo - 0.5) * 2 * spread + Math.sin(i / 6) * spread * 0.4;
    out.push(Math.max(0, Math.round(v * 10) / 10));
  }
  return out;
}

export const metricsMock = {
  cpu: makeSeries(72, 22, 14, 3),
  ram: makeSeries(72, 55, 12, 7),
  players: makeSeries(72, 3, 3, 11).map((v) => Math.max(0, Math.round(v))),
  tps: makeSeries(72, 19.8, 0.6, 5).map((v) => Math.min(20, Math.max(8, v))),
};

export const modpacks: Modpack[] = [
  { id: 'cf-atm9', source: 'curseforge', name: 'All the Mods 9', author: 'ATM Team', downloads: 48_200_000, mcVersions: ['1.20.1'], loaders: ['Forge'], icon: '🧪', summary: 'The kitchen-sink kitchen sink. 400+ mods, quests, performance tuned.', packVersions: [{ v: '0.3.1', mc: '1.20.1', loader: 'Forge 47.2.0', changelog: 'Updated 30 mods, fixed quest gating, bumped Forge.' }, { v: '0.3.0', mc: '1.20.1', loader: 'Forge 47.1.3', changelog: 'Initial stable for this line.' }] },
  { id: 'mr-prominence', source: 'modrinth', name: 'Prominence II', author: 'Prominence Team', downloads: 9_800_000, mcVersions: ['1.20.1', '1.20.4'], loaders: ['Fabric'], icon: '🏔️', summary: 'RPG adventure with 400+ quests and exploration focus.', packVersions: [{ v: '2.6.0', mc: '1.20.1', loader: 'Fabric 0.15', changelog: 'New dungeons, performance pass.' }] },
  { id: 'cf-rlcraft', source: 'curseforge', name: 'RLCraft', author: 'Shivaxi', downloads: 62_500_000, mcVersions: ['1.12.2'], loaders: ['Forge'], icon: '🐉', summary: 'Brutal hardcore survival. You will die. A lot.', packVersions: [{ v: '2.9.5', mc: '1.12.2', loader: 'Forge 14.23', changelog: 'Final bugfix line.' }] },
  { id: 'mr-fabulously', source: 'modrinth', name: 'Fabulously Optimized', author: 'FO Team', downloads: 21_300_000, mcVersions: ['1.20.4', '1.20.6', '1.21'], loaders: ['Fabric', 'Quilt'], icon: '✨', summary: 'Vanilla-feel performance pack. Great starter for servers.', packVersions: [{ v: '6.1.0', mc: '1.20.4', loader: 'Fabric 0.15', changelog: 'Sodium + Lithium updates.' }] },
  { id: 'cf-better', source: 'curseforge', name: 'Better Minecraft', author: 'Shiniverse', downloads: 35_700_000, mcVersions: ['1.20.1'], loaders: ['Forge', 'Fabric'], icon: '🌲', summary: 'Vanilla+ with 250 improvements, keeps the MC feel.', packVersions: [{ v: '82.0', mc: '1.20.1', loader: 'Forge 47.2.0', changelog: 'Rebalanced loot tables.' }] },
  { id: 'mr-atm10', source: 'modrinth', name: 'All the Mods 10', author: 'ATM Team', downloads: 12_100_000, mcVersions: ['1.21'], loaders: ['NeoForge'], icon: '⚗️', summary: 'Next-gen ATM on NeoForge for MC 1.21.', packVersions: [{ v: '2.12', mc: '1.21', loader: 'NeoForge 21.0', changelog: 'Quest book overhaul.' }] },
  { id: 'cf-dawn', source: 'curseforge', name: 'DawnCraft', author: 'Dawn Team', downloads: 7_400_000, mcVersions: ['1.19.2'], loaders: ['Forge'], icon: '🌅', summary: 'Story-driven RPG inspired by adventure maps.', packVersions: [{ v: '1.5.2', mc: '1.19.2', loader: 'Forge 43.2', changelog: 'Ending chapter fixes.' }] },
  { id: 'mr-create', source: 'modrinth', name: 'Create: Above & Beyond', author: 'Create Team', downloads: 4_900_000, mcVersions: ['1.18.2'], loaders: ['Forge'], icon: '⚙️', summary: 'Automation-focused progression through Create.', packVersions: [{ v: '1.3.1', mc: '1.18.2', loader: 'Forge 40.1', changelog: 'Chapter 4 balance.' }] },
];

export const MC_VERSIONS = ['1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.2', '1.18.2', '1.12.2'];
export const LOADERS = ['Any', 'Forge', 'Fabric', 'NeoForge', 'Quilt'];
