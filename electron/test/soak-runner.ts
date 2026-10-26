// Phase 8 soak: keep a real managed server running for hours while churning the rest of the app
// (backups, settings saves, world/player/content reads, restarts, kill+recovery, metrics sampling).
// It runs inside the Electron main process (real services, real JVM) against a persistent data root
// so memory/handle growth and orphan processes are observable. JSONL evidence: <dataRoot>/soak/soak.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { handlersMap, registerRuntimeHandlers, type IpcContext } from '../ipc';
import { buildRuntime } from '../services/runtime';

export interface SoakOptions {
  dataRoot: string;
  hours: number;
  cycleMs?: number;
  /** Injected from main: Electron app metrics (process type/pid/working-set) for leak evidence. */
  appMetrics?: () => unknown;
}

export interface SoakSummary {
  ok: boolean;
  cycles: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
  evidencePath: string;
  finalStatus: string;
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function nowIso(): string { return new Date().toISOString(); }

export async function runSoak(options: SoakOptions): Promise<SoakSummary> {
  const { dataRoot } = options;
  const hours = Math.max(0.01, options.hours);
  const cycleMs = Math.max(5000, options.cycleMs ?? 60_000);
  fs.mkdirSync(dataRoot, { recursive: true });
  const soakDir = path.join(dataRoot, 'soak');
  fs.mkdirSync(soakDir, { recursive: true });
  const evidencePath = path.join(soakDir, 'soak.jsonl');
  const startedAt = nowIso();
  const write = (entry: Record<string, unknown>): void => {
    try { fs.appendFileSync(evidencePath, `${JSON.stringify({ ts: nowIso(), ...entry })}\n`); } catch { /* evidence best effort */ }
  };
  write({ event: 'soak-start', hours, cycleMs, pid: process.pid, memory: process.memoryUsage() });

  const ctx: IpcContext = { dataRoot, send: () => undefined, getWindow: () => null };
  const runtime = buildRuntime();
  registerRuntimeHandlers(runtime.register(ctx).handlers);
  const h = handlersMap();
  const errors: string[] = [];
  let cycles = 0;
  let serverId = '';
  let started = false;
  let finalStatus = 'unknown';

  const call = async <T>(name: string, args: Record<string, unknown> = {}, timeoutMs = 180_000): Promise<T | null> => {
    const handler = h[name];
    if (!handler) { errors.push(`missing handler ${name}`); return null; }
    const started = Date.now();
    try {
      // Every handler is bounded: a stuck lifecycle transition must not freeze the soak silently.
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`handler "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      });
      try {
        const value = await Promise.race([Promise.resolve(handler(args, ctx)) as Promise<T>, timeout]);
        const elapsed = Date.now() - started;
        if (elapsed > 5_000) write({ event: 'slow-handler', name, elapsedMs: elapsed });
        return value;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${name}: ${message}`.slice(0, 400));
      write({ event: 'handler-error', name, message: message.slice(0, 400), elapsedMs: Date.now() - started });
      return null;
    }
  };
  const listRow = async (): Promise<Record<string, unknown> | null> => {
    const rows = await call<Record<string, unknown>[]>('servers_list') ?? [];
    return rows.find((row) => row.id === serverId) ?? null;
  };
  const statusOf = async (): Promise<string> => String((await listRow())?.status ?? 'missing');

  try {
    // Install through the real staged transaction (downloads the server jar/Java, verifies boot
    // before publishing) — this is the same path the Create wizard uses.
    const installed = await call<{ id: string; status?: string }>('server_install', {
      input: {
        name: `soak-${Date.now().toString(36)}`, loader: 'Vanilla', mcVersion: '1.21.1',
        ramMb: 1024, port: 26765, eulaAccepted: true,
      },
      jobId: 'soak-install',
    });
    if (!installed?.id) throw new Error('soak could not install a server');
    serverId = installed.id;
    write({ event: 'server-created', serverId });

    // Start once; retry on failure up to 3 attempts (network-independent after the jar cached).
    for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
      await call('server_start', { id: serverId });
      for (let i = 0; i < 300; i += 1) {
        const status = await statusOf();
        if (status === 'running') { started = true; break; }
        if (status === 'crashed' || status === 'stopped') break;
        await sleep(1000);
      }
      if (!started) {
        write({ event: 'start-failed', attempt: attempt + 1, status: await statusOf() });
        await call('server_stop', { id: serverId });
      }
    }
    if (!started) throw new Error('soak server never reached running state');

    const deadline = Date.now() + hours * 3_600_000;
    let lastBackupAt = 0;
    while (Date.now() < deadline) {
      cycles += 1;
      const cycleStart = Date.now();
      write({ event: 'cycle-begin', cycle: cycles });
      const status = await statusOf();
      const metrics = await call<{ samples?: unknown[]; event?: { cpu?: number; ram?: number } }>('metrics_get', { id: serverId, hours: 1 });
      const logTail = await call<unknown>('logs_tail', { id: serverId, lines: 50 });
      await call('worlds_list', { id: serverId });
      await call('players_list', { id: serverId });
      await call('content_list', { id: serverId });
      await call('server_command_history', { id: serverId });
      if (cycles % 4 === 0) await call('server_send_command', { id: serverId, cmd: 'list' });
      if (cycles % 5 === 0 && Date.now() - lastBackupAt > 300_000) {
        lastBackupAt = Date.now();
        await call('backup_create', { id: serverId, name: `soak-${cycles}` });
      }
      if (cycles % 7 === 0) {
        await call('server_settings_update', { id: serverId, values: { motd: `soak cycle ${cycles}` } });
      }
      if (cycles % 20 === 0) {
        await call('server_restart', { id: serverId });
        for (let i = 0; i < 120; i += 1) { if ((await statusOf()) === 'running') break; await sleep(1000); }
      }
      if (cycles % 30 === 0) {
        await call('server_kill', { id: serverId });
        await sleep(3000);
        await call('server_start', { id: serverId });
        for (let i = 0; i < 180; i += 1) { if ((await statusOf()) === 'running') break; await sleep(1000); }
      }
      const sample = {
        event: 'cycle', cycle: cycles, status: await statusOf(),
        cycleMs: Date.now() - cycleStart,
        metricsSamples: Array.isArray(metrics?.samples) ? metrics.samples.length : null,
        tailLines: Array.isArray(logTail as unknown[]) ? (logTail as unknown[]).length : null,
        memory: process.memoryUsage(),
        appMetrics: options.appMetrics ? options.appMetrics() : null,
      };
      write(sample);
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleep(Math.min(cycleMs, remaining));
    }
    finalStatus = await statusOf();
    write({ event: 'soak-complete', cycles, errors: errors.length, finalStatus });
  } catch (error) {
    finalStatus = 'aborted';
    errors.push(error instanceof Error ? error.message : String(error));
    write({ event: 'soak-abort', message: errors[errors.length - 1] });
  } finally {
    try { await call('server_kill', { id: serverId }); } catch { /* best effort */ }
    try { await call('server_stop', { id: serverId }); } catch { /* best effort */ }
    try { await call('servers_delete', { id: serverId }); } catch { /* best effort */ }
    try { await runtime.shutdown(); } catch { /* best effort */ }
    write({ event: 'soak-teardown', finalStatus, errors: errors.length });
  }
  return {
    ok: errors.length === 0 && finalStatus !== 'aborted',
    cycles,
    errors,
    startedAt,
    finishedAt: nowIso(),
    evidencePath,
    finalStatus,
  };
}
