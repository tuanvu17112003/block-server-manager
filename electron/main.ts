// Electron main — window + lifecycle + IPC wiring (port of src-tauri shell, see docs/electron-port-plan.md).
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { registerIpc, registerRuntimeHandlers, runSelfTest, type IpcContext } from './ipc';
import { buildRuntime } from './services/runtime';
import { dataRoot } from './services/paths';

let mainWindow: BrowserWindow | null = null;

/** Gate modes run headless against throwaway data roots; they must never share a profile or lock. */
const TEST_FLAGS = [
  '--selftest', '--mgmttest', '--ipctest', '--e2e',
  '--servicestest', '--contracttest', '--uitest',
];
const testFlag = process.argv.find((arg) => TEST_FLAGS.includes(arg));

if (testFlag) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `msm-gate-${testFlag.slice(2)}-`));
  app.setPath('userData', profile);
}

function argValue(name: string): string | null {
  const arg = process.argv.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : null;
}

function createTempRoot(label = 'msm-gate-data'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

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

const hasSingleInstanceLock = testFlag ? true : app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // A second normal launch must not register handlers, start schedulers, or open a window.
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const ctx: IpcContext = { dataRoot: dataRoot(), send: broadcast, getWindow: () => mainWindow };

    if (process.argv.includes('--mgmttest')) {
      const root = createTempRoot('msm-mgmt');
      const { runMgmtTest } = await import('./mgmt-test');
      const ok = await runMgmtTest(root);
      app.exit(ok ? 0 : 1);
      return;
    }

    if (process.argv.includes('--selftest')) {
      const root = createTempRoot('msm-selftest');
      const testCtx: IpcContext = { ...ctx, dataRoot: root };
      const { appRuntime } = wireIpc(testCtx);
      let ok = false;
      try {
        ok = await runSelfTest(testCtx);
      } finally {
        try { await appRuntime.shutdown(); } catch { /* best effort */ }
        fs.rmSync(root, { recursive: true, force: true });
      }
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

    if (process.argv.includes('--servicestest') || process.argv.includes('--contracttest')) {
      const root = createTempRoot('msm-suites');
      const testCtx: IpcContext = { ...ctx, dataRoot: root };
      const appRuntime = buildRuntime();
      try {
        if (process.argv.includes('--servicestest')) {
          const { runServiceTests } = await import('./test/service-runner');
          const result = await runServiceTests(argValue('--filter') ?? undefined);
          // eslint-disable-next-line no-console
          console.log(result.report);
          // eslint-disable-next-line no-console
          console.log(result.ok ? 'SERVICETEST PASS' : 'SERVICETEST FAIL');
          app.exit(result.ok ? 0 : 1);
        } else {
          const { runContractTests } = await import('./test/contract-runner');
          const result = await runContractTests(testCtx, argValue('--filter') ?? undefined);
          // eslint-disable-next-line no-console
          console.log(result.report);
          // eslint-disable-next-line no-console
          console.log(result.ok ? 'CONTRACTTEST PASS' : 'CONTRACTTEST FAIL');
          app.exit(result.ok ? 0 : 1);
        }
      } finally {
        await appRuntime.shutdown().catch(() => undefined);
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }

    if (process.argv.includes('--uitest')) {
      const root = createTempRoot('msm-uitest');
      const testCtx: IpcContext = { ...ctx, dataRoot: root };
      let appRuntime: { shutdown: () => Promise<unknown> } | null = null;
      const win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 900,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      try {
        appRuntime = wireIpc(testCtx).appRuntime;
        const { runUiTests } = await import('./test/ui-runner');
        const artifacts = argValue('--artifacts') ?? path.join(os.tmpdir(), 'msm-ui-artifacts');
        const result = await runUiTests(testCtx, win, artifacts);
        // eslint-disable-next-line no-console
        console.log(result.report);
        // eslint-disable-next-line no-console
        console.log(result.ok ? 'UITEST PASS' : 'UITEST FAIL');
        app.exit(result.ok ? 0 : 1);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('UITEST CRASH', error);
        app.exit(1);
      } finally {
        try { win.destroy(); } catch { /* already gone */ }
        try { await appRuntime?.shutdown(); } catch { /* best effort */ }
        fs.rmSync(root, { recursive: true, force: true });
      }
      return;
    }

    if (process.argv.includes('--ipctest')) {
      const root = createTempRoot('msm-ipc');
      const testCtx: IpcContext = { ...ctx, dataRoot: root };
      let ok = false;
      let appRuntime: { shutdown: () => Promise<unknown> } | null = null;
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
        const wired = wireIpc(testCtx);
        appRuntime = wired.appRuntime;
        const { runIpcTest } = await import('./ipc-test');
        ok = await runIpcTest(testCtx, win);
      } finally {
        try { win.destroy(); } catch { /* already gone */ }
        try { await appRuntime?.shutdown(); } catch { /* best effort */ }
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
