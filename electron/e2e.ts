// E2E acceptance — drives the same IPC handlers the renderer calls (via the handler map),
// under the real Electron main process. Steps: ping → vanilla create/install/start(Done)/stop →
// Modrinth cobbleverse pipeline preview/install/start/stop → CurseForge key-mode one-click
// (skyfactory-5) engine + staged-zip inspection. Everything lands in .app-data (dev data root).
import { handlersMap, type IpcContext, type Handler } from './ipc';
import { Store } from './services/store';
import { buildRuntime } from './services/runtime';
import { installCurseforge, inspectStagedZip } from './services/installer/curseforge';
import { searchModpacks } from './services/installer/modrinth';
import { startWithAutoFix, writeEula } from './services/installer/core';
import path from 'node:path';
import fs from 'node:fs';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function runE2E(ctx: IpcContext): Promise<boolean> {
  const results: string[] = [];
  const t = (name: string, ok: boolean): void => { results.push(`${name}=${ok ? 'PASS' : 'FAIL'}`); };
  const runtime = buildRuntime().register(ctx);
  const H = { ...handlersMap(), ...runtime.handlers } as Record<string, Handler>;
  const store = new Store(ctx.dataRoot);

  // idempotent runs: purge leftovers from earlier e2e attempts
  for (const s of store.listServers()) {
    if (s.name.startsWith('e2e-')) {
      store.deleteServer(s.id);
      fs.rmSync(path.join(ctx.dataRoot, 'servers', s.id), { recursive: true, force: true });
    }
  }
  fs.rmSync(path.join(ctx.dataRoot, 'servers', 'e2e-sf5-keymode'), { recursive: true, force: true });

  // 1. ping
  t('ping', (await H.ping({}, ctx)) === 'pong');

  // 2. vanilla 1.21.1: install → start → Done( → stop
  try {
  const vanilla = await H.server_install({ input: { name: 'e2e-vanilla', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048, eulaAccepted: true }, jobId: 'jv' }, ctx) as { id: string };
  t('vanilla-install', !!vanilla?.id);
  let sawDone = false;
  const logUnsub = (() => { const h = (payload: unknown): void => { if (/Done \(\d/.test(String(payload))) sawDone = true; }; return h; })();
  ctx.send; // channel bus is window-bound; capture Done( via polling status instead
  await H.server_start({ id: vanilla.id }, ctx);
  let running = false;
  for (let i = 0; i < 120 && !running; i++) { await sleep(2000); running = store.getServer(vanilla.id)?.status === 'running'; }
  t('vanilla-start-Done', running);
  await H.server_stop({ id: vanilla.id }, ctx);
  for (let i = 0; i < 30 && store.getServer(vanilla.id)?.status !== 'stopped'; i++) await sleep(1000);
  t('vanilla-stop', store.getServer(vanilla.id)?.status === 'stopped');
  void logUnsub;
  } catch (e) { t('vanilla-install', false); results.push(`vanilla-error=${(e as Error).message.slice(0,120)}`); }

  // 3. Modrinth cobbleverse through the pipeline (the wizard's exact path)
  try {
  const search = await H.modrinth_search_modpacks({ query: 'cobbleverse', index: 'relevance', offset: 0, limit: 5 }, ctx) as { results: { id: string }[] };
  const projectId = search.results[0]?.id;
  t('modrinth-search', !!projectId);
  const versions = await H.modrinth_project_versions({ projectId }, ctx) as { id: string; gameVersions: string[] }[];
  const version = versions.find(v => v.gameVersions.includes('1.21.1')) ?? versions[0];
  const preview = await H.modpack_pipeline_preview({ source: { kind: 'modrinthRemote', projectId, versionId: version.id }, jobId: 'jp' }, ctx) as { previewId: string; plan: { loader: { minecraftVersion: string } }; plan2?: unknown };
  t('pipeline-preview', !!preview?.previewId && preview.plan.loader.minecraftVersion === '1.21.1');
  const install = await H.modpack_pipeline_install({ previewId: preview.previewId, input: { name: 'e2e-cobbleverse', ramMb: 4096, eulaAccepted: true }, choices: { files: {}, approvedReplacements: [], autoDeleteCurseforgeZip: false }, jobId: 'ji' }, ctx) as { status: string; server: { id: string } | null };
  t('pipeline-install', install?.status === 'complete' && !!install.server?.id);
  if (install.server?.id) {
    await H.server_start({ id: install.server.id }, ctx);
    let up = false;
    for (let i = 0; i < 180 && !up; i++) { await sleep(2000); up = store.getServer(install.server.id)?.status === 'running'; }
    t('cobbleverse-start-Done', up);
    await H.server_stop({ id: install.server.id }, ctx);
    for (let i = 0; i < 60 && store.getServer(install.server.id)?.status !== 'stopped'; i++) await sleep(1000);
    t('cobbleverse-stop', store.getServer(install.server.id)?.status === 'stopped');
  }
  } catch (e) { t('modrinth-search', false); results.push(`cobbleverse-error=${(e as Error).message.slice(0,120)}`); }

  // 4. CurseForge key-mode one-click (engine path): skyfactory-5 → boot verify via startWithAutoFix
  try {
    const dir = path.join(ctx.dataRoot, 'servers', 'e2e-sf5-keymode');
    fs.rmSync(dir, { recursive: true, force: true });
    const res = await installCurseforge({ projectId: 392141, dir, dataRoot: ctx.dataRoot, cacheDir: path.join(ctx.dataRoot, 'cache') });
    t('sf5-oneclick-download', res.route === 'A' && res.installed >= 0);
    const dto = store.createServer({ name: 'e2e-sf5', loader: 'Forge', mcVersion: res.mc ?? '1.20.1', loaderVersion: res.loaderVersion ?? undefined, ramMb: 4096, eulaAccepted: true, javaPath: undefined });
    fs.mkdirSync(dir, { recursive: true });
    // move engine output into the managed dir shape: engine already installed into `dir` (managed path used directly)
    const rt = await (await import('./services/installer/core')).ensureJava(21, path.join(ctx.dataRoot, 'runtime'), path.join(ctx.dataRoot, 'cache'));
    writeEula(dir); // e2e boots the engine dir directly; the pipeline path writes this itself
    const lc = (await import('./services/installer/core')).launchCommand(dir, rt.javapath);
    const boot = await startWithAutoFix(dir, lc, { timeoutMs: 10 * 60_000 });
    t('sf5-boot-Done', boot.ok);
    results.push(`sf5-reason=${boot.reason.slice(0, 140)}`);
    results.push(`sf5-tail=${boot.tail.slice(-3).join(' / ').slice(0, 180)}`);
    store.deleteServer(dto.id);
  } catch (e) {
    t('sf5-boot-Done', false);
    results.push(`sf5-error=${(e as Error).message.slice(0, 120)}`);
  }

  // 5. staged-zip inspection on the downloaded server pack
  try {
    const staged = fs.readdirSync(path.join(ctx.dataRoot, 'cache', 'cfpack')).find(f => /server/.test(f));
    if (staged) {
      const insp = await inspectStagedZip(path.join(ctx.dataRoot, 'cache', 'cfpack', staged));
      t('zip-inspect', insp.classification === 'supportedServerPack');
    } else t('zip-inspect', false);
  } catch { t('zip-inspect', false); }

  const pass = results.filter(r => /^[a-z0-9-]+=(PASS|FAIL)$/.test(r)).every(r => r.endsWith('PASS')); // step lines only; diagnostics (reason/tail) excluded
  const summary = results.join(' | ') + `
E2E ${pass ? 'PASS' : 'FAIL'}
`;
  // file, not stdout: app.exit() does not flush console buffers
  fs.writeFileSync(path.join(ctx.dataRoot, 'e2e-result.txt'), summary);
  // eslint-disable-next-line no-console
  console.log(summary);
  return pass;
}
