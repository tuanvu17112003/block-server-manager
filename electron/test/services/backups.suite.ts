// Service suite for WP-5.2/5.5 backup correctness: validated schedules, pooled retention,
// running-backup flush acknowledgement (injected process/clock), shutdown-during, and ZIP output
// (entries, deflate, DOS timestamps). Exported for the Lead to register in service-runner.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { tempRoot } from '../harness';
import type { TestRun } from '../harness';
import { withHarness } from '../service-harness';
import { Store, type BackupRecord } from '../../services/store';
import { Jobs } from '../../services/jobs';
import { Backups, type BackupsRuntimeDeps } from '../../services/backups';
import { extractZip } from '../../services/installer/core';
import { SAFETY_POOL_SIZE, WORLD_DELETE_POOL_SIZE } from '../../services/backups-core';
import type { IpcContext } from '../../ipc';
import type { ServerProcesses } from '../../services/server-process';

interface ScheduleDto { auto: boolean; interval: 'Hourly' | 'Daily' | 'Weekly'; maxKept: number; lastRunAt: string | null }

function zipEntries(file: string): Promise<{ name: string; method: number; date: Date }[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('could not open zip')); return; }
      const entries: { name: string; method: number; date: Date }[] = [];
      zip.on('entry', (entry) => {
        entries.push({ name: entry.fileName, method: entry.compressionMethod, date: entry.getLastModDate() });
        zip.readEntry();
      });
      zip.on('end', () => { zip.close(); resolve(entries); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function backupRows(store: Store, serverId: string): BackupRecord[] {
  return store.listBackups(serverId);
}

/** Mocked ServerProcesses surface used by the injected flush/shutdown/scheduler cases. */
interface MockState {
  status: 'running' | 'stopped' | 'starting';
  ring: string[];
  commands: string[];
  stops: number;
  starts: number;
  autoAck: boolean;
}

function mockProcesses(state: MockState): ServerProcesses {
  const mock = {
    status: () => state.status,
    history: () => state.ring,
    lineSeq: () => state.ring.length,
    entriesSince: (_id: string, fromSeq: number, limit = 500) => state.ring
      .slice(fromSeq)
      .slice(-limit)
      .map((text, index) => ({ seq: fromSeq + index + 1, text })),
    command: (_id: string, command: string) => {
      state.commands.push(command);
      if (command === 'save-all flush' && state.autoAck) {
        state.ring.push('[12:00:00] [Server thread/INFO]: Saved the game');
      }
    },
    stop: async () => { state.stops += 1; state.status = 'stopped'; },
    start: async () => { state.starts += 1; state.status = 'running'; },
  };
  return mock as unknown as ServerProcesses;
}

function makeRunningState(overrides: Partial<MockState> = {}): MockState {
  return { status: 'running', ring: [], commands: [], stops: 0, starts: 0, autoAck: true, ...overrides };
}

function createMockBackups(root: string, processes: ServerProcesses, deps: Partial<BackupsRuntimeDeps> = {}): Backups {
  const ctx: IpcContext = { dataRoot: root, send: () => undefined, getWindow: () => null };
  return new Backups(ctx, processes, new Jobs(() => undefined), deps);
}

function scaffoldServerDir(root: string, serverId: string): string {
  const dir = path.join(root, 'servers', serverId);
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'test-level');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\nmotd=Backup Suite\n');
  return dir;
}

function newMockServer(root: string, name: string): { id: string; dir: string } {
  const dto = new Store(root).createServer({ name, loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 });
  return { id: dto.id, dir: scaffoldServerDir(root, dto.id) };
}

export async function runBackupsSuite(run: TestRun): Promise<void> {
  await withHarness(run, async (h) => {
    const created = await h.createServer({ name: 'Backup Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
    h.scaffoldServer(created.id);

    await run.must('schedule: invalid interval rejected; valid patch persists with clamped maxKept', async () => {
      await assert.rejects(
        () => h.invoke('backup_schedule_set', { id: created.id, interval: 'every-second' }),
        (error: unknown) => (error as { code?: string }).code === 'validation',
      );
      const saved = await h.invoke<ScheduleDto>('backup_schedule_set', { id: created.id, auto: true, interval: 'Daily', maxKept: 999 });
      assert.equal(saved.auto, true);
      assert.equal(saved.interval, 'Daily');
      assert.equal(saved.maxKept, 50);
      assert.equal(saved.lastRunAt, null);
    });

    await run.must('backup create: archive entries, deflate, DOS mtimes and job progress event', async () => {
      const backup = await h.invoke<{ id: string; path: string; note: string }>('backup_create', {
        id: created.id, name: 'archive-check', jobId: 'job-backup-archive',
      });
      assert.ok(fs.existsSync(backup.path));
      assert.equal(backup.note, 'Taken while stopped');
      assert.ok(h.events.some((event) => event.channel === 'job://progress/job-backup-archive'));
      const entries = await zipEntries(backup.path);
      assert.ok(entries.some((entry) => entry.name === 'world/level.dat'));
      assert.ok(entries.some((entry) => entry.name === 'server.properties'));
      for (const entry of entries) {
        assert.equal(entry.method, 8, `${entry.name} is not deflated`);
        assert.ok(entry.date.getFullYear() >= 2020, `${entry.name} lost its mtime (year ${entry.date.getFullYear()})`);
      }
      const out = path.join(h.dataRoot, 'unzipped-backup');
      await extractZip(backup.path, out, { skipExisting: false });
      assert.equal(fs.readFileSync(path.join(out, 'world', 'level.dat'), 'utf8'), 'test-level');
    });

    await run.must('retention: Manual/Auto keep exactly maxKept and never prune the new archive', async () => {
      h.store().setBackupSchedule(created.id, { auto: false, interval: 'Daily', maxKept: 2, lastRunAt: null });
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const backup = await h.invoke<{ id: string; path: string }>('backup_create', { id: created.id, name: `manual-${index}` });
        ids.push(backup.id);
      }
      const rows = backupRows(h.store(), created.id).filter((row) => row.kind === 'Manual' || row.kind === 'Auto');
      assert.equal(rows.length, 2);
      assert.ok(rows.some((row) => row.id === ids[4]), 'just-created archive was pruned');
      assert.ok(!rows.some((row) => row.id === ids[0]), 'oldest archive survived retention');
      const files = fs.readdirSync(path.join(h.dataRoot, 'backups')).filter((name) => name.endsWith('.zip'));
      const livePaths = new Set(backupRows(h.store(), created.id).map((row) => path.basename(row.path)));
      for (const file of files) assert.ok(livePaths.has(file), `orphaned archive left on disk: ${file}`);
    });

    await run.must('retention: bounded Pre-install/Pre-restore safety pools and World-delete bound', async () => {
      h.store().setBackupSchedule(created.id, { auto: false, interval: 'Daily', maxKept: 50, lastRunAt: null });
      for (let index = 0; index <= SAFETY_POOL_SIZE; index += 1) {
        await h.invoke('backup_create', { id: created.id, name: `pre-install-${index}`, kind: 'Pre-install' });
        await h.invoke('backup_create', { id: created.id, name: `pre-restore-${index}`, kind: 'Pre-restore' });
      }
      for (let index = 0; index <= WORLD_DELETE_POOL_SIZE; index += 1) {
        await h.invoke('backup_create', { id: created.id, name: `world-delete-${index}`, kind: 'World-delete' });
      }
      const rows = backupRows(h.store(), created.id);
      assert.equal(rows.filter((row) => row.kind === 'Pre-install').length, SAFETY_POOL_SIZE);
      assert.equal(rows.filter((row) => row.kind === 'Pre-restore').length, SAFETY_POOL_SIZE);
      assert.equal(rows.filter((row) => row.kind === 'World-delete').length, WORLD_DELETE_POOL_SIZE);
      await assert.rejects(
        () => h.invoke('backup_create', { id: created.id, name: 'bogus-kind', kind: 'Bogus' }),
        (error: unknown) => (error as { code?: string }).code === 'validation',
      );
    });

    await run.must('shutdownDuring on a stopped server archives without stop/start side effects', async () => {
      const backup = await h.invoke<{ note: string; path: string }>('backup_create', {
        id: created.id, name: 'shutdown-stopped', shutdownDuring: true,
      });
      assert.equal(backup.note, 'Taken while stopped');
      assert.ok(fs.existsSync(backup.path));
    });
  });

  // ── Injected-process cases (no real server): flush ack, timeout, starting refusal, shutdown, tick ──
  const temp = tempRoot('msm-svc-backups-mock');
  let mockSeq = 0;
  try {
    const runMock = async (
      name: string,
      state: MockState,
      body: (backups: Backups, server: { id: string; dir: string }, mock: MockState) => Promise<void>,
      deps: Partial<BackupsRuntimeDeps> = {},
    ): Promise<void> => {
      await run.must(name, async () => {
        mockSeq += 1;
        const server = newMockServer(temp.root, `Mock Server ${mockSeq}`);
        const backups = createMockBackups(temp.root, mockProcesses(state), deps);
        await body(backups, server, state);
      });
    };

    await runMock('running backup waits for the flush ack, then save-on in finally', makeRunningState(), async (backups, server, mock) => {
      const record = await backups.create(server.id, 'flush-ok', 'Manual');
      assert.equal(record.note, 'Taken while running after flush acknowledged');
      assert.ok(mock.commands.includes('save-off'));
      assert.ok(mock.commands.includes('save-all flush'));
      assert.equal(mock.commands[mock.commands.length - 1], 'save-on');
      const rows = backupRows(new Store(temp.root), server.id);
      assert.equal(rows.length, 1);
      assert.ok(fs.existsSync(rows[0]!.path));
    });

    await runMock(
      'running backup notes a flush-ack timeout and still restores save-on',
      makeRunningState({ autoAck: false }),
      async (backups, server, mock) => {
        const record = await backups.create(server.id, 'flush-timeout', 'Manual');
        assert.equal(record.note, 'Taken while running; flush acknowledgement timed out');
        assert.equal(mock.commands[mock.commands.length - 1], 'save-on');
        assert.ok(record.bytes > 0);
      },
      (() => {
        const clock = { now: 0 };
        return { now: () => clock.now, sleep: async (ms: number) => { clock.now += ms; }, flushTimeoutMs: 30, flushPollMs: 10 };
      })(),
    );

    await runMock('backup refuses a server that is still starting', makeRunningState({ status: 'starting' }), async (backups, server, mock) => {
      await assert.rejects(
        () => backups.create(server.id, 'starting', 'Manual'),
        (error: unknown) => (error as { code?: string }).code === 'conflict',
      );
      assert.equal(mock.commands.length, 0);
      assert.equal(backupRows(new Store(temp.root), server.id).length, 0);
    });

    await runMock('shutdownDuring stops, archives stopped and restarts the server', makeRunningState({ autoAck: false }), async (backups, server, mock) => {
      const record = await backups.create(server.id, 'shutdown-during', 'Manual', '', { shutdownDuring: true });
      assert.equal(record.note, 'Server stopped for a consistent backup');
      assert.equal(mock.stops, 1);
      assert.equal(mock.starts, 1);
      assert.ok(!mock.commands.includes('save-off'), 'a stopped server must not receive save-off');
      assert.ok(fs.existsSync(record.path));
    });

    await runMock(
      'scheduler tick honours the injected clock and interval (one auto backup)',
      makeRunningState({ status: 'stopped' }),
      async (backups, server) => {
        const store = new Store(temp.root);
        store.setBackupSchedule(server.id, { auto: true, interval: 'Hourly', maxKept: 10, lastRunAt: null });
        await backups.tick();
        assert.equal(backupRows(new Store(temp.root), server.id).filter((row) => row.kind === 'Auto').length, 1);
        const afterFirst = new Store(temp.root).backupSchedule(server.id);
        assert.ok(afterFirst.lastRunAt, 'lastRunAt was not recorded after a successful auto backup');
        await backups.tick();
        assert.equal(backupRows(new Store(temp.root), server.id).filter((row) => row.kind === 'Auto').length, 1);
      },
      { now: () => Date.parse('2026-10-26T12:00:00.000Z') },
    );
  } finally {
    temp.cleanup();
  }
}
