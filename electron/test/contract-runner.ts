// Contract tests — every renderer-invoked command must exist and keep its payload/return/error
// contract. Runs inside Electron via --contracttest on a throwaway data root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { IpcContext } from '../ipc';
import { handlersMap, registerRuntimeHandlers } from '../ipc';
import { buildRuntime } from '../services/runtime';
import { COMMAND_NAMES, MINIMAL_VALID_ARGS, validateCommandArgs } from '../services/validate-ipc';
import { TestRun } from './harness';

/** Commands invoked by src/tauri.ts (renderer). A missing handler here breaks a UI path. */
export const RENDERER_COMMANDS = [
  'backup_create',
  'backup_delete',
  'backup_export',
  'backup_restore',
  'backup_schedule_get',
  'backup_schedule_set',
  'backups_list',
  'content_install',
  'content_install_cancel',
  'content_list',
  'content_remove',
  'content_search',
  'content_toggle',
  'content_versions',
  'curseforge_cancel_download',
  'curseforge_inspect_project',
  'curseforge_inspect_zip',
  'curseforge_key_clear',
  'curseforge_key_set',
  'curseforge_key_status',
  'curseforge_list_zips',
  'curseforge_open_browser',
  'curseforge_open_external_browser',
  'curseforge_pick_zip',
  'curseforge_project_versions',
  'curseforge_search_modpacks',
  'diagnostics_bundle',
  'diagnostics_recent',
  'gdrive_adopt_backup',
  'gdrive_connect',
  'gdrive_delete_backup',
  'gdrive_disconnect',
  'gdrive_list_backups',
  'gdrive_orphaned_backups',
  'gdrive_restore_backup',
  'gdrive_status',
  'gdrive_upload_backup',
  'java_detect',
  'java_ensure',
  'java_validate',
  'loaders_resolve',
  'logs_tail',
  'metrics_get',
  'modpack_pipeline_cancel',
  'modpack_pipeline_discard_preview',
  'modpack_pipeline_install',
  'modpack_pipeline_pick_local_mrpack',
  'modpack_pipeline_preview',
  'modpack_pipeline_release_local_mrpack',
  'modrinth_project_versions',
  'modrinth_search_modpacks',
  'ping',
  'player_action',
  'players_add_offline',
  'players_list',
  'port_check',
  'server_command_history',
  'server_get',
  'server_install',
  'server_install_cancel',
  'server_kill',
  'server_open_folder',
  'server_restart',
  'server_send_command',
  'server_settings_get',
  'server_settings_update',
  'server_start',
  'server_stop',
  'servers_create',
  'servers_delete',
  'servers_list',
  'servers_set_java_path',
  'storage_get',
  'storage_open_folder',
  'storage_pick_folder',
  'storage_set',
  'system_disk',
  'update_check',
  'update_download',
  'update_install',
  'update_state',
  'versions_paper',
  'versions_vanilla',
  'world_activate',
  'world_create',
  'world_delete',
  'world_duplicate',
  'world_export',
  'world_import',
  'worlds_list',
] as const;

export interface SuiteResult {
  ok: boolean;
  report: string;
}

/**
 * Canonical command list from `shared/contracts.ts` (WP-7.1). The Electron project cannot import
 * that file yet because it lives outside `electron/tsconfig.json`'s rootDir (Lead build-wiring
 * follow-up), so the COMMANDS tuple is parsed with the TypeScript compiler API — the gate then
 * proves the shared list, the Electron runtime list, the handler map and the renderer list agree.
 */
function readSharedCommands(): string[] {
  const file = path.join(__dirname, '..', '..', 'shared', 'contracts.ts');
  const source = fs.readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'COMMANDS') continue;
        let initializer: ts.Expression | undefined = declaration.initializer;
        // `[...] as const` parses as an AsExpression (also unwrap satisfies/parentheses).
        while (initializer
          && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) {
          initializer = initializer.expression;
        }
        if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
          throw new Error('shared/contracts.ts: COMMANDS must be an array literal');
        }
        for (const element of initializer.elements) {
          if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) names.push(element.text);
          else throw new Error('shared/contracts.ts: COMMANDS entries must be string literals');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (names.length === 0) throw new Error('shared/contracts.ts: COMMANDS tuple not found');
  return names;
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
        const shared = readSharedCommands();
        const missing = RENDERER_COMMANDS.filter((name) => typeof merged[name] !== 'function');
        assert.deepEqual(missing, []);
        assert.equal(RENDERER_COMMANDS.length, 90);
        assert.equal(RENDERER_COMMANDS.length, shared.length);
      });
      await run.must('unknown command is not registered', async () => {
        assert.equal(merged['definitely_not_a_command'], undefined);
      });
      await run.must('shared/contracts.ts COMMANDS equals the renderer command list (WP-7.1)', async () => {
        const shared = readSharedCommands();
        assert.equal(shared.length, 90);
        assert.equal(new Set(shared).size, shared.length, 'COMMANDS must not repeat a name');
        assert.deepEqual([...shared].sort(), [...RENDERER_COMMANDS].sort());
      });
      await run.must('Electron runtime command list equals shared COMMANDS (WP-7.1)', async () => {
        assert.deepEqual([...COMMAND_NAMES].sort(), [...readSharedCommands()].sort());
      });
      await run.must('every shared command has a registered handler', async () => {
        const missing = readSharedCommands().filter((name) => typeof merged[name] !== 'function');
        assert.deepEqual(missing, []);
      });
      await run.must('every shared command accepts its minimal valid args object (WP-7.1)', async () => {
        const shared = readSharedCommands();
        const unsupported = shared.filter((name) => !(name in MINIMAL_VALID_ARGS));
        assert.deepEqual(unsupported, [], 'add MINIMAL_VALID_ARGS for new commands');
        const failures: string[] = [];
        for (const name of shared) {
          const args = MINIMAL_VALID_ARGS[name as keyof typeof MINIMAL_VALID_ARGS];
          try {
            validateCommandArgs(name, args);
          } catch (error) {
            failures.push(`${name}: ${(error as Error).message}`);
          }
        }
        assert.deepEqual(failures, []);
      });
      await run.must('IPC validator rejects unknown commands with not-found (WP-7.1)', async () => {
        assert.throws(
          () => validateCommandArgs('definitely_not_a_command', {}),
          (error: unknown) => (error as { code?: string }).code === 'not-found',
        );
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
