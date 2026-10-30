// Deleting a server must never leave a record pointing at a folder that could not be removed, or vice versa.
//
// This is a regression test for a reported defect whose symptom was a raw `ENOTEMPTY, Directory not empty` toast when the
// user pressed Delete. The original implementation did this:
//
//   1. store.deleteServer(id)                       <- record gone
//   2. fs.rmSync(servers/<id>, {recursive, force})   <- throws ENOTEMPTY on Windows when a file is held
//
// so the throw surfaced to the user AND left the folder behind with no record: the server disappeared from the list while
// ~100 MB stayed on disk, unreachable. That is the same invisible-orphan state that had to be cleaned up by hand.
//
// The fix removes the folder FIRST and only then the record, so a lock produces an actionable error and changes nothing.
// The removal is async because a blocking wait would freeze the window and would also prevent the process holding the lock
// from finishing its exit — the very thing the retry is waiting for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describeRemovalFailure, removeDirectory } from '../../services/fs-remove';

function makeServerDir(root: string, id: string): string {
  const dir = path.join(root, 'servers', id);
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level');
  fs.writeFileSync(path.join(dir, 'mods', 'a.jar'), 'jar');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25565\n');
  return dir;
}

test('removeDirectory removes a normal tree and reports success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'del-'));
  const dir = makeServerDir(root, 'aaaaaaaa-0000-0000-0000-000000000001');
  try {
    const result = await removeDirectory(dir);
    assert.equal(result.removed, true);
    assert.equal(result.leftover, 0);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an already-missing directory counts as removed, not as an error', async () => {
  // Delete must be idempotent: pressing it twice must not produce a scary failure.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'del-'));
  try {
    const result = await removeDirectory(path.join(root, 'servers', 'does-not-exist'));
    assert.equal(result.removed, true);
    assert.equal(result.leftover, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a directory held as a live process cwd is reported as NOT removed, with a usable message', async () => {
  // The actual Windows failure mode: any process with the directory as its cwd locks it.
  if (process.platform !== 'win32') return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'del-locked-'));
  const dir = makeServerDir(root, 'bbbbbbbb-0000-0000-0000-000000000002');
  const child = spawn('cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    const result = await removeDirectory(dir, { attempts: 2, baseDelayMs: 50 });
    assert.equal(result.removed, false, 'a locked directory must not be reported as removed');
    assert.equal(fs.existsSync(dir), true, 'the folder is still there');

    const message = describeRemovalFailure(dir);
    assert.match(message, /Could not remove the server folder/);
    assert.match(message, /kept in the list/, 'the message must say the server was kept, not deleted');
    assert.match(message, /Delete again/, 'the message must tell the user what to do');
    assert.ok(!/ENOTEMPTY|EPERM|errno/i.test(message), `the message must not leak a raw OS code: ${message}`);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('retries recover when the lock clears during the attempts', async () => {
  // Realistic case: a JVM is mid-shutdown and releases the folder shortly after Delete is pressed. The async retry loop
  // must capitalise on that. This test also fails if the wait is a blocking one, because the timer that releases the lock
  // could not run while the event loop is parked — which is precisely the bug the async version avoids.
  //
  // The lock is released with `taskkill /T` because killing only the direct child leaves its children holding the cwd.
  // That is not a test detail: it is the same trap that made the install publish fail, and the reason killProcessTree
  // exists in installer/core.ts.
  if (process.platform !== 'win32') return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'del-release-'));
  const dir = makeServerDir(root, 'cccccccc-0000-0000-0000-000000000003');
  const child = spawn('cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 500));

  setTimeout(() => {
    if (child.pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  }, 250);
  try {
    const result = await removeDirectory(dir, { attempts: 10, baseDelayMs: 150 });
    assert.equal(result.removed, true, 'the directory must be removed once the lock clears');
    assert.equal(fs.existsSync(dir), false);
  } finally {
    if (child.pid !== undefined) {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('the async wait does not block the event loop', async () => {
  // Pin the property that matters: a timer must fire while removal is still retrying.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'del-loop-'));
  const dir = makeServerDir(root, 'eeeeeeee-0000-0000-0000-000000000004');
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true })
    : null;
  await new Promise((resolve) => setTimeout(resolve, 400));

  let timerFiredWhileRemoving = false;
  let settled = false;
  const removal = removeDirectory(dir, { attempts: 3, baseDelayMs: 300 })
    .catch(() => undefined)
    .finally(() => { settled = true; });

  await new Promise<void>((resolve) => {
    setTimeout(() => { timerFiredWhileRemoving = !settled; resolve(); }, 150);
  });
  await removal;
  try {
    assert.equal(timerFiredWhileRemoving, true, 'a timer must fire while removal retries, or the UI would freeze');
  } finally {
    if (child?.pid !== undefined) {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('nested content is removed completely, not just the top level', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'del-nested-'));
  const dir = makeServerDir(root, 'dddddddd-0000-0000-0000-000000000005');
  fs.mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'deep.jar'), 'x');
  try {
    const result = await removeDirectory(dir);
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(path.join(dir, 'a')), false, 'nested trees go too');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
