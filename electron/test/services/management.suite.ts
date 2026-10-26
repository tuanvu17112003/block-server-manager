// Service-level suites for the management/content wave. Runs inside Electron via --servicestest
// against throwaway data roots (no real .app-data, no network required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TestRun } from '../harness';
import { withHarness, type Harness } from '../service-harness';

export async function runStoreSuite(run: TestRun): Promise<void> {
  await withHarness(run, async (h) => {
    await run.must('create/list/get/delete round-trip', async () => {
      const created = await h.createServer({ name: 'Store Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
      assert.ok(created.id);
      assert.equal(created.name, 'Store Suite');
      const list = await h.invoke<{ id: string }[]>('servers_list');
      assert.ok(list.some((row) => row.id === created.id));
      const got = await h.invoke<{ id: string } | null>('server_get', { id: created.id });
      assert.equal(got?.id, created.id);
      await h.invoke('servers_delete', { id: created.id });
      const after = await h.invoke<{ id: string }[]>('servers_list');
      assert.ok(!after.some((row) => row.id === created.id));
    });

    await run.must('duplicate name rejected with conflict', async () => {
      await h.createServer({ name: 'Dup', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
      await assert.rejects(
        () => h.createServer({ name: 'Dup', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never),
        (error: unknown) => (error as { code?: string }).code === 'conflict',
      );
    });

    await run.must('settings update/read + list enrichment', async () => {
      const created = await h.createServer({ name: 'Settings Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
      h.scaffoldServer(created.id);
      await h.invoke('server_settings_update', {
        id: created.id,
        values: { motd: 'hello', 'max-players': '30', difficulty: 'hard' },
        name: 'Renamed', ramMb: 3072, eulaAccepted: true,
      });
      const settings = await h.invoke<{ eulaAccepted: boolean; values: Record<string, string>; entries: unknown[] }>(
        'server_settings_get', { id: created.id },
      );
      assert.equal(settings.values.motd, 'hello');
      assert.equal(settings.values['max-players'], '30');
      assert.equal(settings.eulaAccepted, true);
      assert.ok(settings.entries.length >= 3);
      const list = await h.invoke<{ id: string; name: string; motd?: string; maxPlayers?: number; ramMb: number }[]>('servers_list');
      const row = list.find((entry) => entry.id === created.id)!;
      assert.equal(row.name, 'Renamed');
      assert.equal(row.motd, 'hello');
      assert.equal(row.maxPlayers, 30);
      assert.equal(row.ramMb, 3072);
    });

    await run.must('settings validation rejects bad values with validation code', async () => {
      const created = await h.createServer({ name: 'Validation Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
      h.scaffoldServer(created.id);
      await assert.rejects(
        () => h.invoke('server_settings_update', { id: created.id, values: { 'max-players': '9999' } }),
        (error: unknown) => (error as { code?: string }).code === 'validation',
      );
      await assert.rejects(
        () => h.invoke('server_settings_update', { id: 'missing', values: {} }),
        (error: unknown) => (error as { code?: string }).code === 'not-found',
      );
    });

    await run.must('command history is per-server and persisted', async () => {
      const created = await h.createServer({ name: 'History Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 } as never);
      h.store().pushCommand(created.id, 'say hello');
      const history = await h.invoke<string[]>('server_command_history', { id: created.id });
      assert.deepEqual(history, ['say hello']);
    });
  });
}

export async function runManagementSuite(run: TestRun): Promise<void> {
  await withHarness(run, async (h) => {
    const created = await h.createServer({ name: 'Mgmt Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 } as never);
    const dir = h.scaffoldServer(created.id);
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'example.jar'), 'test-jar');

    await run.must('worlds/list sees the scaffold world', async () => {
      const worlds = await h.invoke<{ name: string; active: boolean }[]>('worlds_list', { id: created.id });
      assert.ok(worlds.some((world) => world.name === 'world' && world.active));
    });

    await run.must('backup create/list/delete + job progress event', async () => {
      const backup = await h.invoke<{ id: string; path: string }>('backup_create', { id: created.id, name: 'suite', jobId: 'job-backup-1' });
      assert.ok(fs.existsSync(backup.path));
      const list = await h.invoke<{ id: string }[]>('backups_list', { id: created.id });
      assert.ok(list.some((row) => row.id === backup.id));
      assert.ok(h.events.some((event) => event.channel === 'job://progress/job-backup-1'));
      await h.invoke('backup_delete', { backupId: backup.id });
      const after = await h.invoke<{ id: string }[]>('backups_list', { id: created.id });
      assert.ok(!after.some((row) => row.id === backup.id));
      await assert.rejects(
        () => h.invoke('backup_restore', { id: created.id, backupId: 'missing' }),
        (error: unknown) => (error as { code?: string }).code === 'not-found',
      );
    });

    await run.must('backup restore round-trip brings server.properties back', async () => {
      const backup = await h.invoke<{ id: string }>('backup_create', { id: created.id, name: 'restore-suite' });
      await h.invoke('server_settings_update', { id: created.id, values: { motd: 'changed-after-backup' } });
      await h.invoke('backup_restore', { id: created.id, backupId: backup.id, mode: 'in-place' });
      const settings = await h.invoke<{ values: Record<string, string> }>('server_settings_get', { id: created.id });
      assert.equal(settings.values.motd, 'Test MOTD');
    });

    await run.must('content list/toggle/remove', async () => {
      const listed = await h.invoke<{ fileName: string; enabled: boolean }[]>('content_list', { id: created.id });
      assert.ok(listed.some((item) => item.fileName === 'example.jar' && item.enabled));
      await h.invoke('content_toggle', { id: created.id, fileName: 'example.jar', enabled: false });
      assert.ok(fs.existsSync(path.join(dir, 'mods-disabled', 'example.jar')));
      const toggled = await h.invoke<{ fileName: string; enabled: boolean }[]>('content_list', { id: created.id });
      assert.equal(toggled.find((item) => item.fileName === 'example.jar')?.enabled, false);
      await h.invoke('content_remove', { id: created.id, fileName: 'example.jar' });
      const removed = await h.invoke<{ fileName: string }[]>('content_list', { id: created.id });
      assert.ok(!removed.some((item) => item.fileName === 'example.jar'));
    });

    await run.must('players list is safe while stopped', async () => {
      const result = await h.invoke<{ players: unknown[]; running: boolean; maxPlayers: number }>('players_list', { id: created.id });
      assert.equal(result.running, false);
      assert.ok(Array.isArray(result.players));
      assert.ok(typeof result.maxPlayers === 'number');
    });

    await run.must('metrics history + disk probe', async () => {
      const result = await h.invoke<{ samples: unknown[]; disk: { totalBytes: number } }>('metrics_get', { id: created.id, hours: 1 });
      assert.ok(Array.isArray(result.samples));
      assert.ok(result.disk.totalBytes > 0);
      const disk = await h.invoke<{ totalBytes: number }>('system_disk');
      assert.ok(disk.totalBytes > 0);
    });

    await run.must('world create pending + duplicate safety', async () => {
      const pending = await h.invoke<{ pending?: boolean }>('world_create', { id: created.id, name: 'newworld', seed: '42', levelType: 'minecraft:flat' });
      assert.equal(pending.pending, true);
      const worlds = await h.invoke<{ name: string; pending?: boolean }[]>('worlds_list', { id: created.id });
      assert.ok(worlds.some((world) => world.name === 'newworld' && world.pending));
    });
  });
}
