// Phase 8 live matrix (network): Java mapping + Adoptium Java 25 provisioning, live loader/version
// metadata (vanilla/Paper/Fabric/Forge/NeoForge), live NeoForge server-loader installation, and the
// CurseForge staging inspection path against a real cached server pack.
// Usage: node scripts/live-matrix.mjs   (requires `npm run build:electron` once; uses dist-electron)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const dist = path.join(root, 'dist-electron');
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msm-live-${label}-`));
}

const java = require(path.join(dist, 'services/java.js'));
const versions = require(path.join(dist, 'services/versions.js'));
const core = require(path.join(dist, 'services/installer/core.js'));
const cf = require(path.join(dist, 'services/installer/curseforge.js'));

const matrix = [
  ['1.12.2', 8], ['1.16.5', 8], ['1.17.1', 17], ['1.20.1', 17], ['1.20.4', 17],
  ['1.21.1', 21], ['1.21.4', 21], ['26.3', 25],
];
try {
  const mismatches = [];
  for (const [mc, expectedInstall] of matrix) {
    const required = await java.requiredJavaMajor(mc);
    const install = java.installMajorFor(required) ?? required;
    if (install !== expectedInstall) mismatches.push(`${mc}: required ${required} install ${install} != ${expectedInstall}`);
  }
  record('java-major matrix + install-major mapping (live metadata)', mismatches.length === 0, mismatches.join(', ') || `${matrix.length} versions`);
} catch (error) { record('java-major matrix + install-major mapping (live metadata)', false, String(error)); }

const dataRoot = tempRoot('data');
const cache = path.join(dataRoot, 'cache');
try {
  const needsJava = await java.requiredJavaMajor('1.21.1');
  const runtime = await java.ensureJava(needsJava, path.join(dataRoot, 'runtime'), cache);
  record('Java 21 provisioning (Adoptium verified download)', fs.existsSync(runtime.path), `${needsJava} -> ${runtime.path}`);
  const j25 = await java.ensureJava(25, path.join(dataRoot, 'runtime'), cache);
  const inspected = await java.inspectJava(j25.path);
  record('Java 25 provisioning + inspect', inspected.major === 25, `major=${inspected.major} arch=${inspected.architectureBits}`);

  const resolved = await versions.loadersResolve('1.21.1');
  const choices = Array.isArray(resolved) ? resolved : (resolved.loaders ?? []);
  const loaderNames = choices.map((choice) => choice.loader);
  record('live loader catalogue 1.21.1', ['Paper', 'Fabric', 'Forge', 'NeoForge'].every((loader) => loaderNames.includes(loader)), loaderNames.join('/'));
  const paper = choices.find((choice) => choice.loader === 'Paper');
  record('Paper STABLE build resolved', Boolean(paper?.version), JSON.stringify(paper ?? null).slice(0, 140));
  const neo = choices.find((choice) => choice.loader === 'NeoForge');
  record('NeoForge version resolved', Boolean(neo?.version), `${neo?.version ?? 'none'}`);

  // Live NeoForge installer run (exact version mapping 1.21.1 -> 21.1.265).
  const neoDir = path.join(dataRoot, 'servers', 'neoforge-live');
  fs.mkdirSync(neoDir, { recursive: true });
  const java21 = await java.ensureJava(21, path.join(dataRoot, 'runtime'), cache);
  await core.installLoader('neoforge', neoDir, '1.21.1', '21.1.265', java21.path, cache);
  const artifacts = fs.readdirSync(neoDir);
  const hasLaunch = artifacts.some((name) => /run\.(bat|sh)$/.test(name)) || fs.existsSync(path.join(neoDir, 'libraries'));
  record('NeoForge 21.1.265 installer run (live)', hasLaunch, artifacts.slice(0, 6).join(', '));

  // CurseForge staging inspection against a real cached server pack (if the e2e cache exists).
  const cfCache = path.join(root, '.app-data', 'cache', 'cfpack');
  const staged = fs.existsSync(cfCache) ? fs.readdirSync(cfCache).find((name) => /server.*\.zip$/i.test(name)) : undefined;
  if (staged) {
    const inspection = await cf.inspectStagedZip(path.join(cfCache, staged));
    record('CurseForge staging inspection (real archive)', inspection.classification === 'supportedServerPack', `${inspection.name}: ${inspection.classification} ${inspection.minecraftVersion ?? ''}`);
    const inferred = cf.inferServerPackMetadata(['mods/a.jar', 'forge-1.20.1-47.4.0-installer.jar']);
    record('CurseForge route-A metadata inference', inferred?.mc === '1.20.1' && inferred?.loaderVersion === '47.4.0', JSON.stringify(inferred));
  } else {
    record('CurseForge staging inspection (real archive)', false, `no cached CF server pack under ${cfCache}`);
  }
} catch (error) {
  record('live matrix execution', false, error instanceof Error ? error.stack?.slice(0, 600) : String(error));
} finally {
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = results.filter((entry) => !entry.ok).length;
console.log(`LIVEMATRIX ${failed === 0 ? 'PASS' : 'FAIL'} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
