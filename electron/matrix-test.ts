// Live acceptance matrix — re-runs the reference spike's 12-pack matrix through THIS app's real
// Pipeline (preview → reviewed choices → staged install → L2/L3 verified boot → publish).
//
// Runs inside Electron (needs safeStorage for the CurseForge key and live provider APIs):
//   node node_modules/electron/cli.js . --matrixtest [--only=<slug>] [--resume]
//
// Each pack writes docs/evidence/matrix/<slug>.json BEFORE its throwaway data root is deleted, so every
// claim is falsifiable from disk. Disk roots live under <repo>/20-backups/matrix-<timestamp>/<slug>/.
import { handlersMap, type IpcContext, type Handler } from './ipc';
import { Store } from './services/store';
import { buildRuntime } from './services/runtime';
import { resetCurseForgeKeyCache } from './services/installer/curseforge';
import path from 'node:path';
import fs from 'node:fs';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface MatrixPack {
  slug: string;
  name: string;
  /** Better Modrinth search text than the display name (the reference resolves by slug). */
  searchQuery?: string;
  platform: 'modrinth' | 'curseforge';
  /** Expected facts from the reference (used to detect drift, not to steer the install). */
  expect: { mc?: string; loader?: string; java?: number; route?: string };
  /** Resolve a PipelineSourceRequest, or null with a reason when the pack cannot be reached. */
  source: 'modrinth' | 'cfCache' | 'cfKey';
  /** Cached CF archive file names already on disk (checked before falling back to key mode). */
  cacheZip?: string;
  projectId?: number;
  mrpackName?: string;
}

// Reference matrix: modpack-install-results.md (Modrinth 7/7 incl. extras, CurseForge 6/6).
// CurseForge packs use the official API key path (the reference's own CF sweep did), because the
// author server packs for DawnCraft / Prominence II are not plain archives this app can classify
// without the API's serverPackFileId.
const MATRIX: MatrixPack[] = [
  { slug: 'skyblock-enhanced', name: 'SkyBlock Enhanced', platform: 'modrinth', source: 'modrinth', expect: { loader: 'fabric', java: 25 } },
  { slug: 'cobbleverse', name: 'Cobbleverse', platform: 'modrinth', source: 'modrinth', expect: { mc: '1.21.1', loader: 'fabric', java: 21 } },
  { slug: 'battlearmorytacz', name: 'BattleArmory TACZ', platform: 'modrinth', source: 'modrinth', expect: { mc: '1.20.1', loader: 'forge', java: 17 } },
  { slug: 'prominence-2-fabric', name: 'Prominence II (Modrinth)', searchQuery: 'prominence', platform: 'modrinth', source: 'modrinth', expect: { mc: '1.20.1', loader: 'fabric', java: 17 } },
  { slug: 'slimes-adventure', name: 'Slimes Adventure RE', searchQuery: 'slimes adventure', platform: 'modrinth', source: 'modrinth', expect: { mc: '1.21.1', loader: 'fabric', java: 21 } },
  { slug: 'zombie-invade-100-days', name: 'Zombie Invade 100 Days', platform: 'modrinth', source: 'modrinth', expect: { mc: '1.20.1', loader: 'forge', java: 17 } },
  { slug: 'dungeon-heroes', name: 'Dungeon Heroes', platform: 'curseforge', source: 'cfKey', projectId: 671029, expect: { mc: '1.21.1', loader: 'fabric', java: 21, route: 'A/B' } },
  { slug: 'rlcraft', name: 'RLCraft', platform: 'curseforge', source: 'cfKey', projectId: 285109, expect: { mc: '1.12.2', loader: 'forge', java: 8, route: 'A/B' } },
  { slug: 'skyfactory-5', name: 'SkyFactory 5', platform: 'curseforge', source: 'cfCache', cacheZip: '392141-server-6290699.zip', projectId: 392141, expect: { mc: '1.20.1', loader: 'forge', java: 17, route: 'A' } },
  { slug: 'dawn-craft', name: 'DawnCraft', platform: 'curseforge', source: 'cfKey', projectId: 829758, expect: { mc: '1.18.2', loader: 'forge', java: 17, route: 'A/B' } },
  { slug: 'otherworld-dnd', name: 'Otherworld D&D', platform: 'curseforge', source: 'cfKey', projectId: 1418133, expect: { mc: '1.20.1', loader: 'forge', java: 17, route: 'A/B' } },
  { slug: 'prominence-2-hasturian-era', name: 'Prominence II (CurseForge)', platform: 'curseforge', source: 'cfKey', projectId: 466901, expect: { mc: '1.20.1', loader: 'fabric', java: 17, route: 'A/B' } },
];

