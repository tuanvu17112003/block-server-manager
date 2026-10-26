// Electron-main service harness: builds the production handler map + runtime against a
// throwaway data root, captures events, and exposes direct handler invocation.
// Used by the service and contract test runners (runs inside Electron, not plain Node).
import fs from 'node:fs';
import path from 'node:path';
import type { Handler, IpcContext } from '../ipc';
import { handlersMap, registerRuntimeHandlers } from '../ipc';
import { buildRuntime } from '../services/runtime';
import { Store, type ServerDto } from '../services/store';
import { TestRun, tempRoot, type TempRoot } from './harness';

export interface CapturedEvent {
  channel: string;
  payload: unknown;
}

export interface Harness {
  readonly ctx: IpcContext;
  readonly dataRoot: string;
  readonly events: CapturedEvent[];
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  handler(name: string): Handler;
  store(): Store;
  createServer(input: Partial<ServerDto> & { name: string }): Promise<ServerDto>;
  scaffoldServer(serverId: string): string;
  shutdown(): Promise<void>;
  cleanup(): void;
}

export interface HarnessOptions {
  label?: string;
  /** Seed a single stopped Vanilla server (properties/eula/world/mod). */
  seedServer?: boolean;
}

interface RuntimeApi {
  register: (ctx: IpcContext) => {
    jobs: unknown;
    processes: unknown;
    handlers: Record<string, Handler>;
  };
  shutdown: () => Promise<unknown>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const temp: TempRoot = tempRoot(options.label ?? 'msm-svc');
  const events: CapturedEvent[] = [];
  const ctx: IpcContext = {
    dataRoot: temp.root,
    send: (channel, payload) => { events.push({ channel, payload }); },
    getWindow: () => null,
  };
  const appRuntime = buildRuntime() as unknown as RuntimeApi;
  const runtime = appRuntime.register(ctx);
  registerRuntimeHandlers(runtime.handlers);

  // Snapshot the merged map so a later harness cannot leak its handlers into this one.
  const merged: Record<string, Handler> = { ...handlersMap(), ...runtime.handlers };

  const harness: Harness = {
    ctx,
    dataRoot: temp.root,
    events,
    handler: (name) => {
      const handler = merged[name];
      if (!handler) throw new Error(`no handler "${name}"`);
      return handler;
    },
    async invoke<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const handler = merged[name];
      if (!handler) throw Object.assign(new Error(`No handler registered for "${name}".`), { code: 'not-found' });
      return (await handler(args, ctx)) as T;
    },
    store: () => new Store(temp.root),
    async createServer(input) {
      return harness.invoke<ServerDto>('servers_create', { input });
    },
    scaffoldServer(serverId: string) {
      const dir = path.join(temp.root, 'servers', serverId);
      fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'test-level');
      fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'mods', 'example.jar'), 'test-jar');
      fs.writeFileSync(path.join(dir, 'eula.txt'), '# test\neula=true\n');
      fs.writeFileSync(path.join(dir, 'server.properties'), [
        'motd=Test MOTD', 'max-players=10', 'difficulty=normal', 'gamemode=survival',
        'online-mode=true', 'server-port=25599', 'level-name=world', '',
      ].join('\n'));
      return dir;
    },
    async shutdown() { await appRuntime.shutdown(); },
    cleanup() { temp.cleanup(); },
  };

  if (options.seedServer) {
    const dto = await harness.createServer({ name: 'Test Server', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
    harness.scaffoldServer(dto.id);
    await harness.invoke('server_settings_update', { id: dto.id, values: { motd: 'Test MOTD' }, eulaAccepted: true });
  }

  return harness;
}

/** Shared assertion helper: run a suite body with a fresh harness and always clean up. */
export async function withHarness(
  run: TestRun,
  body: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await body(harness);
  } finally {
    try { await harness.shutdown(); } catch { /* best effort */ }
    harness.cleanup();
  }
}
