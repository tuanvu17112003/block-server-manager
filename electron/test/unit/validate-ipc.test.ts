// Unit tests for WP-7.1 runtime IPC argument validation (electron/services/validate-ipc.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_NAMES,
  MINIMAL_VALID_ARGS,
  isKnownCommand,
  validateCommandArgs,
  type KnownCommand,
} from '../../services/validate-ipc';

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? '';
}

function assertValidation(command: string, args: unknown): void {
  assert.throws(
    () => validateCommandArgs(command, args),
    (error: unknown) => codeOf(error) === 'validation' && (error as Error).message.startsWith(`${command}:`),
    `expected validation for ${command} with ${JSON.stringify(args)}`,
  );
}

test('command list: 76 unique names and a minimal valid payload for every command', () => {
  assert.equal(COMMAND_NAMES.length, 76);
  assert.equal(new Set(COMMAND_NAMES).size, COMMAND_NAMES.length);
  assert.equal(Object.keys(MINIMAL_VALID_ARGS).length, COMMAND_NAMES.length);

  const missing = COMMAND_NAMES.filter((name) => !(name in MINIMAL_VALID_ARGS));
  assert.deepEqual(missing, [], 'every command needs MINIMAL_VALID_ARGS');

  const failures: string[] = [];
  for (const command of COMMAND_NAMES) {
    try {
      validateCommandArgs(command, MINIMAL_VALID_ARGS[command]);
    } catch (error) {
      failures.push(`${command}: ${(error as Error).message}`);
    }
  }
  assert.deepEqual(failures, [], 'every command must accept its minimal valid args');
});

test('unknown command -> not-found; non-object args -> validation', () => {
  assert.equal(isKnownCommand('ping'), true);
  assert.equal(isKnownCommand('definitely_not_a_command'), false);
  assert.throws(
    () => validateCommandArgs('definitely_not_a_command', {}),
    (error: unknown) => codeOf(error) === 'not-found',
  );
  assert.throws(
    () => validateCommandArgs('server_get', 'not-an-object'),
    (error: unknown) => codeOf(error) === 'validation' && /arguments must be an object/.test((error as Error).message),
  );
  assert.throws(
    () => validateCommandArgs('server_get', [1, 2, 3]),
    (error: unknown) => codeOf(error) === 'validation',
  );
});

test('no-arg commands accept {} (and a missing args object)', () => {
  for (const command of ['ping', 'servers_list', 'versions_vanilla', 'versions_paper', 'system_disk',
    'curseforge_list_zips', 'curseforge_pick_zip', 'curseforge_open_browser',
    'modpack_pipeline_pick_local_mrpack'] as KnownCommand[]) {
    assert.doesNotThrow(() => validateCommandArgs(command));
    assert.doesNotThrow(() => validateCommandArgs(command, {}));
  }
});

test('ids are required path-safe strings (traversal/separator/type rejected)', () => {
  assert.doesNotThrow(() => validateCommandArgs('server_get', { id: '5d1f9a3e-2b4c-4d5e-8f90-123456789abc' }));
  assert.doesNotThrow(() => validateCommandArgs('server_get', { id: 'server_1.beta-2' }));
  assertValidation('server_get', {});
  assertValidation('server_get', { id: 42 });
  assertValidation('server_get', { id: '' });
  assertValidation('server_get', { id: '../escape' });
  assertValidation('server_get', { id: 'a/b' });
  assertValidation('server_get', { id: 'a\\b' });
  assertValidation('logs_tail', { id: '..' });
});

test('numbers: NaN/Infinity/fractional/out-of-range rejected', () => {
  assert.doesNotThrow(() => validateCommandArgs('port_check', { port: 25565 }));
  assertValidation('port_check', { port: Number.NaN });
  assertValidation('port_check', { port: Number.POSITIVE_INFINITY });
  assertValidation('port_check', { port: 25565.5 });
  assertValidation('port_check', { port: 80 });
  assertValidation('port_check', { port: 70_000 });
  assertValidation('port_check', { port: '25565' });
  assertValidation('logs_tail', { id: 'server-1', lines: 0 });
  assertValidation('logs_tail', { id: 'server-1', lines: 10_001 });
  assertValidation('logs_tail', { id: 'server-1', lines: Number.NaN });
  assertValidation('java_ensure', { major: Number.NaN });
  assertValidation('metrics_get', { id: 'server-1', hours: 0 });
});

