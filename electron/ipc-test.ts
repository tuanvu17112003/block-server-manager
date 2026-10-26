// Real IPC gate: renderer → preload.contextBridge → ipcRenderer.invoke → ipcMain.handle → handler.
// This is the path runE2E/runSelfTest/runMgmtTest never exercised, which is how the handler-order
// regression slipped through. It must fail while runtime handlers are bound after registerIpc.
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { Store } from './services/store';
import type { IpcContext } from './ipc';

interface CallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

type Results = Record<string, CallResult>;

interface Check { name: string; ok: boolean; detail?: string }

const PAGE = '<!doctype html><meta charset="utf-8"><title>ipc test</title><body>ipc</body>';

function parseError(raw: string | undefined): { code?: string; message?: string } | null {
  try {
    const parsed = JSON.parse(raw ?? '') as { code?: string; message?: string };
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export async function runIpcTest(ctx: IpcContext, win: BrowserWindow): Promise<boolean> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail });
  };

  const page = path.join(ctx.dataRoot, 'ipc-test.html');
  fs.mkdirSync(ctx.dataRoot, { recursive: true });
  fs.writeFileSync(page, PAGE, 'utf8');

  let results: Results = {};
  try {
    await win.loadFile(page);
    const script = `(async () => {
      const api = window.electronAPI;
      if (!api) return { fatal: { ok: false, error: 'electronAPI missing (preload did not run)' } };
      const call = async (name, args) => {
        try { return { ok: true, value: await api.invoke(name, args) }; }
        catch (e) { return { ok: false, error: e && e.message ? String(e.message) : String(e) }; }
      };
      const out = {};
      out.ping = await call('ping');
      out.create = await call('servers_create', { input: { name: 'ipctest-' + Date.now(), loader: 'Vanilla', mcVersion: '1.20.4', ramMb: 1024 } });
      const id = out.create.ok && out.create.value ? out.create.value.id : '';
      if (id) {
        out.port = await call('port_check', { port: 25565 });
        out.settings = await call('server_settings_get', { id });
        out.metrics = await call('metrics_get', { id });
        out.backups = await call('backups_list', { id });
        out.worlds = await call('worlds_list', { id });
        out.players = await call('players_list', { id });
        out.content = await call('content_list', { id });
        out.del = await call('servers_delete', { id });
      }
      out.missing = await call('server_settings_get', { id: 'missing' });
      // Registration check only: do not serialize the whole Mojang manifest back.
      try { await api.invoke('versions_vanilla'); out.versions = { ok: true }; }
      catch (e) { out.versions = { ok: false, error: e && e.message ? String(e.message) : String(e) }; }
      return out;
    })()`;
    results = await win.webContents.executeJavaScript(script, true) as Results;
  } catch (error) {
    check('renderer-bridge', false, error instanceof Error ? error.message : String(error));
  }

  if ((results as { fatal?: CallResult }).fatal) {
    const fatal = (results as { fatal?: CallResult }).fatal!;
    check('preload', false, fatal.error);
  }

  const ok = (name: string): boolean => results[name]?.ok === true;
  const value = (name: string): Record<string, unknown> | null =>
    (results[name]?.value as Record<string, unknown> | undefined) ?? null;

  check('ping', ok('ping') && results.ping?.value === 'pong', results.ping?.error);
  check('servers_create', ok('create') && typeof value('create')?.id === 'string', results.create?.error);
  check('port_check', ok('port') && typeof value('port')?.available === 'boolean', results.port?.error);
  for (const name of ['settings', 'metrics', 'backups', 'worlds', 'players', 'content'] as const) {
    check(name, ok(name), results[name]?.error);
  }
  check('servers_delete', ok('del'), results.del?.error);

  const missing = parseError(results.missing?.error);
  check(
    'error-code',
    results.missing?.ok === false && missing?.code === 'not-found',
    results.missing?.error,
  );

  const versionError = results.versions?.error ?? '';
  check(
    'versions_vanilla-registered',
    results.versions?.ok === true || !/No handler registered/i.test(versionError),
    versionError.slice(0, 160),
  );

  // ── Real renderer smoke: the screenshot failure was on the Create screen. ──
  const rendererIndex = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(rendererIndex)) {
    try {
      await win.loadFile(rendererIndex);
      const ui = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const text = () => document.body.innerText || '';
        for (let i = 0; i < 100 && !text().includes('Create Server'); i += 1) await sleep(100);
        const vanilla = Array.from(document.querySelectorAll('button.mc-edition')).find((button) => /Vanilla/.test(button.textContent || ''));
        if (vanilla) vanilla.click();
        for (let i = 0; i < 150 && !text().includes('Minecraft version'); i += 1) await sleep(100);
        let loaderReady = false;
        for (let i = 0; i < 300; i += 1) {
          const selects = Array.from(document.querySelectorAll('select'));
          const options = selects.flatMap((select) => Array.from(select.options).map((option) => option.value));
          const hasVersion = options.some((value) => /^\\d+\\.\\d+/.test(value));
          const javaReady = /Java required: \\d+/.test(text()) || /No Java .* runtime found/.test(text());
          loaderReady = (selects[1]?.options.length ?? 0) > 0;
          if (hasVersion && javaReady && loaderReady) break;
          await sleep(100);
        }
        const selects = Array.from(document.querySelectorAll('select'));
        const options = selects.flatMap((select) => Array.from(select.options).map((option) => option.value));
        await sleep(400);
        return {
          bad: /Mojang version metadata is unavailable|Paper version metadata is unavailable|No handler registered/.test(text()),
          hasVersion: options.some((value) => /^\\d+\\.\\d+/.test(value)),
          javaReady: /Java required: \\d+/.test(text()) || /No Java .* runtime found/.test(text()),
          loaderReady,
          snippet: text().slice(0, 500),
        };
      })()`, true) as { bad: boolean; hasVersion: boolean; javaReady: boolean; loaderReady: boolean; snippet: string };
      check('ui-create-metadata', !ui.bad && ui.hasVersion, ui.bad ? ui.snippet : undefined);
      check('ui-java-detected', ui.javaReady, ui.javaReady ? undefined : ui.snippet);
      check('ui-loaders-detected', ui.loaderReady, ui.loaderReady ? undefined : ui.snippet);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(ctx.dataRoot, 'ui-smoke.png'), image.toPNG());
      } catch {
        // A screenshot is diagnostic only.
      }
    } catch (error) {
      check('ui-smoke', false, error instanceof Error ? error.message : String(error));
    }
  }

  // The renderer test deletes its server; this is a safety net for a failed call sequence.
  try {
    const store = new Store(ctx.dataRoot);
    for (const server of store.listServers().filter((entry) => entry.name.startsWith('ipctest-'))) {
      store.deleteServer(server.id);
      fs.rmSync(path.join(ctx.dataRoot, 'servers', server.id), { recursive: true, force: true });
    }
  } catch {
    // Cleanup is best effort; the temp data root is removed by the caller.
  }

  const lines = checks.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
  const pass = checks.length > 0 && checks.every((entry) => entry.ok);
  lines.push(pass ? 'IPCTEST PASS' : 'IPCTEST FAIL');
  const summary = lines.join('\n');
  fs.writeFileSync(path.join(ctx.dataRoot, 'ipc-result.txt'), summary + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(summary);
  return pass;
}
