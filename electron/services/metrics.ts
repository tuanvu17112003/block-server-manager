// Metrics — CPU/RAM sampled in ONE batched `Get-Process -Id a,b,c` per tick for every running server,
// live player/TPS values probed through the ring-safe console sequence API, 1-minute history kept 7 days.
//
// WP-5.4 / M-13 fixes:
//  * one PowerShell invocation per tick (5 s cadence), not one per server per 2 s;
//  * CPU is normalized by the logical core count so the number matches Task Manager semantics
//    (`cpuPercent` in player-metrics-core) and is not clamped to 100;
//  * Paper servers get a `tps` command at most once per 30 s and the reply is parsed through
//    `entriesSince` (ring-cap safe); MSPT stays null unless a real `Average tick time` line appears;
//  * `maxPlayers` comes from `server.properties` (M-06), also for player counts;
//  * `metrics_get` validates `hours` as an integer 1..168;
//  * history writes are asynchronous (no sync write on the sampling path) and per-server maps are
//    pruned for stopped servers, removed entirely for deleted ones.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError, type ServerDto } from './store';
import { readProperties } from './properties';
import {
  cpuPercent,
  parseListReply,
  parseProcessSampleOutput,
  parseTpsReply,
  validateHours,
} from './player-metrics-core';
import type { ServerProcesses } from './server-process';

export interface MetricsEvent {
  id: string;
  /** Percent of total CPU capacity (normalized by logical cores, Task Manager semantics). */
  cpuPct: number | null;
  memoryMb: number | null;
  ramPct: number | null;
  uptimeSec: number;
  playersOnline: number | null;
  maxPlayers: number | null;
  tps: number | null;
  mspt: number | null;
  at: string;
}

interface Bucket {
  at: string;
  cpuPct: number | null;
  memoryMb: number | null;
  ramPct: number | null;
  players: number | null;
  tps: number | null;
  mspt: number | null;
}

interface Previous {
  startedAt: number;
  cpuSeconds: number;
  at: number;
  memoryMb: number;
}

interface BatchedReading {
  cpuSeconds: number | null;
  workingSetBytes: number;
}

/** 5 s cadence: one batched process sample covers every running server (M-13). */
const INTERVAL_MS = 5_000;
/** Player count refresh cadence for the metrics event (unrelated to the Players tab). */
const LIST_INTERVAL_MS = 15_000;
/** Paper `tps` command cadence (M-13: ≤ 1 per 30 s). */
const TPS_INTERVAL_MS = 30_000;
/** How long a console reply is awaited before the pending probe is abandoned. */
const REPLY_TIMEOUT_MS = 10_000;
const SAMPLE_TIMEOUT_MS = 5_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LIST_SCAN_LIMIT = 400;
const MSPT_REPLY = /Average tick time:\s*([\d.]+)\s*ms/i;