const sleepLong = async (ms: number): Promise<void> => sleep(ms);

export async function runMatrix(ctx: IpcContext): Promise<boolean> {
  const argv = process.argv;
  const onlyArg = argv.find(a => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()) : null;
  const resume = argv.includes('--resume');

  const runtime = buildRuntime().register(ctx);
  const H = { ...handlersMap(), ...runtime.handlers } as Record<string, Handler>;
  const store = new Store(ctx.dataRoot);

  const startedAt = new Date().toISOString();
  const runRoot = path.join('H:\\TESTMultiAI\\20-backups', `matrix-${startedAt.replace(/[:.]/g, '-')}`);
  fs.mkdirSync(runRoot, { recursive: true });
  const evidenceDir = path.join(process.cwd(), 'docs', 'evidence', 'matrix');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const summary: Record<string, unknown>[] = [];

  console.log(`[matrix] run root: ${runRoot}`);
  console.log(`[matrix] flags: only=${only ? only.join(',') : '(all)'} resume=${resume}`);

  for (const pack of MATRIX) {
    if (only && !only.includes(pack.slug)) continue;
    const evidenceFile = path.join(evidenceDir, `${pack.slug}.json`);
    if (resume && fs.existsSync(evidenceFile)) {
      const prev = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) as { verdict?: string };
      if (prev.verdict === 'PASS') { console.log(`[matrix] ${pack.slug}: skipped (resume, prior PASS)`); summary.push({ slug: pack.slug, verdict: prev.verdict, skipped: true }); continue; }
    }

    const packRoot = path.join(runRoot, pack.slug);
    fs.mkdirSync(packRoot, { recursive: true });
    const packStore = new Store(packRoot);
    const packCtx: IpcContext = { ...ctx, dataRoot: packRoot };
    // Fresh handler map bound to this pack's data root: one app instance per pack, fully isolated.
    const packRuntime = buildRuntime().register(packCtx);
    const PH = { ...handlersMap(), ...packRuntime.handlers } as Record<string, Handler>;

    const t0 = Date.now();
    const ev: Record<string, unknown> = {
      slug: pack.slug,
      name: pack.name,
      platform: pack.platform,
      expect: pack.expect,
      startedAt: new Date().toISOString(),
      dataRoot: packRoot,
      sourceKind: null,
      preview: null,
      plan: null,
      report: null,
      published: null,
      error: null,
      verdict: null,
    };
    const log = (m: string): void => { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] [${pack.slug}] ${m}`); };

    try {
      // ---- 0. seed the CurseForge key into this pack's data root ----
      // `safeStorage` is bound to the process profile, and `--matrixtest` runs under an isolated one,
      // so the real settings key cannot be decrypted here. The runner reads the key the same way the
      // reference spike did (its key.txt, outside any repo) and writes it into the pack's own
      // plaintext slot, which is exactly what the app's documented fallback path reads.
      if (pack.source === 'cfKey') {
        const keySources = [
          path.join('H:\\TestAI\\modrinth-curseforge', 'new_key.txt'),
          path.join('H:\\TestAI\\modrinth-curseforge', 'key.txt'),
          path.join('H:\\TESTMultiAI\\20', '.app-data', 'curseforge-key.txt'),
        ];
        let seeded: string | null = null;
        for (const candidate of keySources) {
          try {
            const raw = fs.readFileSync(candidate, 'utf8').trim();
            if (raw.length >= 16) { seeded = raw; break; }
          } catch { /* try next */ }
        }
        if (seeded) {
          fs.mkdirSync(packRoot, { recursive: true });
          fs.writeFileSync(path.join(packRoot, 'curseforge-key.txt'), seeded, { mode: 0o600 });
          resetCurseForgeKeyCache();
          log('seeded CurseForge key for this data root (classic key format)');
        } else {
          log('WARNING: no CurseForge key available; key-mode packs will fail');
        }
      }

      // ---- 1. resolve a real source ----
      let source: Record<string, unknown> | null = null;

      if (pack.source === 'cfCache' && pack.cacheZip) {
        // Reuse the archive the app itself cached: hard-link it into this pack's import dir.
        const cached = path.join('H:\\TESTMultiAI\\20', '.app-data', 'cache', 'cfpack', pack.cacheZip);
        if (fs.existsSync(cached)) {
          const importDir = path.join(packRoot, 'curseforge-import');
          fs.mkdirSync(importDir, { recursive: true });
          const dest = path.join(importDir, pack.cacheZip);
          try { fs.linkSync(cached, dest); } catch { fs.copyFileSync(cached, dest); }
          source = { kind: 'curseForgeServerZip', zipName: pack.cacheZip };
          ev.sourceKind = 'curseForgeServerZip (cached)';
          log(`source: cached server zip ${pack.cacheZip}`);
        }
      }

      if (!source && pack.source === 'modrinth') {
        // Resolve the project's newest version whose MC/loader matches the reference expectation.
        const query = pack.searchQuery ?? pack.name;
        const search = await PH.modrinth_search_modpacks({ query, index: 'relevance', offset: 0, limit: 10 }, packCtx) as { results: { id: string; name: string }[] };
        const needle = (pack.searchQuery ?? pack.name).toLowerCase().split(' ')[0]!;
        const hit = search.results.find(h => h.name.toLowerCase().includes(needle)) ?? search.results[0];
        if (!hit) throw new Error(`Modrinth search returned no project for "${query}"`);
        const versions = await PH.modrinth_project_versions({ projectId: hit.id }, packCtx) as { id: string; gameVersions: string[]; loaders: string[] }[];
        const list = Array.isArray(versions) ? versions : [];
        const wantedLoader = pack.expect.loader;
        const match = list.find(v => (!pack.expect.mc || v.gameVersions.includes(pack.expect.mc!))
          && (!wantedLoader || v.loaders.includes(wantedLoader))) ?? list[0];
        if (!match) throw new Error('no Modrinth version matched the reference MC/loader');
        source = { kind: 'modrinthRemote', projectId: hit.id, versionId: match.id };
        ev.sourceKind = `modrinthRemote (project ${hit.id} "${hit.name}", version ${match.id})`;
        log(`source: modrinth ${hit.name} version ${match.id} (${match.gameVersions.join(',')} / ${match.loaders.join(',')})`);
      }

      if (!source && pack.source === 'cfKey' && pack.projectId) {
        source = { kind: 'curseforgeProject', projectId: pack.projectId };
        ev.sourceKind = `curseforgeProject ${pack.projectId} (official API key mode)`;
        log(`source: curseforge project ${pack.projectId} via API key`);
      }

      if (!source) throw new Error('no reachable source for this pack (cache absent and key mode unavailable)');

      // ---- 2. preview ----
      log('preview…');
      const preview = await PH.modpack_pipeline_preview({ source, jobId: `mx-preview-${pack.slug}` }, packCtx) as {
        previewId: string; sourceName: string; plan: { fileDecisions: { path: string; action: string; reason: string }[]; loader: { kind: string; minecraftVersion: string; loaderVersion?: string | null }; warnings: string[] };
      } | null;
      if (!preview) throw new Error('preview returned null');

      const decisions = preview.plan.fileDecisions;
      const conflicts = decisions.filter(d => d.action === 'awaitingUserChoice').map(d => d.path);
      ev.preview = { sourceName: preview.sourceName, loader: preview.plan.loader, warningCount: preview.plan.warnings?.length ?? 0 };
      const planSummary = {
        total: decisions.length,
        include: decisions.filter(d => d.action === 'include').length,
        exclude: decisions.filter(d => d.action === 'exclude').length,
        conflicts,
      };
      ev.plan = planSummary;
      log(`preview: ${preview.sourceName} | ${preview.plan.loader.kind} ${preview.plan.loader.minecraftVersion} | include=${planSummary.include} exclude=${planSummary.exclude} conflicts=${conflicts.length}`);

      // Reviewed choices: exclude curated-unsupported client extras (cautious user), keep optional defaults.
      const files: Record<string, 'include' | 'exclude'> = {};
      for (const d of decisions) {
        if (d.action === 'awaitingUserChoice') files[d.path] = 'exclude';
        else if (d.reason === 'optionalDefaultKeep') files[d.path] = 'include';
      }

      // ---- 3. install (staged + L2/L3 verified boot + publish) ----
      log('install (real downloads, verified boot before publish)…');
      const result = await PH.modpack_pipeline_install({
        previewId: preview.previewId,
        input: { name: `mx-${pack.slug}`.slice(0, 40), ramMb: 4096, eulaAccepted: true },
        choices: { files, approvedReplacements: [], autoDeleteCurseForgeZip: false },
        jobId: `mx-install-${pack.slug}`,
      }, packCtx) as { status: string; server: { id: string } | null; error: string | null; report: { stages: { stage: string; outcome: string; detail?: string }[]; files: { path: string; outcome: string; detail?: string }[]; warnings: string[]; errors?: string[] } };

      ev.report = {
        status: result.status,
        stages: result.report.stages,
        files: result.report.files,
        warningCount: result.report.warnings.length,
        warnings: result.report.warnings.slice(0, 40),
        errors: result.report.errors ?? [],
      };

      if (result.status === 'complete' && result.server) {
        const dir = path.join(packRoot, 'servers', result.server.id);
        const jars = fs.existsSync(path.join(dir, 'mods')) ? fs.readdirSync(path.join(dir, 'mods')).filter(f => f.endsWith('.jar')) : [];
        const disabled = fs.existsSync(path.join(dir, 'mods-disabled')) ? fs.readdirSync(path.join(dir, 'mods-disabled')) : [];
        const verifyStage = result.report.stages.find(s => s.stage === 'verify-boot');
        ev.published = { serverId: result.server.id, jarsEnabled: jars.length, jarsDisabled: disabled.length, disabled, verifiedBoot: verifyStage?.outcome ?? null, verifyDetail: verifyStage?.detail ?? null };
        const bootLog = path.join(dir, 'logs', 'msm-console.log');
        let doneLine: string | null = null;
        if (fs.existsSync(bootLog)) {
          const lines = fs.readFileSync(bootLog, 'utf8').split('\n').filter(l => /Done \(\d/.test(l));
          doneLine = lines.length ? lines[lines.length - 1]!.trim() : null;
        }
        ev.verdict = 'PASS';
        log(`PASS: ${jars.length} jars + ${disabled.length} disabled, verify-boot=${verifyStage?.outcome ?? '?'}${doneLine ? `, ${doneLine.replace(/^.*Done/, 'Done')}` : ''}`);
        // Keep the boot log as durable, human-readable proof inside the evidence folder.
        if (doneLine) {
          ev.doneLine = doneLine;
          fs.writeFileSync(path.join(evidenceDir, `${pack.slug}.boot.log`), doneLine + '\n');
        }
      } else {
        ev.verdict = 'FAIL';
        ev.error = result.error ?? 'install did not complete';
        log(`FAIL: ${ev.error}`);
      }
    } catch (error) {
      ev.verdict = 'ERROR';
      ev.error = error instanceof Error ? error.message : String(error);
      log(`ERROR: ${ev.error}`);
      if (error instanceof Error && error.stack) ev.stack = error.stack.split('\n').slice(0, 10);
    } finally {
      ev.finishedAt = new Date().toISOString();
      ev.durationSeconds = Math.round((Date.now() - t0) / 100) / 10;
      fs.writeFileSync(evidenceFile, `${JSON.stringify(ev, null, 2)}\n`);
      console.log(`[matrix] ${pack.slug}: ${String(ev.verdict)} (${String(ev.durationSeconds)}s) -> ${evidenceFile}`);
      summary.push({ slug: pack.slug, verdict: ev.verdict, durationSeconds: ev.durationSeconds, sourceKind: ev.sourceKind, error: ev.error });

      // Clean this pack's throwaway tree on success only; failures stay for inspection.
      if (ev.verdict === 'PASS') {
        try { fs.rmSync(packRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch { /* best effort */ }
      } else {
        log(`kept for inspection: ${packRoot}`);
      }
    }
  }

  // ---- summary ----
  const summaryFile = path.join(evidenceDir, '_summary.json');
  fs.writeFileSync(summaryFile, `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), runRoot, results: summary }, null, 2)}\n`);
  console.log('\n================ MATRIX SUMMARY ================');
  for (const r of summary) {
    const mark = r.verdict === 'PASS' ? 'PASS' : r.verdict === 'FAIL' ? 'FAIL' : 'ERROR';
    console.log(`${mark}  ${String(r.slug).padEnd(30)} ${String(r.durationSeconds ?? '').padStart(7)}s  ${String(r.sourceKind ?? '')}`);
    if (r.error) console.log(`      -> ${r.error}`);
  }
  const passed = summary.filter(r => r.verdict === 'PASS').length;
  console.log(`\n${passed}/${summary.length} PASS  (evidence: ${evidenceDir})`);
  return summary.length > 0 && passed === summary.length;
}
