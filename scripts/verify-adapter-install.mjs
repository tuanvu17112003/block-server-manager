// C8 evidence: install a REAL modpack end-to-end through the adapter layer and reach a verified boot.
//
// This is the step invariant I3 requires before any format may be called "supported". Everything up to now was
// resolve-level (E2−): real artefacts parsed into correct recipes, but never installed through the new path.
//
// What is proven here that was not before:
//   - `PipelineSourceRequest { kind: 'packArchive' }` really reaches the adapter registry,
//   - the canonical recipe's override layers are extracted from the archive,
//   - the loader is installed from the recipe's exact family/build,
//   - every planned file is fetched with hash verification,
//   - the L2/L3 defence stack still runs,
//   - one real boot reaches `Done (` and the server is published atomically.
//
// Usage: node scripts/verify-adapter-install.mjs [mrpackPath] [javaPath]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const { Pipeline } = require(path.join(dist, 'services/pipeline.js'));
const { Jobs } = require(path.join(dist, 'services/jobs.js'));

const packPath = process.argv[2]
  ?? '.app-data/cache/mrpack/Prominence™ II Hasturian Era v4.1.5hf.mrpack';
const javaPath = process.argv[3] ?? 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const evidenceFile = process.argv[4]
  ?? path.join(process.cwd(), 'docs', 'evidence', 'adapters', 'adapter-end-to-end-install.json');

if (!fs.existsSync(packPath)) {
  console.error(`pack not found: ${packPath}`);
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-c8-'));
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

const evidence = {
  harness: 'verify-adapter-install.mjs',
  startedAt: new Date().toISOString(),
  purpose: 'C8 / invariant I3: a real modpack must install through the ADAPTER layer and reach a verified boot, '
    + 'not merely resolve. Before this run every adapter claim was E2- (resolve parity only).',
  pack: path.basename(packPath),
  packBytes: fs.statSync(packPath).size,
  javaPath,
  preview: null,
  install: null,
  published: null,
  verdict: null,
  error: null,
};

let pipeline = null;
try {
  pipeline = new Pipeline({ dataRoot: root, send: () => {}, getWindow: () => null }, new Jobs(() => {}));
  log(`data root ${root}`);
  log(`pack: ${path.basename(packPath)} (${(evidence.packBytes / 1024 / 1024).toFixed(0)} MB)`);

  // ---- preview through the adapter layer ----
  log('preview via { kind: "packArchive" } (adapter registry)');
  const preview = await pipeline.preview({ kind: 'packArchive', sourceId: packPath }, 'job-preview');
  const decisions = preview.plan.fileDecisions;
  const included = decisions.filter(d => d.action === 'include').length;
  const excluded = decisions.filter(d => d.action === 'exclude').length;
  const conflicts = decisions.filter(d => d.action === 'awaitingUserChoice').map(d => d.path);
  evidence.preview = {
    sourceName: preview.sourceName,
    loader: preview.plan.loader,
    include: included,
    exclude: excluded,
    conflicts,
    totalFiles: decisions.length,
    sourcePin: preview.plan.sourcePin,
    warnings: preview.warnings.slice(0, 30),
  };
  log(`preview: "${preview.sourceName}" ${preview.plan.loader.kind} ${preview.plan.loader.minecraftVersion} | ${included} include / ${excluded} exclude / ${conflicts.length} conflicts`);

  // Resolve conflicts the way a cautious operator would: exclude only explicit conflicts.
  const files = {};
  for (const decision of decisions) {
    if (decision.action === 'awaitingUserChoice') files[decision.path] = 'exclude';
    else if (decision.reason === 'optionalDefaultKeep') files[decision.path] = 'include';
  }

  // ---- install: staged download -> loader -> verified boot -> publish ----
  log('install (staged → loader → verified boot → publish)');
  const result = await pipeline.install(
    preview.previewId,
    { name: 'C8 Adapter Test', ramMb: 4096, eulaAccepted: true, javaPath },
    { files, approvedReplacements: [], autoDeleteCurseForgeZip: false },
    'job-install',
  );

  evidence.install = {
    status: result.report?.status ?? null,
    serverId: result.report?.serverId ?? null,
    loader: result.report?.loader ?? null,
    files: result.report?.files ?? [],
    stages: result.report?.stages ?? [],
    warnings: (result.report?.warnings ?? []).slice(0, 40),
    error: result.error ?? null,
    autofix: result.autoFix ?? null,
  };
  log(`install status: ${evidence.install.status}`);
  log(`report files: ${JSON.stringify(evidence.install.files)}`);
  log(`stages: ${JSON.stringify(evidence.install.stages)}`);
  if (evidence.install.error) log(`error: ${evidence.install.error}`);
  for (const warning of (evidence.install.warnings ?? []).slice(0, 10)) log(`  warning: ${warning}`);

  // ---- confirm the published tree really exists ----
  const serverId = evidence.install.serverId;
  if (serverId) {
    const serverDir = path.join(root, 'servers', serverId);
    if (fs.existsSync(serverDir)) {
      const entries = fs.readdirSync(serverDir);
      const modsDir = path.join(serverDir, 'mods');
      const modCount = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(n => n.endsWith('.jar')).length : 0;
      evidence.published = {
        dir: '(data root)/servers/<id>',
        topLevelEntries: entries.slice(0, 30),
        modJarCount: modCount,
        hasEula: fs.existsSync(path.join(serverDir, 'eula.txt')),
        hasProperties: fs.existsSync(path.join(serverDir, 'server.properties')),
      };
      log(`published tree: ${entries.length} top-level entries, ${modCount} mod jars, eula=${evidence.published.hasEula}`);
    }
  }

  const ok = evidence.install.status === 'complete'
    && evidence.install.stages.some(stage => stage.stage === 'verify-boot' && stage.outcome === 'complete')
    && evidence.install.stages.some(stage => stage.stage === 'publish' && stage.outcome === 'complete');
  evidence.verdict = ok ? 'PASS' : 'FAIL';
  if (!ok) process.exitCode = 1;
  log(ok
    ? 'PASS: a real pack installed through the ADAPTER layer, verified its boot, and published atomically'
    : 'FAIL: the adapter install did not reach a verified publish');
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
  if (evidence.verdict === 'PASS') {
    try { fs.rmSync(root, { recursive: true, force: true }); evidence.dataRoot = '(deleted after success)'; } catch { /* best effort */ }
  } else {
    log(`tree kept for inspection: ${root}`);
  }
}
