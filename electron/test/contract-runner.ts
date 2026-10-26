// Contract tests — every renderer-invoked command must exist and keep its payload/return/error
// contract. Runs inside Electron via --contracttest on a throwaway data root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IpcContext } from '../ipc';
import { handlersMap, registerRuntimeHandlers } from '../ipc';
import { buildRuntime } from '../services/runtime';
import { TestRun } from './harness';

/** Commands invoked by src/tauri.ts (renderer). A missing handler here breaks a UI path. */
export const RENDERER_COMMANDS = [
  'backup_create', 'backup_delete', 'backup_export', 'backup_restore', 'backup_schedule_get',
  'backup_schedule_set', 'backups_list', 'content_install', 'content_install_cancel', 'content_list', 'content_remove',
  'content_search', 'content_toggle', 'content_versions', 'curseforge_cancel_download',
  'curseforge_inspect_project', 'curseforge_inspect_zip', 'curseforge_list_zips',
  'curseforge_open_browser', 'curseforge_open_external_browser', 'curseforge_pick_zip',
  'java_detect', 'java_ensure', 'java_validate', 'loaders_resolve', 'logs_tail', 'metrics_get',
  'modpack_pipeline_cancel', 'modpack_pipeline_discard_preview', 'modpack_pipeline_install',
  'modpack_pipeline_pick_local_mrpack', 'modpack_pipeline_preview',
  'modpack_pipeline_release_local_mrpack', 'modrinth_project_versions', 'modrinth_search_modpacks',
  'ping', 'player_action', 'players_add_offline', 'players_list', 'port_check',
  'server_command_history', 'server_get', 'server_install', 'server_install_cancel', 'server_kill',
  'server_open_folder', 'server_restart', 'server_send_command', 'server_settings_get',
  'server_settings_update', 'server_start', 'server_stop', 'servers_create', 'servers_delete',
  'servers_list', 'servers_set_java_path', 'system_disk', 'versions_paper', 'versions_vanilla',
  'world_activate', 'world_create', 'world_delete', 'world_duplicate', 'world_export',
  'world_import', 'worlds_list',
] as const;

export interface SuiteResult {
  ok: boolean;
  report: string;
}

export async function runContractTests(ctx: IpcContext, filter?: string): Promise<SuiteResult> {
  const run = new TestRun('contract');
  const appRuntime = buildRuntime();
  const runtime = appRuntime.register(ctx);
  registerRuntimeHandlers(runtime.handlers);
  const merged: Record<string, (args: Record<string, unknown>, context: IpcContext) => unknown> = {
    ...handlersMap(), ...runtime.handlers,
  };
  const invoke = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const handler = merged[name];
    if (!handler) throw Object.assign(new Error(`No handler registered for "${name}".`), { code: 'not-found' });
    return handler(args, ctx) as Promise<T>;
  };

  try {
    if (!filter || 'commands'.includes(filter)) {
      await run.must('all renderer commands are registered', async () => {
        const missing = RENDERER_COMMANDS.filter((name) => typeof merged[name] !== 'function');
        assert.deepEqual(missing, []);
        assert.equal(RENDERER_COMMANDS.length, 66);
      });
      await run.must('unknown command is not registered', async () => {
        assert.equal(merged['definitely_not_a_command'], undefined);
      });
    }

    if (!filter || 'shape'.includes(filter)) {
      await run.must('ping returns pong', async () => {
        assert.equal(await invoke('ping'), 'pong');
      });
      await run.must('servers_create returns the camelCase DTO contract', async () => {
        const created = await invoke<Record<string, unknown>>('servers_create', {
          input: { name: 'Contract Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 2048 },
        });
        for (const key of ['id', 'name', 'loader', 'mcVersion', 'port', 'ramMb', 'eulaAccepted', 'status', 'createdAt']) {
          assert.ok(key in created, `missing ${key}`);
        }
        assert.equal(created.status, 'stopped');
        assert.equal(created.eulaAccepted, false);
        const list = await invoke<unknown[]>('servers_list');
        assert.ok(Array.isArray(list) && list.length === 1);
      });
      await run.must('servers_delete of a missing id rejects with not-found', async () => {
        await assert.rejects(() => invoke('servers_delete', { id: 'missing' }), (error: unknown) => {
          return (error as { code?: string }).code === 'not-found';
        });
      });
    }

    if (!filter || 'json'.includes(filter)) {
      await run.must('management DTOs are JSON-serializable', async () => {
        const created = await invoke<{ id: string }>('servers_create', {
          input: { name: 'JSON Suite', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: 1024 },
        });
        const dir = path.join(ctx.dataRoot, 'servers', created.id);
        fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'x');
        fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
        const calls: [string, Record<string, unknown>][] = [
          ['servers_list', {}],
          ['server_get', { id: created.id }],
          ['server_settings_get', { id: created.id }],
          ['worlds_list', { id: created.id }],
          ['backups_list', { id: created.id }],
          ['players_list', { id: created.id }],
          ['content_list', { id: created.id }],
          ['metrics_get', { id: created.id, hours: 1 }],
          ['logs_tail', { id: created.id, lines: 10 }],
          ['server_command_history', { id: created.id }],
        ];
        for (const [name, args] of calls) {
          const value = await invoke(name, args);
          const roundTrip = JSON.parse(JSON.stringify(value));
          assert.deepEqual(roundTrip, value, `${name} is not plain JSON`);
        }
      });
    }

    if (!filter || 'errors'.includes(filter)) {
      await run.must('handler errors carry a code for the IPC envelope', async () => {
        for (const [name, args] of [
          ['servers_delete', { id: 'missing' }],
          ['server_settings_get', { id: 'missing' }],
          ['backups_list', { id: 'missing' }],
          ['content_list', { id: 'missing' }],
        ] as [string, Record<string, unknown>][]) {
          await assert.rejects(() => invoke(name, args), (error: unknown) => {
            const code = (error as { code?: string }).code;
            assert.ok(typeof code === 'string' && code.length > 0, `${name} error has no code`);
            return true;
          });
        }
      });
      await run.must('server_install_cancel reports false for an unknown job', async () => {
        assert.equal(await invoke('server_install_cancel', { jobId: 'no-such-job' }), false);
      });
    }
  } finally {
    try { await appRuntime.shutdown(); } catch { /* best effort */ }
  }

  const lines = run.lines();
  if (lines.length === 0) lines.push('FAIL contract/no checks matched the filter');
  return { ok: run.ok, report: lines.join('\n') };
}
