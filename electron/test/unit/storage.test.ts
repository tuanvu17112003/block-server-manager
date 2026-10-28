// Settings → Downloads & storage: path normalization/persistence and the write probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  effectiveCacheDir,
  getStorageInfo,
  normalizeDownloadsPath,
  setDownloadsPath,
} from '../../services/storage';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msm-storage-'));
}

test('normalizeDownloadsPath: null/blank means default, relative/invalid paths are rejected', () => {
  const root = tempRoot();
  try {
    assert.equal(normalizeDownloadsPath(null, root), null);
    assert.equal(normalizeDownloadsPath('', root), null);
    assert.equal(normalizeDownloadsPath('   ', root), null);
    assert.throws(() => normalizeDownloadsPath('relative\\downloads', root), (error: unknown) => (error as { code?: string }).code === 'validation');
    assert.throws(() => normalizeDownloadsPath('C:\\bad\0path', root), (error: unknown) => (error as { code?: string }).code === 'validation');
    const custom = path.join(root, 'downloads');
    assert.equal(normalizeDownloadsPath(custom, root), path.resolve(custom));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('normalizeDownloadsPath: refuses manager-managed folders and the data root', () => {
  const root = tempRoot();
  try {
    for (const managed of ['servers', 'backups', 'runtime', 'installer-staging', 'metrics', 'logs', 'diagnostics']) {
      assert.throws(
        () => normalizeDownloadsPath(path.join(root, managed, 'downloads'), root),
        (error: unknown) => (error as { code?: string }).code === 'validation',
        `${managed} must be rejected`,
      );
    }
    assert.throws(
      () => normalizeDownloadsPath(path.dirname(root), root),
      (error: unknown) => (error as { code?: string }).code === 'validation',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setDownloadsPath persists the folder and effectiveCacheDir follows it (then resets)', () => {
  const root = tempRoot();
  const custom = path.join(root, 'downloads-custom');
  try {
    const initial = getStorageInfo(root);
    assert.equal(initial.isDefault, true);
    assert.equal(initial.effectiveDownloadsPath, path.join(root, 'cache'));

    const saved = setDownloadsPath(root, custom);
    assert.equal(saved.isDefault, false);
    assert.equal(saved.downloadsPath, path.resolve(custom));
    assert.equal(saved.effectiveDownloadsPath, path.resolve(custom));
    assert.equal(fs.existsSync(custom), true, 'custom folder must be created');
    assert.equal(effectiveCacheDir(root), path.resolve(custom));
    assert.equal(getStorageInfo(root).downloadsPath, path.resolve(custom));

    const reset = setDownloadsPath(root, null);
    assert.equal(reset.isDefault, true);
    assert.equal(getStorageInfo(root).downloadsPath, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setDownloadsPath fails with io when the folder cannot be created', () => {
  const root = tempRoot();
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'this is a file, so a folder cannot be created under it', 'utf8');
  try {
    assert.throws(
      () => setDownloadsPath(root, path.join(blocker, 'downloads')),
      (error: unknown) => ['io', 'validation'].includes(String((error as { code?: string }).code)),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
