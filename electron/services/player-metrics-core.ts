// Pure helpers shared by the players and metrics services (WP-5.4 / findings M-13, M-20, M-21).
//
// Everything in this module is deterministic and dependency-free (no `electron`, no I/O) so it can be
// unit-tested with `node --test` under plain Node — see electron/test/unit/player-metrics-core.test.ts.
// The services own all file/process/network access.

// ---------------------------------------------------------------------------------------------------
// Minecraft log parsing (joined/left across vanilla, Fabric, Forge, NeoForge and Paper formats)
// ---------------------------------------------------------------------------------------------------

/** One log line after the loader-specific prefix has been removed. */
export interface ParsedLogLine {
  /** Normalized `HH:MM:SS` time-of-day as written in the log. */
  time: string;
  /** Seconds since midnight derived from `time`. */
  seconds: number;
  /** Message text after the `[thread/LEVEL]:` (or Paper `[LEVEL]:`) prefix. */
  message: string;
}

export interface ParsedPlayerLog {
  /** Player name (lower-cased) -> last `HH:MM:SS` time seen in the log. */
  lastSeen: Map<string, string>;
  /** Player name (lower-cased) -> completed session hours (may be fractional). */
  playtime: Map<string, number>;
  /** Number of completed join/leave pairs (diagnostics + tests). */
  sessions: number;
}

/** Strip ANSI SGR escapes and Minecraft's legacy `§` colour codes. */
export function stripFormatting(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\u00a7[0-9a-fk-or]/gi, '');
}

function timeToSeconds(time: string): number {
  return Number(time.slice(0, 2)) * 3600 + Number(time.slice(3, 5)) * 60 + Number(time.slice(6, 8));
}

// Forge/NeoForge: `[26Oct2026 13:02:43.381] [Server thread/INFO] [net.minecraft.../]: message`
const FORGE_PREFIX = /^\[(\d{2}[A-Za-z]{3}\d{4}) (\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?\] \[[^\]]+\](?: \[[^\]]+\])?: ?(.*)$/;
// Vanilla/Fabric: `[13:02:43] [Server thread/INFO]: message` (some builds add a second `[logger]` bracket)
const VANILLA_PREFIX = /^\[(\d{2}:\d{2}:\d{2})\] \[[^\]]+\](?: \[[^\]]+\])?: ?(.*)$/;
// Paper: `[13:02:43 INFO]: message`
const PAPER_PREFIX = /^\[(\d{2}:\d{2}:\d{2}) (?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]: ?(.*)$/i;

/**
 * Remove a supported Minecraft log-line prefix.
 * Returns `null` for lines that do not use one of the known formats (stack traces, raw stdout, ...).
 */
export function stripLogLinePrefix(raw: string): ParsedLogLine | null {
  const line = stripFormatting(raw).replace(/\r$/, '');
  const forge = FORGE_PREFIX.exec(line);
  if (forge) {
    const time = forge[2]!;
    return { time, seconds: timeToSeconds(time), message: forge[3] ?? '' };
  }
  const vanilla = VANILLA_PREFIX.exec(line);
  if (vanilla) {
    const time = vanilla[1]!;
    return { time, seconds: timeToSeconds(time), message: vanilla[2] ?? '' };
  }
  const paper = PAPER_PREFIX.exec(line);
  if (paper) {
    const time = paper[1]!;
    return { time, seconds: timeToSeconds(time), message: paper[2] ?? '' };
  }
  return null;
}

const JOIN_LEAVE = /^([A-Za-z0-9_]{1,16}) (joined|left) the game\b/;

/**
 * Parse `latest.log` text for player presence: last seen time-of-day and completed session hours.
 * Same-day sessions are summed; a leave time earlier than the join time is treated as a midnight wrap.
 * A re-join without a matching leave replaces the open session (server restarted mid-session).
 */
export function parsePlayerLog(text: string): ParsedPlayerLog {
  const lastSeen = new Map<string, string>();
  const playtime = new Map<string, number>();
  const open = new Map<string, number>();
  let sessions = 0;
  for (const raw of text.split('\n')) {
    const line = stripLogLinePrefix(raw);
    if (!line) continue;
    const match = JOIN_LEAVE.exec(line.message);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    if (match[2] === 'joined') {
      open.set(name, line.seconds);
      lastSeen.set(name, line.time);
      continue;
    }
    const joinedSeconds = open.get(name);
    open.delete(name);
    lastSeen.set(name, line.time);
    if (joinedSeconds === undefined) continue; // left without a join in this file (rotation edge)
    let duration = line.seconds - joinedSeconds;
    if (duration < 0) duration += 24 * 3600;
    playtime.set(name, (playtime.get(name) ?? 0) + duration / 3600);
    sessions += 1;
  }
  return { lastSeen, playtime, sessions };
}

// ---------------------------------------------------------------------------------------------------
// Console reply parsing (`list`, Paper `tps`)
// ---------------------------------------------------------------------------------------------------

export interface ParsedListReply {
  online: number;
  /** Max players reported by the server; the service still prefers server.properties (M-06). */
  max: number;
  names: string[];
}

const LIST_REPLIES = [
  /There are (\d+) of a max(?:imum)? of (\d+) players online:?\s*(.*)$/i,
  /There are (\d+)\/(\d+) players online:?\s*(.*)$/i,
];

/** Parse the vanilla/Paper `list` command reply; `null` when the line is not a reply. */
export function parseListReply(text: string): ParsedListReply | null {
  const line = stripFormatting(text);
  for (const pattern of LIST_REPLIES) {
    const match = pattern.exec(line);
    if (!match) continue;
    const online = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isInteger(online) || !Number.isInteger(max)) continue;
    const names = (match[3] ?? '')
      .trim()
      .split(/\s*,\s*/)
      .map((name) => name.trim())
      .filter((name) => name !== '');
    return { online, max, names };
  }
  return null;
}

