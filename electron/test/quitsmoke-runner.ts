// Phase 8 WP-8.1: quit-while-running live proof.
// Starts a real managed Vanilla server through the real handlers, waits for a complete boot (Done),
// then hands control back to main.ts which installs the production bounded-quit handler and quits.
// The external wrapper (scripts/quitsmoke.mjs) then checks no JVM with the server identity marker
// survives and asserts the app exited 0.
import { handlersMap, registerRuntimeHandlers, type IpcContext } from '../ipc';
import { buildRuntime } from '../services/runtime';

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export interface QuitSmokePreparation {
  ok: boolean;
  serverId: string | null;
  detail: string;
}

export async function prepareQuitSmoke(ctx: IpcContext): Promise<QuitSmokePreparation> {
  const runtime = buildRuntime();
  registerRuntimeHandlers(runtime.register(ctx).handlers);
  const h = handlersMap();
  let serverId: string | null = null;
  try {
    // Real staged install (server jar + Java, verified boot) through the production handler.
    const installed = await h.server_install({
      input: {
        name: `quitsmoke-${Date.now().toString(36)}`, loader: 'Vanilla', mcVersion: '1.21.1',
        ramMb: 1024, port: 26766, eulaAccepted: true,
      },
      jobId: 'quitsmoke-install',
    }, ctx) as { id: string };
    serverId = installed?.id ?? null;
    if (!serverId) return { ok: false, serverId: null, detail: 'install returned no server' };
    // eslint-disable-next-line no-console
    console.log(`QUITSMOKE-SERVER ${serverId}`);
    await h.server_start({ id: serverId }, ctx);
    for (let i = 0; i < 240; i += 1) {
      const rows = await h.servers_list({}, ctx) as { id: string; status: string }[];
      const status = rows.find((row) => row.id === serverId)?.status ?? 'missing';
      if (status === 'crashed') return { ok: false, serverId, detail: 'server crashed before Done' };
      if (status === 'running') {
        const tail = await h.logs_tail({ id: serverId, lines: 400 }, ctx) as string[];
        if (tail.some((line) => line.includes('Done ('))) return { ok: true, serverId, detail: 'booted (Done observed)' };
      }
      await sleep(1000);
    }
    return { ok: false, serverId, detail: 'timed out waiting for Done' };
  } catch (error) {
    return { ok: false, serverId, detail: error instanceof Error ? error.message : String(error) };
  }
}