/** One batched `Get-Process` invocation; invariant-culture `pid|cpuSeconds|workingSetBytes` lines. */
function runGetProcessBatch(pids: number[], timeoutMs = SAMPLE_TIMEOUT_MS): Promise<Map<number, BatchedReading>> {
  if (pids.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    const command =
      `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { ` +
      `[string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0}|{1}|{2}', ` +
      `$_.Id, $_.CPU, $_.WorkingSet64) }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let output = '';
    let settled = false;
    const finish = (value: Map<number, BatchedReading>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(new Map()), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', () => finish(new Map()));
    child.on('close', () => finish(parseProcessSampleOutput(output)));
  });
}

function isPaper(dto: ServerDto): boolean {
  return /paper/i.test(dto.loader ?? '');
}

export class Metrics {
  private timer: NodeJS.Timeout | null = null;
  private previous = new Map<string, Previous>();
  private history = new Map<string, Bucket[]>();
  private lastBucket = new Map<string, number>();
  /** Server -> next allowed `list` / `tps` probe timestamp. */
  private nextListAt = new Map<string, number>();
  private nextTpsAt = new Map<string, number>();
  /** Outstanding console probes: server -> log sequence the command was sent at. */
  private pendingList = new Map<string, number>();
  private pendingListAt = new Map<string, number>();
  private pendingTps = new Map<string, number>();
  private pendingTpsAt = new Map<string, number>();
  /** Latest parsed console values, refreshed by the pending probes. */
  private livePlayersOnline = new Map<string, number | null>();
  private liveTps = new Map<string, number | null>();
  private inFlightSaves = new Map<string, Promise<void>>();
  private dirtyHistory = new Set<string>();
  private ticking = false;
  /** Task Manager parity: CPU percent is normalized by the logical processor count. */
  private readonly cpuCount = Math.max(1, os.cpus().length);

  constructor(private ctx: IpcContext, private processes: ServerProcesses) {}

  private store(): Store { return new Store(this.ctx.dataRoot); }
  private historyFile(id: string): string { return path.join(this.ctx.dataRoot, 'metrics', `${id}.json`); }

  private loadHistory(id: string): Bucket[] {
    const cached = this.history.get(id);
    if (cached) return cached;
    let rows: Bucket[] = [];
    try {
      rows = JSON.parse(fs.readFileSync(this.historyFile(id), 'utf8')) as Bucket[];
      if (!Array.isArray(rows)) rows = [];
    } catch {
      rows = [];
    }
    const cutoff = Date.now() - RETENTION_MS;
    rows = rows.filter((row) => row && typeof row === 'object' && Date.parse(row.at) >= cutoff);
    this.history.set(id, rows);
    return rows;
  }

  /** Async, coalesced history write — never blocks the sampling tick or the IPC thread. */
  private flushHistory(id: string): Promise<void> {
    const inFlight = this.inFlightSaves.get(id);
    if (inFlight) {
      this.dirtyHistory.add(id);
      return inFlight;
    }
    this.dirtyHistory.add(id);
    const task = (async (): Promise<void> => {
      try {
        while (this.dirtyHistory.delete(id)) {
          const rows = this.history.get(id);
          if (!rows) return;
          const file = this.historyFile(id);
          const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
          try {
            await fsp.mkdir(path.dirname(file), { recursive: true });
            await fsp.writeFile(temp, JSON.stringify(rows), 'utf8');
            await fsp.rename(temp, file);
          } catch {
            try { await fsp.rm(temp, { force: true }); } catch { /* best effort cleanup */ }
          }
        }
      } finally {
        this.inFlightSaves.delete(id);
      }
    })();
    this.inFlightSaves.set(id, task);
    return task;
  }

  private ramPct(memoryMb: number | null, ramMb: number): number | null {
    if (memoryMb === null || ramMb <= 0) return null;
    return Math.round((memoryMb / ramMb) * 1000) / 10;
  }

  /** server.properties is the authority for the cap (M-06); fall back to the DTO then 20. */
  private propertyMaxPlayers(dto: ServerDto): number {
    try {
      const value = Number(readProperties(path.join(this.ctx.dataRoot, 'servers', dto.id)).values['max-players']);
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      /* unreadable properties: fall back */
    }
    return Number.isInteger(dto.maxPlayers) && (dto.maxPlayers ?? 0) > 0 ? dto.maxPlayers! : 20;
  }

  /** Last `Average tick time` line in the ring (kept null unless a real MSPT line appears). */
  private recentMspt(id: string): number | null {
    const ring = this.processes.history(id).slice(-LIST_SCAN_LIMIT);
    for (let index = ring.length - 1; index >= 0; index -= 1) {
      const match = MSPT_REPLY.exec(ring[index]!);
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  private record(id: string, event: MetricsEvent): void {
    const minute = Math.floor(Date.parse(event.at) / 60_000) * 60_000;
    const last = this.lastBucket.get(id) ?? 0;
    if (minute === last) return;
    this.lastBucket.set(id, minute);
    const rows = this.loadHistory(id);
    rows.push({
      at: new Date(minute).toISOString(),
      cpuPct: event.cpuPct,
      memoryMb: event.memoryMb,
      ramPct: event.ramPct,
      players: event.playersOnline,
      tps: event.tps,
      mspt: event.mspt,
    });
    const cutoff = Date.now() - RETENTION_MS;
    while (rows.length > 0 && Date.parse(rows[0]!.at) < cutoff) rows.shift();
    void this.flushHistory(id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Drop per-server state for stopped servers; forget cached history for deleted servers (no unbounded maps). */
  private pruneMaps(servers: Map<string, ServerDto>, running: Set<string>): void {
    for (const map of [
      this.previous, this.nextListAt, this.nextTpsAt,
      this.pendingList, this.pendingListAt, this.pendingTps, this.pendingTpsAt,
      this.livePlayersOnline, this.liveTps,
    ]) {
      for (const key of [...map.keys()]) if (!running.has(key)) map.delete(key);
    }
    for (const key of [...this.history.keys()]) if (!servers.has(key)) this.history.delete(key);
    for (const key of [...this.lastBucket.keys()]) if (!servers.has(key)) this.lastBucket.delete(key);
    for (const key of [...this.dirtyHistory]) if (!servers.has(key)) this.dirtyHistory.delete(key);
    for (const key of [...this.inFlightSaves.keys()]) if (!servers.has(key)) this.inFlightSaves.delete(key);
  }

  /** Send due `list`/`tps` probes and consume replies to probes sent on earlier ticks. */
  private serviceConsole(id: string, dto: ServerDto, at: number): void {
    this.scanPendingReplies(id, at);
    if (at >= (this.nextListAt.get(id) ?? 0)) {
      try {
        this.pendingList.set(id, this.processes.lineSeq(id));
        this.pendingListAt.set(id, at);
        this.processes.command(id, 'list');
        this.nextListAt.set(id, at + LIST_INTERVAL_MS);
      } catch { /* server stopped between listing and write */ }
    }
    if (!isPaper(dto)) return;
    if (at >= (this.nextTpsAt.get(id) ?? 0)) {
      try {
        this.pendingTps.set(id, this.processes.lineSeq(id));
        this.pendingTpsAt.set(id, at);
        this.processes.command(id, 'tps');
        this.nextTpsAt.set(id, at + TPS_INTERVAL_MS);
      } catch { /* server stopped between listing and write */ }
    }
  }

  private scanPendingReplies(id: string, at: number): void {
    const listFrom = this.pendingList.get(id);
    if (listFrom !== undefined) {
      for (const entry of this.processes.entriesSince(id, listFrom, LIST_SCAN_LIMIT)) {
        const reply = parseListReply(entry.text);
        if (!reply) continue;
        this.livePlayersOnline.set(id, reply.online);
        this.pendingList.delete(id);
        this.pendingListAt.delete(id);
        break;
      }
      if (this.pendingList.has(id) && at - (this.pendingListAt.get(id) ?? at) > REPLY_TIMEOUT_MS) {
        this.pendingList.delete(id);
        this.pendingListAt.delete(id);
      }
    }
    const tpsFrom = this.pendingTps.get(id);
    if (tpsFrom !== undefined) {
      for (const entry of this.processes.entriesSince(id, tpsFrom, LIST_SCAN_LIMIT)) {
        const reply = parseTpsReply(entry.text);
        if (!reply) continue;
        this.liveTps.set(id, reply.tps1m);
        this.pendingTps.delete(id);
        this.pendingTpsAt.delete(id);
        break;
      }
      if (this.pendingTps.has(id) && at - (this.pendingTpsAt.get(id) ?? at) > REPLY_TIMEOUT_MS) {
        this.pendingTps.delete(id);
        this.pendingTpsAt.delete(id);
      }
    }
  }

  private emitSample(
    id: string,
    dto: ServerDto,
    reading: BatchedReading | null,
    at: number,
  ): void {
    const startedAt = this.processes.startedAt(id);
    if (startedAt === null) return;
    const baseline = this.previous.get(id);
    const sameRun = baseline !== undefined && baseline.startedAt === startedAt ? baseline : null;
    if (reading === null && sameRun === null) return; // nothing to report on the first failed sample
    const memoryMb = reading !== null
      ? Math.round(reading.workingSetBytes / 1024 / 1024)
      : sameRun?.memoryMb ?? null;
    let cpu: number | null = null;
    if (reading !== null && reading.cpuSeconds !== null && sameRun !== null) {
      cpu = cpuPercent(reading.cpuSeconds - sameRun.cpuSeconds, at - sameRun.at, this.cpuCount);
    }
    if (reading !== null && reading.cpuSeconds !== null) {
      this.previous.set(id, { startedAt, cpuSeconds: reading.cpuSeconds, at, memoryMb: memoryMb ?? 0 });
    } else if (sameRun !== null) {
      this.previous.set(id, { ...sameRun, at, memoryMb: memoryMb ?? sameRun.memoryMb });
    }
    const event: MetricsEvent = {
      id,
      cpuPct: cpu,
      memoryMb,
      ramPct: this.ramPct(memoryMb, dto.ramMb),
      uptimeSec: Math.max(0, Math.floor((at - startedAt) / 1000)),
      playersOnline: this.livePlayersOnline.get(id) ?? null,
      maxPlayers: this.propertyMaxPlayers(dto),
      tps: this.liveTps.get(id) ?? null,
      mspt: this.recentMspt(id),
      at: new Date(at).toISOString(),
    };
    this.ctx.send(`metrics://${id}`, event);
    this.record(id, event);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const servers = new Map(this.store().listServers().map((dto) => [dto.id, dto]));
      const runningIds = this.processes.runningIds();
      this.pruneMaps(servers, new Set(runningIds));
      if (runningIds.length === 0) return;
      const at = Date.now();
      // One PowerShell invocation for all running servers (M-13).
      const pidByServer = new Map<string, number>();
      for (const id of runningIds) {
        const pid = this.processes.pid(id);
        if (pid !== null && Number.isInteger(pid) && pid > 0) pidByServer.set(id, pid);
      }
      const batch = await runGetProcessBatch([...pidByServer.values()]);
      for (const id of runningIds) {
        const dto = servers.get(id);
        if (!dto) continue;
        this.serviceConsole(id, dto, at);
        const pid = pidByServer.get(id);
        this.emitSample(id, dto, pid === undefined ? null : batch.get(pid) ?? null, at);
      }
    } catch {
      // A transient store/process error must not kill the sampler; the next tick retries.
    } finally {
      this.ticking = false;
    }
  }

  async get(id: string, hours: unknown = 1): Promise<{ samples: Bucket[]; disk: { freeBytes: number; totalBytes: number }; current: Bucket | null }> {
    const dto = this.store().getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    const valid = validateHours(hours);
    if (!valid.ok) throw appError('validation', valid.reason);
    const rows = this.loadHistory(id);
    const cutoff = Date.now() - valid.hours * 60 * 60 * 1000;
    const samples = rows.filter((row) => Date.parse(row.at) >= cutoff);
    let disk = { freeBytes: 0, totalBytes: 0 };
    try {
      const stats = fs.statfsSync(this.ctx.dataRoot);
      disk = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch {
      // statfs is unavailable on some volumes; zeros keep the UI honest.
    }
    return { samples, disk, current: samples[samples.length - 1] ?? null };
  }

  disk(): { freeBytes: number; totalBytes: number } {
    try {
      const stats = fs.statfsSync(this.ctx.dataRoot);
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch {
      return { freeBytes: 0, totalBytes: 0 };
    }
  }

  handlers(): Record<string, Handler> {
    return {
      metrics_get: (a) => this.get(String(a.id), a.hours === undefined ? 1 : a.hours),
      system_disk: () => this.disk(),
    };
  }
}
