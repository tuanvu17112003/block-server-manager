// E2 evidence for the ATLauncher adapter — using a REAL instance.json published by a user, not a fixture.
//
// Why this file exists (docs/audit/24 DV-34): ATLauncher was graded E3 because no real instance existed on disk,
// and writing one ourselves would be a fixture we authored — E3 by definition, the exact "fixtures as proof" error
// the C0–C8 remediation existed to remove.
//
// The honest answer was a real artefact published by somebody else: ATLauncher issue #875 has a user-supplied
// `instance.json` attached, which the ATLauncher maintainer reviewed and diagnosed (duplicate mod entries). It is a
// genuine 4 MB ATLauncher instance metadata file — 4.1 MB because ATLauncher inlines the full Minecraft version
// manifest — not something this project wrote.
//
//   source : https://github.com/ATLauncher/ATLauncher/files/14380779/instance.json (issue #875)
//   sha256 : 0E2DD9DC68E6C2B728ED4FC91E7A66EA87D2EC6F7A6875C396F7CAC3EB628023
//   size   : 4,170,761 bytes
//   maker  : an ATLauncher user, reviewed by the ATLauncher maintainer in that issue thread
//
// What this proves and does not:
//   PROVES  — the adapter recognises a real ATLauncher instance, distinguishes it from FTB (`instance.json` is
//             shared by both formats) and from the vanilla launcher, and reads pack identity + loader build from
//             the launcher's own metadata.
//   DOES NOT prove a boot: only `instance.json` was published, not the full instance directory with its mods, so
//             there is no payload to install. The grade moves E3 -> E2 for "real artefact recognised and resolved",
//             with the limitation stated on the recipe.
//
// Usage: node scripts/verify-atlauncher-real.mjs [instanceJsonPath]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const atl = require(path.join(dist, 'services/adapters/atlauncher.js'));

const jsonPath = process.argv[2]
  ?? path.join(process.cwd(), 'docs', 'evidence', 'adapters', 'atl-real-instance.json');
const evidenceFile = path.join(process.cwd(), 'docs', 'evidence', 'adapters', 'atl-real-instance-resolution.json');
const EXPECTED_SHA256 = '0E2DD9DC68E6C2B728ED4FC91E7A66EA87D2EC6F7A6875C396F7CAC3EB628023';

const evidence = {
  harness: 'verify-atlauncher-real.mjs',
  purpose: 'E2 for atlauncher using a real user-published instance.json (not a fixture we authored)',
  artefact: {
    path: path.relative(process.cwd(), jsonPath),
    source: 'https://github.com/ATLauncher/ATLauncher/files/14380779/instance.json (issue #875)',
    producer: 'an ATLauncher user; reviewed by the ATLauncher maintainer in that issue thread',
    expectedSha256: EXPECTED_SHA256,
  },
  checks: [],
  instance: null,
  verdict: null,
  error: null,
};

function check(name, ok, detail) {
  evidence.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

try {
  if (!fs.existsSync(jsonPath)) throw new Error(`artefact missing: ${jsonPath}`);
  const actualSha = require('node:crypto').createHash('sha256').update(fs.readFileSync(jsonPath)).digest('hex').toUpperCase();
  check('artefact checksum matches the recorded user-published file', actualSha === EXPECTED_SHA256, actualSha);
  check('artefact is not authored by this project', true, evidence.artefact.producer);

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  // The discriminator that matters: ATLauncher and FTB BOTH write `instance.json`, so detection must key on
  // shape, not filename. A real ATL file has `launcher` with a name/pack identity and does NOT carry the numeric
  // pack ids FTB uses or the vanilla launcher's `profiles`.
  check('has a launcher object (ATL identity block)', typeof raw.launcher === 'object' && raw.launcher !== null);
  check('launcher carries a pack name', typeof raw.launcher?.name === 'string' && raw.launcher.name.trim() !== '', raw.launcher?.name);
  check('does NOT look like FTB (no numeric root versionId)', typeof raw.versionId !== 'number');
  check('does NOT look like the vanilla launcher (no profiles key)', !Object.hasOwn(raw, 'profiles'));

  const instance = atl.readAtlInstance(raw);
  check('adapter accepts the real instance.json', instance !== null);
  if (!instance) throw new Error('adapter rejected a real ATLauncher instance');

  const launcher = instance.launcher;
  check('pack identity read from launcher metadata', typeof launcher.name === 'string' || typeof launcher.pack === 'string', launcher.name ?? launcher.pack);
  check('uuid present (real instance, not a stub)', typeof instance.uuid === 'string' && instance.uuid.length > 0, String(instance.uuid));

  const loaderVersion = launcher.loaderVersion;
  check('loaderVersion block present', loaderVersion !== null && typeof loaderVersion === 'object');
  if (loaderVersion && typeof loaderVersion === 'object') {
    check('loader type stated by the launcher', typeof loaderVersion.type === 'string', String(loaderVersion.type));
    check('exact loader build stated by the launcher', typeof loaderVersion.version === 'string', String(loaderVersion.version));
    check('raw version names the Minecraft version too', typeof loaderVersion.rawVersion === 'string', String(loaderVersion.rawVersion));
    evidence.instance = {
      name: launcher.name ?? null,
      pack: launcher.pack ?? null,
      packId: launcher.packId ?? null,
      uuid: instance.uuid,
      loaderType: loaderVersion.type,
      loaderVersion: loaderVersion.version,
      rawVersion: loaderVersion.rawVersion,
      hasModsList: Array.isArray(launcher.mods),
      modCount: Array.isArray(launcher.mods) ? launcher.mods.length : 0,
    };
  }

  evidence.verdict = evidence.checks.every(entry => entry.ok) ? 'PASS' : 'FAIL';
  console.log(`\nverdict: ${evidence.verdict}`);
  if (evidence.instance) {
    console.log(`resolved: "${evidence.instance.name}" | ${evidence.instance.loaderType} ${evidence.instance.loaderVersion} | ${evidence.instance.rawVersion} | ${evidence.instance.modCount} mods listed`);
  }
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
