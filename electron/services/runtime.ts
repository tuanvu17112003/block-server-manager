// P1 runtime handlers — java, versions/loaders, server_install, lifecycle, logs, history.
// Registered into the ipc handler map at registerIpc time.
import path from 'node:path';
import fs from 'node:fs';
import type { IpcContext, Handler } from '../ipc';
import { appError, Store, type ServerDto, type CreateServerInput } from './store';
import { Jobs } from './jobs';
import { ServerProcesses } from './server-process';
import { vanillaVersions, paperVersions, loadersResolve, validateLoaderPin } from './versions';
import { installLoader, ensureServerProperties, writeEula, type LoaderKind } from './installer/core';
import { requiredJavaMajor, offlineJavaMajor, installMajorFor, detectJava, validateJava, ensureJava } from './java';
import { probePortAvailable, PORT_MIN, PORT_MAX } from './validate-args';
import { publishStagedServer, assertServerNameAvailable } from './install-transaction';
import { searchModpacks, projectVersions } from './installer/modrinth';
import { Pipeline } from './pipeline';
import { CurseForgeStaging } from './curseforge-staging';
import { settingsHandlers } from './properties';
import { Backups } from './backups';
import { Worlds } from './worlds';
import { Players } from './players';
import { Metrics } from './metrics';
import { Content } from './content';

export interface Runtime {
  jobs: Jobs;
  processes: ServerProcesses;
  handlers: Record<string, Handler>;
}

const LOADER_MAP: Record<string, LoaderKind> = {
  Vanilla: 'vanilla', Paper: 'paper', Fabric: 'fabric', Forge: 'forge', NeoForge: 'neoforge',
};

