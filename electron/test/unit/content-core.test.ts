// Pure content-planning helper tests (Phase 5 WP-5.1: M-01/M-07/F-13).
// node:test only — no Electron, no filesystem, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptsProjectType,
  contentFileName,
  dependencySkipReason,
  isClientOnlyProject,
  loaderMatches,
  mergeContentMeta,
  planContentUpdate,
  presentProjectIds,
  primaryJarFile,
  pruneContentMeta,
  requiredDependencies,
  selectCompatibleVersion,
  stripDisabledSuffix,
  type ContentFileRef,
} from '../../services/content-core';

const file = (fileName: string, enabled: boolean, projectId: string | null = null): ContentFileRef => ({ fileName, enabled, projectId });

test('planContentUpdate: fresh install has nothing to replace', () => {
  const plan = planContentUpdate({ files: [], projectId: 'projA', targetFileName: 'projA-2.0.jar' });
  assert.equal(plan.targetFileName, 'projA-2.0.jar');
  assert.equal(plan.overwrite, null);
  assert.deepEqual(plan.stale, []);
  assert.equal(plan.conflict, null);
  assert.deepEqual(plan.warnings, []);
});

test('planContentUpdate: update with a new file name replaces old active + disabled copies after publish', () => {
  const plan = planContentUpdate({
    files: [
      file('projA-1.0.jar', true, 'projA'),
      file('projA-1.0.jar', false, 'projA'),
      file('other.jar', true, 'projB'),
    ],
    projectId: 'projA',
    targetFileName: 'projA-2.0.jar',
  });
  assert.equal(plan.overwrite, null);
  assert.equal(plan.conflict, null);
  assert.deepEqual(plan.stale.map((entry) => entry.fileName).sort(), ['projA-1.0.jar', 'projA-1.0.jar']);
  assert.ok(plan.warnings.some((warning) => warning.includes('Replacing 2 previous file(s)')));
  // Other projects are never part of the plan.
  assert.ok(!plan.stale.some((entry) => entry.projectId === 'projB'));
});

test('planContentUpdate: same-name update is an atomic overwrite (no stale duplicate)', () => {
  const plan = planContentUpdate({
    files: [file('projA.jar', true, 'projA')],
    projectId: 'projA',
    targetFileName: 'projA.jar',
  });
  assert.equal(plan.overwrite?.fileName, 'projA.jar');
  assert.deepEqual(plan.stale, []);
  assert.equal(plan.conflict, null);
});

test('planContentUpdate: same-name disabled copy is stale, not an overwrite', () => {
  const plan = planContentUpdate({
    files: [file('projA.jar', false, 'projA')],
    projectId: 'projA',
    targetFileName: 'projA.jar',
  });
  assert.equal(plan.overwrite, null);
  assert.deepEqual(plan.stale.map((entry) => entry.fileName), ['projA.jar']);
});

test('planContentUpdate: legacy *.jar.disabled copies of the target name are superseded', () => {
  const plan = planContentUpdate({
    files: [file('projA.jar.disabled', false, null)],
    projectId: 'projA',
    targetFileName: 'projA.jar',
  });
  assert.equal(plan.conflict, null);
  assert.deepEqual(plan.stale.map((entry) => entry.fileName), ['projA.jar.disabled']);
});

test('planContentUpdate: another project (or unmanaged jar) owning the target name is a conflict', () => {
  const other = planContentUpdate({
    files: [file('shared.jar', true, 'projB')],
    projectId: 'projA',
    targetFileName: 'shared.jar',
  });
  assert.equal(other.conflict?.fileName, 'shared.jar');
  assert.ok(other.warnings.some((warning) => warning.includes('different project')));

  const unmanaged = planContentUpdate({
    files: [file('shared.jar', true, null)],
    projectId: 'projA',
    targetFileName: 'shared.jar',
  });
  assert.equal(unmanaged.conflict?.fileName, 'shared.jar');
});

test('planContentUpdate: file name is reduced to a safe basename and must be a jar', () => {
  assert.equal(contentFileName('mods/projA.jar'), 'projA.jar');
  assert.equal(contentFileName('C:\\tmp\\nested\\projA.jar'), 'projA.jar');
  assert.throws(() => contentFileName('projA.zip'), /not a \.jar/);
  assert.throws(() => contentFileName('   '), /empty/);
  assert.equal(stripDisabledSuffix('projA.jar.disabled'), 'projA.jar');
});

test('mergeContentMeta: replaces legacy disabled keys and only records published files', () => {
  const merged = mergeContentMeta(
    { 'new.jar.disabled': { projectId: 'old' }, 'keep.jar': { projectId: 'keep' } },
    [{ fileName: 'new.jar', entry: { projectId: 'projA', versionId: 'v2', title: 'A' } }],
  );
  assert.deepEqual(merged['new.jar'], { projectId: 'projA', versionId: 'v2', title: 'A' });
  assert.equal(merged['new.jar.disabled'], undefined);
  assert.equal(merged['keep.jar'].projectId, 'keep');
});

test('pruneContentMeta: drops exact, stripped and .disabled variants of removed files', () => {
  const pruned = pruneContentMeta(
    {
      'a.jar': { projectId: 'a' },
      'a.jar.disabled': { projectId: 'a' },
      'b.jar': { projectId: 'b' },
    },
    ['a.jar'],
  );
  assert.deepEqual(Object.keys(pruned), ['b.jar']);
});

