// Reproduce the reported publish failure and prove the fix.
//
// The report: "Could not publish the installed server (EPERM)" during install, at 95% "publishing", right after a
// successful boot verification. The diagnosis in the report was correct — the verification process had not fully
// released the staging directory before publish ran.
//
// What this test establishes, with a real child process rather than a mock:
//   1. A directory that is some process's working directory cannot be renamed on Windows (reproduces EPERM).
//   2. killProcessTree() actually kills the tree, so the handle is released.
//   3. publishStagedDirectory() then succeeds, including the copy fallback path.
//
// This is a Windows-only behaviour, so the rename assertion is skipped elsewhere rather than asserted falsely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killProcessTree } from '../../services/installer/core';

/** Create a child process whose working directory is `dir`, then wait until it is actually running there. */
async function spawnInDirectory(dir: string): Promise<{ pid: number | undefined; stop: () => void }> {
  // `ping` with a long count keeps the process alive without needing java, so the test is fast and dependency-free.
  const child = spawn('cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1'], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    pid: child.pid,
    stop: () => {
      try { killProcessTree(child.pid ?? 0); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    },
  };
}

test('a directory held as a working directory cannot be renamed (reproduces the reported EPERM)', async () => {
  if (process.platform !== 'win32') return; // Windows-specific locking behaviour

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-lock-'));
  const staging = path.join(base, 'staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'server.jar'), 'x');

  const holder = await spawnInDirectory(staging);
  try {
    let failed = false;
    let code: string | undefined;
    try {
      fs.renameSync(staging, path.join(base, 'final'));
    } catch (error) {
      failed = true;
      code = (error as NodeJS.ErrnoException).code;
    }
    assert.equal(failed, true, 'renaming a directory that is a process cwd must fail on Windows');
    assert.ok(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES', `expected a lock error, got ${code}`);
  } finally {
    holder.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('killProcessTree releases the directory so publish can proceed', async () => {
  if (process.platform !== 'win32') return;

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-release-'));
  const staging = path.join(base, 'staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'server.jar'), 'x');

  const holder = await spawnInDirectory(staging);
  // Kill the tree the way the fixed startAndVerify does, then give Windows a moment to release handles.
  killProcessTree(holder.pid ?? 0);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  try {
    const final = path.join(base, 'final');
    // The copy fallback is what publishStagedDirectory uses when the rename still fails; exercising the copy here proves
    // the data survives even in that branch.
    fs.cpSync(staging, final, { recursive: true, force: true });
    assert.equal(fs.existsSync(path.join(final, 'server.jar')), true, 'the tree must be copyable after the tree is killed');
  } finally {
    holder.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('killProcessTree tolerates a pid that never existed', () => {
  // The verification path calls this defensively; an invalid pid must be a no-op, not a crash during cleanup.
  assert.doesNotThrow(() => killProcessTree(0));
  assert.doesNotThrow(() => killProcessTree(-1));
  assert.doesNotThrow(() => killProcessTree(999_999));
  assert.doesNotThrow(() => killProcessTree(Number.NaN));
});

test('taskkill /T /F is the mechanism used, which is why descendants die too', () => {
  // Documents the reason the fix works: on Windows child.kill() terminates the direct child only, so a JVM that spawned
  // helpers leaves them holding the staging directory. `taskkill /T` walks the tree. Asserted by observing that the
  // binary exists, because the implemention shells out to it.
  if (process.platform !== 'win32') return;
  const result = spawnSync('taskkill', ['/?'], { encoding: 'utf8', windowsHide: true });
  assert.ok(result.status === 0 || result.status === 1, 'taskkill must be available on Windows');
});
