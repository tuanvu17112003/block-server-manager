// Staged-install transaction suite (WP-2.4): success publication, failure/cancel cleanup,
// record-only-after-validation, publish-failure rollback and the handler wiring prechecks.
// Fake install callbacks only — no network, no Java, no install engines are invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TestRun, tempRoot } from '../harness';
import { withHarness } from '../service-harness';
import { Store } from '../../services/store';
import {
  INSTALLER_LOG_FILE,
  STAGING_DIR,
  assertServerNameAvailable,
  publishStagedServer,
  validateStagedInstall,
} from '../../services/install-transaction';

const VANILLA_INPUT = { name: 'Staged Vanilla', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024, port: 25565, eulaAccepted: false };

/** Minimal on-disk shape of a successful Vanilla install (validated by the real validator). */
async function fakeVanillaInstall(stagingDir: string): Promise<void> {
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(path.join(stagingDir, 'server.jar'), 'fake-server-jar');
  fs.writeFileSync(path.join(stagingDir, 'server.properties'), 'server-port=25565\n');
}

function listing(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function assertNoStagingOrRecord(dataRoot: string, store: Store): void {
  assert.equal(store.listServers().length, 0, 'a failed/cancelled install left a server record');
  assert.deepEqual(listing(path.join(dataRoot, STAGING_DIR)), [], 'a failed/cancelled install left staged files');
  assert.deepEqual(listing(path.join(dataRoot, 'servers')), [], 'a failed/cancelled install left a final server directory');
}

export async function runInstallSuite(run: TestRun): Promise<void> {
  await run.must('success: stage -> validate -> publish leaves one record, one dir and a published installer.log', async () => {
    const temp = tempRoot('msm-svc-install-ok');
    try {
      const store = new Store(temp.root);
      const recordsSeen: number[] = [];
      const progress: string[] = [];
      const result = await publishStagedServer({
        dataRoot: temp.root,
        store,
        input: { ...VANILLA_INPUT },
        onProgress: event => progress.push(event.stage),
        install: async ctx => {
          recordsSeen.push(store.listServers().length);
          assert.ok(ctx.stagingDir.startsWith(path.join(temp.root, STAGING_DIR)), 'install dir is not under installer-staging');
          await fakeVanillaInstall(ctx.stagingDir);
          ctx.log('fake vanilla installed');
        },
        verify: ctx => {
          recordsSeen.push(store.listServers().length);
          return validateStagedInstall({ stagingDir: ctx.stagingDir, loaderKind: 'vanilla', log: ctx.log });
        },
      });

      assert.deepEqual(recordsSeen, [0, 0], 'record was visible before validation finished');
      assert.deepEqual(progress, ['validating install', 'publishing']);
      const servers = store.listServers();
      assert.equal(servers.length, 1);
      assert.equal(servers[0].id, result.server.id);
      const dir = path.join(temp.root, 'servers', result.server.id);
      assert.equal(fs.readFileSync(path.join(dir, 'server.jar'), 'utf8'), 'fake-server-jar');
      assert.ok(fs.existsSync(path.join(dir, 'server.properties')));
      assert.deepEqual(listing(path.join(temp.root, STAGING_DIR)), [], 'staging directory survived publication');
      assert.deepEqual(listing(path.join(temp.root, 'servers')), [result.server.id]);
      const logText = fs.readFileSync(path.join(dir, INSTALLER_LOG_FILE), 'utf8');
      assert.match(logText, /fake vanilla installed/);
      assert.match(logText, /published as servers\//);
      assert.ok(result.launch && result.launch.args.includes('-jar'), 'validated launch shape was not returned');
    } finally {
      temp.cleanup();
    }
  });

  await run.must('record appears only after validation, immediately before the atomic publish', async () => {
    const temp = tempRoot('msm-svc-install-record');
    try {
      const store = new Store(temp.root);
      let recordsDuringVerify = -1;
      let recordsAtBeforePublish = -1;
      let finalDirExistedAtBeforePublish = true;
      const result = await publishStagedServer({
        dataRoot: temp.root,
        store,
        input: { ...VANILLA_INPUT },
        install: async ctx => { await fakeVanillaInstall(ctx.stagingDir); },
        verify: ctx => {
          recordsDuringVerify = store.listServers().length;
          validateStagedInstall({ stagingDir: ctx.stagingDir, loaderKind: 'vanilla' });
        },
        beforePublish: (server, ctx) => {
          recordsAtBeforePublish = store.listServers().length;
          finalDirExistedAtBeforePublish = fs.existsSync(path.join(temp.root, 'servers', server.id));
          assert.ok(ctx.stagingDir.includes(STAGING_DIR), 'beforePublish ran after the publish');
        },
      });
      assert.equal(recordsDuringVerify, 0, 'record existed during validation');
      assert.equal(recordsAtBeforePublish, 1, 'record was not inserted before the publish hook');
      assert.equal(finalDirExistedAtBeforePublish, false, 'final directory existed before the atomic rename');
      assert.ok(fs.existsSync(path.join(temp.root, 'servers', result.server.id, 'server.jar')));
    } finally {
      temp.cleanup();
    }
  });

  await run.must('installer failure removes staging and leaves no record or final directory', async () => {
    const temp = tempRoot('msm-svc-install-fail');
    try {
      const store = new Store(temp.root);
      let stagingSeen = '';
      await assert.rejects(
        () => publishStagedServer({
          dataRoot: temp.root,
          store,
          input: { ...VANILLA_INPUT },
          install: async ctx => {
            stagingSeen = ctx.stagingDir;
            await fakeVanillaInstall(ctx.stagingDir);
            throw Object.assign(new Error('fake installer exploded'), { code: 'install-failed' });
          },
        }),
        (error: unknown) => (error as { code?: string }).code === 'install-failed',
      );
      assert.ok(stagingSeen.length > 0, 'install callback never ran');
      assert.equal(fs.existsSync(stagingSeen), false, 'staging directory survived the failure');
      assertNoStagingOrRecord(temp.root, store);
      assert.equal(fs.existsSync(path.join(temp.root, 'servers')), false, 'servers/ was created for a failed install');
    } finally {
      temp.cleanup();
    }
  });

  await run.must('validation failure (no launch artifact) rejects before any record or publish', async () => {
    const temp = tempRoot('msm-svc-install-invalid');
    try {
      const store = new Store(temp.root);
      await assert.rejects(
        () => publishStagedServer({
          dataRoot: temp.root,
          store,
          input: { ...VANILLA_INPUT },
          install: async ctx => {
            fs.mkdirSync(ctx.stagingDir, { recursive: true });
            fs.writeFileSync(path.join(ctx.stagingDir, 'README.txt'), 'not a server');
          },
        }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'install-invalid');
          assert.match((error as Error).message, /artifact|launch/i);
          return true;
        },
      );
      assertNoStagingOrRecord(temp.root, store);
    } finally {
      temp.cleanup();
    }
  });

  await run.must('cancel after install removes staging and leaves no record or final directory', async () => {
    const temp = tempRoot('msm-svc-install-cancel');
    try {
      const store = new Store(temp.root);
      let cancelled = false;
      let stagingSeen = '';
      await assert.rejects(
        () => publishStagedServer({
          dataRoot: temp.root,
          store,
          input: { ...VANILLA_INPUT },
          isCancelled: () => cancelled,
          install: async ctx => {
            stagingSeen = ctx.stagingDir;
            await fakeVanillaInstall(ctx.stagingDir);
            cancelled = true;
          },
        }),
        (error: unknown) => (error as { code?: string }).code === 'cancelled',
      );
      assert.equal(fs.existsSync(stagingSeen), false, 'staging directory survived the cancellation');
      assertNoStagingOrRecord(temp.root, store);
    } finally {
      temp.cleanup();
    }
  });

  await run.must('cancel before install starts never creates staging or a record', async () => {
    const temp = tempRoot('msm-svc-install-cancel-early');
    try {
      const store = new Store(temp.root);
      let installCalls = 0;
      await assert.rejects(
        () => publishStagedServer({
          dataRoot: temp.root,
          store,
          input: { ...VANILLA_INPUT },
          isCancelled: () => true,
          install: async () => { installCalls++; },
        }),
        (error: unknown) => (error as { code?: string }).code === 'cancelled',
      );
      assert.equal(installCalls, 0, 'installer ran after cancellation');
      assertNoStagingOrRecord(temp.root, store);
    } finally {
      temp.cleanup();
    }
  });

  await run.must('publish failure rolls the created record back and removes staging', async () => {
    const temp = tempRoot('msm-svc-install-publish-fail');
    try {
      const store = new Store(temp.root);
      let stagingSeen = '';
      await assert.rejects(
        () => publishStagedServer({
          dataRoot: temp.root,
          store,
          input: { ...VANILLA_INPUT },
          install: async ctx => { stagingSeen = ctx.stagingDir; await fakeVanillaInstall(ctx.stagingDir); },
          publish: () => { throw new Error('rename exploded'); },
        }),
        /rename exploded/,
      );
      assert.equal(store.listServers().length, 0, 'publish failure left a server record');
      assert.equal(fs.existsSync(stagingSeen), false, 'publish failure left staging behind');
      assert.deepEqual(listing(path.join(temp.root, STAGING_DIR)), []);
      assert.deepEqual(listing(path.join(temp.root, 'servers')), []);
    } finally {
      temp.cleanup();
    }
  });

  await run.must('assertServerNameAvailable fails fast with conflict for a taken name', async () => {
    const temp = tempRoot('msm-svc-install-name');
    try {
      const store = new Store(temp.root);
      store.createServer({ name: 'Taken', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 });
      assert.throws(() => assertServerNameAvailable(store, 'Taken'), (error: unknown) => (error as { code?: string }).code === 'conflict');
      assert.doesNotThrow(() => assertServerNameAvailable(store, 'Free'));
    } finally {
      temp.cleanup();
    }
  });

  // Handler-level wiring: both install entry points must reject a duplicate name before staging any
  // files. These paths never resolve Java or touch the network.
  await withHarness(run, async h => {
    await run.must('server_install (runtime) rejects a duplicate name before staging', async () => {
      const created = await h.createServer({ name: 'Wired Duplicate', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
      await assert.rejects(
        () => h.invoke('server_install', { input: { name: 'Wired Duplicate', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 }, jobId: '' }),
        (error: unknown) => (error as { code?: string }).code === 'conflict',
      );
      const rows = await h.invoke<{ id: string }[]>('servers_list');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, created.id);
      assert.deepEqual(listing(path.join(h.dataRoot, STAGING_DIR)), []);
    });

    await run.must('modpack_pipeline_install rejects a duplicate name before staging', async () => {
      await h.createServer({ name: 'Wired Pipeline Duplicate', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
      const preview = await h.invoke<{ previewId: string }>('modpack_pipeline_preview', {
        source: { kind: 'unsupportedPipelineSource' },
        jobId: '',
      });
      const result = await h.invoke<{ status: string; error: string | null; report: { serverId: string } }>('modpack_pipeline_install', {
        previewId: preview.previewId,
        input: { name: 'Wired Pipeline Duplicate', ramMb: 1024 },
        choices: { files: {}, approvedReplacements: [], autoDeleteCurseForgeZip: false },
        jobId: '',
      });
      assert.equal(result.status, 'failed');
      assert.match(String(result.error), /already exists/);
      const rows = await h.invoke<{ name: string }[]>('servers_list');
      assert.equal(rows.filter(row => row.name === 'Wired Pipeline Duplicate').length, 1);
      assert.deepEqual(listing(path.join(h.dataRoot, STAGING_DIR)), []);
    });
  });
}
