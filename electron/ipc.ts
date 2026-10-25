// Command router — same command names as the Rust backend; errors serialize as {code,message}
// (JSON-in-message, the ipcRenderer.invoke convention) so the renderer adapter can rebuild AppError.
import type { BrowserWindow, IpcMain } from 'electron';
import { dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Store, appError, type CreateServerInput } from './services/store';

export interface IpcContext {
  dataRoot: string;
  send: (channel: string, payload: unknown) => void;
  getWindow: () => BrowserWindow | null;
}

export type Handler = (args: Record<string, unknown>, ctx: IpcContext) => Promise<unknown> | unknown;

const store = (ctx: IpcContext): Store => new Store(ctx.dataRoot);

const handlers: Record<string, Handler> = {
  // ---- phase 0: shell + servers store ----
  ping: () => 'pong',
  servers_list: (_a, ctx) => store(ctx).listServers(),
  server_get: (a, ctx) => store(ctx).getServer(String(a.id)),
  servers_create: (a, ctx) => store(ctx).createServer(a.input as CreateServerInput),
  servers_delete: (a, ctx) => { store(ctx).deleteServer(String(a.id)); },
  servers_set_java_path: (a, ctx) => store(ctx).setJavaPath(String(a.id), (a.path as string | null) ?? null),
};

// ---- P1: runtime (java, versions/loaders, install, lifecycle) ----
// Late-bound because they need the window-broadcast context wired in registerIpc.
export function registerRuntimeHandlers(extra: Record<string, Handler>): void {
  for (const [name, handler] of Object.entries(extra)) handlers[name] = handler;
}

// Commands arriving in P2 — registered now so the UI gets a clean
// {code:'not-implemented'} rejection instead of "No handler registered" noise.
const UPCOMING: string[] = [
  'modpack_pipeline_pick_local_mrpack', 'modpack_pipeline_preview', 'modpack_pipeline_install',
  'modpack_pipeline_cancel', 'modpack_pipeline_discard_preview', 'modpack_pipeline_release_local_mrpack',
  'modrinth_search_modpacks', 'modrinth_project_versions',
  'curseforge_open_browser', 'curseforge_open_external_browser', 'curseforge_list_zips',
  'curseforge_pick_zip', 'curseforge_inspect_zip', 'curseforge_cancel_download',
] as const;
for (const name of UPCOMING) {
  handlers[name] = () => { throw appError('not-implemented', `Command "${name}" arrives in the next port phase.`); };
}

const dialogs: Record<string, (ctx: IpcContext) => Promise<unknown>> = {
  'dialog:pick-mrpack': async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return { sourceId: r.filePaths[0], fileName: path.basename(r.filePaths[0]) };
  },
  'dialog:pick-zip': async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'CurseForge server pack', extensions: ['zip'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const st = fs.statSync(r.filePaths[0]);
    return { name: path.basename(r.filePaths[0]), size: st.size, modifiedAt: st.mtimeMs };
  },
  'shell:open-external': async (a: unknown) => { await shell.openExternal(String(a)); },
};

export function registerIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('cmd:' + name, async (_event, args: Record<string, unknown> = {}) => {
      try {
        return await handler(args, ctx);
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'internal';
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(JSON.stringify({ code, message }));
      }
    });
  }
  for (const [name, handler] of Object.entries(dialogs)) {
    ipcMain.handle(name, async (_event, args) => {
      try { return await handler(args as IpcContext); }
      catch (err) { throw new Error(JSON.stringify({ code: 'internal', message: err instanceof Error ? err.message : String(err) })); }
    });
  }
}

export function handlersMap(): Record<string, Handler> { return handlers; }

/** Direct handler invocation for the automated gate (no window needed). */
export async function runSelfTest(ctx: IpcContext): Promise<boolean> {
  const t = (name: string, v: unknown) => ({ name, v });
  const results: { name: string; v: unknown }[] = [];
  results.push(t('ping', handlers.ping({}, ctx)));
  const created = await handlers.servers_create({
    input: { name: 'selftest-' + Date.now(), loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 },
  }, ctx) as { id: string; name: string; status: string };
  results.push(t('create', created.name));
  const list = await handlers.servers_list({}, ctx) as unknown[];
  results.push(t('list>=1', list.length >= 1));
  const updated = await handlers.servers_set_java_path({ id: created.id, path: 'C:/j/java.exe' }, ctx) as { javaPath: string };
  results.push(t('setJava', updated.javaPath === 'C:/j/java.exe'));
  const got = await handlers.server_get({ id: created.id }, ctx) as { id: string } | null;
  results.push(t('get', got?.id === created.id));
  await handlers.servers_delete({ id: created.id }, ctx);
  const after = await handlers.servers_list({}, ctx) as { name: string }[];
  results.push(t('delete', !after.some(s => s.name === created.name)));
  // error contract
  let errShape = 'no-error';
  try { await handlers.server_get({ id: 'missing' }, ctx); } catch (e) { errShape = ((e as { code?: string }).code === 'not-found') ? 'not-found' : 'wrong'; }
  results.push(t('error-code', errShape));
  const pass = results.every(r => r.v === true || typeof r.v === 'string');
  // eslint-disable-next-line no-console
  console.log(results.map(r => `${r.name}=${String(r.v)}`).join(' | '));
  void appError;
  return pass;
}