export interface ParsedTpsReply {
  tps1m: number;
  tps5m: number;
  tps15m: number;
}

/** Parse Paper's `tps` reply: `TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0` (colour codes stripped). */
export function parseTpsReply(text: string): ParsedTpsReply | null {
  const line = stripFormatting(text);
  const match = /TPS from last 1m, 5m, 15m:\s*([\d.]+)(?:\*?),\s*([\d.]+)(?:\*?),\s*([\d.]+)(?:\*?)/i.exec(line);
  if (!match) return null;
  const values = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!values.every((value) => Number.isFinite(value))) return null;
  return { tps1m: values[0]!, tps5m: values[1]!, tps15m: values[2]! };
}

// ---------------------------------------------------------------------------------------------------
// Process sampling (one batched `Get-Process -Id a,b,c` per metrics tick)
// ---------------------------------------------------------------------------------------------------

export interface ProcessSample {
  /** Cumulative CPU seconds from `Get-Process CPU`; `null` when PowerShell returned an empty value. */
  cpuSeconds: number | null;
  workingSetBytes: number;
}

/**
 * Parse the batched PowerShell output produced by `player-metrics-core`'s command contract:
 * one `pid|cpuSeconds|workingSetBytes` line per process (invariant culture), or whitespace-separated
 * fallback. Lines for dead/invalid pids are ignored.
 */
export function parseProcessSampleOutput(text: string): Map<number, ProcessSample> {
  const samples = new Map<number, ProcessSample>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.includes('|') ? line.split('|') : line.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const memory = Number(parts[parts.length - 1]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(memory) || memory < 0) continue;
    const cpuText = parts.slice(1, -1).join('|').trim();
    const cpu = cpuText === '' ? null : Number(cpuText);
    samples.set(pid, {
      cpuSeconds: cpu !== null && Number.isFinite(cpu) && cpu >= 0 ? cpu : null,
      workingSetBytes: memory,
    });
  }
  return samples;
}

/**
 * Normalized CPU percent with Task Manager semantics: cumulative CPU seconds over wall time gives
 * percent-of-one-core, then divide by the logical core count (a 4-core JVM at 200 % of one core is
 * 50 %). `null` when the delta/elapsed pair cannot produce a meaningful number.
 */
export function cpuPercent(deltaCpuSeconds: number, elapsedMs: number, cpuCount: number): number | null {
  if (!Number.isFinite(deltaCpuSeconds) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  if (!Number.isFinite(deltaCpuSeconds) || deltaCpuSeconds < 0) return null;
  const cores = Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : 1;
  const normalized = (deltaCpuSeconds / (elapsedMs / 1000)) * 100 / cores;
  if (!Number.isFinite(normalized) || normalized < 0) return null;
  return Math.round(normalized * 10) / 10;
}

// ---------------------------------------------------------------------------------------------------
// `metrics_get` range validation
// ---------------------------------------------------------------------------------------------------

export type ValidateHoursResult =
  | { ok: true; hours: number }
  | { ok: false; reason: string };

/** Validate the `hours` argument: integer 1..168 (7 days of retained history). */
export function validateHours(input: unknown): ValidateHoursResult {
  const value = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'hours must be a finite number.' };
  if (!Number.isInteger(value)) return { ok: false, reason: 'hours must be an integer.' };
  if (value < 1 || value > 168) return { ok: false, reason: 'hours must be between 1 and 168.' };
  return { ok: true, hours: value };
}