export function buildRuntime(): {
  register: (ctx: IpcContext) => Runtime;
  stopAll: (budgetMs?: number) => Promise<void[]>;
  shutdown: (budgetMs?: number) => Promise<void[]>;
} {
  let jobs: Jobs | null = null;
  let processes: ServerProcesses | null = null;
  let backups: Backups | null = null;
  let metrics: Metrics | null = null;

  const register = (ctx: IpcContext): Runtime => {
    const j = new Jobs(ctx.send);
    jobs = j;
    const cacheDir = path.join(ctx.dataRoot, 'cache');
    const runtimeRoot = path.join(ctx.dataRoot, 'runtime');

    // Start must not wait on Mojang: prefer the local mapping and only fall back to metadata for
    // versions the local table does not know (e.g. future 26.x) when a network lookup is unavoidable.
    const startTimeRequiredMajor = async (mcVersion: string): Promise<number> => {
      const offline = offlineJavaMajor(mcVersion);
      if (offline !== null) return offline;
      return requiredJavaMajor(mcVersion);
    };

    const resolveJava = async (dto: ServerDto): Promise<string> => {
      const required = await startTimeRequiredMajor(dto.mcVersion);
      const installMajor = installMajorFor(required) ?? required;
      if (dto.javaPath) {
        // A configured override is inspected locally (major/arch) — never silently replaced.
        return (await validateJava(dto.javaPath, installMajor)).path;
      }
      return (await ensureJava(installMajor, runtimeRoot, cacheDir)).path;
    };
    processes = new ServerProcesses(new Store(ctx.dataRoot), ctx.dataRoot, ctx.send, resolveJava);

    const handlers: Record<string, Handler> = {
      java_detect: async a => {
        const mcVersion = String(a.mcVersion);
        const requiredMajor = await requiredJavaMajor(mcVersion);
        const installMajor = installMajorFor(requiredMajor) ?? requiredMajor;
        const candidates = await detectJava(requiredMajor, [runtimeRoot], { maxCandidates: 32 });
        return { mcVersion, requiredMajor, installMajor, candidates };
      },
      java_validate: async a => {
        const mcVersion = String(a.mcVersion);
        const requiredMajor = await requiredJavaMajor(mcVersion);
        const installMajor = installMajorFor(requiredMajor) ?? requiredMajor;
        return validateJava(String(a.path), installMajor);
      },
      java_ensure: async a => {
        const major = Number(a.major);
        const jobId = String(a.jobId ?? '');
        const candidate = await ensureJava(major, runtimeRoot, cacheDir,
          progress => { if (jobId) j.progress(jobId, { progress: progress.pct ?? 10, stage: progress.phase }); });
        if (jobId) j.progress(jobId, { progress: 100, stage: 'java ready' });
        return { path: candidate.path, major: candidate.major, architectureBits: candidate.architectureBits, source: candidate.source };
      },
      versions_vanilla: () => vanillaVersions(),
      versions_paper: () => paperVersions(),
      loaders_resolve: a => loadersResolve(String(a.mcVersion)),
      port_check: async a => {
        const port = Number(a.port);
        if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
          throw appError('validation', `Port must be ${PORT_MIN}-${PORT_MAX}.`);
        }
        // Availability must match what Start enforces: OS probe + no other server record.
        const available = await probePortAvailable(port);
        let suggested = port;
        if (!available) {
          try { suggested = await new Store(ctx.dataRoot).allocatePort(port); } catch { suggested = port; }
        }
        return { port, available, suggested };
      },

      server_install: async a => {
        const input = a.input as CreateServerInput;
        const jobId = String(a.jobId ?? '');
        const s = new Store(ctx.dataRoot);
        const kind = LOADER_MAP[input.loader] ?? appErrorThrow(input.loader);
        if (jobId) j.begin(jobId);
        try {
          assertServerNameAvailable(s, input.name);
          // WP-2.3 port model: allocate (record-free + OS-bindable) before provisioning; the same
          // port is written to the staged server.properties and carried by the published record.
          const port = await s.allocatePort(input.port ?? null);
          // WP-3.1: a loader pin must exist in the live catalogue for this MC version.
          const choices = await loadersResolve(input.mcVersion);
          const pin = validateLoaderPin(input.loader, input.mcVersion, input.loaderVersion ?? '', choices);
          if (!pin.ok) throw appError('validation', pin.message ?? `Invalid ${input.loader} version for Minecraft ${input.mcVersion}.`);
          j.progress(jobId, { progress: 5, stage: 'resolving Java' });
          const requiredMajor = await requiredJavaMajor(input.mcVersion);
          const installMajor = installMajorFor(requiredMajor) ?? requiredMajor;
          // A configured Java path is validated and used as-is; only a missing runtime triggers
          // provisioning. Start/install must not silently download a JDK over an explicit choice.
          let javaExe: string;
          if (input.javaPath) {
            javaExe = (await validateJava(input.javaPath, requiredMajor)).path;
          } else {
            javaExe = (await ensureJava(installMajor, runtimeRoot, cacheDir)).path;
          }
          // WP-2.4: everything installs into <dataRoot>/installer-staging/<uuid>; the record and the
          // final servers/<id> directory only appear after artifact + launch-shape validation.
          const result = await publishStagedServer({
            dataRoot: ctx.dataRoot,
            store: s,
            loaderKind: kind,
            input: {
              ...input,
              port,
              javaPath: input.javaPath ?? javaExe,
              eulaAccepted: input.eulaAccepted ?? false,
            },
            isCancelled: () => Boolean(jobId) && j.isCancelled(jobId),
            onProgress: p => j.progress(jobId, { stage: p.stage, progress: p.progress }),
            install: async ({ stagingDir, log }) => {
              j.progress(jobId, { progress: 25, stage: `installing ${kind}` });
              log(`installing ${kind} ${input.mcVersion}${input.loaderVersion ? ` ${input.loaderVersion}` : ''}`);
              await installLoader(kind, stagingDir, input.mcVersion, input.loaderVersion ?? '', javaExe, cacheDir);
              j.progress(jobId, { progress: 80, stage: 'writing config' });
              ensureServerProperties(stagingDir, port);
              if (input.eulaAccepted) writeEula(stagingDir);
              log('configuration written (server.properties/eula)');
            },
          });
          j.progress(jobId, { progress: 100, stage: 'done' });
          return result.server;
        } finally {
          if (jobId) j.end(jobId);
        }
      },
      server_install_cancel: a => jobs!.cancel(String(a.jobId)),

      server_start: a => processes!.startDetached(String(a.id)),
      server_stop: a => processes!.stop(String(a.id)),
      server_kill: a => processes!.kill(String(a.id)),
      server_restart: a => processes!.restartDetached(String(a.id)),
      server_send_command: a => processes!.sendCommand(String(a.id), String(a.cmd)),
      logs_tail: a => processes!.tail(String(a.id), Number(a.lines ?? 200)),
      server_command_history: a => new Store(ctx.dataRoot).commandHistory(String(a.id)),

      modrinth_search_modpacks: a => searchModpacks(String(a.query ?? ''), a.gameVersion as string | null, a.loader as string | null, String(a.index ?? 'relevance'), Number(a.offset ?? 0), Number(a.limit ?? 20)),
      modrinth_project_versions: a => projectVersions(String(a.projectId)),
    };
    const pipeline = new Pipeline(ctx, jobs);
    const staging = new CurseForgeStaging(ctx);
    const backupService = new Backups(ctx, processes, j);
    const worldService = new Worlds(ctx, processes, backupService);
    const playerService = new Players(ctx, processes);
    const metricService = new Metrics(ctx, processes);
    const contentService = new Content(ctx, processes, j, backupService);
    backups = backupService;
    metrics = metricService;
    metricService.start();
    backupService.startScheduler();

    Object.assign(
      handlers,
      pipeline.handlers(),
      staging.handlers(),
      settingsHandlers(ctx, async (id) => { await processes!.stop(id); }),
      backupService.handlers(),
      worldService.handlers(),
      playerService.handlers(),
      metricService.handlers(),
      contentService.handlers(),
    );
    return { jobs, processes, handlers };
  };

  const shutdown = async (budgetMs = 5000): Promise<void[]> => {
    backups?.stopScheduler();
    metrics?.stop();
    return processes ? processes.stopAll(budgetMs) : Promise.resolve([]);
  };

  return {
    register,
    stopAll: (budgetMs = 5000) => (processes ? processes.stopAll(budgetMs) : Promise.resolve([])),
    shutdown,
  };
}

function appErrorThrow(loader: string): never { throw appError('validation', `Unsupported loader "${loader}".`); }
