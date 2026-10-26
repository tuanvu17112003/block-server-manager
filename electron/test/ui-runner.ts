// Real-UI E2E harness (no extra dependencies): drives the production renderer + preload + IPC in a
// hidden BrowserWindow, asserts tab/flow state and captures screenshots as gate artifacts.
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { IpcContext } from '../ipc';
import { handlersMap } from '../ipc';
import { TestRun, sleep, waitUntil } from './harness';

export interface SuiteResult {
  ok: boolean;
  report: string;
}

const TABS = ['Overview', 'Console', 'Content', 'Players', 'Worlds', 'Backups', 'Metrics', 'Settings'] as const;

export async function runUiTests(ctx: IpcContext, win: BrowserWindow, artifactsDir: string): Promise<SuiteResult> {
  const run = new TestRun('ui');
  const consoleErrors: string[] = [];
  fs.mkdirSync(artifactsDir, { recursive: true });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || /Uncaught|TypeError|ReferenceError/i.test(event.message)) {
      consoleErrors.push(`${event.message}`.slice(0, 400));
    }
  });

  const exec = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const body = (): Promise<string> => exec<string>('document.body.innerText || ""');
  const shot = async (name: string): Promise<void> => {
    await sleep(300);
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(artifactsDir, `${name}.png`), image.toPNG());
    } catch {
      // Screenshot is diagnostic; a capture failure must not fail the suite.
    }
  };
  const clickTab = (label: string): Promise<boolean> => exec<boolean>(`(() => {
    const button = Array.from(document.querySelectorAll('.mc-tab')).find((element) => (element.textContent || '').trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);

  // Seed one stopped server through the same handlers the renderer calls, then load the real UI.
  const H = handlersMap();
  const created = await H.servers_create(
    { input: { name: 'UI Suite Server', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } }, ctx,
  ) as { id: string };
  const dir = path.join(ctx.dataRoot, 'servers', created.id);
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'ui-level');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), [
    'motd=UI MOTD', 'max-players=10', 'difficulty=normal', 'gamemode=survival',
    'online-mode=true', 'server-port=25599', 'level-name=world', '',
  ].join('\n'));
  await H.server_settings_update({ id: created.id, values: { motd: 'UI MOTD' }, eulaAccepted: true }, ctx);

  try {
    await win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
    await run.must('server list hydrates from the backend', async () => {
      await waitUntil(async () => (await body()).includes('UI Suite Server'), { timeoutMs: 25_000, label: 'server list' });
    });
    await run.must('overview tab renders the active server', async () => {
      const text = await body();
      if (!/UI Suite Server/.test(text)) throw new Error('server name missing');
    });
    await shot('01-overview');

    for (const label of TABS) {
      await run.must(`tab ${label} renders`, async () => {
        if (!(await clickTab(label))) throw new Error('tab button not found');
        await sleep(600);
        const active = await exec<string>(`(() => {
          const button = document.querySelector('.mc-tab-active');
          return button ? (button.textContent || '').trim() : '';
        })()`);
        if (active !== label) throw new Error(`active tab is "${active}"`);
        if ((await body()).trim().length < 20) throw new Error('tab body empty');
      });
      await shot(`02-tab-${label.toLowerCase()}`);
    }

    await run.must('create wizard reaches Vanilla configure with catalogue metadata', async () => {
      const opened = await exec<boolean>(`(() => {
        const button = Array.from(document.querySelectorAll('button')).find((element) => /New Server/.test(element.textContent || ''));
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!opened) throw new Error('New Server button missing');
      await waitUntil(async () => (await body()).includes('Create Server'), { timeoutMs: 10_000, label: 'create view' });
      const vanilla = await exec<boolean>(`(() => {
        const button = Array.from(document.querySelectorAll('button.mc-edition')).find((element) => /Vanilla/.test(element.textContent || ''));
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!vanilla) throw new Error('Vanilla edition card missing');
      await waitUntil(async () => {
        const state = await exec<{ hasVersion: boolean; javaReady: boolean }>(`(() => {
          const text = document.body.innerText || '';
          const selects = Array.from(document.querySelectorAll('select'));
          const options = selects.flatMap((select) => Array.from(select.options).map((option) => option.value));
          return {
            hasVersion: options.some((value) => /^\\d+\\.\\d+/.test(value)),
            javaReady: /Java required: \\d+/.test(text) || /No Java .* runtime found/.test(text),
          };
        })()`);
        return state.hasVersion && state.javaReady;
      }, { timeoutMs: 40_000, label: 'version + java metadata' });
      await shot('03-create-configure');
    });

    await run.must('no renderer errors during the walk', async () => {
      if (consoleErrors.length > 0) throw new Error(consoleErrors.slice(0, 3).join(' | '));
    });
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'console-errors.json'), JSON.stringify(consoleErrors, null, 2));
  }

  const lines = run.lines();
  if (lines.length === 0) lines.push('FAIL ui/no checks ran');
  return { ok: run.ok, report: lines.join('\n') };
}
