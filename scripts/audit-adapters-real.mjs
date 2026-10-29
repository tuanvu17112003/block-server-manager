// Phase A evidence audit: run the adapter layer against REAL artefacts, not fixtures I authored.
//
// This is the harness the previous phase was missing. Three evidence sources, none of which I wrote:
//   A1. real CurseForge server packs already cached on disk (plain.serverzip / curseforge paths)
//   A2. real packwiz packs fetched over HTTP from public repositories (GitHub code search corpus)
//   A3. real .mrpack files cached on disk (sanity: the adapter layer must not regress the working path)
//
// For every artefact it records: which adapter claimed it, the canonical recipe, whether validateRecipe
// passed, and every honest problem found. Nothing is "fixed" here â€” this harness only measures.
//
// Usage: node scripts/audit-adapters-real.mjs [--packwiz N] [--skip-cf] [--skip-packwiz] [--skip-mrpack]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const { adapterRegistry, createAdapterIo, validateRecipe } = require(path.join(dist, 'services/adapters/index.js'));
const { normalizeArchive, cleanupNormalized } = require(path.join(dist, 'services/adapters/normalize.js'));

const argNum = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const has = (flag) => process.argv.includes(flag);
const PACKWIZ_COUNT = argNum('--packwiz', 8);
const evidenceFile = path.join(process.cwd(), 'docs', 'evidence', 'adapters', 'real-artefact-audit.json');
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);
const silentIo = createAdapterIo(() => {});

const report = {
  harness: 'audit-adapters-real.mjs',
  startedAt: new Date().toISOString(),
  premise: 'real artefacts only; no fixture authored by the harness is used as evidence',
  archives: [],
  packwiz: [],
  defects: [],
  verdict: null,
};

/** Describe a recipe compactly for the record. */
function describe(recipe) {
  return {
    formatId: recipe.formatId,
    name: recipe.name,
    mc: recipe.mc,
    loader: recipe.loader,
    loaderVersion: recipe.loaderVersion,
    javaMajor: recipe.javaMajor,
    fileCount: recipe.files.length,
    overrideLayers: recipe.overrides.map(layer => layer.prefix || '(root)'),
    launchShape: recipe.launchShape,
    sideCounts: recipe.files.reduce((acc, file) => ({ ...acc, [file.side]: (acc[file.side] ?? 0) + 1 }), {}),
    warningRules: [...new Set(recipe.warnings.map(w => w.rule))],
    resolution: recipe.resolution,
    sampleFiles: recipe.files.slice(0, 3).map(file => file.path),
  };
}

/** Run one archive through normalization â†’ detection â†’ resolve, recording everything. */
async function auditArchive(label, archivePath) {
  const entry = { label, path: archivePath, sizeBytes: fs.statSync(archivePath).size, normalization: null, candidates: null, recipe: null, validation: null, error: null, ok: false };
  let normalized = null;
  try {
    // C2: research Â§6 step 2 â€” normalize BEFORE detection (unwrap one nested zip, detect wrapper dir).
    normalized = await normalizeArchive(archivePath);
    entry.normalization = {
      unwrapped: normalized.unwrapped,
      nestedZip: normalized.nestedZip,
      strippedPrefix: normalized.strippedPrefix,
      outerEntryCount: normalized.outerEntryCount,
      effectiveEntryCount: normalized.index.entries.length,
    };
    if (normalized.unwrapped) {
      log(`${label}: unwrapped nested zip "${normalized.nestedZip}" (${normalized.outerEntryCount} â†’ ${normalized.index.entries.length} entries)`);
    }
    const archive = normalized.index;
    entry.entryCount = archive.entries.length;
    const ctx = { archive };
    entry.candidates = (await adapterRegistry.candidates(ctx)).map(adapter => adapter.id);
    log(`${label}: candidates = ${entry.candidates.join(', ') || '(none)'}`);
    if (entry.candidates.length === 0) throw new Error('no adapter claimed this real archive');
    const recipe = await adapterRegistry.resolve(ctx, silentIo);
    validateRecipe(recipe);
    entry.validation = 'passed';
    entry.recipe = describe(recipe);
    entry.ok = true;
    log(`${label}: ${recipe.formatId} | ${recipe.loader} ${recipe.loaderVersion ?? '(unpinned)'} MC ${recipe.mc} | ${recipe.files.length} files, layers ${entry.recipe.overrideLayers.join('+')}`);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    log(`${label}: FAILED â€” ${entry.error}`);
  } finally {
    if (normalized) cleanupNormalized(normalized);
  }
  report.archives.push(entry);
  return entry;
}