test('requiredDependencies: required only, deduped, excludes present/self, keeps pins', () => {
  const deps = requiredDependencies(
    [
      { projectId: 'dep1', versionId: 'v1', type: 'required' },
      { projectId: 'dep2', versionId: null, type: 'required' },
      { projectId: 'dep1', versionId: 'v9', type: 'required' }, // duplicate project
      { projectId: 'dep3', versionId: null, type: 'optional' },
      { projectId: 'projA', versionId: null, type: 'required' }, // self
      { versionId: 'no-project', type: 'required' },
    ],
    { excludeProjectIds: ['dep2'], selfProjectId: 'projA' },
  );
  assert.deepEqual(deps, [{ projectId: 'dep1', versionId: 'v1' }]);
});

test('presentProjectIds sees active and disabled copies (de-dupe source)', () => {
  const ids = presentProjectIds([
    file('x.jar', true, 'dep1'),
    file('y.jar', false, 'dep2'),
    file('manual.jar', true, null),
  ]);
  assert.deepEqual([...ids].sort(), ['dep1', 'dep2']);
});

test('loaderMatches: exact loader for mods, Paper plugin union for plugins', () => {
  assert.equal(loaderMatches(['fabric'], 'mod', 'fabric'), true);
  assert.equal(loaderMatches(['forge'], 'mod', 'fabric'), false);
  assert.equal(loaderMatches(undefined, 'mod', 'fabric'), false);
  assert.equal(loaderMatches(['paper'], 'plugin', 'paper'), true);
  assert.equal(loaderMatches(['spigot'], 'plugin', 'paper'), true);
  assert.equal(loaderMatches(['bukkit', 'purpur'], 'plugin', 'paper'), true);
  assert.equal(loaderMatches(['folia'], 'plugin', 'paper'), true);
  assert.equal(loaderMatches(['fabric'], 'plugin', 'paper'), false);
  assert.equal(loaderMatches(['SPIGOT'], 'plugin', 'paper'), true);
});

test('project guards: client-only and project-type mismatch are detected', () => {
  assert.equal(isClientOnlyProject({ server_side: 'unsupported' }), true);
  assert.equal(isClientOnlyProject({ server_side: 'optional' }), false);
  assert.equal(isClientOnlyProject({ server_side: 'required' }), false);
  assert.equal(isClientOnlyProject(null), false);

  assert.equal(acceptsProjectType('mod', 'mod'), true);
  assert.equal(acceptsProjectType('plugin', 'plugin'), true);
  assert.equal(acceptsProjectType('plugin', 'mod'), false);
  assert.equal(acceptsProjectType(undefined, 'plugin'), true); // partial payload: do not reject blindly
});

test('selectCompatibleVersion: newest matching mc+loader with a downloadable jar, plugin union', () => {
  const versions = [
    { id: 'v3', game_versions: ['1.21.1'], loaders: ['paper'], files: [{ filename: 'x.jar', url: 'https://cdn.modrinth.com/x.jar', primary: true }] },
    { id: 'v2', game_versions: ['1.21.1'], loaders: ['fabric'], files: [{ filename: 'y.jar', url: 'https://cdn.modrinth.com/y.jar' }] },
    { id: 'v1', game_versions: ['1.20.1'], loaders: ['paper'], files: [{ filename: 'z.jar', url: 'https://cdn.modrinth.com/z.jar' }] },
    { id: 'v0', game_versions: ['1.21.1'], loaders: ['spigot'], files: [{ filename: 'w.jar', url: 'https://cdn.modrinth.com/w.jar' }] },
  ];
  assert.equal(selectCompatibleVersion(versions, { mcVersion: '1.21.1', kind: 'plugin', loader: 'paper' })?.id, 'v3');
  assert.equal(selectCompatibleVersion(versions, { mcVersion: '1.21.1', kind: 'mod', loader: 'fabric' })?.id, 'v2');
  assert.equal(selectCompatibleVersion(versions, { mcVersion: '1.21.1', kind: 'mod', loader: 'forge' }), null);
  assert.equal(selectCompatibleVersion(versions, { mcVersion: '1.19.2', kind: 'plugin', loader: 'paper' }), null);

  const noJar = selectCompatibleVersion(
    [{ id: 'vx', game_versions: ['1.21.1'], loaders: ['paper'], files: [{ filename: 'notes.txt', url: 'https://cdn.modrinth.com/notes.txt' }] }],
    { mcVersion: '1.21.1', kind: 'plugin', loader: 'paper' },
  );
  assert.equal(noJar, null);
});

test('primaryJarFile: primary file wins, falls back to the first jar', () => {
  const primary = primaryJarFile([
    { filename: 'first.jar', url: 'https://cdn.modrinth.com/first.jar' },
    { filename: 'main.jar', url: 'https://cdn.modrinth.com/main.jar', primary: true },
  ]);
  assert.equal(primary?.filename, 'main.jar');
  assert.equal(primaryJarFile([{ filename: 'readme.txt', url: 'https://cdn.modrinth.com/readme.txt' }]), null);
  assert.equal(primaryJarFile([{ filename: 'no-url.jar' }]), null);
});

test('dependencySkipReason conveys loader compatibility for warnings', () => {
  assert.match(dependencySkipReason('plugin', 'paper'), /Paper plugin/);
  assert.match(dependencySkipReason('mod', 'fabric'), /fabric/);
});
