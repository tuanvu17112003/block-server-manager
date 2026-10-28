// Electron main — window + lifecycle + IPC wiring (port of the archived Tauri shell, see docs/electron-port-plan.md).
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { registerIpc, registerRuntimeHandlers, runSelfTest, type IpcContext } from './ipc';
import { buildRuntime } from './services/runtime';
import { dataRoot } from './services/paths';
import { detectLegacy, planImport, runImport } from './services/legacy-import';
import { initDiagnostics, installProcessHandlers, getDiagnostics, recordTimeline } from './services/diagnostics';

let mainWindow: BrowserWindow | null = null;

/** Gate modes run headless against throwaway data roots; they must never share a profile or lock. */
const TEST_FLAGS = [
  '--selftest', '--mgmttest', '--ipctest', '--e2e',
  '--servicestest', '--contracttest', '--uitest', '--lifetest',
  '--soak', '--quitsmoke',
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

/** True for the app's own renderer documents (Vite dev URL or the built `dist/` folder). */
function isAppDocumentUrl(url: string): boolean {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl && url.startsWith(devUrl)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    const filePath = decodeURIComponent(parsed.pathname).replace(/^\/([A-Za-z]:)/, '$1');
    const distDir = path.resolve(__dirname, '..', 'dist');
    const resolved = path.resolve(filePath);
    return resolved === distDir || resolved.startsWith(distDir + path.sep);
  } catch {
    return false;
  }
}

/**
 * WP-7.3 renderer/session hardening shared by the production window and hidden test windows:
 * - popups are denied; http(s) links open in the OS browser instead of a privileged window;
 * - navigation is restricted to the app's own document (dev URL/file dist), external navigation is
 *   denied and only handed to the OS browser;
 * - `webview` attachment and every permission request are denied;
 * - DevTools are closed again in packaged builds.
 */
function hardenWebContents(win: BrowserWindow): void {
  const { webContents } = win;
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isAppDocumentUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
  });
  webContents.on('will-attach-webview', (event) => { event.preventDefault(); });
  webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (app.isPackaged) {
    webContents.on('devtools-opened', () => { try { webContents.closeDevTools(); } catch { /* ignore */ } });
  }
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
      devTools: !app.isPackaged,
    },
  });
  hardenWebContents(mainWindow);
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

/**
 * Production quit policy (D7): preventDefault, stop servers within a bounded budget (then tree-kill
 * survivors), and quit again. Shared by the normal lifecycle and the --quitsmoke live proof so both
 * exercise identical shutdown semantics.
 */
function installBoundedQuit(appRuntime: { shutdown: (budgetMs?: number) => Promise<unknown> }): void {
  let quitStarted = false;
  app.on('before-quit', (event) => {
    if (quitStarted) return; // second app.quit() below lets the quit proceed
    event.preventDefault();
    quitStarted = true;
    recordTimeline({ kind: 'app', action: 'quit' });
    getDiagnostics()?.logger.info('shutdown requested');
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      app.quit();
    };
    const hardTimer = setTimeout(finish, 8000);
    hardTimer.unref?.();
    void appRuntime.shutdown(5000)
      .catch(() => undefined)
      .finally(() => { clearTimeout(hardTimer); finish(); });
  });
}

const hasSingleInstanceLock = testFlag ? true : app.requestSingleInstanceLock();

/**
 * One-shot Tauri → Electron data import (D1). Auto-imports only into an empty store; when the
 * target already has servers a plan is written next to the data file for the UI to confirm later.
 * Never throws: a failed import must not block app startup.
 */
