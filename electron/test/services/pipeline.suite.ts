// Pipeline install-report contract suite: a failed install must still return the full
// PipelineInstallReport DTO (src/tauri.ts) and roll the server row/directory back, and the
// durable artifact writer must emit the same shape as `install-report.json`.
// Runs inside Electron via --servicestest against a throwaway data root; no network is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TestRun } from '../harness';
import { withHarness } from '../service-harness';
import {
  INSTALL_REPORT_FILE,
  PIPELINE_REPORT_SCHEMA_VERSION,
  writeInstallReport,
  type PipelineInstallReport,
  type PipelineInstallResult,
} from '../../services/pipeline';

const REPORT_KEYS = [
  'schemaVersion', 'planId', 'serverId', 'createdAt', 'status', 'sourcePin',
  'loader', 'files', 'stages', 'warnings', 'errors',
] as const;

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

      const result = await h.invoke<PipelineInstallResult>('modpack_pipeline_install', {
        previewId: preview.previewId,
        input: { name: 'Pipeline Failure', port: 25565, ramMb: 2048, eulaAccepted: false },
        choices: { files: {}, approvedReplacements: [], autoDeleteCurseForgeZip: false },
        jobId: '',
      });

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
  });
}
