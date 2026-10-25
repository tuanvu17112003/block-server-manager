// Electron main — window + lifecycle + IPC wiring (port of src-tauri shell, see docs/electron-port-plan.md).
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { registerIpc, registerRuntimeHandlers, runSelfTest, type IpcContext } from './ipc';
import { buildRuntime } from './services/runtime';
import { dataRoot } from './services/paths';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: 'Block Server Manager',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

app.whenReady().then(async () => {
  const ctx: IpcContext = { dataRoot: dataRoot(), send: broadcast, getWindow: () => mainWindow };
  registerIpc(ipcMain, ctx);

  if (process.argv.includes('--selftest')) {
    const ok = await runSelfTest(ctx);
    // eslint-disable-next-line no-console
    console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL');
    app.exit(ok ? 0 : 1);
    return;
  }

  const runtime = buildRuntime().register(ctx);
  registerRuntimeHandlers(runtime.handlers);
  app.on('before-quit', () => { void runtime.processes.stopAll(); });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
