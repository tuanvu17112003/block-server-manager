// Stale staging cleanup must free space without ever touching an install that is still running.
//
// Measured motivation: 8 leftover staging folders, 2.6 GB, oldest 58 hours old. cleanupStaging() only runs in the failure
// path, so any killed install or failed final removal leaves the folder forever. Nothing else deletes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanStaleStaging } from '../../services/install-transaction';

function makeDataRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-clean-'));
  fs.mkdirSync(path.join(base, 'installer-staging'), { recursive: true });
  return base;
}

/** A staging folder with some content, whose mtime is set `ageMs` into the past. */
function makeStaging(dataRoot: string, id: string, ageMs: number): string {
  const dir = path.join(dataRoot, 'installer-staging', id);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.jar'), Buffer.alloc(1024, 'j'));
  fs.writeFileSync(path.join(dir, 'mods', 'a.jar'), Buffer.alloc(2048, 'm'));
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

test('old staging folders are removed and their size is reported', () => {
  const dataRoot = makeDataRoot();
  const old = makeStaging(dataRoot, 'aaaaaaaa-0000-0000-0000-000000000001', 48 * 60 * 60_000);
  try {
    const result = cleanStaleStaging(dataRoot);
    assert.deepEqual(result.removed, ['aaaaaaaa-0000-0000-0000-000000000001']);
    assert.equal(result.freedBytes, 1024 + 2048);
    assert.equal(fs.existsSync(old), false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a recent staging folder is KEPT, because it may be an install running right now', () => {
  // This is the one dangerous mistake this function could make: deleting the staging folder of a live install.
  const dataRoot = makeDataRoot();
  const recent = makeStaging(dataRoot, 'bbbbbbbb-0000-0000-0000-000000000002', 60_000); // one minute
  try {
    const result = cleanStaleStaging(dataRoot);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.kept, ['bbbbbbbb-0000-0000-0000-000000000002']);
    assert.equal(fs.existsSync(recent), true, 'a recent folder must survive');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('the age threshold is configurable and respected at the boundary', () => {
  const dataRoot = makeDataRoot();
  const boundary = makeStaging(dataRoot, 'cccccccc-0000-0000-0000-000000000003', 2 * 60 * 60_000); // 2 hours
  try {
    // With a 3-hour threshold this folder is too new.
    const kept = cleanStaleStaging(dataRoot, { minAgeMs: 3 * 60 * 60_000 });
    assert.deepEqual(kept.kept, ['cccccccc-0000-0000-0000-000000000003']);
    assert.equal(fs.existsSync(boundary), true);

    // With a 1-hour threshold it is stale.
    const removed = cleanStaleStaging(dataRoot, { minAgeMs: 60 * 60_000 });
    assert.deepEqual(removed.removed, ['cccccccc-0000-0000-0000-000000000003']);
    assert.equal(fs.existsSync(boundary), false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('only staging folders are touched, never a sibling directory', () => {
  // Runs against a real data root, so a path bug could delete servers.
  const dataRoot = makeDataRoot();
  fs.mkdirSync(path.join(dataRoot, 'servers', 'real-server'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'servers', 'real-server', 'server.jar'), 'keep');
  fs.writeFileSync(path.join(dataRoot, 'app-data.json'), '{"servers":[]}');
  makeStaging(dataRoot, 'dddddddd-0000-0000-0000-000000000004', 48 * 60 * 60_000);
  try {
    cleanStaleStaging(dataRoot);
    assert.equal(fs.existsSync(path.join(dataRoot, 'servers', 'real-server', 'server.jar')), true);
    assert.equal(fs.existsSync(path.join(dataRoot, 'app-data.json')), true);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a missing staging directory is not an error', () => {
  // The app may start before any install has ever run.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-none-'));
  try {
    assert.deepEqual(cleanStaleStaging(base), { removed: [], kept: [], freedBytes: 0 });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
