// Publish cleanup must retry, so a locked tree does not survive a successful install.
//
// Reported symptom: after an install where the publish fell back to the copy path, `<id>.publishing-*` folders stayed in
// servers/ and accumulated across servers. The cause was that the ladder retried the publish but then cleaned up with a
// single `fs.rmSync(..., {force:true})`, which gives up on the first refusal — and the ladder had just proven the tree was
// locked, so the first refusal was guaranteed. Verified directly: force only covers ENOENT, and maxRetries does not help
// against a live process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { publishStagedDirectoryAsync } from '../../services/install-transaction';
import { removeDirectory } from '../../services/fs-remove';

function makeStaging(root: string): string {
  const from = path.join(root, 'installer-staging', 'abc-123');
  fs.mkdirSync(path.join(from, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(from, 'server.jar'), 'jar');
  fs.writeFileSync(path.join(from, 'mods', 'm.jar'), 'mod');
  return from;
}

test('a successful publish leaves no staging and no .publishing- folder behind', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-clean-'));
  const from = makeStaging(root);
  const to = path.join(root, 'servers', 'id-1');
  try {
    await publishStagedDirectoryAsync(from, to);
    assert.equal(fs.existsSync(path.join(to, 'server.jar')), true, 'the server is published');
    assert.equal(fs.existsSync(from), false, 'staging is consumed');
    const siblings = fs.readdirSync(path.join(root, 'servers')).filter((n) => n.includes('.publishing-'));
    assert.deepEqual(siblings, [], 'no temp sibling survives');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup retries while a lock clears, instead of abandoning the folder', async () => {
  // The realistic shape: the tree is locked when cleanup starts (that is why the copy fallback ran), and the lock clears a
  // moment later. A single rmSync attempt loses that race; a retrying removal wins it.
  if (process.platform !== 'win32') return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-lock-'));
  const dir = path.join(root, 'leftover');
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.jar'), 'jar');

  const child = spawn('cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Release the lock shortly after the removal starts retrying.
  setTimeout(() => {
    if (child.pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  }, 250);

  try {
    const result = await removeDirectory(dir, { attempts: 10, baseDelayMs: 150 });
    assert.equal(result.removed, true, 'cleanup must succeed once the lock clears');
    assert.equal(fs.existsSync(dir), false);
  } finally {
    if (child.pid !== undefined) {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('staging survives a failed publish so Retry can finish, and no temp sibling is orphaned', async () => {
  // A failure must not consume the staging tree (that would make Retry impossible) and must not leave a temp copy.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-fail-'));
  const from = makeStaging(root);
  // Destination whose parent is a file: mkdir fails with ENOTDIR, which is not retryable, so the ladder stops at the first
  // rung after attempting a rename. The interesting assertion is about what is left on disk.
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const to = path.join(blocker, 'servers', 'id-1');
  try {
    await assert.rejects(() => publishStagedDirectoryAsync(from, to));
    assert.equal(fs.existsSync(from), true, 'staging is preserved for Retry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
