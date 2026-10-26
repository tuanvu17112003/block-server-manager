// CurseForge staging — embedded browser (route C, D-16): sandboxed window, own session,
// will-download captures archives into <dataRoot>/curseforge-import with `curseforge://download` updates.
import { BrowserWindow, shell, dialog, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext, Handler } from '../ipc';
import { inspectStagedZip, inspectCurseForgeProject } from './installer/curseforge';

interface ActiveDownload { id: string; name: string; cancel: () => void }

export class CurseForgeStaging {
  private win: BrowserWindow | null = null;
  private downloads = new Map<string, ActiveDownload>();

  constructor(private ctx: IpcContext) {}

  private stagingDir(): string { return path.join(this.ctx.dataRoot, 'curseforge-import'); }

  openBrowser(): boolean {
    if (this.win && !this.win.isDestroyed()) { this.win.focus(); return true; }
    fs.mkdirSync(this.stagingDir(), { recursive: true });
    this.win = new BrowserWindow({
      width: 1200, height: 800, title: 'CurseForge — download a server pack',
      parent: this.ctx.getWindow() ?? undefined,
      webPreferences: { session: session.fromPartition('persist:curseforge'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const sess = this.win.webContents.session;
    sess.on('will-download', (_event, item) => {
      const id = path.basename(item.getFilename()) + '-' + Date.now();
      const dest = path.join(this.stagingDir(), item.getFilename());
      item.setSavePath(dest);
      this.downloads.set(id, { id, name: item.getFilename(), cancel: () => item.cancel() });
      const send = (status: string, message: string): void =>
        this.ctx.send('curseforge://download', { id, name: item.getFilename(), status, bytesReceived: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), message });
      send('downloading', 'Downloading into managed staging.');
      item.on('updated', (_e, state) => send(state === 'interrupted' ? 'failed' : 'downloading', state));
      item.once('done', (_e, state) => {
        this.downloads.delete(id);
        send(state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed', state);
      });
    });
    this.win.on('closed', () => { this.win = null; });
    void this.win.loadURL('https://www.curseforge.com/minecraft/search?class=modpacks');
    return true;
  }

  async openExternal(): Promise<void> {
    await shell.openExternal('https://www.curseforge.com/minecraft/search?class=modpacks');
  }

  listZips(): { name: string; size: number; modifiedAt: number | null }[] {
    try {
      return fs.readdirSync(this.stagingDir())
        .filter(f => /\.zip$/i.test(f))
        .map(f => { const st = fs.statSync(path.join(this.stagingDir(), f)); return { name: f, size: st.size, modifiedAt: st.mtimeMs }; })
        .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    } catch { return []; }
  }

  async pickZip(): Promise<{ name: string; size: number; modifiedAt: number | null } | null> {
    const r = await dialog.showOpenDialog(this.win ?? this.ctx.getWindow() ?? undefined!, { properties: ['openFile'], filters: [{ name: 'CurseForge server pack', extensions: ['zip'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    fs.mkdirSync(this.stagingDir(), { recursive: true });
    const dest = path.join(this.stagingDir(), path.basename(r.filePaths[0]));
    fs.copyFileSync(r.filePaths[0], dest);
    const st = fs.statSync(dest);
    return { name: path.basename(dest), size: st.size, modifiedAt: st.mtimeMs };
  }

  cancelDownload(transferId: string): boolean {
    const d = this.downloads.get(transferId);
    if (!d) return false;
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
        const name = String(a.name);
        const p = path.join(this.stagingDir(), name);
        if (!fs.existsSync(p)) throw Object.assign(new Error(`Staged ZIP "${name}" not found.`), { code: 'not-found' });
        return inspectStagedZip(p);
      },
      curseforge_cancel_download: a => this.cancelDownload(String(a.transferId ?? a.id ?? '')),
      curseforge_inspect_project: a => inspectCurseForgeProject(String(a.project), this.ctx.dataRoot),
    };
  }
}
