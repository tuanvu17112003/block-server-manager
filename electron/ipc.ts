// Command router — same command names as the Rust backend; errors serialize as {code,message}
// (JSON-in-message, the ipcRenderer.invoke convention) so the renderer adapter can rebuild AppError.
// Security (WP-2.3): every `cmd:` invocation checks the sender frame origin against the app's own
// file:// renderer (or the Vite dev-server origin); untrusted senders get a `{code:'forbidden'}`
// envelope instead of reaching a handler. Dialogs are unchanged.
import type { BrowserWindow, IpcMain } from 'electron';
import { app, dialog, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, appError, type ServerDto } from './services/store';
import { applySettingsToDto, serverDir } from './services/properties';
import { normalizeCreateServerInput } from './services/validate-args';
import { validateCommandArgs } from './services/validate-ipc';
import { clearCurseForgeKey, curseForgeKeyStatus, setCurseForgeKey } from './services/secrets';
import { resetCurseForgeKeyCache } from './services/installer/curseforge';
import { createSupportBundle, recentDiagnostics } from './services/diagnostics';
import { describeRemovalFailure, removeDirectory } from './services/fs-remove';
import { getStorageInfo, setDownloadsPath } from './services/storage';
import { canInstallNow, checkForUpdates, downloadUpdate, installUpdate, updateState } from './services/updater';
import {
  connect as gdriveConnect,
  disconnect as gdriveDisconnect,
  driveDeleteBackup,
  driveRestoreBackup,
  driveListBackups,
  driveStatus,
  driveUploadBackup,
} from './services/gdrive';

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
  servers_create: async (a, ctx) => {
    const input = normalizeCreateServerInput(a.input);
    const s = store(ctx);
    // OS-probed allocation: explicit ports are validated/unique/free; omitted ports pick 25565+.
    const port = await s.allocatePort(input.port);
    return enrich(ctx, s.createServer({ ...input, port }));
  },
  servers_delete: async (a, ctx) => {
    const id = String(a.id);
    const dto = store(ctx).getServer(id);
    if (!dto) throw appError('not-found', `Server ${id} not found.`);
    if (dto.status === 'running' || dto.status === 'starting' || dto.status === 'stopping') {
      throw appError('conflict', 'Stop the server before deleting it.');
    }
    const backups = store(ctx).listBackups(id);
    const serverDirectory = path.join(ctx.dataRoot, 'servers', id);

    // ORDER MATTERS, and this order is the fix for a real defect.
    //
    // The previous implementation deleted the store record FIRST and the folder second. On Windows removing a directory
    // fails while any process holds a file inside it (a JVM still shutting down, an antivirus scan), so the record was
    // already gone when the folder removal threw — the server vanished from the list while ~100 MB stayed on disk with
    // nothing able to reach it. That produced both the reported "ENOTEMPTY" toast and a fresh batch of invisible
    // `servers/<id>` folders, indistinguishable from the orphans that had to be adopted by hand.
    //
    // Removing the folder first inverts the failure: if it cannot be removed, the record is kept, the error is actionable,
    // and the user can simply press Delete again. Nothing is ever half-deleted.
    //
    // Async on purpose: the removal retries while a lock clears, and a blocking wait would freeze the window — the same
    // mistake that made installs hang. The awaits also let the process that holds the lock finish exiting, which is
    // exactly what the retry needs.
    const removal = await removeDirectory(serverDirectory);
    if (!removal.removed) throw appError('io', describeRemovalFailure(serverDirectory));

    // The folder is gone, so the record can be safely dropped. Everything below is cleanup that cannot fail the delete.
    store(ctx).deleteServer(id);
    for (const backup of backups) {
      try { fs.rmSync(backup.path, { force: true }); } catch { /* the backup file may be on a disconnected drive */ }
    }
    try { fs.rmSync(path.join(ctx.dataRoot, 'metrics', `${id}.json`), { force: true }); } catch { /* best effort */ }
  },
  servers_set_java_path: (a, ctx) => enrich(ctx, store(ctx).setJavaPath(String(a.id), (a.path as string | null) ?? null)),

  // ---- Phase 7: secrets (D11) + diagnostics (WP-7.4) ----
  curseforge_key_status: (_a, ctx) => curseForgeKeyStatus(ctx.dataRoot),
  curseforge_key_set: (a, ctx) => {
    const result = setCurseForgeKey(ctx.dataRoot, String(a.key ?? ''));
    resetCurseForgeKeyCache();
    return result;
  },
  curseforge_key_clear: (_a, ctx) => {
    const result = clearCurseForgeKey(ctx.dataRoot);
    resetCurseForgeKeyCache();
    return result;
  },
  diagnostics_bundle: async (_a, ctx) => createSupportBundle({
    dataRoot: ctx.dataRoot,
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      node: process.version,
      chrome: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
    },
  }),
  diagnostics_recent: (a) => recentDiagnostics(Number(a.limit ?? 200)),

  // ---- Phase 8: user-selectable download location (Settings → Downloads & storage) ----
  storage_get: (_a, ctx) => getStorageInfo(ctx.dataRoot),
  storage_set: (a, ctx) => setDownloadsPath(ctx.dataRoot, a.path ?? null),
  storage_pick_folder: async (_a, ctx) => {
    const info = getStorageInfo(ctx.dataRoot);
    const result = await dialog.showOpenDialog({
      defaultPath: info.effectiveDownloadsPath,
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose the download folder',
    });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  },
  storage_open_folder: async (a, ctx) => {
    const info = getStorageInfo(ctx.dataRoot);
    const folder = String(a.target ?? 'downloads') === 'data' ? info.dataRoot : info.effectiveDownloadsPath;
    fs.mkdirSync(folder, { recursive: true });
    const failure = await shell.openPath(folder);
    if (failure !== '') throw appError('io', `Could not open "${folder}": ${failure}`);
    return true;
  },

  // ---- auto-update ----
  // Read-only status first: the renderer polls this after any action instead of inferring state from events alone,
  // because an event emitted before the renderer subscribed would otherwise leave the UI stale.
  update_state: () => updateState(),
  update_check: async () => checkForUpdates(),
  update_download: async () => downloadUpdate(),
  // Installing restarts the app and kills child processes, so the handler re-derives the running-server count from the
  // store rather than trusting a number the renderer passed in.
  update_install: async (_a, ctx) => {
    const running = store(ctx).listServers().filter((s) => s.status === 'running' || s.status === 'starting').length;
    const allowed = canInstallNow(running);
    if (!allowed.ok) throw appError('validation', allowed.reason ?? 'Update cannot be installed right now.');
    if (!installUpdate(running)) throw appError('internal', 'The updater refused to install.');
    return true;
  },

  // ---- Google Drive backup ----
  // The renderer never receives tokens: every command returns either a summary or a file list.
  gdrive_status: (_a, ctx) => driveStatus(ctx.dataRoot),
  gdrive_connect: async (_a, ctx) => {
    const result = await gdriveConnect(ctx.dataRoot);
    if (!result.ok) throw appError('validation', result.error ?? 'Could not connect to Google Drive.');
    return driveStatus(ctx.dataRoot);
  },
  gdrive_disconnect: (_a, ctx) => { gdriveDisconnect(ctx.dataRoot); return driveStatus(ctx.dataRoot); },
  gdrive_list_backups: (a, ctx) => {
    const serverId = String(a.serverId ?? '');
    const server = serverId === '' ? null : store(ctx).getServer(serverId);
    // Both id and name are passed: the id separates two live servers, the name is what keeps a recreated server's old
    // backups reachable (its new record has a different UUID but the same name).
    return driveListBackups(ctx.dataRoot, serverId, server?.name ?? '');
  },
  /**
   * Backups whose owning server no longer exists.
   *
   * Shown separately in the UI rather than mixed into a server's list, because they cannot be restored into a server
   * that is gone — the user has to pick a destination.
   *
   * `serverName` scopes the query to what this panel can act on. Without it every server's panel showed the same global
   * list, which was reported as "why does every server have this?" — the answer was that the list ignored the server
   * entirely. A backup is only orphaned relative to a server if it does not belong to that server by id AND does not
   * carry that server's name. The name half matters: when a server is deleted and recreated, its old backups keep the
   * old UUID but the same name, so they are NOT orphans as far as the new server is concerned and must not be offered
   * as unrecoverable.
   */
  gdrive_orphaned_backups: async (a, ctx) => {
    const servers = store(ctx).listServers();
    const live = servers.map((server) => server.id);
    const requestedName = String(a.serverName ?? '').trim().toLowerCase();
    const auth = await driveListBackups(ctx.dataRoot, '', '');
    if (!auth.ok) throw appError('validation', auth.error ?? 'Google Drive is not available.');
    const liveSet = new Set(live);
    const liveNames = new Set(servers.map((server) => server.name.trim().toLowerCase()));

    const orphans = (auth.files ?? []).filter((file) => {
      const ownedByLiveId = file.serverId !== undefined && file.serverId !== '' && liveSet.has(file.serverId);
      if (ownedByLiveId) return false;
      // A backup carrying the name of a server that exists is recoverable into it, so it is not an orphan for that panel.
      const name = (file.serverName ?? '').trim().toLowerCase();
      if (name !== '' && liveNames.has(name)) {
        // Only exclude it from the panel that owns that name; other panels may still legitimately see it.
        if (requestedName === '' || requestedName === name) return false;
      }
      // A file with no recorded server id cannot be attributed, so it is treated as recoverable rather than hidden.
      if (file.serverId === undefined || file.serverId === '') return true;
      return !liveSet.has(file.serverId);
    });
    return { ok: true, files: orphans };
  },
  gdrive_upload_backup: async (a, ctx) => {
    // The backup id alone is not enough to find it: listBackups is per-server, so the caller supplies the server and
    // the lookup stays exact rather than scanning every server's backups.
    const serverId = String(a.serverId ?? '');
    const backup = store(ctx).listBackups(serverId).find((b) => b.id === String(a.backupId));
    if (backup === undefined) throw appError('validation', `No backup with id ${String(a.backupId)} on server ${serverId}.`);
    const server = store(ctx).getServer(backup.serverId);
    const result = await driveUploadBackup({
      dataRoot: ctx.dataRoot,
      serverId: backup.serverId,
      serverName: server?.name ?? 'server',
      backupName: backup.name,
      backupId: backup.id,
      filePath: backup.path,
    });
    if (!result.ok) throw appError(result.needsReauth ? 'validation' : 'io', result.error ?? 'Upload failed.');
    return result.file ?? null;
  },
  gdrive_delete_backup: async (a, ctx) => {
    const result = await driveDeleteBackup(ctx.dataRoot, String(a.fileId));
    if (!result.ok) throw appError('io', result.error ?? 'Delete failed.');
    return true;
  },
  /**
   * Restore from a Drive copy, for when the local ZIP is gone.
   *
   * The download is written into the same directory local backups live in, registered as a normal backup record, and
   * then handed to the existing restore routine. That reuse is deliberate: it keeps the pre-restore safety snapshot, the
   * live-server refusal and the in-place/reset handling identical for both sources, so a remote restore cannot behave
   * subtly differently from a local one.
   */
  gdrive_restore_backup: async (a, ctx) => {
    const fileId = String(a.fileId ?? '');
    const serverId = String(a.serverId ?? '');
    if (fileId === '') throw appError('validation', 'A Drive file id is required.');
    if (serverId === '') throw appError('validation', 'A server id is required.');

    // Verify the file belongs to this server before downloading anything: a stale or crafted id must not be able to pull
    // a different world's archive over this one.
    //
    // The server NAME must be passed too. Listing matches on id OR name, because a server that was deleted and recreated
    // keeps its name but gets a new UUID — and its old backups stay reachable through the name. Omitting it here made the
    // lookup id-only, so restoring a backup into a recreated server failed with "not in this server's Drive folder" even
    // though the file was listed on screen a moment earlier.
    const ownerName = store(ctx).getServer(serverId)?.name ?? '';
    const listing = await driveListBackups(ctx.dataRoot, serverId, ownerName);
    if (!listing.ok) throw appError('validation', listing.error ?? 'Google Drive is not available.');
    const remote = (listing.files ?? []).find((file) => file.id === fileId);
    if (remote === undefined) {
      throw appError('not-found', 'That backup is not in this server\'s Drive folder.');
    }

    const backupDir = path.join(ctx.dataRoot, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    // Derive a local name from the remote one, stripping the "server__" prefix so the result looks like a normal local
    // backup. A timestamp keeps two same-named Drive copies from overwriting each other on disk.
    const base = (remote.name.replace(/^.*__/, '') || 'backup').replace(/[\\/:*?"<>|]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${base.replace(/\.zip$/, '')}-from-drive-${stamp}.zip`;

    const downloaded = await driveRestoreBackup({
      dataRoot: ctx.dataRoot,
      fileId,
      downloadDir: backupDir,
      fileName,
    });
    if (!downloaded.ok || downloaded.path === undefined) {
      throw appError(downloaded.needsReauth ? 'validation' : 'io', downloaded.error ?? 'Download failed.');
    }

    // Register it as a normal backup so the user sees it locally afterwards and retention can clean it up later.
    // The handler stops here rather than restoring: the restore lives in the backups service (backup_restore), and
    // chaining into it from here would need that service instance inside this module. Returning the record id lets the
    // renderer call the ordinary restore path, so there is exactly one implementation of "restore".
    return store(ctx).addBackup({
      id: `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      serverId,
      name: fileName.replace(/\.zip$/, ''),
      path: downloaded.path,
      bytes: fs.statSync(downloaded.path).size,
      kind: 'Manual',
      note: 'Downloaded from Google Drive',
      createdAt: new Date().toISOString(),
    });
  },
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

/** Where a renderer frame is allowed to come from. Injected in tests; see {@link trustedIpcPolicy}. */
export interface IpcTrustPolicy {
  /** Application root (`app.getAppPath()`); the packaged/preview `dist/index.html` lives beneath it. */
  appPath: string;
  /** `VITE_DEV_SERVER_URL` (dev mode); frames on the same origin are trusted. */
  devUrl?: string | null;
  /** Non-packaged builds allow gate pages loaded from a throwaway temp root (`--ipctest`). */
  allowTempRoots?: boolean;
  /** Temp root to allow when `allowTempRoots` is set; defaults to `os.tmpdir()`. */
  tempRoot?: string;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `candidate` is `root` itself or lies underneath it (no `..` escape). */
function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Pure sender-origin decision (exported for unit tests):
 * - the Vite dev-server origin when dev mode is configured;
 * - `file:` URLs inside the application root (renderer bundle);
 * - `file:` URLs under the temp root for non-packaged gate harnesses.
 * Anything else (http(s)://, other file paths, data:, empty/malformed URLs) is rejected.
 */
export function isTrustedIpcUrl(rawUrl: string, policy: IpcTrustPolicy): boolean {
  if (typeof rawUrl !== 'string' || rawUrl === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const devUrl = typeof policy.devUrl === 'string' ? policy.devUrl.trim() : '';
  if (devUrl !== '') {
    try {
      if (parsed.origin === new URL(devUrl).origin) return true;
    } catch {
      // Misconfigured dev URL must never open the gate.
    }
  }

  if (parsed.protocol !== 'file:') return false;
  let filePath: string;
  try {
    filePath = fileURLToPath(parsed);
  } catch {
    return false;
  }
  if (typeof policy.appPath === 'string' && policy.appPath !== '' && isPathInside(filePath, policy.appPath)) {
    return true;
  }
  if (policy.allowTempRoots) {
    const tempRoot = policy.tempRoot ?? os.tmpdir();
    if (isPathInside(filePath, tempRoot)) return true;
  }
  return false;
}

/** Policy for the running app. Computed once per `registerIpc()` call. */
export function trustedIpcPolicy(): IpcTrustPolicy {
  let appPath = '';
  try { appPath = app.getAppPath(); } catch { appPath = process.cwd(); }
  let allowTempRoots = true;
  try { allowTempRoots = !app.isPackaged; } catch { allowTempRoots = true; }
  return {
    appPath,
    devUrl: process.env.VITE_DEV_SERVER_URL ?? null,
    allowTempRoots,
    tempRoot: os.tmpdir(),
  };
}

/** Reject frames whose URL cannot be read (destroyed/absent) — fail closed. */
function isTrustedSender(event: unknown, policy: IpcTrustPolicy): boolean {
  try {
    const frame = (event as { senderFrame?: { url?: string } | null }).senderFrame;
    if (!frame || typeof frame.url !== 'string' || frame.url === '') return false;
    return isTrustedIpcUrl(frame.url, policy);
  } catch {
    return false;
  }
}

/**
 * Bind the command map to ipcMain. Call ONCE, after every runtime handler was merged with
 * registerRuntimeHandlers(); this function snapshots the map, so a later merge is invisible to IPC.
 *
 * Results travel in an envelope ({__ipc:true, ok, value|error}) instead of a thrown Error.
 * Electron prefixes thrown IPC errors with `Error invoking remote method ...`, which would break
 * the renderer's JSON {code,message} contract; the preload unwraps this envelope.
 *
 * Sender hardening (WP-2.3): command invocations from any frame outside the app's own renderer get
 * `{ok:false, error:{code:'forbidden'}}`; direct handler-map calls (unit/service/contract gates) do
 * not go through ipcMain and are unaffected.
 */
export function registerIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  if (ipcRegistered) throw new Error('registerIpc called twice');
  ipcRegistered = true;
  const policy = trustedIpcPolicy();

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('cmd:' + name, async (event, args: Record<string, unknown> = {}) => {
      if (!isTrustedSender(event, policy)) {
        // eslint-disable-next-line no-console
        console.warn(`[ipc] blocked command "${name}" from an untrusted sender frame.`);
        return {
          __ipc: true,
          ok: false,
          error: { code: 'forbidden', message: 'Blocked an IPC command from an untrusted sender.' },
        };
      }
      try {
        // WP-7.1: light per-command argument validation at the IPC boundary only. Direct
        // handlersMap callers (service/contract/selftest gates) keep their existing behavior.
        validateCommandArgs(name, args);
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

/** Direct handler invocation for the automated gate (no window needed). Booleans only — never
 *  "a string exists" — so a broken assertion cannot pass (B-25). */
export async function runSelfTest(ctx: IpcContext): Promise<boolean> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => { checks.push({ name, ok, detail }); };
  const must = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try { await fn(); check(name, true); }
    catch (error) { check(name, false, error instanceof Error ? error.message : String(error)); }
  };

  await must('ping', async () => { if ((await handlers.ping({}, ctx)) !== 'pong') throw new Error('pong expected'); });
  await must('runtime-handlers-registered', async () => {
    for (const name of ['versions_vanilla', 'server_start', 'server_settings_get', 'backups_list', 'worlds_list', 'players_list', 'metrics_get', 'content_list']) {
      if (typeof handlers[name] !== 'function') throw new Error(`handler ${name} missing`);
    }
  });
  await must('create-list-get-delete', async () => {
    const created = await handlers.servers_create({
      input: { name: 'selftest-' + Date.now(), loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 },
    }, ctx) as { id: string; name: string };
    if (typeof created.id !== 'string' || created.id.length === 0) throw new Error('no id');
    const list = await handlers.servers_list({}, ctx) as unknown[];
    if (list.length < 1) throw new Error('list empty');
    const updated = await handlers.servers_set_java_path({ id: created.id, path: 'C:/j/java.exe' }, ctx) as { javaPath: string };
    if (updated.javaPath !== 'C:/j/java.exe') throw new Error('javaPath not persisted');
    const got = await handlers.server_get({ id: created.id }, ctx) as { id: string } | null;
    if (got?.id !== created.id) throw new Error('server_get mismatch');
    await handlers.servers_delete({ id: created.id }, ctx);
    const after = await handlers.servers_list({}, ctx) as { id: string }[];
    if (after.some((entry) => entry.id === created.id)) throw new Error('delete left record');
  });
  await must('error-code', async () => {
    try {
      await handlers.servers_delete({ id: 'missing' }, ctx);
      throw new Error('delete of a missing server must reject');
    } catch (error) {
      if ((error as { code?: string }).code !== 'not-found') throw new Error('wrong error code');
    }
  });
  await must('port-check', async () => {
    const result = await handlers.port_check({ port: 25565 }, ctx) as { available?: unknown };
    if (typeof result.available !== 'boolean') throw new Error('port_check shape');
  });

  for (const entry of checks) {
    // eslint-disable-next-line no-console
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  }
  return checks.length > 0 && checks.every((entry) => entry.ok);
}