async function runLegacyStartupMigration(ctx: IpcContext): Promise<void> {
  try {
    const legacy = detectLegacy();
    if (!legacy) return;
    const plan = planImport({ dataRoot: ctx.dataRoot });
    if (!plan.ok) {
      console.warn(`[legacy-import] plan failed: ${plan.errors.join('; ')}`);
      return;
    }
    if (plan.alreadyImported) {
      console.log('[legacy-import] already imported; marker present.');
      return;
    }
    const importable = plan.counts.servers ?? 0;
    if (importable === 0) return;
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, 'app-data.json'), 'utf8')) as { servers?: unknown[] };
      if (Array.isArray(existing.servers) && existing.servers.length > 0) {
        fs.writeFileSync(path.join(ctx.dataRoot, 'legacy-import-plan.json'), JSON.stringify(plan, null, 2));
        console.log(`[legacy-import] legacy data found (${importable} servers) but target is not empty; plan written for confirmation.`);
        return;
      }
    } catch {
      // No existing store: safe to auto-import into the empty target.
    }
    const report = await runImport({ dataRoot: ctx.dataRoot });
    console.log(`[legacy-import] ${report.status}: imported ${JSON.stringify(report.imported)}`);
  } catch (error) {
    console.warn(`[legacy-import] skipped: ${(error as Error).message}`);
  }
}

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

    if (process.argv.includes('--soak')) {
      // Phase 8 soak: long-lived real server + churn, persistent evidence root under .app-data.
      const hours = Number(argValue('--soak-hours') ?? '24');
      const soakRoot = path.resolve(process.cwd(), '.app-data', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      const { runSoak } = await import('./test/soak-runner');
      const summary = await runSoak({
        dataRoot: soakRoot,
        hours: Number.isFinite(hours) && hours > 0 ? hours : 24,
        appMetrics: () => app.getAppMetrics().map((metric) => ({
          type: metric.type, pid: metric.pid, workingSetSize: metric.memory.workingSetSize,
        })),
      });
      // eslint-disable-next-line no-console
      console.log(`SOAK ${summary.ok ? 'PASS' : 'FAIL'} cycles=${summary.cycles} final=${summary.finalStatus} errors=${summary.errors.length} evidence=${summary.evidencePath}`);
      if (!summary.ok) for (const error of summary.errors.slice(0, 5)) console.log(`SOAK ERROR: ${error}`);
      app.exit(summary.ok ? 0 : 1);
      return;
    }

    if (process.argv.includes('--quitsmoke')) {
      // Phase 8 WP-8.1: start a real server, then exercise the production quit path and prove the
      // JVM tree stops (the external wrapper checks for surviving identity markers). Uses its own
      // data root so it never collides with a concurrently running soak/e2e instance.
      const quitRoot = path.resolve(process.cwd(), '.app-data', `quitsmoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      const quitCtx: IpcContext = { ...ctx, dataRoot: quitRoot };
      const { appRuntime } = wireIpc(quitCtx);
      const { prepareQuitSmoke } = await import('./test/quitsmoke-runner');
      const prepared = await prepareQuitSmoke(quitCtx);
      // eslint-disable-next-line no-console
      console.log(`QUITSMOKE-READY serverId=${prepared.serverId ?? ''} ok=${prepared.ok} detail=${prepared.detail}`);
      if (!prepared.ok) {
        try { await appRuntime.shutdown(5000); } catch { /* best effort */ }
        app.exit(1);
        return;
      }
      installBoundedQuit(appRuntime);
      const quitFinished = await new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (value: boolean): void => { if (!done) { done = true; resolve(value); } };
        app.once('will-quit', () => finish(true));
        setTimeout(() => finish(false), 20_000).unref?.();
        app.quit();
      });
      // eslint-disable-next-line no-console
      console.log(quitFinished ? 'QUITSMOKE PASS' : 'QUITSMOKE FAIL (quit did not complete in 20s)');
      app.exit(quitFinished ? 0 : 1);
      return;
    }

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
      hardenWebContents(win);
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

    if (process.argv.includes('--lifetest')) {
      const root = createTempRoot('msm-life');
      try {
        const { runLifecycleTests } = await import('./test/lifecycle-runner');
        const result = await runLifecycleTests(root);
        // eslint-disable-next-line no-console
        console.log(result.report);
        // eslint-disable-next-line no-console
        console.log(result.ok ? 'LIFETEST PASS' : 'LIFETEST FAIL');
        app.exit(result.ok ? 0 : 1);
      } finally {
        try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* temp root */ }
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
      hardenWebContents(win);
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
    // Diagnostics are production-only: gate runs use throwaway roots and must not leave log files.
    const diagnostics = initDiagnostics({
      dataRoot: ctx.dataRoot,
      mirror: !app.isPackaged ? (line: string) => { /* eslint-disable-next-line no-console */ console.log(line); } : false,
    });
    diagnostics.logger.info('app starting', { version: app.getVersion(), dataRoot: ctx.dataRoot });
    installProcessHandlers(diagnostics.logger, {
      onFatal: (error: unknown) => {
        try {
          dialog.showErrorBox('Unexpected error', error instanceof Error ? (error.stack ?? error.message) : String(error));
        } catch { /* headless */ }
      },
    });
    recordTimeline({ kind: 'app', action: 'start', detail: { version: app.getVersion() } });
    await runtime.processes.reapOrphans();
    await runLegacyStartupMigration(ctx);
    recordTimeline({ kind: 'app', action: 'legacy-import-check' });
    // Quit must be synchronous-safe: Electron continues quitting immediately after this event, so
    // we preventDefault, stop servers with a bounded budget (then tree-kill survivors), and quit.
    installBoundedQuit(appRuntime);

    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    try { getDiagnostics()?.logger.error('startup failed', error); } catch { /* diagnostics optional */ }
    try { dialog.showErrorBox('Startup failed', message); } catch { /* headless */ }
    // eslint-disable-next-line no-console
    console.error(message);
    app.exit(1);
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
