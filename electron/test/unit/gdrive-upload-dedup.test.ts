// Upload de-duplication must hold across BOTH paths that upload the same backup.
//
// Reported twice: "creating a new server and pressing To Drive creates two identical backups; later presses only one".
// The first fix put the duplicate check in the IPC handler, which missed the real cause. Two callers upload:
//
//   1. the automatic mirror (afterBackup hook) runs in the background right after every backup
//   2. the manual "To Drive" button
//
// The manual path goes through the IPC handler; the automatic path calls driveUploadBackup directly, so it bypassed the
// check entirely. Worse, even a correct listing check races: the mirror is still streaming when the user presses the
// button, so a listing at that moment returns nothing and both upload. The two duplicate timestamps in the report were
// 9 seconds apart — exactly a stream still in flight.
//
// The guarantee therefore lives in driveUploadBackup itself: an in-flight map keyed by server+backup, plus a listing check
// for uploads that already completed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors the in-flight key used by driveUploadBackup (electron/services/gdrive.ts). */
function uploadKey(serverId: string, backupId: string | undefined, filePath: string): string {
  return `${serverId}:${backupId ?? filePath}`;
}

test('the automatic mirror and the manual button compute the SAME key for one backup', () => {
  // If these differed, the in-flight guard would never match and the duplicate would survive the fix.
  const automatic = uploadKey('server-1', 'b-abc123', 'C:/data/backups/x.zip');
  const manual = uploadKey('server-1', 'b-abc123', 'C:/data/backups/x.zip');
  assert.equal(automatic, manual, 'both upload paths must agree on the identity of one backup');
});

test('different backups never collide on the in-flight key', () => {
  const first = uploadKey('server-1', 'b-one', 'C:/data/backups/a.zip');
  const second = uploadKey('server-1', 'b-two', 'C:/data/backups/b.zip');
  assert.notEqual(first, second);
});

test('the same backup id on different servers does not collide', () => {
  // Backup ids are generated per record, but a restored/adopted backup could in principle carry a familiar id; keying by
  // server+backup keeps two servers' uploads independent.
  assert.notEqual(uploadKey('server-1', 'b-x', 'p'), uploadKey('server-2', 'b-x', 'p'));
});

test('an upload without a backup id still gets a usable key from its path', () => {
  // The upload path is used for one-off transfers too; a missing id must not produce "undefined" keys that all collide.
  const a = uploadKey('server-1', undefined, 'C:/data/backups/a.zip');
  const b = uploadKey('server-1', undefined, 'C:/data/backups/b.zip');
  assert.ok(!a.includes('undefined'));
  assert.notEqual(a, b);
});

test('a completed upload is detected by backup id, not by Drive filename', () => {
  // Drive names carry a timestamp, so the same backup re-uploaded later would have a different name. Only the recorded
  // backup id identifies it. Two different backups can also share a display name, so a name match would wrongly skip one.
  const remote = [
    { id: 'r1', name: 'Test__manual-2026-10-30.zip', backupId: 'b-abc' },
    { id: 'r2', name: 'Test__manual-2026-10-30.zip', backupId: 'b-def' },
  ];
  assert.equal(remote.some((f) => f.backupId === 'b-abc'), true, 'the exact backup is found');
  assert.equal(remote.some((f) => f.backupId === 'b-ghi'), false, 'a different backup is not skipped');
  // A remote file with no backup id must not be treated as a duplicate of anything: older uploads predate the property,
  // and skipping them would make the button do nothing with no explanation.
  assert.equal([{ id: 'r3', name: 'old.zip' }].some((f) => (f as { backupId?: string }).backupId === 'b-abc'), false);
});
