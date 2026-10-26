// Command router — same command names as the Rust backend; errors serialize as {code,message}
// (JSON-in-message, the ipcRenderer.invoke convention) so the renderer adapter can rebuild AppError.
import type { BrowserWindow, IpcMain } from 'electron';
import { dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Store, appError, type CreateServerInput, type ServerDto } from './services/store';
import { applySettingsToDto, serverDir } from './services/properties';

export interface IpcContext {
  dataRoot: string;
  send: (channel: string, payload: unknown) => void;
  getWindow: () => BrowserWindow | null;
}

export type Handler = (args: Record<string, unknown>, ctx: IpcContext) => Promise<unknown> | unknown;

const store = (ctx: IpcContext): Store => new Store(ctx.dataRoot);

/** Merge the server.properties subset into every DTO the renderer sees (file stays authoritative). */
function enrich(ctx: IpcContext, dto: ServerDto): ServerDto {
  return applySettingsToDto(dto, serverDir(ctx, dto.id));
}

const handlers: Record<string, Handler> = {
  // ---- phase 0: shell + servers store ----
  ping: () => 'pong',
  servers_list: (_a, ctx) => store(ctx).listServers().map((dto) => enrich(ctx, dto)),
  server_get: (a, ctx) => {
    const dto = store(ctx).getServer(String(a.id));
    return dto === null ? null : enrich(ctx, dto);
  },
  servers_create: (a, ctx) => enrich(ctx, store(ctx).createServer(a.input as CreateServerInput)),
  servers_delete: (a, ctx) => {
    const id = String(a.id);
    const dto = store(ctx).getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    if (dto.status === 'running' || dto.status === 'starting' || dto.status === 'stopping') {
      throw appError('conflict', 'Stop the server before deleting it.');
    }
    const backups = store(ctx).listBackups(id);
    store(ctx).deleteServer(id);
    for (const backup of backups) fs.rmSync(backup.path, { force: true });
    fs.rmSync(path.join(ctx.dataRoot, 'metrics', `${id}.json`), { force: true });
    fs.rmSync(path.join(ctx.dataRoot, 'servers', id), { recursive: true, force: true });
  },
  servers_set_java_path: (a, ctx) => enrich(ctx, store(ctx).setJavaPath(String(a.id), (a.path as string | null) ?? null)),
};

// ---- P1: runtime (java, versions/loaders, install, lifecycle) ----
// Merge only: registerIpc() snapshots this map, so it MUST be called after this function.
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

let ipcRegistered = false;

/**
 * Bind the command map to ipcMain. Call ONCE, after every runtime handler was merged with
 * registerRuntimeHandlers(); this function snapshots the map, so a later merge is invisible to IPC.
 *
 * Results travel in an envelope ({__ipc:true, ok, value|error}) instead of a thrown Error.
 * Electron prefixes thrown IPC errors with `Error invoking remote method ...`, which would break
 * the renderer's JSON {code,message} contract; the preload unwraps this envelope.
 */
export function registerIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  if (ipcRegistered) throw new Error('registerIpc called twice');
  ipcRegistered = true;

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('cmd:' + name, async (_event, args: Record<string, unknown> = {}) => {
      try {
        return { __ipc: true, ok: true, value: await handler(args, ctx) };
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'internal';
        const message = err instanceof Error ? err.message : String(err);
        return { __ipc: true, ok: false, error: { code, message } };
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
  // error contract: servers_delete throws not-found before touching any filesystem path
  let errShape = 'no-error';
  try { await handlers.servers_delete({ id: 'missing' }, ctx); } catch (e) { errShape = ((e as { code?: string }).code === 'not-found') ? 'not-found' : 'wrong'; }
  results.push(t('error-code', errShape === 'not-found'));
  const pass = results.every(r => r.v === true || typeof r.v === 'string');
  // eslint-disable-next-line no-console
  console.log(results.map(r => `${r.name}=${String(r.v)}`).join(' | '));
  void appError;
  return pass;
}
