// CurseForge staging — embedded browser (route C, D-16): sandboxed window, own session,
// will-download captures archives into <dataRoot>/curseforge-import with `curseforge://download` updates.
//
// WP-4.7 hardening: one `will-download` listener per window (detached on close), navigation/window-open
// allowlist (curseforge.com + forgecdn.net only), `.part` download staging + atomic rename on
// completion, list/inspect only complete basenames inside staging, and starting/canceling events.
import { BrowserWindow, shell, dialog, session, type DownloadItem, type Event as ElectronEvent, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext, Handler } from '../ipc';
import { inspectStagedZip, inspectCurseForgeProject } from './installer/curseforge';

interface ActiveDownload { id: string; name: string; cancel: () => void }

const STAGING_START_URL = 'https://www.curseforge.com/minecraft/search?class=modpacks';
const ALLOWED_STAGING_HOSTS: readonly RegExp[] = [/(^|\.)curseforge\.com$/i, /(^|\.)forgecdn\.net$/i];

/** True for HTTPS URLs on CurseForge/ForgeCDN hosts (browser navigation + window-open allowlist). */
export function isAllowedStagingUrl(raw: string): boolean {
  try {
    const parsed = new URL(String(raw ?? ''));
    return parsed.protocol === 'https:' && ALLOWED_STAGING_HOSTS.some((pattern) => pattern.test(parsed.hostname));
  } catch { return false; }
}

/** Basename-only validation for staged archives (no separators, no traversal, `.zip` only). */
export function safeStagedZipName(name: string): string | null {
  const raw = String(name ?? '');
  const base = path.basename(raw);
  if (!base || base !== raw || base === '.' || base === '..' || /[\\/]/.test(base)) return null;
  if (!/\.zip$/i.test(base)) return null;
  return base;
}

export class CurseForgeStaging {
  private win: BrowserWindow | null = null;
  private downloads = new Map<string, ActiveDownload>();
  private session: Session | null = null;
  private downloadHandler: ((event: ElectronEvent, item: DownloadItem) => void) | null = null;

  constructor(private ctx: IpcContext) {}

  private stagingDir(): string { return path.join(this.ctx.dataRoot, 'curseforge-import'); }

  /** Unique final archive name in staging (`name.zip`, `name-2.zip`, ...). */
  private uniqueStagedName(fileName: string): string {
    fs.mkdirSync(this.stagingDir(), { recursive: true });
    const safe = path.basename(fileName) || `curseforge-${Date.now()}.zip`;
    const ext = path.extname(safe) || '.zip';
    const stem = path.basename(safe, ext);
    let candidate = safe;
    for (let index = 2; fs.existsSync(path.join(this.stagingDir(), candidate)); index += 1) candidate = `${stem}-${index}${ext}`;
    return candidate;
  }

  /** Resolve a staged ZIP by basename only, refusing traversal/absolute paths and missing files. */
  private stagedZipPath(name: string): string {
    const base = safeStagedZipName(name);
    if (!base) throw Object.assign(new Error(`Invalid staged ZIP name "${String(name ?? '')}".`), { code: 'validation' });
    const dir = path.resolve(this.stagingDir());
    const resolved = path.resolve(dir, base);
    if (!resolved.startsWith(dir + path.sep)) throw Object.assign(new Error(`Staged ZIP escapes the staging directory.`), { code: 'validation' });
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw Object.assign(new Error(`Staged ZIP "${base}" not found.`), { code: 'not-found' });
    return resolved;
  }

  private detachDownloadHandler(): void {
    if (this.session && this.downloadHandler) {
      try { this.session.removeListener('will-download', this.downloadHandler); } catch { /* session gone */ }
    }
    this.downloadHandler = null;
    this.session = null;
  }

