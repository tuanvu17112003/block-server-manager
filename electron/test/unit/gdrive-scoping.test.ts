// Drive backup matching must survive a server being deleted and recreated.
//
// Two reported defects, both from the name-based matching added earlier being applied in only some call sites:
//
//  1. "I recreated the server Test, its backups are listed, but Download says 'that backup is not in this server's Drive
//     folder'." The restore handler listed with an id-only filter while the panel listed with id-OR-name, so the panel
//     showed a file the restore could not then find.
//  2. "Why does every server show 'backups from servers that no longer exist'?" The orphan list was global and ignored
//     the server entirely.
//
// The rule these tests pin: a backup belongs to a server if it matches by id OR by name. It is only an orphan relative to
// a server when it matches neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors the filter in listBackups() (electron/services/gdrive-upload.ts). */
function matchesServer(
  file: { serverId?: string; serverName?: string; name: string },
  options: { serverId?: string; serverName?: string },
): boolean {
  const id = options.serverId ?? '';
  const rawName = options.serverName ?? '';
  if (id === '' && rawName === '') return true;
  if (id !== '' && file.serverId === id) return true;
  const name = rawName.trim().toLowerCase();
  if (name !== '' && file.serverName !== undefined && file.serverName.trim().toLowerCase() === name) return true;
  if (name !== '') {
    const prefix = `${name}__`;
    if (file.name.toLowerCase().startsWith(prefix)) return true;
  }
  return false;
}

/** Mirrors the filter in gdrive_orphaned_backups (electron/ipc.ts). */
function isOrphanFor(
  file: { serverId?: string; serverName?: string; name?: string },
  servers: { id: string; name: string }[],
  requestedName: string,
): boolean {
  const liveIds = new Set(servers.map((s) => s.id));
  const liveNames = new Set(servers.map((s) => s.name.trim().toLowerCase()));
  const ownedByLiveId = file.serverId !== undefined && file.serverId !== '' && liveIds.has(file.serverId);
  if (ownedByLiveId) return false;
  const name = (file.serverName ?? '').trim().toLowerCase();
  if (name !== '' && liveNames.has(name)) {
    const want = requestedName.trim().toLowerCase();
    if (want === '' || want === name) return false;
  }
  if (file.serverId === undefined || file.serverId === '') return true;
  return !liveIds.has(file.serverId);
}

test('restoring into a recreated server finds the backup taken from the old one', () => {
  // The exact reported case: server "Test" deleted, new server "Test" created with a new UUID. The backup still carries
  // the OLD id but the same name, so id-only matching fails and name matching must succeed.
  const file = { serverId: 'old-uuid-0000', serverName: 'Test', name: 'Test__manual-2026-10-30.zip' };
  const recreated = { serverId: 'new-uuid-1111', serverName: 'Test' };
  assert.equal(
    matchesServer(file, recreated),
    true,
    'a backup from the previous server of the same name must be listed for the recreated server',
  );
});

test('id matching still separates two live servers that share a name', () => {
  const file = { serverId: 'server-a', serverName: 'Shared', name: 'Shared__a.zip' };
  assert.equal(matchesServer(file, { serverId: 'server-a', serverName: 'Shared' }), true);
  // Separate check with a name that does not match, proving the id alone was the deciding factor.
  const otherName = { serverId: 'server-a', serverName: 'Different' };
  assert.equal(matchesServer(file, otherName), true, 'the id still matches regardless of the panel name');
});

test('a backup from an unrelated server is NOT listed', () => {
  const file = { serverId: 'other-uuid', serverName: 'OtherWorld', name: 'OtherWorld__x.zip' };
  assert.equal(matchesServer(file, { serverId: 'new-uuid', serverName: 'Test' }), false);
});

test('the orphan list is scoped: a backup belonging to a live server is not an orphan anywhere', () => {
  const servers = [
    { id: 'id-a', name: 'Alpha' },
    { id: 'id-b', name: 'Beta' },
  ];
  const file = { serverId: 'id-a', serverName: 'Alpha', name: 'Alpha__x.zip' };
  assert.equal(isOrphanFor(file, servers, 'Alpha'), false);
  assert.equal(isOrphanFor(file, servers, 'Beta'), false);
});

test('the orphan list is scoped: a name-only match is not an orphan for that server', () => {
  // This is what stops "Test" from showing its own previous backups as unrecoverable.
  const servers = [{ id: 'new-test', name: 'Test' }];
  const file = { serverId: 'old-test', serverName: 'Test', name: 'Test__manual.zip' };
  assert.equal(isOrphanFor(file, servers, 'Test'), false, 'the panel for Test must not call it an orphan');
  // A different server's panel genuinely cannot use it.
  assert.equal(isOrphanFor(file, servers, 'Other'), true);
});

test('a truly orphaned backup is reported for every panel', () => {
  const servers = [{ id: 'id-a', name: 'Alpha' }];
  const file = { serverId: 'gone-uuid', serverName: 'Deleted', name: 'Deleted__x.zip' };
  assert.equal(isOrphanFor(file, servers, 'Alpha'), true);
  assert.equal(isOrphanFor(file, servers, ''), true);
});

test('a backup with no recorded server id is treated as recoverable, never hidden', () => {
  const servers = [{ id: 'id-a', name: 'Alpha' }];
  const file = { name: 'legacy-upload.zip' };
  assert.equal(isOrphanFor(file, servers, 'Alpha'), true, 'cannot be attributed, so it must be offered');
  assert.equal(matchesServer(file, { serverName: '' }), true, 'listing with no scope returns everything');
  assert.equal(matchesServer(file, { serverName: 'Alpha' }), false, 'but it is not claimed by a named server');
});

test('an empty name scope lists everything, which is what the orphan query needs', () => {
  const file = { serverId: 'whatever', serverName: 'Whatever', name: 'x.zip' };
  assert.equal(matchesServer(file, { serverId: '', serverName: '' }), true);
});
