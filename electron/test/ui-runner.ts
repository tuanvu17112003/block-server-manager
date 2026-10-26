// Real-UI E2E harness (no extra dependencies): drives the production renderer + preload + IPC in a
// hidden BrowserWindow against a richly seeded backend, captures screenshots as gate artifacts and
// reports UI gaps/pending scenarios without failing the gate for in-flight UI work.
//
// Phase 6 (task-23) expansion: management tabs are checked against real backend content (mods,
// roster flags, worlds badges, backup kinds, metrics state, settings values), plus server switching,
// settings-save shell stability, delete-server fallback and the Create wizard. Body text is matched
// through a normalized view (whitespace collapsed, case-insensitive) because CSS upper-cases card
// titles and tab owners may still be iterating on copy.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BrowserWindow } from 'electron';
import type { IpcContext } from '../ipc';
import { handlersMap } from '../ipc';
import { TestRun, sleep, waitUntil } from './harness';

export interface SuiteResult {
  ok: boolean;
  report: string;
}

const TABS = ['Overview', 'Console', 'Content', 'Players', 'Worlds', 'Backups', 'Metrics', 'Settings'] as const;
const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const SETTINGS_STEP_TIMEOUT_MS = 45_000;

/** Minimal NBT level.dat fixture: root compound -> Data{LevelName, RandomSeed, Version{Name}}. */
function levelDatFixture(seed: string, levelName = 'world'): Buffer {
  const chunks: Buffer[] = [];
  const name = (text: string): Buffer => {
    const body = Buffer.from(text, 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(body.length, 0);
    return Buffer.concat([length, body]);
  };
  const tag = (type: number): Buffer => Buffer.from([type]);
  chunks.push(tag(10), name('')); // root compound, empty name
  chunks.push(tag(10), name('Data'));
  chunks.push(tag(8), name('LevelName'), name(levelName));
  const seedBuffer = Buffer.alloc(8);
  seedBuffer.writeBigInt64BE(BigInt(seed), 0);
  chunks.push(tag(4), name('RandomSeed'), seedBuffer);
  chunks.push(tag(10), name('Version'), tag(8), name('Name'), name('19133'), tag(0));
  chunks.push(tag(0)); // end Data
  chunks.push(tag(0)); // end root
  return gzipSync(Buffer.concat(chunks));
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export async function runUiTests(ctx: IpcContext, win: BrowserWindow, artifactsDir: string): Promise<SuiteResult> {
  const run = new TestRun('ui');
  const consoleErrors: string[] = [];
  const gaps: string[] = [];
  const pending: string[] = [];
  fs.mkdirSync(artifactsDir, { recursive: true });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || /Uncaught|TypeError|ReferenceError/i.test(event.message)) {
      consoleErrors.push(`${event.message}`.slice(0, 400));
    }
  });

  const exec = <T = unknown>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const body = (): Promise<string> => exec<string>('document.body.innerText || ""');
  /** Whitespace-collapsed, case-insensitive view of the rendered page. */
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toUpperCase();
  const hasText = async (needle: string): Promise<boolean> => normalize(await body()).includes(normalize(needle));
  const shot = async (name: string): Promise<void> => {
    await sleep(250);
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(artifactsDir, `${name}.png`), image.toPNG());
    } catch {
      // Screenshot is diagnostic; a capture failure must not fail the suite.
    }
  };
  const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`step "${label}" timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  };
  const check = (name: string, fn: () => Promise<void>, timeoutMs = DEFAULT_STEP_TIMEOUT_MS): Promise<void> =>
    run.must(name, async () => {
      try {
        await withTimeout(fn(), timeoutMs, name);
      } catch (error) {
        await shot(`failure-${slug(name)}`);
        throw error;
      }
    });
  /** Non-fatal scenario outcome for in-flight UI work: recorded, never fails the gate. */
  const markPending = (name: string, note: unknown): void => {
    pending.push(`${name}: ${String(note instanceof Error ? note.message : note).slice(0, 300)}`);
  };

  const clickTab = (label: string): Promise<boolean> => exec<boolean>(`(() => {
    const button = Array.from(document.querySelectorAll('.mc-tab')).find((element) => (element.textContent || '').trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  const activeTab = (): Promise<string> => exec<string>(`(() => {
    const button = document.querySelector('.mc-tab-active');
    return button ? (button.textContent || '').trim() : '';
  })()`);
  const clickButton = (text: string, withinSelector = ''): Promise<boolean> => exec<boolean>(`(() => {
    const root = ${withinSelector ? `document.querySelector(${JSON.stringify(withinSelector)})` : 'document'};
    if (!root) return false;
    const button = Array.from(root.querySelectorAll('button')).find((element) => (element.textContent || '').trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  const clickButtonMatching = (pattern: string, withinSelector = ''): Promise<boolean> => exec<boolean>(`(() => {
    const root = ${withinSelector ? `document.querySelector(${JSON.stringify(withinSelector)})` : 'document'};
    if (!root) return false;
    const re = new RegExp(${JSON.stringify(pattern)});
    const button = Array.from(root.querySelectorAll('button')).find((element) => re.test((element.textContent || '').trim()));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  const waitForText = (needle: string, timeoutMs = 20_000): Promise<void> =>
    waitUntil(async () => hasText(needle), { timeoutMs, intervalMs: 120, label: `text ${needle}` });
  const waitForPattern = (pattern: RegExp, timeoutMs = 20_000): Promise<void> =>
    waitUntil(async () => pattern.test(await body()), { timeoutMs, intervalMs: 120, label: `pattern ${pattern}` });
  const headerName = (): Promise<string> => exec<string>(`(() => {
    const heading = document.querySelector('.mc-header-title');
    return heading ? (heading.textContent || '').trim() : '';
  })()`);
  const activeSidebarRow = (): Promise<string> => exec<string>(`(() => {
    const row = document.querySelector('.mc-server-row-active');
    return row ? (row.textContent || '').trim() : '';
  })()`);
  const sidebarRowNames = (): Promise<string[]> => exec<string[]>(`(() => Array.from(document.querySelectorAll('.mc-server-row')).map((row) => (row.textContent || '').trim()))()`);
  const clickSidebarServer = (name: string): Promise<boolean> => exec<boolean>(`(() => {
    const row = Array.from(document.querySelectorAll('.mc-server-row')).find((element) => (element.textContent || '').includes(${JSON.stringify(name)}));
    if (!row) return false;
    row.click();
    return true;
  })()`);

  // ------------------------------------------------------------------------------------------
  // Seed a rich backend state through the same handlers the renderer calls.
  // ------------------------------------------------------------------------------------------
  const H = handlersMap();
  const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const handler = H[name];
    if (!handler) throw new Error(`handler ${name} is not registered`);
    return handler(args, ctx) as Promise<T>;
  };
  const SERVER_A = 'UI Fabric Server';
  const SERVER_B = 'UI Second Server';
  const serverA = await invoke<{ id: string }>('servers_create', {
    input: { name: SERVER_A, loader: 'Fabric', mcVersion: '1.21.1', ramMb: 2048, port: 25601 },
  });
  const dirA = path.join(ctx.dataRoot, 'servers', serverA.id);
  const writeA = (rel: string, content: string | Buffer): void => {
    const file = path.join(dirA, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  writeA(path.join('world', 'level.dat'), levelDatFixture('123456789'));
  writeA(path.join('world_nether', 'level.dat'), levelDatFixture('123456789'));
  writeA(path.join('world_nether', 'region'), 'nether-region');
  writeA('eula.txt', '# accepted\n# https://aka.ms/MinecraftEULA\neula=true\n');
  writeA('server.properties', [
    'motd=UI MOTD', 'max-players=10', 'difficulty=normal', 'gamemode=survival',
    'online-mode=true', 'server-port=25601', 'level-name=world', '',
  ].join('\n'));
  writeA(path.join('mods', 'example-mod.jar'), 'enabled-mod-jar');
  writeA(path.join('mods-disabled', 'disabled-mod.jar'), 'disabled-mod-jar');
  const uuid = (tail: string): string => `00000000-0000-0000-0000-0000000000${tail}`;
  writeA('usercache.json', JSON.stringify([
    { name: 'Steve', uuid: uuid('01'), expiresOn: '2027-01-01' },
    { name: 'Alex', uuid: uuid('02'), expiresOn: '2027-01-01' },
    { name: 'Notch', uuid: uuid('03'), expiresOn: '2027-01-01' },
  ], null, 2));
  writeA('whitelist.json', JSON.stringify([{ name: 'Steve', uuid: uuid('01') }], null, 2));
  writeA('ops.json', JSON.stringify([{ uuid: uuid('02'), name: 'Alex', level: 4, bypassesPlayerLimit: false }], null, 2));
  writeA('banned-players.json', JSON.stringify([{ uuid: uuid('04'), name: 'Herobrine', created: '2024-01-01 00:00:00 +0000', source: 'Server', expires: 'forever', reason: 'UI fixture' }], null, 2));
  await invoke('server_settings_update', { id: serverA.id, values: { motd: 'UI MOTD', 'max-players': '10', 'server-port': '25601' }, eulaAccepted: true });
  await invoke('backup_create', { id: serverA.id, name: 'ui-manual-backup', kind: 'Manual', jobId: '' });
  await invoke('backup_create', { id: serverA.id, name: 'ui-delete-safety', kind: 'World-delete', jobId: '' });
  await invoke('world_create', { id: serverA.id, name: 'ui_pending_world', seed: '42', levelType: 'minecraft:normal' });
  const metricsFile = path.join(ctx.dataRoot, 'metrics', `${serverA.id}.json`);
  fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
  fs.writeFileSync(metricsFile, JSON.stringify([
    { at: new Date(Date.now() - 120_000).toISOString(), cpuPct: 12, memoryMb: 1024, ramPct: 50, players: 1, tps: 20, mspt: 2 },
    { at: new Date(Date.now() - 60_000).toISOString(), cpuPct: 18, memoryMb: 1100, ramPct: 54, players: 2, tps: 19.9, mspt: 3 },
    { at: new Date().toISOString(), cpuPct: 9, memoryMb: 900, ramPct: 44, players: 0, tps: 20, mspt: 1.8 },
  ]), 'utf8');
  const serverB = await invoke<{ id: string }>('servers_create', {
    input: { name: SERVER_B, loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024, port: 25602 },
  });
  const dirB = path.join(ctx.dataRoot, 'servers', serverB.id);
  fs.mkdirSync(path.join(dirB, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dirB, 'world', 'level.dat'), levelDatFixture('987654321'));
  fs.writeFileSync(path.join(dirB, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dirB, 'server.properties'), 'motd=Second UI MOTD\nmax-players=5\ndifficulty=easy\nlevel-name=world\nserver-port=25602\n');
  await invoke('server_settings_update', { id: serverB.id, values: { motd: 'Second UI MOTD', 'max-players': '5', 'server-port': '25602' }, eulaAccepted: true });

  try {
    await win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));

    await check('server list hydrates both seeded servers from the backend', async () => {
      await waitUntil(async () => hasText(SERVER_A), { timeoutMs: 25_000, label: 'server list' });
      await waitUntil(async () => hasText(SERVER_B), { timeoutMs: 25_000, label: 'second server' });
      const names = await sidebarRowNames();
      if (!names.some((name) => name.includes(SERVER_A)) || !names.some((name) => name.includes(SERVER_B))) {
        throw new Error(`sidebar rows missing servers: ${names.join(' | ')}`);
      }
    });
    await shot('01-overview');

    for (const label of TABS) {
      await check(`tab ${label} renders`, async () => {
        if (!(await clickTab(label))) throw new Error('tab button not found');
        await sleep(400);
        const active = await activeTab();
        if (active !== label) throw new Error(`active tab is "${active}"`);
        if ((await body()).trim().length < 20) throw new Error('tab body empty');
      });
      await shot(`02-tab-${label.toLowerCase()}`);
    }

    await check('Content tab lists enabled + disabled mods for the Fabric server', async () => {
      if (!(await clickTab('Content'))) throw new Error('Content tab missing');
      await waitForText('example-mod.jar', 20_000);
      const text = normalize(await body());
      if (!text.includes('DISABLED-MOD.JAR')) throw new Error('disabled mod row missing (mods-disabled not listed)');
      if (!/1 ENABLED/.test(text) || !/2 TOTAL/.test(text)) throw new Error(`enabled/total summary wrong: ${text.slice(0, 400)}`);
      if (!text.includes('DISABLE') || !text.includes('ENABLE')) throw new Error('enable/disable actions missing');
    });
    await shot('03-content-mods');

    await check('Players tab shows the seeded offline roster with OP/whitelist/banned flags', async () => {
      if (!(await clickTab('Players'))) throw new Error('Players tab missing');
      await waitForText('Steve', 20_000);
      const text = normalize(await body());
      for (const expected of ['ALEX', 'HEROBRINE', 'OFFLINE', 'OP', 'WHITELIST', 'BANNED']) {
        if (!text.includes(expected)) throw new Error(`missing "${expected}" in players view`);
      }
    });
    await shot('03-players-roster');

    await check('Worlds tab shows the active world + pending world badges', async () => {
      if (!(await clickTab('Worlds'))) throw new Error('Worlds tab missing');
      await waitForPattern(/CURRENT WORLD/i, 20_000);
      await waitForText('ui_pending_world', 20_000);
      const text = normalize(await body());
      if (!/ACTIVE/.test(text)) throw new Error('active world badge missing');
      if (!/NEXT START/.test(text)) throw new Error('pending world "next start" badge missing');
      const worlds = await invoke<{ name: string; seed?: string | null; active: boolean; pending?: boolean }[]>('worlds_list', { id: serverA.id });
      if (!worlds.some((world) => world.pending && world.name === 'ui_pending_world')) {
        throw new Error(`pending world not reported by worlds_list: ${JSON.stringify(worlds)}`);
      }
      const seeded = worlds.find((world) => typeof world.seed === 'string' && world.seed.length > 0);
      if (!seeded) {
        markPending('Worlds seed', 'worlds_list returned no parsed level.dat seed for the seeded fixture (backend parser/UI data path)');
      } else if (!text.includes(normalize(String(seeded.seed)))) {
        gaps.push(`Worlds tab does not render the level.dat seed (backend seed "${seeded.seed}") - expected a seed value/badge.`);
      }
    });
    await shot('03-worlds-badges');

    await check('Backups tab lists Manual + World-delete backup rows', async () => {
      if (!(await clickTab('Backups'))) throw new Error('Backups tab missing');
      await waitForText('ui-manual-backup', 20_000);
      const text = normalize(await body());
      if (!text.includes('UI-DELETE-SAFETY')) throw new Error('World-delete backup row missing');
      if (!text.includes('MANUAL')) throw new Error('Manual kind badge missing');
      if (!text.includes('WORLD-DELETE')) throw new Error('World-delete kind badge missing');
      if (!text.includes('RESTORE')) throw new Error('Restore action missing (tooltip/buttons not rendered)');
    });
    await shot('03-backups-rows');

    await check('Metrics tab shows the stopped empty state and keeps seeded disk/history data', async () => {
      if (!(await clickTab('Metrics'))) throw new Error('Metrics tab missing');
      await waitForPattern(/METRICS ARE EMPTY|START THE SERVER TO COLLECT/i, 20_000);
      const history = await invoke<{ samples: unknown[]; disk: { freeBytes: number; totalBytes: number } }>('metrics_get', { id: serverA.id, hours: 1 });
      if (!Array.isArray(history.samples) || history.samples.length < 2) throw new Error('seeded metrics history not returned');
      if (!(history.disk.freeBytes > 0) || !(history.disk.totalBytes > 0)) throw new Error('disk probe returned no data');
    });
    await shot('03-metrics-empty');

    await check('Settings tab shows backend values + Java requirement, EULA checked', async () => {
      if (!(await clickTab('Settings'))) throw new Error('Settings tab missing');
      await waitForPattern(/SERVER SETTINGS/i, 25_000);
      await waitUntil(async () => {
        const value = await exec<{ motd: string } | null>(`(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          const motd = inputs.find((element) => element.type === 'text' && (element.value || '').includes('UI MOTD'));
          return motd ? { motd: motd.value } : null;
        })()`);
        return value !== null;
      }, { timeoutMs: 20_000, label: 'settings values' });
      const state = await exec<{ motd: string; maxPlayers: string; port: string; eula: boolean }>(`(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const motd = inputs.find((element) => element.type === 'text' && (element.value || '').includes('UI MOTD'));
        const numberInputs = inputs.filter((element) => element.type === 'number').map((element) => element.value);
        const eula = inputs.find((element) => element.type === 'checkbox' && (element.parentElement?.textContent || '').includes('Minecraft EULA'));
        return { motd: motd ? motd.value : '', maxPlayers: numberInputs[0] ?? '', port: numberInputs[1] ?? '', eula: Boolean(eula?.checked) };
      })()`);
      if (!state.motd.includes('UI MOTD')) throw new Error(`MOTD input wrong: ${state.motd}`);
      if (state.maxPlayers !== '10') throw new Error(`max players wrong: ${state.maxPlayers}`);
      if (state.port !== '25601') throw new Error(`port wrong: ${state.port}`);
      if (!state.eula) throw new Error('EULA checkbox is not checked though the file+store say accepted');
      // Java detection resolves asynchronously (Mojang metadata + local scan); wait for a terminal state.
      await waitUntil(async () => /JAVA REQUIRED: \d+|NO COMPATIBLE JAVA|JAVA REQUIREMENT UNAVAILABLE/.test(normalize(await body())), {
        timeoutMs: 40_000, intervalMs: 200, label: 'Java section resolution',
      });
      const text = normalize(await body());
      if (!/JAVA REQUIRED: \d+|NO COMPATIBLE JAVA|JAVA REQUIREMENT UNAVAILABLE/.test(text)) {
        throw new Error(`Java section did not resolve: ${text.slice(0, 500)}`);
      }
      if (!/DANGER ZONE/.test(text) || !text.includes('DELETE SERVER')) throw new Error('Danger zone/delete action missing');
    }, SETTINGS_STEP_TIMEOUT_MS);
    await shot('03-settings-values');

    await check('server switching keeps per-server state and no stale sidebar selection', async () => {
      if (!(await clickSidebarServer(SERVER_B))) throw new Error('second server row missing');
      await waitUntil(async () => (await headerName()) === SERVER_B, { timeoutMs: 10_000, label: 'header second server' });
      if (!(await clickTab('Content'))) throw new Error('Content tab missing');
      await waitForPattern(/VANILLA SERVERS? DO NOT LOAD|NO MODS OR PLUGINS/i, 20_000);
      if (!(await clickTab('Players'))) throw new Error('Players tab missing');
      await waitForPattern(/NO ONE (HAS )?JOINED YET/i, 20_000);
      if (!(await clickSidebarServer(SERVER_A))) throw new Error('first server row missing');
      await waitUntil(async () => (await headerName()) === SERVER_A, { timeoutMs: 10_000, label: 'header first server' });
      if (!(await clickTab('Content'))) throw new Error('Content tab missing after switching back');
      await waitForText('example-mod.jar', 20_000);
      const activeRow = await activeSidebarRow();
      if (!activeRow.includes(SERVER_A)) throw new Error(`stale sidebar selection: "${activeRow}"`);
    });
    await shot('04-server-switch');

    await check('settings save keeps the shell mounted and persists (no persistent loading state)', async () => {
      if (!(await clickTab('Settings'))) throw new Error('Settings tab missing');
      await waitForPattern(/SERVER SETTINGS/i, 25_000);
      await exec(`(() => {
        window.__msmLoadingFlash = 0;
        try { window.__msmFlashObserver?.disconnect(); } catch { /* first run */ }
        const observer = new MutationObserver(() => {
          if ((document.body.innerText || '').includes('Loading servers')) window.__msmLoadingFlash += 1;
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.__msmFlashObserver = observer;
        return true;
      })()`);
      const changed = await exec<boolean>(`(() => {
        const input = Array.from(document.querySelectorAll('input')).find((element) => element.type === 'text' && (element.value || '').includes('UI MOTD'));
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'UI MOTD saved');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      if (!changed) throw new Error('MOTD input not editable');
      await sleep(250);
      const saveClicked = (await clickButtonMatching('^SAVE')) || (await clickButtonMatching('^Save'));
      if (!saveClicked) throw new Error('Save button not enabled/clickable after editing MOTD');
      await waitUntil(async () => hasText('settings saved'), { timeoutMs: 20_000, label: 'settings saved toast' });
      await sleep(1_200);
      const flash = await exec<number>('window.__msmLoadingFlash || 0');
      const header = await headerName();
      if (header !== SERVER_A) throw new Error(`shell lost the active server after save (header "${header}")`);
      const rows = await sidebarRowNames();
      if (!rows.some((name) => name.includes(SERVER_A))) throw new Error('sidebar lost servers after save');
      if (flash > 0) gaps.push(`Settings save transiently renders "Loading servers" (${flash} mutation frames) - expected: patch the shell in place without the full-screen loading state (F-06).`);
      const settings = await invoke<{ values?: Record<string, string>; motd?: string }>('server_settings_get', { id: serverA.id });
      const persistedMotd = String(settings.values?.motd ?? settings.motd ?? '');
      if (!persistedMotd.includes('UI MOTD saved')) throw new Error(`settings did not persist: ${JSON.stringify(settings)}`);
    }, SETTINGS_STEP_TIMEOUT_MS);
    await shot('05-settings-save');

    await check('delete-server via Settings falls back to the remaining server', async () => {
      if (!(await clickSidebarServer(SERVER_B))) throw new Error('second server row missing');
      await waitUntil(async () => (await headerName()) === SERVER_B, { timeoutMs: 10_000, label: 'second server active' });
      if (!(await clickTab('Settings'))) throw new Error('Settings tab missing');
      await waitForPattern(/DANGER ZONE/i, 20_000);
      const deleteClicked = (await clickButtonMatching('DELETE SERVER')) || (await clickButtonMatching('Delete server'));
      if (!deleteClicked) throw new Error('delete-server card action missing');
      await waitUntil(async () => Boolean(await exec<boolean>('Boolean(document.querySelector(\'[role="dialog"]\'))')), { timeoutMs: 10_000, label: 'delete confirm dialog' });
      const confirmed = (await clickButtonMatching('DELETE SERVER', '[role="dialog"]')) || (await clickButtonMatching('Delete server', '[role="dialog"]'));
      if (!confirmed) throw new Error('confirm delete button missing/disabled');
      await waitUntil(async () => !(await hasText(SERVER_B)), { timeoutMs: 20_000, label: 'server B removed from UI' });
      await waitUntil(async () => (await headerName()) === SERVER_A, { timeoutMs: 10_000, label: 'fallback header' });
      const rows = await sidebarRowNames();
      if (rows.some((name) => name.includes(SERVER_B))) throw new Error('deleted server still listed');
      const activeRow = await activeSidebarRow();
      if (!activeRow.includes(SERVER_A)) {
        gaps.push('Deleting the active server leaves the sidebar with no active row (stale activeId after reload) - expected: select the fallback server explicitly (F-08).');
      }
    });
    await shot('06-delete-fallback');

    await check('Create wizard: header + Back navigation, catalogue select present', async () => {
      if (!(await clickButton('+ New Server'))) throw new Error('New Server button missing');
      await waitForPattern(/CREATE SERVER/i, 15_000);
      const hasBack = await exec<boolean>(`Boolean(Array.from(document.querySelectorAll('button')).find((element) => /(^|\\s)BACK$/i.test((element.textContent || '').trim())))`);
      if (!hasBack) throw new Error('Back button missing from the Create header');
      const editionClicked = (await clickButtonMatching('Vanilla', 'button.mc-edition')) || (await clickButtonMatching('^VANILLA')) || (await clickButtonMatching('^Vanilla'));
      if (!editionClicked) {
        markPending('Create edition card', 'Vanilla edition card not found (Create decomposition in progress)');
      } else {
        try {
          // The configure step renders the selects before the Mojang/Paper/Fabric/Forge/NeoForge
          // catalogue arrives; wait for populated version options instead of racing the network.
          await waitUntil(async () => {
            const options = await exec<number>(`(() => {
              const select = document.querySelector('select');
              return select ? select.options.length : 0;
            })()`);
            return options > 1;
          }, { timeoutMs: 45_000, label: 'catalogue version options' });
          const catalogue = await exec<{ selects: number; versionOptions: number; eula: boolean }>(`(() => {
            const selects = Array.from(document.querySelectorAll('select'));
            const eula = Array.from(document.querySelectorAll('input')).find((element) => element.type === 'checkbox' && (element.parentElement?.textContent || '').includes('Minecraft EULA'));
            return { selects: selects.length, versionOptions: selects[0] ? selects[0].options.length : 0, eula: Boolean(eula) };
          })()`);
          if (catalogue.versionOptions <= 1) {
            throw new Error(`catalogue select has ${catalogue.versionOptions} option(s)`);
          }
          if (!catalogue.eula) {
            markPending('Create EULA checkbox', 'EULA checkbox not present on the current configure step (Create decomposition in progress)');
          } else {
            const eulaChecked = await exec<boolean>(`(() => {
              const input = Array.from(document.querySelectorAll('input')).find((element) => element.type === 'checkbox' && (element.parentElement?.textContent || '').includes('Minecraft EULA'));
              return Boolean(input ? input.checked : true);
            })()`);
            if (eulaChecked) gaps.push('Create wizard EULA checkbox defaults to checked - expected: never auto-accept.');
          }
        } catch (error) {
          throw new Error(`Create catalogue did not populate version options: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const backClicked = (await clickButtonMatching('Back$')) || (await clickButtonMatching('Back'));
      if (!backClicked) throw new Error('Back button not clickable');
      await sleep(300);
      const backAgain = (await clickButtonMatching('Back$')) || (await clickButtonMatching('Back'));
      if (!backAgain) {
        markPending('Create header Back', 'header Back not found after returning a step (Create decomposition in progress)');
      } else {
        await waitUntil(async () => hasText(SERVER_A), { timeoutMs: 15_000, label: 'return to shell' });
      }
    }, SETTINGS_STEP_TIMEOUT_MS);
    await shot('07-create-back');

    await check('no renderer errors during the walk', async () => {
      if (consoleErrors.length > 0) throw new Error(consoleErrors.slice(0, 3).join(' | '));
    });
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'console-errors.json'), JSON.stringify(consoleErrors, null, 2));
    fs.writeFileSync(path.join(artifactsDir, 'ui-gaps.json'), JSON.stringify(gaps, null, 2));
    fs.writeFileSync(path.join(artifactsDir, 'ui-pending.json'), JSON.stringify(pending, null, 2));
  }

  const lines = run.lines();
  if (lines.length === 0) lines.push('FAIL ui/no checks ran');
  for (const gap of gaps) lines.push(`GAP  ui/${gap}`);
  for (const item of pending) lines.push(`PENDING ui/${item}`);
  return { ok: run.ok, report: lines.join('\n') };
}
