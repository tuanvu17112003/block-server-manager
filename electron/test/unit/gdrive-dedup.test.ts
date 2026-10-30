// Drive orphan scoping and upload de-duplication.
//
// Two reported defects:
//
//  1. "Backups from servers that no longer exist (1)" still appeared, and Download on it failed. The list was scoped by the
//     requesting panel's name only, so a panel for "VanillaGGDTest" still listed a backup belonging to "Test" — a
//     different name. Download then failed because the restore path legitimately refuses files outside the current
//     server's scope.
//
//  2. "Creating a new server and pressing To Drive creates two identical backups; later presses create only one." Every
//     new backup is mirrored automatically, so the manual press was a second upload of the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface DriveFileLike { id: string; name: string; serverId?: string; serverName?: string; backupId?: string }
interface ServerLike { id: string; name: string }

/** Mirrors the filter in gdrive_orphaned_backups (electron/ipc.ts). */
function unclaimableByAnyServer(file: DriveFileLike, servers: ServerLike[]): boolean {
  const liveIds = new Set(servers.map((s) => s.id));
  const liveNames = new Set(servers.map((s) => s.name.trim().toLowerCase()));
  if (file.serverId !== undefined && file.serverId !== '' && liveIds.has(file.serverId)) return false;
  const name = (file.serverName ?? '').trim().toLowerCase();
  if (name !== '' && liveNames.has(name)) return false;
  for (const liveName of liveNames) {
    if (file.name.toLowerCase().startsWith(`${liveName}__`)) return false;
  }
  return true;
}

/** Mirrors the duplicate check in gdrive_upload_backup (electron/ipc.ts). */
function alreadyUploaded(file: DriveFileLike, backupId: string): boolean {
  return file.backupId === backupId;
}

test('a backup belonging to another live server is NOT listed as unclaimed', () => {
  // This is the reported case: panel for VanillaGGDTest, file from Test. Test is a live server, so the file is reachable
  // from Test's panel and must not be advertised as unclaimed here.
  const servers: ServerLike[] = [
    { id: 'ggd-id', name: 'VanillaGGDTest' },
    { id: 'test-id', name: 'Test' },
  ];
  const file: DriveFileLike = { id: 'f1', name: 'Test__manual-2026-10-30.zip', serverId: 'old-test-id', serverName: 'Test' };
  assert.equal(unclaimableByAnyServer(file, servers), false, 'a live server claims it by name');
});

test('a backup whose server is truly gone IS listed', () => {
  const servers: ServerLike[] = [{ id: 'ggd-id', name: 'VanillaGGDTest' }];
  const file: DriveFileLike = { id: 'f2', name: 'Ghost__manual.zip', serverId: 'gone-id', serverName: 'Ghost' };
  assert.equal(unclaimableByAnyServer(file, servers), true);
});

test('a recreated server claims its predecessor\'s backups by name', () => {
  // Delete "Test", create "Test" again: new id, same name. The old backups must be claimed, not offered as orphans.
  const servers: ServerLike[] = [{ id: 'new-test', name: 'Test' }];
  const file: DriveFileLike = { id: 'f3', name: 'Test__manual.zip', serverId: 'old-test', serverName: 'Test' };
  assert.equal(unclaimableByAnyServer(file, servers), false);
});

test('a file with no recorded server is unclaimed, but claimable by filename prefix', () => {
  const servers: ServerLike[] = [{ id: 'a', name: 'Alpha' }];
  // No properties at all: cannot be attributed, so it is offered.
  assert.equal(unclaimableByAnyServer({ id: 'f4', name: 'mystery.zip' }, servers), true);
  // No properties, but the filename carries the server name — claimable.
  assert.equal(unclaimableByAnyServer({ id: 'f5', name: 'Alpha__manual.zip' }, servers), false);
});

test('exact id match wins over an unrelated filename', () => {
  const servers: ServerLike[] = [{ id: 'a', name: 'Alpha' }];
  const file: DriveFileLike = { id: 'f6', name: 'weird-name.zip', serverId: 'a' };
  assert.equal(unclaimableByAnyServer(file, servers), false);
});

test('an already-uploaded backup is not uploaded a second time', () => {
  // The duplicate bug: afterBackup mirrors the new backup, then To Drive uploaded it again because nothing checked.
  const remote: DriveFileLike[] = [{ id: 'r1', name: 'Test__manual-2026-10-30.zip', serverId: 's1', serverName: 'Test', backupId: 'b-abc' }];
  assert.equal(remote.some((f) => alreadyUploaded(f, 'b-abc')), true, 'the same backup id must be detected');
  assert.equal(remote.some((f) => alreadyUploaded(f, 'b-different')), false, 'a different backup still uploads');
});

test('de-duplication is by backup id, not by name', () => {
  // Two backups can share a display name (the same manual backup taken twice); matching by name would skip a real upload.
  const remote: DriveFileLike[] = [{ id: 'r2', name: 'manual-2026-10-30.zip', backupId: 'b-one' }];
  assert.equal(remote.some((f) => alreadyUploaded(f, 'b-one')), true);
  assert.equal(remote.some((f) => alreadyUploaded(f, 'b-two')), false, 'same name, different id must upload');
});

test('an upload with no recorded id on the remote side is not treated as a duplicate', () => {
  // Older uploads may predate the property. Skipping those would make the button do nothing with no explanation.
  const remote: DriveFileLike[] = [{ id: 'r3', name: 'old.zip' }];
  assert.equal(remote.some((f) => alreadyUploaded(f, 'b-new')), false);
});