try {
  // ---------- A1: real CurseForge server packs ----------
  if (!has('--skip-cf')) {
    const cfDir = path.join(process.cwd(), '.app-data', 'cache', 'cfpack');
    const zips = fs.existsSync(cfDir) ? fs.readdirSync(cfDir).filter(name => name.toLowerCase().endsWith('.zip')) : [];
    log(`A1: ${zips.length} real CurseForge server pack(s) on disk`);
    for (const zip of zips) {
      await auditArchive(`cf:${zip}`, path.join(cfDir, zip));
    }
  }

  // ---------- A3: real .mrpack ----------
  if (!has('--skip-mrpack')) {
    const mrDir = path.join(process.cwd(), '.app-data', 'cache', 'mrpack');
    const packs = fs.existsSync(mrDir) ? fs.readdirSync(mrDir).filter(name => name.toLowerCase().endsWith('.mrpack')) : [];
    log(`A3: ${packs.length} real .mrpack file(s) on disk`);
    for (const pack of packs) {
      await auditArchive(`mrpack:${pack}`, path.join(mrDir, pack));
    }
  }

  // ---------- A2: real packwiz packs over HTTP ----------
  if (!has('--skip-packwiz')) {
    log(`A2: fetching real packwiz packs over HTTP (target ${PACKWIZ_COUNT})`);
    // Candidates discovered by GitHub code search `filename:pack.toml "packwiz:1.1.0"` â€” public, fetchable.
    const repos = [
      'GregTech-Odyssey/GregTech-Odyssey',
      'Laskyyy/Create-Astral',
      'DM-Earth/Cabricality',
      'GregTechCEu/GregTech-Modern-Community-Pack',
      'Ministry-of-CBT/Project-CBT',
      'Jasons-impart/Create-Delight-Remake',
      'Fabulously-Optimized/fabulously-optimized',
      'game-design-driven/Create-Prepare-to-Dye',
    ].slice(0, PACKWIZ_COUNT);

    for (const repo of repos) {
      const entry = { repo, packFile: null, packToml: null, indexToml: null, metafiles: [], recipe: null, validation: null, error: null, ok: false };
      try {
        // The pack file may be `pack.toml` or `modpack.toml` â€” discovered from real data, not assumed.
        let packFile = null;
        let packText = null;
        for (const candidate of ['pack.toml', 'modpack.toml', 'Packwiz/1.21/pack.toml', 'Packwiz/26.3/pack.toml', 'Packwiz/1.20.4/pack.toml']) {
          const response = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${candidate}`);
          if (response.ok) { packFile = candidate; packText = await response.text(); break; }
        }
        if (!packFile) throw new Error('no pack.toml/modpack.toml at any known path');
        entry.packFile = packFile;
        entry.packTomlBytes = packText.length;

        const packDir = packFile.includes('/') ? packFile.slice(0, packFile.lastIndexOf('/') + 1) : '';
        const indexResponse = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${packDir}index.toml`);
        if (!indexResponse.ok) throw new Error(`no index.toml beside ${packFile} (HTTP ${indexResponse.status})`);
        const indexText = await indexResponse.text();
        entry.indexTomlBytes = indexText.length;

        // Materialise the REAL fetched metadata into a zip and drive the adapter over it.
        const zipPath = path.join(process.cwd(), '.tmp-audit', `${repo.replaceAll('/', '_')}.zip`);
        fs.mkdirSync(path.dirname(zipPath), { recursive: true });
        const { writeRealZip } = await import('./lib/zip-writer.mjs');
        // Fetch up to 6 real metafiles referenced by index.toml so the adapter has real per-mod sides.
        const metafilePaths = [...indexText.matchAll(/file\s*=\s*"([^"]+\.pw\.toml)"/g)].map(match => match[1]).slice(0, 6);
        const entries = [[`${packDir}pack.toml`.replace(/^\.\//, ''), packText], [`${packDir}index.toml`.replace(/^\.\//, ''), indexText]];
        for (const metafilePath of metafilePaths) {
          const response = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${metafilePath}`);
          if (!response.ok) continue;
          entries.push([metafilePath, await response.text()]);
          entry.metafiles.push(metafilePath);
        }
        // The adapter looks for `pack.toml` at the archive root, so normalise a modpack.toml into pack.toml.
        if (packFile.endsWith('modpack.toml') && packDir === '') entries.push(['pack.toml', packText]);
        writeRealZip(zipPath, entries);

        const archive = await buildArchiveIndex(zipPath);
        const ctx = { archive };
        entry.candidates = (await adapterRegistry.candidates(ctx)).map(adapter => adapter.id);
        if (entry.candidates[0] !== 'packwiz') {
          throw new Error(`packwiz must claim this real pack; got "${entry.candidates[0] ?? '(none)'}"`);
        }
        const recipe = await adapterRegistry.resolve(ctx, silentIo);
        validateRecipe(recipe);
        entry.validation = 'passed';
        entry.recipe = describe(recipe);
        entry.ok = true;
        log(`${repo}: ${recipe.loader} ${recipe.loaderVersion ?? '(unpinned)'} MC ${recipe.mc} | ${recipe.files.length} metafiles (${entry.metafiles.length} fetched)`);
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        log(`${repo}: FAILED â€” ${entry.error}`);
        report.defects.push({ source: 'packwiz', repo, defect: entry.error });
      }
      report.packwiz.push(entry);
    }
  }

  // ---------- summary ----------
  const archiveOk = report.archives.filter(entry => entry.ok).length;
  const packwizOk = report.packwiz.filter(entry => entry.ok).length;
  report.summary = {
    realArchives: { total: report.archives.length, resolved: archiveOk },
    realPackwiz: { total: report.packwiz.length, resolved: packwizOk },
    formatsObserved: [...new Set([...report.archives, ...report.packwiz].filter(entry => entry.recipe).map(entry => entry.recipe.formatId))],
    defects: report.defects.length,
  };
  log(`SUMMARY: archives ${archiveOk}/${report.archives.length}, packwiz ${packwizOk}/${report.packwiz.length}, formats ${report.summary.formatsObserved.join(', ')}`);
  report.verdict = archiveOk === report.archives.length && packwizOk === report.packwiz.length ? 'PASS' : 'DEFECTS_FOUND';
} catch (error) {
  report.verdict = 'ERROR';
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${report.error}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`evidence written: ${evidenceFile}`);
}