test('missing/wrong objects rejected for create/install/settings/pipeline', () => {
  assertValidation('servers_create', {});
  assertValidation('servers_create', { input: null });
  assertValidation('servers_create', { input: 'server' });
  assertValidation('server_install', { jobId: 'job-1' });
  assertValidation('servers_create', {
    input: { name: 'Bad', loader: 'Quilt', mcVersion: '1.21.1', ramMb: 1024 },
  });
  assertValidation('servers_create', {
    input: { name: 'Bad', loader: 'Vanilla', mcVersion: '1.21.1', ramMb: Number.NaN },
  });
  assertValidation('server_settings_update', { id: 'server-1' }); // values required
  assertValidation('server_settings_update', { id: 'server-1', values: 'motd=x' });
  assertValidation('server_settings_update', { id: 'server-1', values: { motd: 5 } });
  assert.doesNotThrow(() => validateCommandArgs('server_settings_update', { id: 'server-1', values: {} }));
  assertValidation('modpack_pipeline_install', { previewId: 'preview-1', input: { name: 'P', ramMb: 2048 } });
  assertValidation('modpack_pipeline_preview', {});
  assertValidation('modpack_pipeline_preview', { source: { kind: 'nope' } });
  assertValidation('modpack_pipeline_preview', { source: { kind: 'localMrpack' } });
  assertValidation('modpack_pipeline_preview', { source: { kind: 'curseforgeProject', projectId: 0 } });
  assert.doesNotThrow(() => validateCommandArgs('modpack_pipeline_preview', {
    source: { kind: 'modrinthRemote', projectId: 'p', versionId: 'v', loader: { kind: 'fabric', minecraftVersion: '1.21.1', loaderVersion: null } },
    jobId: 'job-1',
  }));
  assertValidation('modpack_pipeline_install', {
    previewId: 'preview-1',
    input: { name: 'P', ramMb: 2048 },
    choices: { files: { 'mods/a.jar': 'maybe' }, approvedReplacements: [], autoDeleteCurseForgeZip: false },
  });
});

test('enums and booleans use exact allowed values', () => {
  assertValidation('player_action', { id: 'server-1', action: 'explode', name: 'Steve' });
  assertValidation('player_action', { id: 'server-1', action: 'op', name: 'bad name' });
  assertValidation('player_action', { id: 'server-1', action: 'op' });
  assert.doesNotThrow(() => validateCommandArgs('player_action', { id: 'server-1', action: 'op', name: 'Steve_1' }));
  assertValidation('backup_restore', { id: 'server-1', backupId: 'b1', mode: 'overwrite' });
  assertValidation('backup_schedule_set', { id: 'server-1', interval: 'Minutely' });
  assertValidation('content_toggle', { id: 'server-1', fileName: 'a.jar', enabled: 'yes' });
  assertValidation('content_toggle', { id: 'server-1', fileName: 'a.jar', enabled: 1 });
  assertValidation('modrinth_search_modpacks', { index: 'popular' });
});

test('world/content file names are plain path segments (no traversal)', () => {
  assert.doesNotThrow(() => validateCommandArgs('world_activate', { id: 'server-1', name: 'world_nether' }));
  assertValidation('world_activate', { id: 'server-1', name: '../world' });
  assertValidation('world_activate', { id: 'server-1', name: 'a/b' });
  assertValidation('world_activate', { id: 'server-1', name: '..' });
  assertValidation('world_delete', { id: 'server-1', name: '' });
  assertValidation('content_remove', { id: 'server-1', fileName: '..\\evil.jar' });
  assertValidation('curseforge_inspect_zip', { name: 'nested/pack.zip' });
  assert.doesNotThrow(() => validateCommandArgs('content_remove', { id: 'server-1', fileName: 'sodium-0.5.jar' }));
});

test('curseforge project accepts a positive number or a slug/url string', () => {
  assert.doesNotThrow(() => validateCommandArgs('curseforge_inspect_project', { project: 392141 }));
  assert.doesNotThrow(() => validateCommandArgs('curseforge_inspect_project', { project: 'skyfactory-5' }));
  assertValidation('curseforge_inspect_project', {});
  assertValidation('curseforge_inspect_project', { project: 0 });
  assertValidation('curseforge_inspect_project', { project: -3 });
  assertValidation('curseforge_inspect_project', { project: '' });
  assertValidation('curseforge_inspect_project', { project: {} });
});

test('validation errors are command-prefixed and keep the {code,message} shape', () => {
  try {
    validateCommandArgs('content_toggle', { id: 'server-1', fileName: 'a.jar', enabled: 'nope' });
    assert.fail('expected validation error');
  } catch (error) {
    assert.equal(codeOf(error), 'validation');
    assert.match((error as Error).message, /^content_toggle: /);
  }
  try {
    validateCommandArgs('unknown_command_xyz', {});
    assert.fail('expected not-found error');
  } catch (error) {
    assert.equal(codeOf(error), 'not-found');
    assert.match((error as Error).message, /Unknown IPC command/);
  }
});

test('optional args tolerate explicit undefined (renderer object spreads)', () => {
  assert.doesNotThrow(() => validateCommandArgs('backup_create', {
    id: 'server-1', name: 'backup-1', jobId: undefined, shutdownDuring: undefined,
  }));
  assert.doesNotThrow(() => validateCommandArgs('modpack_pipeline_preview', {
    source: { kind: 'localMrpack', sourceId: 'C:\\packs\\pack.mrpack' },
    jobId: undefined,
  }));
  assert.doesNotThrow(() => validateCommandArgs('servers_set_java_path', { id: 'server-1', path: undefined }));
  assert.doesNotThrow(() => validateCommandArgs('modrinth_search_modpacks', {
    query: 'x', gameVersion: null, loader: null, index: 'downloads', offset: 0, limit: 20,
  }));
});
