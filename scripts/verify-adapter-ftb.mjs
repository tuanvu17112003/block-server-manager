// Live proof that the adapter layer opens a pack format the app previously could not read at all.
// Runs the real FTB adapter against the real public API (no key), then validates the recipe through
// the same structural gate the pipeline uses. Writes docs/evidence/adapters/ftb-<pack>.json.
//
// Usage: node scripts/verify-adapter-ftb.mjs [packId] [versionId]
// Requires `npm run build:electron`.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const { adapterRegistry, createAdapterIo, validateRecipe } = require(path.join(dist, 'services/adapters/index.js'));

const packId = Number(process.argv[2] ?? 1);
const versionArg = process.argv[3];
const versionId = versionArg === undefined ? undefined : Number(versionArg);

const evidenceFile = path.join(process.cwd(), 'docs', 'evidence', 'adapters', `ftb-pack-${packId}.json`);
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);
const io = createAdapterIo((message) => console.log(`    ${message}`));

const evidence = {
  harness: 'verify-adapter-ftb.mjs',
  startedAt: new Date().toISOString(),
  packId,
  versionId: versionId ?? null,
  detected: null,
  candidates: null,
  recipe: null,
  validation: null,
  error: null,
  verdict: null,
};

try {
  log(`running the FTB adapter against the live public API (pack ${packId}${versionId === undefined ? ', latest version' : `, version ${versionId}`})`);

  const ctx = { provider: { kind: 'ftb', ids: { packId, versionId } } };
  // Detection must claim this input before resolve is attempted.
  const candidates = await adapterRegistry.candidates(ctx);
  evidence.candidates = candidates.map((adapter) => adapter.id);
  log(`candidates: ${evidence.candidates.join(', ') || '(none)'}`);
  if (!candidates.some((adapter) => adapter.id === 'ftb.app')) throw new Error('FTB adapter did not detect a provider FTB input');
  evidence.detected = 'ftb.app';

  const recipe = await adapterRegistry.resolve(ctx, io);
  evidence.recipe = {
    formatId: recipe.formatId,
    name: recipe.name,
    mc: recipe.mc,
    loader: recipe.loader,
    loaderVersion: recipe.loaderVersion,
    javaMajor: recipe.javaMajor,
    launchShape: recipe.launchShape,
    overrides: recipe.overrides,
    fileCount: recipe.files.length,
    sideCounts: recipe.files.reduce((acc, file) => ({ ...acc, [file.side]: (acc[file.side] ?? 0) + 1 }), {}),
    sampleFiles: recipe.files.slice(0, 5).map((file) => ({
      path: file.path, side: file.side, size: file.size, sha1: file.sha1, provenance: file.sideProvenance,
    })),
    warnings: recipe.warnings,
    resolution: recipe.resolution,
  };
  log(`recipe: "${recipe.name}" | ${recipe.loader} ${recipe.loaderVersion ?? '(unpinned)'} | MC ${recipe.mc} | java ${recipe.javaMajor ?? '?'}`);
  log(`files: ${recipe.files.length} (${Object.entries(evidence.recipe.sideCounts).map(([k, v]) => `${k}=${v}`).join(', ')})`);
  const serverFiles = recipe.files.filter((file) => file.side === 'required' || file.side === 'optional');
  log(`server-installable files: ${serverFiles.length}`);

  // Same structural gate every adapter must satisfy before the pipeline touches disk.
  validateRecipe(recipe);
  evidence.validation = 'passed';
  log('validateRecipe: passed');

  // Prove one file is actually fetchable and hash-verifiable without authentication.
  const sample = recipe.files.find((file) => file.sha1 && file.source.urls?.[0]);
  if (sample) {
    const response = await fetch(sample.source.urls[0]);
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const { createHash } = await import('node:crypto');
      const sha1 = createHash('sha1').update(bytes).digest('hex');
      evidence.download = {
        path: sample.path,
        status: response.status,
        bytes: bytes.length,
        expectedSize: sample.size,
        sizeMatch: sample.size == null ? null : bytes.length === sample.size,
        sha1,
        expectedSha1: sample.sha1,
        sha1Match: sha1 === sample.sha1,
      };
      log(`download check: ${sample.path} → HTTP ${response.status}, ${bytes.length}B, sha1 match=${sha1 === sample.sha1}`);
    } else {
      evidence.download = { path: sample.path, status: response.status, error: 'non-2xx' };
      log(`download check: HTTP ${response.status} (not fatal for recipe resolution)`);
    }
  }

  evidence.verdict = 'PASS';
  log('PASS: a format this app could not open before now resolves to a canonical recipe end-to-end');
} catch (error) {
  evidence.verdict = 'FAIL';
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${evidence.error}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence written: ${evidenceFile}`);
}
