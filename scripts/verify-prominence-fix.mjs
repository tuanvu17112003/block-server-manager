// D9 regression harness: install a *cached real* Modrinth pack through the actual Pipeline
// (preview → resolve decisions → install → L2/L3 verified boot → publish) into a throwaway data root,
// then start it once to prove the installed server still boots. No UI, no mocks.
//
// Usage: node scripts/verify-prominence-fix.mjs <pack.mrpack> [slug]
// Requires `npm run build:electron`. Uses the installed Java 17 when available (Prominence = MC 1.20.1).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const { Pipeline } = require(path.join(dist, 'services/pipeline.js'));
const { Jobs } = require(path.join(dist, 'services/jobs.js'));
const { Store } = require(path.join(dist, 'services/store.js'));

const JAVA17 = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const packPath = process.argv[2];
const slug = process.argv[3] ?? 'prominence-2-fabric';
if (!packPath || !fs.existsSync(packPath)) {
  console.error('usage: node scripts/verify-prominence-fix.mjs <pack.mrpack> [slug]');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-prominence-'));
const ctx = {
  dataRoot: root,
  send: () => {},
  getWindow: () => null,
};
const jobs = new Jobs(() => {});
const pipeline = new Pipeline(ctx, jobs);
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

// Durable evidence: the throwaway data root is deleted on success, so every claim this harness makes
// must land in docs/evidence/ first (otherwise the result is unfalsifiable from disk).
const evidenceDir = path.join(process.cwd(), 'docs', 'evidence');
const evidenceFile = process.argv[4] ?? path.join(evidenceDir, 'prominence-modrinth-install.json');
const evidence = {
  harness: 'verify-prominence-fix.mjs',
  startedAt: new Date().toISOString(),
  pack: path.basename(packPath),
  packBytes: fs.statSync(packPath).size,
  slug,
  javaPath: JAVA17,
  plan: null,
  report: null,
  published: null,
  error: null,
};
function writeEvidence(data) {
  data.finishedAt = new Date().toISOString();
  data.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`evidence written: ${evidenceFile}`);
}

try {
  log(`data root ${root}`);
  log('preview (real resolve + L1/L4 decisions)');
  const preview = await pipeline.preview({ kind: 'localMrpack', sourceId: packPath }, 'job-preview');
  const decisions = preview.plan.fileDecisions;
  const conflicts = decisions.filter((d) => d.action === 'awaitingUserChoice').map((d) => d.path);
  const included = decisions.filter((d) => d.action === 'include').length;
  const excluded = decisions.filter((d) => d.action === 'exclude').length;
  log(`plan: ${included} include / ${excluded} exclude / ${conflicts.length} conflict; loader=${preview.plan.loader.kind} ${preview.plan.loader.minecraftVersion}`);
  evidence.plan = {
    include: included,
    exclude: excluded,
    conflicts,
    totalFiles: preview.plan.fileDecisions.length,
    loader: `${preview.plan.loader.kind} ${preview.plan.loader.minecraftVersion}`,
  };
  for (const c of conflicts) log(`  conflict: ${c}`);

  // Resolve conflicts the way a cautious user would: exclude curated-unsupported client extras that
  // can break a dedicated server, include everything the plan marked optional-default.
  const files = {};
  for (const d of decisions) {
    if (d.action === 'awaitingUserChoice') files[d.path] = 'exclude';
    else if (d.reason === 'optionalDefaultKeep') files[d.path] = 'include';
  }

  log('install (staged download + L2/L3 verified boot before publish)');
  const result = await pipeline.install(
    preview.previewId,
    { name: `verify-prominence-${Date.now()}`, ramMb: 4096, javaPath: JAVA17, eulaAccepted: true },
    { files, approvedReplacements: [], autoDeleteCurseForgeZip: false },
    'job-install',
  );
  log(`install status=${result.status} server=${result.server?.id ?? '(none)'} error=${result.error ?? '(none)'}`);
  evidence.report = {
    status: result.status,
    stages: result.report.stages,
    files: result.report.files,
    warningCount: result.report.warnings.length,
    warnings: result.report.warnings.slice(0, 40),
  };
  for (const stage of result.report.stages) log(`  stage ${stage.stage}: ${stage.outcome}${stage.detail ? ` (${stage.detail})` : ''}`);
  for (const warning of result.report.warnings.slice(0, 12)) log(`  warning: ${warning}`);

  const fixes = result.report.files.filter((f) => String(f.outcome).includes('autofix'));
  log(`autofix changes=${fixes.length}`);
  for (const fix of fixes) log(`  ${fix.outcome}: ${fix.path} — ${fix.detail ?? ''}`);

  const broken = result.report.files.filter((f) => String(f.outcome).includes('skipped'));
  log(`skipped entries: ${broken.map((f) => `${f.path} (${f.outcome})`).join(', ') || '(none)'}`);

  if (result.status !== 'complete' || !result.server) {
    log('FAIL: install did not complete');
    process.exitCode = 1;
  } else {
    const dir = path.join(root, 'servers', result.server.id);
    const mods = fs.existsSync(path.join(dir, 'mods')) ? fs.readdirSync(path.join(dir, 'mods')).filter((f) => f.endsWith('.jar')) : [];
    const disabled = fs.existsSync(path.join(dir, 'mods-disabled')) ? fs.readdirSync(path.join(dir, 'mods-disabled')) : [];
    log(`published server: ${mods.length} jars enabled, ${disabled.length} disabled: ${disabled.join(', ') || '(none)'}`);
    evidence.published = { serverId: result.server.id, jarsEnabled: mods.length, jarsDisabled: disabled.length, disabled };
    log('PASS: install reached Done( and published');
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${evidence.error}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  // Durable evidence FIRST (the throwaway root is deleted on success, so a claim without this file
  // would be unfalsifiable), then clean up.
  writeEvidence(evidence);
  if (!process.exitCode) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch { /* best effort */ }
    log(`cleaned ${root}`);
  } else {
    log(`kept for inspection: ${root}`);
  }
}
