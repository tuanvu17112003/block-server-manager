// Electron main — window + lifecycle + IPC wiring (port of src-tauri shell, see docs/electron-port-plan.md).
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { registerIpc, registerRuntimeHandlers, runSelfTest, type IpcContext } from './ipc';
import { buildRuntime } from './services/runtime';
import { dataRoot } from './services/paths';

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

/**
 * Production IPC wiring. Order is load-bearing: registerIpc() snapshots the handler map, so every
 * runtime handler must be merged first. Tests that call the map directly do not use this helper.
 */
function wireIpc(ctx: IpcContext) {
  const appRuntime = buildRuntime();
  const runtime = appRuntime.register(ctx);
  registerRuntimeHandlers(runtime.handlers);
  registerIpc(ipcMain, ctx);
  return { appRuntime, runtime };
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // A second launch must not register handlers, start schedulers, or open a window.
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const ctx: IpcContext = { dataRoot: dataRoot(), send: broadcast, getWindow: () => mainWindow };

    if (process.argv.includes('--mgmttest')) {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const { runMgmtTest } = await import('./mgmt-test');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-mgmt-'));
      const ok = await runMgmtTest(root);
      app.exit(ok ? 0 : 1);
      return;
    }

    if (process.argv.includes('--selftest')) {
      const ok = await runSelfTest(ctx);
      // eslint-disable-next-line no-console
      console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL');
      app.exit(ok ? 0 : 1);
      return;
    }

    if (process.argv.includes('--e2e')) {
      const { runE2E } = await import('./e2e');
      const ok = await runE2E(ctx);
      app.exit(ok ? 0 : 1);
      return;
    }

    if (process.argv.includes('--ipctest')) {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-ipc-'));
      const testCtx: IpcContext = { ...ctx, dataRoot: root };
      let ok = false;
      const { appRuntime } = wireIpc(testCtx);
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      try {
        const { runIpcTest } = await import('./ipc-test');
        ok = await runIpcTest(testCtx, win);
      } finally {
        win.destroy();
        await appRuntime.shutdown();
        for (const name of ['ipc-result.txt', 'ui-smoke.png']) {
          try { fs.copyFileSync(path.join(root, name), path.join(ctx.dataRoot, name)); } catch { /* not produced */ }
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
      app.exit(ok ? 0 : 1);
      return;
    }

    const { appRuntime, runtime } = wireIpc(ctx);
    await runtime.processes.reapOrphans();
    app.on('before-quit', () => { void appRuntime.shutdown(); });

    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    try { dialog.showErrorBox('Startup failed', message); } catch { /* headless */ }
    // eslint-disable-next-line no-console
    console.error(message);
    app.exit(1);
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
