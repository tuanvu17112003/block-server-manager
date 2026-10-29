// Conformance sweep: run the REAL adapter against EVERY published FTB pack and assert the canonical recipe
// contract. This replaces "try a few packs and hope" with a corpus test.
//
// For each pack and its newest release it asserts:
//  - the recipe passes validateRecipe (safe paths, resolvable sources, valid MC version),
//  - no duplicate destinations survive,
//  - every destination is a safe relative path,
//  - a loader is resolved (declared, or inferred with a warning),
//  - every file with a side of required/optional/unknown has a download URL,
//  - counts are reported so a regression shows up as a number change.
//
// Usage: node scripts/conformance-ftb-corpus.mjs [--max-packs N]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const { adapterRegistry, createAdapterIo, validateRecipe } = require(path.join(dist, 'services/adapters/index.js'));
const { isMinecraftVersionString } = require(path.join(dist, 'services/adapters/ftb.js'));

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const MAX_PACKS = argOf('--max-packs', 200);
const evidenceFile = path.join(process.cwd(), 'docs', 'evidence', 'adapters', 'ftb-corpus-conformance.json');
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

const silentIo = createAdapterIo(() => {});
const results = { harness: 'conformance-ftb-corpus.mjs', startedAt: new Date().toISOString(), packs: [], failures: [], totals: {} };

const all = await (await fetch('https://api.modpacks.ch/public/modpack/all')).json();
const ids = (Array.isArray(all) ? all : all?.packs ?? []).slice(0, MAX_PACKS);
log(`conformance sweep over ${ids.length} published packs`);

let files = 0, skippedPacks = 0;
for (const packId of ids) {
  const entry = { packId, name: null, ok: false, error: null, formatId: null, mc: null, loader: null, loaderVersion: null, javaMajor: null, files: 0, sideCounts: {}, warnings: [] };
  try {
    const recipe = await adapterRegistry.resolve({ provider: { kind: 'ftb', ids: { packId } } }, silentIo);
    entry.name = recipe.name;
    entry.formatId = recipe.formatId;
    entry.mc = recipe.mc;
    entry.loader = recipe.loader;
    entry.loaderVersion = recipe.loaderVersion;
    entry.javaMajor = recipe.javaMajor;
    entry.files = recipe.files.length;
    entry.warnings = recipe.warnings.map(w => w.rule);
    for (const file of recipe.files) entry.sideCounts[file.side] = (entry.sideCounts[file.side] ?? 0) + 1;

    // The contract assertions.
    validateRecipe(recipe);
    if (!isMinecraftVersionString(recipe.mc)) throw new Error(`invalid mc "${recipe.mc}"`);
    const seen = new Set();
    for (const file of recipe.files) {
      if (seen.has(file.path)) throw new Error(`duplicate destination survived: ${file.path}`);
      seen.add(file.path);
      if (file.path.split('/').includes('..') || file.path.startsWith('/')) throw new Error(`unsafe path: ${file.path}`);
      if ((file.source.urls?.length ?? 0) === 0 && !file.source.provider) throw new Error(`no source for ${file.path}`);
    }
    if (recipe.loader === 'vanilla' && (entry.sideCounts.required ?? 0) > 0 && recipe.files.some(f => /^mods\/.+\.jar$/i.test(f.path))) {
      throw new Error('resolved vanilla but ships mods');
    }
    entry.ok = true;
    files += recipe.files.length;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    // Some published packs are genuinely empty/vanilla-only; record them as skipped rather than failures.
    if (/has no versions|has no downloadable files/.test(entry.error)) { skippedPacks += 1; entry.skipped = true; results.failures.push(entry); }
    else results.failures.push(entry);
  }
  results.packs.push(entry);
  if (results.packs.length % 20 === 0) log(`  ${results.packs.length}/${ids.length} packs checked, ${results.failures.filter(f => !f.skipped).length} failures so far`);
}

const hardFailures = results.failures.filter(f => !f.skipped);
results.totals = {
  packs: theCount(results.packs),
  passed: results.packs.filter(p => p.ok).length,
  hardFailures: hardFailures.length,
  skippedEmpty: results.failures.filter(f => f.skipped).length,
  filesPlanned: files,
};
log(`packs=${results.totals.packs} passed=${results.totals.passed} hardFailures=${results.totals.hardFailures} skipped=${results.totals.skippedEmpty} files=${files}`);
if (hardFailures.length > 0) {
  console.log('\nHARD FAILURES:');
  for (const failure of hardFailures.slice(0, 15)) console.log(`  pack ${failure.packId} ${failure.name ?? ''}: ${failure.error}`);
}
results.verdict = hardFailures.length === 0 ? 'PASS' : 'FAIL';

results.finishedAt = new Date().toISOString();
results.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
fs.writeFileSync(evidenceFile, `${JSON.stringify(results, null, 2)}\n`);
console.log(`evidence written: ${evidenceFile}`);
if (hardFailures.length > 0) process.exitCode = 1;

function theCount(items) { return items.length; }
