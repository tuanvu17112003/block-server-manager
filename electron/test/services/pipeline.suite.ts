// Pipeline contract suite (Phase 1 report + Phase 4 WP-4.2/4.5/4.6/4.8).
// Covers: full failed-install report + rollback; plan completeness with the archive source-pin
// snapshot; snapshot drift rejection; blank CurseForge route-A metadata rejection (no blank server);
// Quilt rejection; optionalDefaultKeep/conflictingSignals decisions; preview single-use.
// Runs inside Electron via --servicestest against a throwaway data root; no network is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TestRun } from '../harness';
import { withHarness, type Harness } from '../service-harness';
import { writeZip } from '../../services/zip';
import {
  INSTALL_REPORT_FILE,
  PIPELINE_REPORT_SCHEMA_VERSION,
  writeInstallReport,
  type PipelineInstallReport,
  type PipelineInstallPlan,
  type PipelineInstallResult,
  type PipelinePreviewDto,
} from '../../services/pipeline';

const REPORT_KEYS = [
  'schemaVersion', 'planId', 'serverId', 'createdAt', 'status', 'sourcePin',
  'loader', 'files', 'stages', 'warnings', 'errors',
] as const;
const PLAN_KEYS = ['schemaVersion', 'planId', 'createdAt', 'target', 'sourcePin', 'loader', 'fileDecisions'] as const;

/** Assert the exact `PipelineInstallReport` contract the renderer consumes. */
function assertReportShape(report: unknown): asserts report is PipelineInstallReport {
  assert.ok(report && typeof report === 'object', 'install report is not an object');
  const value = report as unknown as Record<string, unknown>;
  for (const key of REPORT_KEYS) assert.ok(key in value, `install report is missing "${key}"`);
  assert.equal(value.schemaVersion, PIPELINE_REPORT_SCHEMA_VERSION);
  assert.equal(typeof value.planId, 'string');
  assert.equal(typeof value.serverId, 'string');
  assert.equal(typeof value.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(String(value.createdAt))), 'createdAt is not an ISO timestamp');
  assert.ok(
    ['preparing', 'complete', 'failed', 'cancelled'].includes(String(value.status)),
    `unexpected report status "${String(value.status)}"`,
  );
  const loader = value.loader as Record<string, unknown> | null;
  assert.ok(loader && typeof loader === 'object', 'report.loader is missing');
  assert.equal(typeof loader.kind, 'string');
  assert.equal(typeof loader.minecraftVersion, 'string');
  assert.ok('loaderVersion' in loader, 'report.loader.loaderVersion is missing');
  assert.ok(Array.isArray(value.files), 'report.files is not an array');
  assert.ok(Array.isArray(value.stages), 'report.stages is not an array');
  assert.ok(Array.isArray(value.warnings), 'report.warnings is not an array');
  assert.ok(Array.isArray(value.errors), 'report.errors is not an array');
  assert.ok('sourcePin' in value, 'report.sourcePin is missing');
  // The report crosses the IPC boundary as JSON; it must round-trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