  private attachDownloadHandler(sess: Session): void {
    this.detachDownloadHandler(); // keep exactly one listener even if the window is reopened
    const handler = (_event: ElectronEvent, item: DownloadItem): void => {
      const sourceUrl = item.getURL();
      if (!isAllowedStagingUrl(sourceUrl)) {
        item.cancel();
        this.ctx.send('curseforge://download', {
          id: `blocked-${Date.now()}`, name: item.getFilename(), status: 'failed', bytesReceived: 0, totalBytes: 0,
          message: `Download blocked (host not allowlisted): ${sourceUrl}`,
        });
        return;
      }
      const id = `${path.basename(item.getFilename())}-${Date.now()}`;
      const finalName = this.uniqueStagedName(item.getFilename());
      const finalPath = path.join(this.stagingDir(), finalName);
      const partPath = `${finalPath}.part`;
      item.setSavePath(partPath);
      this.downloads.set(id, { id, name: finalName, cancel: () => item.cancel() });
      const send = (status: string, message: string): void =>
        this.ctx.send('curseforge://download', { id, name: finalName, status, bytesReceived: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), message });
      send('starting', 'Download starting into managed staging.');
      item.on('updated', (_e, state) => send(state === 'interrupted' ? 'failed' : 'downloading', state));
      item.once('done', (_e, state) => {
        this.downloads.delete(id);
        if (state === 'completed') {
          try {
            fs.renameSync(partPath, finalPath);
            send('completed', 'Download completed.');
          } catch (error) {
            try { fs.rmSync(partPath, { force: true }); } catch { /* best effort */ }
            send('failed', `Could not finalize download: ${(error as Error).message}`);
          }
          return;
        }
        try { fs.rmSync(partPath, { force: true }); } catch { /* best effort */ }
        send(state === 'cancelled' ? 'cancelled' : 'failed', state);
      });
    };
    this.session = sess;
    this.downloadHandler = handler;
    sess.on('will-download', handler);
  }

  openBrowser(): boolean {
    if (this.win && !this.win.isDestroyed()) { this.win.focus(); return true; }
    fs.mkdirSync(this.stagingDir(), { recursive: true });
    this.win = new BrowserWindow({
      width: 1200, height: 800, title: 'CurseForge — download a server pack',
      parent: this.ctx.getWindow() ?? undefined,
      webPreferences: { session: session.fromPartition('persist:curseforge'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const contents = this.win.webContents;
    this.attachDownloadHandler(contents.session);
    // Navigation + popup allowlist: only CurseForge/ForgeCDN HTTPS pages may load.
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedStagingUrl(url)) {
        event.preventDefault();
        this.ctx.send('curseforge://download', { id: 'navigation-blocked', name: url, status: 'failed', message: 'Navigation blocked (host not allowlisted).' });
      }
    });
    contents.setWindowOpenHandler(({ url }) => (isAllowedStagingUrl(url) ? { action: 'allow' } : { action: 'deny' }));
    this.win.on('closed', () => {
      this.detachDownloadHandler();
      this.win = null;
    });
    void this.win.loadURL(STAGING_START_URL);
    return true;
  }

  async openExternal(): Promise<void> {
    await shell.openExternal(STAGING_START_URL);
  }

  listZips(): { name: string; size: number; modifiedAt: number | null }[] {
    try {
      return fs.readdirSync(this.stagingDir())
        .filter(f => /\.zip$/i.test(f) && !/\.part$/i.test(f))
        .map(f => {
          const full = path.join(this.stagingDir(), f);
          const st = fs.statSync(full);
          return { name: f, size: st.size, modifiedAt: st.mtimeMs, complete: st.isFile() && st.size > 0 };
        })
        .filter(entry => entry.complete)
        .map(({ complete: _complete, ...entry }) => entry)
        .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    } catch { return []; }
  }

  async pickZip(): Promise<{ name: string; size: number; modifiedAt: number | null } | null> {
    const r = await dialog.showOpenDialog(this.win ?? this.ctx.getWindow() ?? undefined!, { properties: ['openFile'], filters: [{ name: 'CurseForge server pack', extensions: ['zip'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    fs.mkdirSync(this.stagingDir(), { recursive: true });
    const name = this.uniqueStagedName(r.filePaths[0]);
    const dest = path.join(this.stagingDir(), name);
    const part = `${dest}.part`;
    fs.copyFileSync(r.filePaths[0], part);
    fs.renameSync(part, dest); // only complete files are visible to list/inspect
    const st = fs.statSync(dest);
    return { name, size: st.size, modifiedAt: st.mtimeMs };
  }

  cancelDownload(transferId: string): boolean {
    const d = this.downloads.get(transferId);
    if (!d) return false;
    // Surface the cancel request before Electron flips the item into `cancelled`.
    this.ctx.send('curseforge://download', { id: transferId, name: d.name, status: 'canceling', message: 'Cancelling download.' });
    d.cancel();
    return true;
  }

  handlers(): Record<string, Handler> {
    return {
      curseforge_open_browser: () => this.openBrowser(),
      curseforge_open_external_browser: () => this.openExternal(),
      curseforge_list_zips: () => this.listZips(),
      curseforge_pick_zip: () => this.pickZip(),
      curseforge_inspect_zip: async a => {
        const p = this.stagedZipPath(String(a.name ?? ''));
        return inspectStagedZip(p);
      },
      curseforge_cancel_download: a => this.cancelDownload(String(a.transferId ?? a.id ?? '')),
      curseforge_inspect_project: a => inspectCurseForgeProject(String(a.project), this.ctx.dataRoot),
    };
  }
}
