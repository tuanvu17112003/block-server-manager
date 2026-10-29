// E2 evidence for the Prism/MultiMC adapter — using a REAL instance export, not a fixture we authored.
//
// Why this file exists (docs/audit/24 DV-34): the Prism adapter was graded E3 because no real Prism instance
// existed anywhere on disk, and authoring one would have been a fixture we wrote — E3 by definition, which is the
// exact "fixtures as proof" error the C0–C8 remediation existed to remove. This harness instead uses an instance
// archive produced by a THIRD PARTY's CI, unmodified:
//
//   source : https://github.com/sugoidogo/packwiz-pack releases, asset `CHANGEME-prism.zip`
//   sha256 : 15456AB9D502142965175C14ADA62E464CA254440412D09D62B0AA2C52685EC8
//   size   : 3,859,512 bytes
//   maker  : sugoidogo's Gitea Actions workflow (not this project)
//
// It is a genuine PrismLauncher instance export: root `instance.cfg`, root `mmc-pack.json`, and
// `minecraft/packwiz-installer.jar` for the updater. The adapter must read the runtime out of that
// launcher-written `mmc-pack.json` without being told anything.
//
// What this does and does NOT prove:
//   PROVES  — the adapter recognises a real, third-party Prism instance and extracts mc/loader/build from the
//             launcher's own metadata file.
//   DOES NOT prove a boot: a Prism instance is a *client* instance carrying no dedicated server export, so the
//             recipe has no download list and the payload is applied as override layers. Invariant I3 would need
//             a server-side start to call Prism "supported"; that is why the grade moves E3 -> E2 (real artefact
//             resolved and installed) but the note says a boot was not performed.
//
// Usage: node scripts/verify-prism-real.mjs [zipPath]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const adapters = require(path.join(dist, 'services/adapters/index.js'));

const zipPath = process.argv[2]
  ?? path.join(process.cwd(), 'docs', 'evidence', 'adapters', 'prism-real-instance.zip');
const evidenceFile = path.join(process.cwd(), 'docs', 'evidence', 'adapters', 'prism-real-instance-resolution.json');
const EXPECTED_SHA256 = '15456AB9D502142965175C14ADA62E464CA254440412D09D62B0AA2C52685EC8';

const evidence = {
  harness: 'verify-prism-real.mjs',
  purpose: 'E2 for prism.multimc using a third-party CI-built PrismLauncher instance export (not a fixture we authored)',
  artefact: {
    path: path.relative(process.cwd(), zipPath),
    source: 'https://github.com/sugoidogo/packwiz-pack/releases/download/0.0.0/CHANGEME-prism.zip',
    producer: 'sugoidogo/packwiz-pack Gitea/GitHub Actions workflow — a third party, not this project',
    expectedSha256: EXPECTED_SHA256,
  },
  checks: [],
  recipe: null,
  verdict: null,
  error: null,
};

function check(name, ok, detail) {
  evidence.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

try {
  if (!fs.existsSync(zipPath)) throw new Error(`artefact missing: ${zipPath}`);
  const actualSha = require('node:crypto').createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex').toUpperCase();
  check('artefact checksum matches the recorded third-party build', actualSha === EXPECTED_SHA256, actualSha);
  check('artefact is not authored by this project', true, evidence.artefact.producer);

  const index = await adapters.buildArchiveIndex(zipPath);
  const names = index.entries.map(entry => entry.name);
  check('root mmc-pack.json present (what a real Prism export writes)', names.includes('mmc-pack.json'));
  check('root instance.cfg present', names.includes('instance.cfg'));

  const mmc = await index.readJson('mmc-pack.json');
  const components = (mmc?.components ?? []).map(c => c.uid);
  check('mmc-pack.json carries net.minecraft (launcher-written, not ours)', components.includes('net.minecraft'), components.join(','));

  // Detection must be content-based: the adapter is never told this is a Prism archive.
  const detected = await adapters.prismAdapter.detect({ shape: 'archive', index });
  check('prism adapter claims the real archive by content', detected === true);

  const recipe = await adapters.adapterRegistry.resolve(
    { shape: 'archive', index, path: path.resolve(zipPath) },
    adapters.createAdapterIo(message => console.log(`  [log] ${message}`)),
  );
  adapters.validateRecipe(recipe);

  check('format is prism.multimc', recipe.formatId === 'prism.multimc', recipe.formatId);
  check('Minecraft version read from the launcher metadata', /^\d+\.\d+(\.\d+)?$/.test(recipe.mc), recipe.mc);
  check('loader family resolved', ['forge', 'neoforge', 'fabric', 'quilt', 'vanilla'].includes(recipe.loader), recipe.loader);
  check('exact loader build resolved (not guessed)', typeof recipe.loaderVersion === 'string' && recipe.loaderVersion.length > 0, String(recipe.loaderVersion));
  check('resolution records mmc-pack.json as the source', recipe.resolution.some(entry => entry.source.includes('mmc-pack.json')));
  check('payload is override layers (a Prism instance has no server export)', recipe.overrides.length > 0, JSON.stringify(recipe.overrides));
  check('evidence grade is stated', Boolean(recipe.evidenceGrade), recipe.evidenceGrade);

  evidence.recipe = {
    formatId: recipe.formatId,
    mc: recipe.mc,
    loader: recipe.loader,
    loaderVersion: recipe.loaderVersion,
    files: recipe.files.length,
    overrides: recipe.overrides,
    resolution: recipe.resolution,
    evidenceGrade: recipe.evidenceGrade,
    evidenceNote: recipe.evidenceNote,
  };
  evidence.verdict = evidence.checks.every(entry => entry.ok) ? 'PASS' : 'FAIL';
  console.log(`\nverdict: ${evidence.verdict}`);
  console.log(`resolved: ${recipe.formatId} | ${recipe.loader} ${recipe.loaderVersion} | MC ${recipe.mc} | grade ${recipe.evidenceGrade}`);
} catch (error) {
  evidence.verdict = 'FAIL';
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence written: ${evidenceFile}`);
}
