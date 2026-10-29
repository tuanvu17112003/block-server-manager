// CurseForge (route A, prebuilt Forge pack) install/boot regression: same Pipeline as the UI.
// Uses cached 936875 server pack (libraries + forge server jar, MC 1.20.1). Proves the verified boot
// (L2/L3) also covers CurseForge and that CF dependency policy stays prune-only.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const dist = path.join(process.cwd(), 'dist-electron');
const { Pipeline } = require(path.join(dist, 'services/pipeline.js'));
const { Jobs } = require(path.join(dist, 'services/jobs.js'));

const source = process.argv[2] ?? '.app-data/cache/cfpack/936875-server-8853081.zip';
const javaPath = process.argv[3] ?? 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const root = path.join('H:\\TESTMultiAI\\20-backups', `verify-cf-${Date.now()}`);
const zipName = path.basename(source);
fs.mkdirSync(path.join(root, 'curseforge-import'), { recursive: true });
const target = path.join(root, 'curseforge-import', zipName);
try { fs.linkSync(path.resolve(source), target); } catch { fs.copyFileSync(path.resolve(source), target); }
const pipeline = new Pipeline({ dataRoot: root, send: () => {}, getWindow: () => null }, new Jobs(() => {}));
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

try {
  log(`data root ${root}`);
  const preview = await pipeline.preview({ kind: 'curseForgeServerZip', zipName }, 'cf-preview');
  log(`preview: ${preview.sourceName} loader=${preview.plan.loader.kind} mc=${preview.plan.loader.minecraftVersion || '(blank)'} decisions=${preview.plan.fileDecisions.length}`);
  const result = await pipeline.install(
    preview.previewId,
    { name: `verify-cf-${Date.now()}`, ramMb: 4096, javaPath, eulaAccepted: true },
    { files: {}, approvedReplacements: [], autoDeleteCurseForgeZip: false },
    'cf-install',
  );
  log(`install status=${result.status} error=${result.error ?? '(none)'}`);
  for (const stage of result.report.stages) log(`  stage ${stage.stage}: ${stage.outcome}${stage.detail ? ` (${stage.detail})` : ''}`);
  for (const file of result.report.files) log(`  file: ${file.path} -> ${file.outcome}${file.detail ? ` (${file.detail})` : ''}`);
  for (const warning of result.report.warnings.slice(0, 8)) log(`  warning: ${warning}`);
  if (result.status === 'complete' && result.server) {
    const dir = path.join(root, 'servers', result.server.id);
    const mods = fs.existsSync(path.join(dir, 'mods')) ? fs.readdirSync(path.join(dir, 'mods')).filter((f) => f.endsWith('.jar')) : [];
    const disabled = fs.existsSync(path.join(dir, 'mods-disabled')) ? fs.readdirSync(path.join(dir, 'mods-disabled')) : [];
    log(`published: ${mods.length} jars, ${disabled.length} disabled`);
    log('PASS: CurseForge install reached Done( with verified boot');
  } else {
    log('FAIL: CurseForge install did not complete');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  if (!process.exitCode) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch {} log(`cleaned ${root}`); }
  else log(`kept for inspection: ${root}`);
}
