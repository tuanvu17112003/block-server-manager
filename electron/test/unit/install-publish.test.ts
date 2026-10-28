// Windows publish hardening: EPERM retry and copy fallback keep a successful install from failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishStagedDirectory } from '../../services/install-transaction';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msm-publish-'));
}

function makeStage(root: string): string {
  const stage = path.join(root, 'installer-staging', 'stage-1');
  fs.mkdirSync(path.join(stage, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'server.jar'), 'jar-bytes', 'utf8');
  fs.writeFileSync(path.join(stage, 'mods', 'example.jar'), 'mod-bytes', 'utf8');
  return stage;
}

function withRenameStub<T>(stub: typeof fs.renameSync, run: () => T): T {
  const original = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = stub;
  try { return run(); } finally { (fs as { renameSync: typeof fs.renameSync }).renameSync = original; }
}

function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
}

test('publish retries transient EPERM and still moves the tree atomically', () => {
  const root = tempRoot();
  try {
    const stage = makeStage(root);
    const target = path.join(root, 'servers', 'server-1');
    const original = fs.renameSync;
    let calls = 0;
    withRenameStub(((from: fs.PathLike, to: fs.PathLike) => {
      calls += 1;
      if (calls <= 3) throw eperm();
      return original(from, to);
    }) as typeof fs.renameSync, () => publishStagedDirectory(stage, target));
    assert.equal(fs.readFileSync(path.join(target, 'server.jar'), 'utf8'), 'jar-bytes');
    assert.equal(fs.existsSync(stage), false, 'staging must be moved, not copied, when the retry succeeds');
    assert.ok(calls >= 4, `expected retries, got ${calls} rename call(s)`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publish falls back to a verified copy when Windows keeps denying the rename', () => {
  const root = tempRoot();
  try {
    const stage = makeStage(root);
    const target = path.join(root, 'servers', 'server-1');
    const original = fs.renameSync;
    let calls = 0;
    // Exhaust the direct-rename retries (10), then allow the copy-fallback rename to succeed.
    withRenameStub(((from: fs.PathLike, to: fs.PathLike) => {
      calls += 1;
      if (calls <= 10) throw eperm();
      return original(from, to);
    }) as typeof fs.renameSync, () => publishStagedDirectory(stage, target));
    assert.equal(fs.readFileSync(path.join(target, 'server.jar'), 'utf8'), 'jar-bytes');
    assert.equal(fs.readFileSync(path.join(target, 'mods', 'example.jar'), 'utf8'), 'mod-bytes');
    assert.equal(fs.existsSync(stage), false);
    assert.ok(calls > 10, 'copy fallback must run after the rename retries');
    const leftovers = fs.readdirSync(path.join(root, 'servers')).filter((name) => name.includes('.publishing-'));
    assert.deepEqual(leftovers, [], 'copy fallback must not leave a temp publishing folder');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
