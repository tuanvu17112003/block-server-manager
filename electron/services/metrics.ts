// Metrics — per-server process CPU/RAM sampled every 2 s, live events, 1-minute history kept 7 days.
// CPU is derived from the cumulative process CPU counter; the first sample of a run has no baseline.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { IpcContext, Handler } from '../ipc';
import { Store, appError } from './store';
import type { ServerProcesses } from './server-process';

export interface MetricsEvent {
  id: string;
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

const INTERVAL_MS = 2_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LIST_REPLY = /There are (\d+) of a max of (\d+) players online:?\s*(.*)$/;
const TPS_REPLY = /TPS from last 1m, 5m, 15m:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/i;
const MSPT_REPLY = /Average tick time:\s*([\d.]+)\s*ms/i;

function runPowerShell(pid: number, timeoutMs = 5000): Promise<{ cpuSeconds: number; workingSetBytes: number }> {
  return new Promise((resolve, reject) => {
    const command = `Get-Process -Id ${pid} | ForEach-Object { "$($_.CPU) $($_.WorkingSet64)" }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let output = '';
    let settled = false;
    const against = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => against(new Error(`Get-Process timed out reading pid ${pid}`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', (error) => against(error));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parts = output.trim().split(/\s+/);
      const cpu = Number((parts[0] ?? '').replace(',', '.'));
      const memory = Number(parts[1]);
      if (code !== 0 || !Number.isFinite(cpu) || !Number.isFinite(memory)) {
        reject(new Error(`Get-Process could not read pid ${pid}`));
        return;
      }
      resolve({ cpuSeconds: cpu, workingSetBytes: memory });
    });
  });
}

export class Metrics {
  private timer: NodeJS.Timeout | null = null;
  private previous = new Map<string, Previous>();
  private history = new Map<string, Bucket[]>();
  private lastBucket = new Map<string, number>();
  private lastList = new Map<string, number>();
  private ticking = false;

  constructor(private ctx: IpcContext, private processes: ServerProcesses) {}

  private store(): Store { return new Store(this.ctx.dataRoot); }
  private historyFile(id: string): string { return path.join(this.ctx.dataRoot, 'metrics', `${id}.json`); }

  private loadHistory(id: string): Bucket[] {
    const cached = this.history.get(id);
    if (cached) return cached;
    let rows: Bucket[] = [];
    try {
      rows = JSON.parse(fs.readFileSync(this.historyFile(id), 'utf8')) as Bucket[];
    } catch {
      rows = [];
    }
    const cutoff = Date.now() - RETENTION_MS;
    rows = rows.filter((row) => Date.parse(row.at) >= cutoff);
    this.history.set(id, rows);
    return rows;
  }

  private saveHistory(id: string): void {
    const rows = this.history.get(id);
    if (!rows) return;
    try {
      fs.mkdirSync(path.dirname(this.historyFile(id)), { recursive: true });
      const temp = `${this.historyFile(id)}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(rows));
      fs.renameSync(temp, this.historyFile(id));
    } catch {
      // History is a convenience; a read-only data root must not break metrics.
    }
  }

  private fromRing(id: string): { playersOnline: number | null; maxPlayers: number | null; tps: number | null; mspt: number | null } {
    const ring = this.processes.history(id).slice(-400);
    let playersOnline: number | null = null;
    let maxPlayers: number | null = null;
    let tps: number | null = null;
    let mspt: number | null = null;
    for (const line of ring) {
      const list = LIST_REPLY.exec(line);
      if (list) {
        playersOnline = Number(list[1]);
        maxPlayers = Number(list[2]);
      }
      const tpsMatch = TPS_REPLY.exec(line);
      if (tpsMatch) {
        const value = Number(tpsMatch[1]);
        if (Number.isFinite(value)) tps = value;
      }
      const msptMatch = MSPT_REPLY.exec(line);
      if (msptMatch) {
        const value = Number(msptMatch[1]);
        if (Number.isFinite(value)) mspt = value;
      }
    }
    return { playersOnline, maxPlayers, tps, mspt };
  }

  private ramPct(memoryMb: number | null, ramMb: number): number | null {
    if (memoryMb === null || ramMb <= 0) return null;
    return Math.round((memoryMb / ramMb) * 1000) / 10;
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
    this.saveHistory(id);
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

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const ids = this.processes.runningIds();
      for (const id of ids) {
        await this.sample(id);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async sample(id: string): Promise<void> {
    const dto = this.store().getServer(id);
    if (!dto) return;
    const pid = this.processes.pid(id);
    const startedAt = this.processes.startedAt(id);
    if (pid === null || startedAt === null) return;
    const at = Date.now();
    const uptimeSec = Math.max(0, Math.floor((at - startedAt) / 1000));
    const last = this.previous.get(id);
    const baseline = last && last.startedAt === startedAt ? last : null;
    // Refresh the player count without spamming the console: one `list` every 15 s.
    const lastList = this.lastList.get(id) ?? 0;
    if (at - lastList >= 15_000) {
      try { this.processes.command(id, 'list'); this.lastList.set(id, at); } catch { /* server just stopped */ }
    }
    const live = this.fromRing(id);
    let reading: { cpuSeconds: number; workingSetBytes: number };
    try {
      reading = await runPowerShell(pid);
    } catch {
      if (baseline === null) return;
      const event: MetricsEvent = {
        id,
        cpuPct: null,
        memoryMb: baseline.memoryMb,
        ramPct: this.ramPct(baseline.memoryMb, dto.ramMb),
        uptimeSec,
        playersOnline: live.playersOnline,
        maxPlayers: live.maxPlayers ?? dto.maxPlayers ?? null,
        tps: live.tps,
        mspt: live.mspt,
        at: new Date(at).toISOString(),
      };
      this.ctx.send(`metrics://${id}`, event);
      this.record(id, event);
      return;
    }
    const memoryMb = Math.round(reading.workingSetBytes / 1024 / 1024);
    let cpuPct: number | null = null;
    if (baseline) {
      const elapsed = at - baseline.at;
      if (elapsed > 0) {
        const pct = ((reading.cpuSeconds - baseline.cpuSeconds) / elapsed) * 1000 * 100;
        cpuPct = Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
      }
    }
    this.previous.set(id, { startedAt, cpuSeconds: reading.cpuSeconds, at, memoryMb });
    const event: MetricsEvent = {
      id,
      cpuPct,
      memoryMb,
      ramPct: this.ramPct(memoryMb, dto.ramMb),
      uptimeSec,
      playersOnline: live.playersOnline,
      maxPlayers: live.maxPlayers ?? dto.maxPlayers ?? null,
      tps: live.tps,
      mspt: live.mspt,
      at: new Date(at).toISOString(),
    };
    this.ctx.send(`metrics://${id}`, event);
    this.record(id, event);
  }

  async get(id: string, hours = 1): Promise<{ samples: Bucket[]; disk: { freeBytes: number; totalBytes: number }; current: Bucket | null }> {
    const dto = this.store().getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    const rows = this.loadHistory(id);
    const cutoff = Date.now() - Math.max(1, Math.min(168, hours)) * 60 * 60 * 1000;
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
      metrics_get: (a) => this.get(String(a.id), Number(a.hours ?? 1)),
      system_disk: () => this.disk(),
    };
  }
}
