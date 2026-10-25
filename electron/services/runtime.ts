// P1 runtime handlers — java, versions/loaders, server_install, lifecycle, logs, history.
// Registered into the ipc handler map at registerIpc time.
import path from 'node:path';
import type { IpcContext, Handler } from '../ipc';
import { appError, Store, type ServerDto, type CreateServerInput } from './store';
import { Jobs } from './jobs';
import { ServerProcesses } from './server-process';
import { vanillaVersions, paperVersions, loadersResolve } from './versions';
import { ensureJava, detectJava, requiredJavaMajor, installLoader, type LoaderKind } from './installer/core';

export interface Runtime {
  jobs: Jobs;
  processes: ServerProcesses;
  handlers: Record<string, Handler>;
}

const LOADER_MAP: Record<string, LoaderKind> = {
  Vanilla: 'vanilla', Paper: 'paper', Fabric: 'fabric', Forge: 'forge', NeoForge: 'neoforge',
};

export function buildRuntime(): { register: (ctx: IpcContext) => Runtime; stopAll: () => Promise<void[]> } {
  let jobs: Jobs | null = null;
  let processes: ServerProcesses | null = null;

  const register = (ctx: IpcContext): Runtime => {
    const j = new Jobs(ctx.send);
    jobs = j;
    const cacheDir = path.join(ctx.dataRoot, 'cache');
    const runtimeRoot = path.join(ctx.dataRoot, 'runtime');

    const resolveJava = async (dto: ServerDto): Promise<string> => {
      if (dto.javaPath) return dto.javaPath;
      const major = await requiredJavaMajor(dto.mcVersion);
      const rt = await ensureJava(major, runtimeRoot, cacheDir);
      return rt.javapath;
    };
    processes = new ServerProcesses(new Store(ctx.dataRoot), ctx.dataRoot, ctx.send, resolveJava);

    const handlers: Record<string, Handler> = {
      java_detect: async a => {
        const mcVersion = String(a.mcVersion);
        const requiredMajor = await requiredJavaMajor(mcVersion);
        const found = await detectJava(requiredMajor, [path.join(ctx.dataRoot, "runtime")]);
        return { mcVersion, requiredMajor, installMajor: found[0]?.major ?? requiredMajor, candidates: found };
      },
      java_validate: async a => {
        const mcVersion = String(a.mcVersion);
        const requiredMajor = await requiredJavaMajor(mcVersion);
        const found = await detectJava(requiredMajor, [path.join(ctx.dataRoot, "runtime")]);
        const hit = found.find(c => c.javapath === String(a.path));
        if (!hit) throw appError('validation', 'That Java path is not a matching runtime.');
        return hit;
      },
      java_ensure: async a => {
        const major = Number(a.major);
        const jobId = String(a.jobId ?? '');
        const rt = await ensureJava(major, path.join(ctx.dataRoot, 'runtime'), path.join(ctx.dataRoot, 'cache'),
          p => { if (jobId) j.progress(jobId, { progress: 10, stage: p.phase }); });
        if (jobId) j.progress(jobId, { progress: 100, stage: 'java ready' });
        return { path: rt.javapath, major: rt.major, architectureBits: 64, source: rt.source };
      },
      versions_vanilla: () => vanillaVersions(),
      versions_paper: () => paperVersions(),
      loaders_resolve: a => loadersResolve(String(a.mcVersion)),

      server_install: async a => {
        const input = a.input as CreateServerInput;
        const jobId = String(a.jobId ?? '');
        const s = new Store(ctx.dataRoot);
        const kind = LOADER_MAP[input.loader] ?? appErrorThrow(input.loader);
        const dto = s.createServer({ ...input, loader: input.loader });
        const dir = path.join(ctx.dataRoot, 'servers', dto.id);
        try {
          j.progress(jobId, { progress: 5, stage: 'resolving Java' });
          const major = await requiredJavaMajor(input.mcVersion);
          const rt = await ensureJava(major, path.join(ctx.dataRoot, 'runtime'), path.join(ctx.dataRoot, 'cache'));
          if (!input.javaPath) s.setJavaPath(dto.id, rt.javapath);
          j.progress(jobId, { progress: 25, stage: `installing ${kind}` });
          await installLoader(kind, dir, input.mcVersion, input.loaderVersion ?? '', rt.javapath, cacheDir);
          j.progress(jobId, { progress: 80, stage: 'writing config' });
          if (input.eulaAccepted) { /* eula written at start; recorded on the DTO below */ }
          const patch: Partial<ServerDto> = { javaPath: input.javaPath ?? rt.javapath, eulaAccepted: input.eulaAccepted ?? false };
          const updated = s.updateServer(dto.id, patch);
          j.progress(jobId, { progress: 100, stage: 'done' });
          return updated;
        } catch (err) {
          s.deleteServer(dto.id);
          throw err;
        }
      },
      server_install_cancel: a => jobs!.cancel(String(a.jobId)),

      server_start: a => processes!.start(String(a.id)),
      server_stop: a => processes!.stop(String(a.id)),
      server_kill: a => processes!.kill(String(a.id)),
      server_restart: a => processes!.restart(String(a.id)),
      server_send_command: a => processes!.sendCommand(String(a.id), String(a.cmd)),
      logs_tail: a => processes!.tail(String(a.id), Number(a.lines ?? 200)),
      server_command_history: a => new Store(ctx.dataRoot).commandHistory(String(a.id)),
    };
    return { jobs, processes, handlers };
  };

  return {
    register,
    stopAll: () => (processes ? processes.stopAll() : Promise.resolve([])),
  };
}

function appErrorThrow(loader: string): never { throw appError('validation', `Unsupported loader "${loader}".`); }