/** Assert the preview `plan` contract (src/tauri.ts `PipelineInstallPlan`). */
function assertPlanShape(plan: unknown): asserts plan is PipelineInstallPlan {
  assert.ok(plan && typeof plan === 'object', 'preview plan is not an object');
  const value = plan as unknown as Record<string, unknown>;
  for (const key of PLAN_KEYS) assert.ok(key in value, `preview plan is missing "${key}"`);
  assert.equal(value.schemaVersion, PIPELINE_REPORT_SCHEMA_VERSION);
  assert.ok(typeof value.planId === 'string' && value.planId.length > 0, 'planId is empty');
  assert.ok(!Number.isNaN(Date.parse(String(value.createdAt))), 'plan createdAt is not an ISO timestamp');
  const target = value.target as Record<string, unknown>;
  assert.ok(target && typeof target === 'object', 'plan.target is missing');
  for (const key of ['serverId', 'serverName', 'directory']) assert.ok(key in target, `plan.target is missing "${key}"`);
  const loader = value.loader as Record<string, unknown>;
  assert.equal(typeof loader.kind, 'string');
  assert.equal(typeof loader.minecraftVersion, 'string');
  assert.ok('loaderVersion' in loader);
  assert.ok(Array.isArray(value.fileDecisions), 'plan.fileDecisions is not an array');
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

interface MrpackFile {
  path: string;
  env?: { server?: string; client?: string };
}

/** Build a real (minimal) `.mrpack` fixture: a ZIP with a valid modrinth.index.json. */
async function makeMrpack(dataRoot: string, fileName: string, opts: {
  name?: string;
  dependencies?: Record<string, string>;
  files?: MrpackFile[];
} = {}): Promise<string> {
  const work = path.join(dataRoot, 'suite-fixtures');
  fs.mkdirSync(work, { recursive: true });
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'suite-local',
    name: opts.name ?? 'Pipeline Suite Pack',
    files: (opts.files ?? []).map(file => ({
      path: file.path,
      hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
      ...(file.env ? { env: file.env } : {}),
      downloads: [`https://cdn.modrinth.com/data/suite/versions/v/files/${path.basename(file.path)}`],
      fileSize: 1,
    })),
    dependencies: opts.dependencies ?? { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
  };
  const indexFile = path.join(work, `${fileName}.modrinth.index.json`);
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  const dest = path.join(work, fileName);
  await writeZip(dest, [{ name: 'modrinth.index.json', path: indexFile }]);
  return dest;
}

/** Build a minimal CurseForge route-A server ZIP (mods/ only -> no MC/loader metadata). */
async function makeBlankRouteAZip(dataRoot: string, zipName: string): Promise<string> {
  const work = path.join(dataRoot, 'suite-fixtures');
  fs.mkdirSync(work, { recursive: true });
  const mod = path.join(work, 'route-a-example.jar');
  fs.writeFileSync(mod, 'fake-mod-jar');
  const dest = path.join(dataRoot, 'curseforge-import', zipName);
  await writeZip(dest, [{ name: 'mods/route-a-example.jar', path: mod }]);
  return dest;
}

function install(h: Harness, previewId: string, overrides: { name: string; port?: number; files?: Record<string, 'include' | 'exclude'> }): Promise<PipelineInstallResult> {
  return h.invoke<PipelineInstallResult>('modpack_pipeline_install', {
    previewId,
    input: { name: overrides.name, port: overrides.port ?? 0, ramMb: 2048, eulaAccepted: false },
    choices: { files: overrides.files ?? {}, approvedReplacements: [], autoDeleteCurseForgeZip: false },
    jobId: '',
  });
}

function stagingListing(h: Harness): string[] {
  try { return fs.readdirSync(path.join(h.dataRoot, 'installer-staging')); } catch { return []; }
}

export async function runPipelineSuite(run: TestRun): Promise<void> {
  await withHarness(run, async (h) => {
    await run.must('unknown previewId returns a failed report and leaves no server row', async () => {
      const before = await h.invoke<unknown[]>('servers_list');
      const result = await h.invoke<PipelineInstallResult>('modpack_pipeline_install', {
        previewId: 'preview-does-not-exist',
        input: { name: 'Ghost Install', ramMb: 1024 },
        choices: { files: {}, approvedReplacements: [], autoDeleteCurseForgeZip: false },
        jobId: '',
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.server, null);
      assert.ok(typeof result.error === 'string' && result.error.length > 0);
      assertReportShape(result.report);
      assert.equal(result.report.status, 'failed');
      assert.equal(result.report.planId, '');
      assert.equal(result.report.serverId, '');
      assert.deepEqual(result.report.loader, { kind: 'vanilla', minecraftVersion: '', loaderVersion: null });
      assert.ok(result.report.errors.some((entry) => entry.includes('not found')));
      const after = await h.invoke<unknown[]>('servers_list');
      assert.equal(after.length, before.length);
    });

    await run.must('unsupported source fails with a full report and rolls the server row back', async () => {
      const preview = await h.invoke<{ previewId: string }>('modpack_pipeline_preview', {
        source: { kind: 'unsupportedPipelineSource' },
        jobId: '',
      });
      assert.ok(typeof preview.previewId === 'string' && preview.previewId.length > 0);
      const before = await h.invoke<unknown[]>('servers_list');

      const result = await install(h, preview.previewId, { name: 'Pipeline Failure', port: 25565 });

      assert.equal(result.status, 'failed');
      assert.equal(result.server, null);
      assertReportShape(result.report);
      assert.equal(result.report.status, 'failed');
      assert.ok(result.report.planId.length > 0, 'failed report has no planId');
      assert.ok(result.report.serverId.length > 0, 'failed report has no serverId');
      assert.ok(result.report.errors.length > 0, 'failed report has no errors');
      assert.ok(result.report.errors.some((entry) => entry.includes('Unsupported pipeline source.')));
      assert.deepEqual(result.report.loader, { kind: 'vanilla', minecraftVersion: '', loaderVersion: null });
      assert.equal(typeof result.report.sourcePin, 'object');

      // Complete-or-nothing rollback: no persisted row and no leftover server directory.
      const after = await h.invoke<{ id: string; name: string }[]>('servers_list');
      assert.equal(after.length, before.length);
      assert.ok(!after.some((row) => row.id === result.report.serverId));
      assert.ok(!after.some((row) => row.name === 'Pipeline Failure'));
      assert.ok(!fs.existsSync(path.join(h.dataRoot, 'servers', result.report.serverId)));
      assert.deepEqual(stagingListing(h), []);
    });

    await run.must('install-report.json writer persists the full DTO and keeps the sidecar', async () => {
      const dir = path.join(h.dataRoot, 'servers', 'report-writer');
      fs.mkdirSync(dir, { recursive: true });
      const sidecar = path.join(dir, 'msm-install.json');
      fs.writeFileSync(sidecar, JSON.stringify({ platform: 'modrinth', loader: 'fabric' }, null, 2));

      const report: PipelineInstallReport = {
        schemaVersion: PIPELINE_REPORT_SCHEMA_VERSION,
        planId: 'plan-suite',
        serverId: 'server-suite',
        createdAt: new Date().toISOString(),
        status: 'complete',
        sourcePin: { source: 'modrinth', projectId: 'abc', versionId: 'def' },
        loader: { kind: 'neoForge', minecraftVersion: '1.21.1', loaderVersion: '21.1.80' },
        files: [
          { path: 'mods/example.jar', outcome: 'installed', sizeBytes: 42, hashes: { sha1: 'a', sha512: 'b' }, sourceHost: 'cdn.modrinth.com' },
          { path: '2 optional', outcome: 'skipped-optional' },
        ],
        stages: [{ stage: 'download', outcome: 'complete' }],
        warnings: ['pack declares optional files'],
        errors: [],
      };
      assert.equal(writeInstallReport(dir, report), true);

      const file = path.join(dir, INSTALL_REPORT_FILE);
      assert.ok(fs.existsSync(file), 'install-report.json was not written');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      assertReportShape(parsed);
      assert.deepEqual(parsed, JSON.parse(JSON.stringify(report)));
      assert.ok(!fs.existsSync(`${file}.tmp`), 'temporary report file was left behind');
      assert.ok(fs.existsSync(sidecar), 'msm-install.json sidecar was removed');
      assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).platform, 'modrinth');
    });

    await run.must('preview plan is complete and pins the resolved archive snapshot', async () => {
      const mrpack = await makeMrpack(h.dataRoot, 'plan-suite.mrpack', { name: 'Plan Suite Pack' });
      const preview = await h.invoke<PipelinePreviewDto>('modpack_pipeline_preview', {
        source: { kind: 'localMrpack', sourceId: mrpack },
        jobId: '',
      });
      assert.ok(preview.previewId && preview.previewId !== preview.plan.planId);
      assertPlanShape(preview.plan);
      assert.deepEqual(preview.plan.target, { serverId: '', serverName: '', directory: '' });
      assert.deepEqual(preview.plan.loader, { kind: 'fabric', minecraftVersion: '1.21.1', loaderVersion: '0.16.9' });
      assert.equal(preview.sourceName, 'Plan Suite Pack');
      const pin = preview.plan.sourcePin as { source: string; artifact: Record<string, unknown> };
      assert.equal(pin.source, 'localMrpack');
      assert.equal(pin.artifact.kind, 'localMrpack');
      assert.ok(Number(pin.artifact.sizeBytes) > 0);
      assert.equal(typeof pin.artifact.mtimeMs, 'number');
      assert.match(String(pin.artifact.sha256), /^[a-f0-9]{64}$/);
      assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview);
      assert.equal(await h.invoke<boolean>('modpack_pipeline_discard_preview', { previewId: preview.previewId }), true);
    });

    await run.must('preview decisions default optional includes and flag conflictingSignals', async () => {
      const mrpack = await makeMrpack(h.dataRoot, 'decisions-suite.mrpack', {
        files: [
          { path: 'mods/suite-required-0001.jar', env: { server: 'required' } },
          { path: 'mods/suite-optional-0001.jar', env: { server: 'optional' } },
          { path: 'mods/suite-client-0001.jar', env: { server: 'unsupported', client: 'required' } },
          { path: 'mods/suite-metadata-missing-0001.jar' },
          // Hand-curated L4 says this client shader mod is unsupported while the pack declares it required.
          { path: 'mods/asyncparticles-1.2.3.jar', env: { server: 'required' } },
        ],
      });
      const preview = await h.invoke<PipelinePreviewDto>('modpack_pipeline_preview', {
        source: { kind: 'localMrpack', sourceId: mrpack },
        jobId: '',
      });
      const decisions = new Map(preview.plan.fileDecisions.map(decision => [decision.path, decision]));
      const optional = decisions.get('mods/suite-optional-0001.jar');
      assert.equal(optional?.action, 'include');
      assert.equal(optional?.reason, 'optionalDefaultKeep');
      const required = decisions.get('mods/suite-required-0001.jar');
      assert.equal(required?.action, 'include');
      assert.equal(required?.reason, 'required');
      const clientOnly = decisions.get('mods/suite-client-0001.jar');
      assert.equal(clientOnly?.action, 'exclude');
      assert.equal(clientOnly?.reason, 'serverUnsupported');
      assert.equal(clientOnly?.side, 'client');
      const missing = decisions.get('mods/suite-metadata-missing-0001.jar');
      assert.equal(missing?.action, 'include');
      assert.equal(missing?.reason, 'missingEnvironmentRetained');
      const conflict = decisions.get('mods/asyncparticles-1.2.3.jar');
      assert.equal(conflict?.action, 'awaitingUserChoice');
      assert.equal(conflict?.reason, 'conflictingSignals');
      assert.ok(preview.warnings.some(warning => warning.includes('asyncparticles')), 'missing curated-override warning');
      assert.equal(await h.invoke<boolean>('modpack_pipeline_discard_preview', { previewId: preview.previewId }), true);
    });

    await run.must('Quilt packs are rejected at preview (ADR-0005)', async () => {
      const mrpack = await makeMrpack(h.dataRoot, 'quilt-suite.mrpack', {
        dependencies: { minecraft: '1.21.1', 'quilt-loader': '0.27.0' },
      });
      await assert.rejects(
        () => h.invoke('modpack_pipeline_preview', { source: { kind: 'localMrpack', sourceId: mrpack }, jobId: '' }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'validation');
          assert.ok(String((error as Error).message).includes('ADR-0005'));
          return true;
        },
      );
      const servers = await h.invoke<unknown[]>('servers_list');
      assert.equal(servers.length, 0);
    });

    await run.must('artifact drift rejects the install and re-inserts the preview', async () => {
      const mrpack = await makeMrpack(h.dataRoot, 'drift-suite.mrpack');
      const preview = await h.invoke<PipelinePreviewDto>('modpack_pipeline_preview', {
        source: { kind: 'localMrpack', sourceId: mrpack },
        jobId: '',
      });
      // Simulate a cached/local archive replaced after review: bytes + mtime change.
      fs.appendFileSync(mrpack, 'drift-after-review');

      const before = await h.invoke<unknown[]>('servers_list');
      const result = await install(h, preview.previewId, { name: 'Drift Install' });
      assert.equal(result.status, 'failed');
      assert.equal(result.server, null);
      assertReportShape(result.report);
      assert.ok(result.report.errors.some(entry => entry.includes('Review the pack again')), String(result.report.errors));
      assert.ok(result.report.errors.some(entry => entry.includes('changed size') || entry.includes('modified')), String(result.report.errors));
      const after = await h.invoke<unknown[]>('servers_list');
      assert.equal(after.length, before.length);
      assert.deepEqual(stagingListing(h), []);
      // Pre-mutation failure keeps the preview reviewable; a second attempt is still drift-rejected.
      assert.equal(await h.invoke<boolean>('modpack_pipeline_discard_preview', { previewId: preview.previewId }), true);
    });

    await run.must('blank CurseForge route-A metadata fails cleanly and publishes no server', async () => {
      await makeBlankRouteAZip(h.dataRoot, 'route-a-blank.zip');
      const preview = await h.invoke<PipelinePreviewDto>('modpack_pipeline_preview', {
        source: { kind: 'curseForgeServerZip', zipName: 'route-a-blank.zip' },
        jobId: '',
      });
      assertPlanShape(preview.plan);
      assert.equal(preview.plan.loader.kind, '');
      assert.equal(preview.plan.loader.minecraftVersion, '');
      const before = await h.invoke<unknown[]>('servers_list');

      const result = await install(h, preview.previewId, { name: 'Blank Metadata Pack' });
      assert.equal(result.status, 'failed');
      assert.equal(result.server, null);
      assertReportShape(result.report);
      assert.ok(
        result.report.errors.some(entry => entry.includes('does not declare an exact Minecraft version and loader')),
        String(result.report.errors),
      );
      const after = await h.invoke<unknown[]>('servers_list');
      assert.equal(after.length, before.length);
      assert.deepEqual(stagingListing(h), []);
      assert.equal(await h.invoke<boolean>('modpack_pipeline_discard_preview', { previewId: preview.previewId }), true);
    });

    await run.must('preview is single-use: a second install cannot publish a duplicate server', async () => {
      const preview = await h.invoke<{ previewId: string }>('modpack_pipeline_preview', {
        source: { kind: 'unsupportedPipelineSource' },
        jobId: '',
      });
      const first = await install(h, preview.previewId, { name: 'Single Use First' });
      assert.equal(first.status, 'failed'); // fails inside the staged transaction, so the preview is consumed
      const second = await install(h, preview.previewId, { name: 'Single Use Second' });
      assert.equal(second.status, 'failed');
      assert.equal(second.server, null);
      assertReportShape(second.report);
      assert.ok(second.report.errors.some(entry => entry.includes('not found or already used')), String(second.report.errors));
      assert.equal(await h.invoke<boolean>('modpack_pipeline_discard_preview', { previewId: preview.previewId }), false);
      const servers = await h.invoke<{ id: string; name: string }[]>('servers_list');
      assert.equal(servers.length, 0);
      assert.deepEqual(stagingListing(h), []);
    });
  });
}
