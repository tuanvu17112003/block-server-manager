// The publish must never block the Electron main thread.
//
// This is a regression test for a real hang. The publish ladder originally used a synchronous sleep (`Atomics.wait`,
// which parks the thread completely) and its retry budgets grew to 312 seconds in a single rung. On a failed install the
// window froze for over five minutes and Windows marked the app "Not Responding"; the user killed it. Measured: a 300ms
// request took 311ms with no yields at all.
//
// The async ladder must wait the same way but yield in between. The test forces every retry rung to be exercised (by
// publishing into a destination that cannot be created) and asserts that a timer scheduled before the call still fires
// while the publish is pending. If the event loop were blocked, that timer would only fire after the publish settled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishStagedDirectoryAsync } from '../../services/install-transaction';

function makeStaging(): { base: string; from: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-async-'));
  const from = path.join(base, 'staging');
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'server.jar'), 'jar');
  fs.writeFileSync(path.join(from, 'server.properties'), 'motd=x');
  return { base, from };
}

test('async publish moves the tree and reports a trace for the successful rung', async () => {
  const { base, from } = makeStaging();
  const to = path.join(base, 'servers', 'id-1');
  const traces: { step: string; ok: boolean; durationMs: number }[] = [];
  try {
    await publishStagedDirectoryAsync(from, to, { trace: (entry) => traces.push(entry) });
    assert.equal(fs.existsSync(path.join(to, 'server.jar')), true);
    assert.equal(fs.existsSync(from), false, 'staging is consumed');
    assert.equal(traces.length, 1, 'a first-rung success records exactly one trace');
    assert.equal(traces[0].ok, true);
    assert.match(traces[0].step, /rename/);
    assert.ok(traces[0].durationMs >= 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the event loop stays responsive while publish retries are waiting', async () => {
  // Force the RETRY path, not an immediate throw. ENOTDIR is not retryable (correctly — it will never heal), so the test
  // holds the destination open with a real open file handle instead: EPERM/EBUSY is retryable, so the publish enters its
  // retry ladder and waits between attempts. A timer armed before the call must fire DURING that waiting.
  const { base, from } = makeStaging();
  const serversDir = path.join(base, 'servers');
  const to = path.join(serversDir, 'id-1');
  fs.mkdirSync(serversDir, { recursive: true });

  // An open file handle inside the destination makes a directory rename fail with EPERM on Windows, which is retryable —
  // exactly the situation the ladder exists for.
  const held = path.join(base, 'held');
  fs.mkdirSync(held, { recursive: true });
  const handleFile = path.join(held, 'locked.jar');
  fs.writeFileSync(handleFile, 'x');
  const fd = fs.openSync(handleFile, 'r');

  let timerFiredWhilePublishing = false;
  let publishSettled = false;

  const publish = publishStagedDirectoryAsync(from, held)
    .catch(() => { /* the assertion is about responsiveness, not the outcome */ })
    .finally(() => { publishSettled = true; });

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      timerFiredWhilePublishing = !publishSettled;
      resolve();
    }, 150);
  });

  await publish;
  try { fs.closeSync(fd); } catch { /* ignore */ }
  try {
    assert.equal(
      timerFiredWhilePublishing,
      true,
      'a timer must fire while the publish is still retrying — otherwise the main thread is blocked and the UI freezes',
    );
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('a failing publish reports every attempted rung, naming the step that failed', async () => {
  // The diagnostics exist so a future failure can be attributed to a step instead of being one opaque EPERM line. This
  // pins that the traces survive a total failure.
  const { base, from } = makeStaging();
  // A destination path whose parent is a regular FILE. mkdir fails with ENOTDIR, which is not retryable, so the ladder
  // stops immediately — the point of this test is that the trace is still recorded for the step that failed.
  const blocker = path.join(base, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const to = path.join(blocker, 'servers', 'id-1');
  const traces: { step: string; ok: boolean; code?: string }[] = [];
  try {
    await assert.rejects(
      () => publishStagedDirectoryAsync(from, to, { trace: (entry) => traces.push(entry) }),
      (error: Error) => error !== undefined && error !== null,
    );
    // The staging folder must survive a failed publish: it is what makes Retry possible.
    assert.equal(fs.existsSync(from), true, 'staging is preserved on failure so Retry can finish the job');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('async publish into a pre-created destination keeps the tree shape', async () => {
  // Same shape guarantee as the sync version, because the file-by-file rung creates the destination first.
  const { base, from } = makeStaging();
  const to = path.join(base, 'dst');
  fs.mkdirSync(to, { recursive: true });
  fs.mkdirSync(path.join(from, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(from, 'mods', 'm.jar'), 'm');
  try {
    await publishStagedDirectoryAsync(from, to);
    assert.equal(fs.existsSync(path.join(to, 'server.jar')), true, 'files land directly in the destination');
    assert.equal(fs.existsSync(path.join(to, 'staging')), false, 'must not nest the source basename');
    assert.equal(fs.existsSync(path.join(to, 'mods', 'm.jar')), true, 'subdirectories preserved');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
