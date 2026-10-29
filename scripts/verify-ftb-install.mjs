// P1b live proof: install a real FTB modpack end-to-end through the REAL pipeline
// (preview → staged download → loader → verified boot → atomic publish) and report the outcome.
//
// This is the step that turns the adapter layer from a verified capability into a shipped feature:
// it exercises `PipelineSourceRequest { kind: 'ftbProject' }`, the adapter registry, and the
// format-agnostic recipe installer together.
//
// Usage: node scripts/verify-ftb-install.mjs [packId] [versionId]
// Requires `npm run build:electron`.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const { Pipeline } = require(path.join(dist, 'services/pipeline.js'));
const { Jobs } = require(path.join(dist, 'services/jobs.js'));

const JAVA17 = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const JAVA8_CANDIDATES = [
  'C:\\Program Files\\Java\\jre1.8.0_503\\bin\\java.exe',
  'C:\\Program Files\\Java\\jdk-8\\bin\\java.exe',
];
const packId = Number(process.argv[2] ?? 6);
const versionArg = process.argv[3];
const versionId = versionArg === undefined ? undefined : Number(versionArg);
const evidenceFile = process.argv[4]
  ?? path.join(process.cwd(), 'docs', 'evidence', 'adapters', `ftb-install-pack-${packId}.json`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-ftb-install-'));
const ctx = { dataRoot: root, send: () => {}, getWindow: () => null };
const jobs = new Jobs(() => {});
const pipeline = new Pipeline(ctx, jobs);
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

// FTB Academy / Stoneblock / Interactions / Sky Odyssey / Omnia are all Java 8 era.
const javaPath = JAVA8_CANDIDATES.find(candidate => fs.existsSync(candidate)) ?? JAVA17;
const evidence = {
  harness: 'verify-ftb-install.mjs',
  startedAt: new Date().toISOString(),
  packId,
  versionId: versionId ?? null,
  javaPath,
  dataRoot: root,
  preview: null,
  install: null,
  published: null,
  error: null,
  verdict: null,
};
function writeEvidence() {
  evidence.finishedAt = new Date().toISOString();
  evidence.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence written: ${evidenceFile}`);
}

try {
  log(`java: ${javaPath}`);
  log(`preview FTB pack ${packId}${versionId === undefined ? ' (latest)' : ` version ${versionId}`}`);
  const preview = await pipeline.preview(
    { kind: 'ftbProject', packId, ...(versionId === undefined ? {} : { versionId }) },
    'job-preview',
  );
  const decisions = preview.plan.fileDecisions;
  const included = decisions.filter((d) => d.action === 'include').length;
  const excluded = decisions.filter((d) => d.action === 'exclude').length;
  const conflicts = decisions.filter((d) => d.action === 'awaitingUserChoice').map((d) => d.path);
  log(`preview: "${preview.sourceName}" | loader ${preview.plan.loader.kind} ${preview.plan.loader.minecraftVersion} | ${included} include / ${excluded} exclude / ${conflicts.length} conflicts`);
  evidence.preview = {
    sourceName: preview.sourceName,
    loader: preview.plan.loader,
    include: included,
    exclude: excluded,
    conflicts,
    totalFiles: decisions.length,
    sourcePin: preview.plan.sourcePin,
    warnings: preview.warnings.slice(0, 40),
  };

  // Resolve like a cautious operator: exclude only explicit conflicts; keep the optional defaults.
  const files = {};
  for (const decision of decisions) {
    if (decision.action === 'awaitingUserChoice') files[decision.path] = 'exclude';
    else if (decision.reason === 'optionalDefaultKeep') files[decision.path] = 'include';
  }

  log('install (staged download → loader → verified boot → publish)');
  const result = await pipeline.install(
    preview.previewId,
    { name: `FTB Test ${packId}`, ramMb: 4096, eulaAccepted: true, javaPath },
    { files, approvedReplacements: [], autoDeleteCurseForgeZip: false },
    'job-install',
  );

  evidence.install = {
    status: result.report?.status ?? null,
    serverId: result.report?.serverId ?? null,
    loader: result.report?.loader ?? null,
    files: result.report?.files ?? [],
    stages: result.report?.stages ?? [],
    warnings: (result.report?.warnings ?? []).slice(0, 60),
    error: result.error ?? null,
    autofix: result.autoFix ?? null,
  };
  log(`install status: ${evidence.install.status}`);
  log(`report files: ${JSON.stringify(evidence.install.files)}`);
  log(`stages: ${JSON.stringify(evidence.install.stages)}`);
  if (evidence.install.error) log(`error: ${evidence.install.error}`);
  for (const warning of evidence.install.warnings.slice(0, 12)) log(`  warning: ${warning}`);

  const ok = evidence.install.status === 'complete';
  evidence.verdict = ok ? 'PASS' : 'FAIL';
  if (!ok) process.exitCode = 1;
  log(ok
    ? 'PASS: a format the app could not install at all now installs and verifies end-to-end'
    : 'FAIL: install did not reach a verified publish');
} catch (error) {
  evidence.verdict = 'FAIL';
  evidence.error = error instanceof Error ? `${error.message}` : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  evidence.errorCode = code;
  console.error(`FAIL: ${evidence.error}${code ? ` (code=${code})` : ''}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 10).join('\n'));
  process.exitCode = 1;
} finally {
  // Keep the tree when it failed so the failure is inspectable; delete it on success.
  if (evidence.verdict === 'PASS') {
    try { fs.rmSync(root, { recursive: true, force: true }); evidence.dataRoot = '(deleted after success)'; } catch { /* best effort */ }
  }
  writeEvidence();
}
