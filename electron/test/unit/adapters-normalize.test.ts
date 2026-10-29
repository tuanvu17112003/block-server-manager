// C2 tests: shared archive normalization (research §6 pipeline step 2).
//
// The design requirement is quoted from docs/research/2026-10-29-universal-modpack-install.md line 305:
//   "Normalize — list entries once; unwrap single nested zip; strip a single wrapping directory"
//
// These tests use real zip files written to a temp dir (via the same yauzl-backed reader the product uses),
// because the behaviour under test is filesystem/archive behaviour, not pure logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupNormalized, findWrapperPrefix, findWrapperZip, hasRootFormatMarker, normalizeArchive,
  stripPrefixFromIndex,
} from '../../services/adapters/normalize';

// ---- minimal zip writer (deflate via zlib, valid central directory with correct local-header offsets) ----

function crc32(buffer: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeZip(zipPath: string, entries: [string, string | Buffer][]): void {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const startOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored (uncompressed): the writer below does not actually deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(startOffset, 42);
    central.push(Buffer.concat([entry, nameBuffer]));
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuffer, end]));
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msm-normalize-'));
}

// ---- pure helpers ----

test('hasRootFormatMarker: only root-level markers count', () => {
  assert.equal(hasRootFormatMarker(['modrinth.index.json']), true);
  assert.equal(hasRootFormatMarker(['pack.toml']), true);
  assert.equal(hasRootFormatMarker(['modpack.toml']), true, 'real packs use modpack.toml too');
  assert.equal(hasRootFormatMarker(['instance.json']), true);
  // A marker inside a folder is not a root marker.
  assert.equal(hasRootFormatMarker(['Pack/pack.toml']), false);
  assert.equal(hasRootFormatMarker(['mods/a.jar', 'readme.txt']), false);
});

test('findWrapperZip: exactly one zip plus harmless metadata is a wrapper', () => {
  assert.equal(findWrapperZip([{ name: 'pack.zip' }, { name: 'readme.txt' }]), 'pack.zip');
  // Two zips is ambiguous, so no unwrap.
  assert.equal(findWrapperZip([{ name: 'a.zip' }, { name: 'b.zip' }]), null);
  // A payload file alongside the zip means it is not a pure wrapper.
  assert.equal(findWrapperZip([{ name: 'pack.zip' }, { name: 'mods/a.jar' }]), null);
  // No zip at all.
  assert.equal(findWrapperZip([{ name: 'mods/a.jar' }]), null);
});

test('findWrapperPrefix: detects a single wrapping directory', () => {
  assert.equal(findWrapperPrefix(['Pack/mods/a.jar', 'Pack/config/b.cfg']), 'Pack');
  assert.equal(findWrapperPrefix(['Pack/mods/a.jar', 'Other/config/b.cfg']), null);
  // A root-level file means there is no single wrapper.
  assert.equal(findWrapperPrefix(['Pack/mods/a.jar', 'readme.txt']), null);
});

// ---- filesystem behaviour ----

test('normalizeArchive: unwraps a single nested-zip wrapper (the real 1 GB CF shape)', async () => {
  const dir = tempDir();
  try {
    const innerPath = path.join(dir, 'inner.zip');
    writeZip(innerPath, [['mods/a.jar', 'A'], ['config/b.cfg', 'B']]);
    const outerPath = path.join(dir, 'outer.zip');
    // This is exactly the shape of 466901-server-9296268.zip: one nested zip + readme.txt.
    writeZip(outerPath, [['server_pack.zip', fs.readFileSync(innerPath)], ['readme.txt', 'hello']]);

    const result = await normalizeArchive(outerPath);
    assert.equal(result.unwrapped, true);
    assert.equal(result.nestedZip, 'server_pack.zip');
    assert.equal(result.outerEntryCount, 2);
    assert.ok(result.index.names.has('mods/a.jar'), 'the inner payload must be visible after unwrapping');
    assert.equal(await result.index.readText('config/b.cfg'), 'B');
    cleanupNormalized(result);
    assert.equal(fs.existsSync(result.effectivePath), false, 'temp archive must be removed by cleanup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeArchive: a real pack archive is NOT unwrapped (root marker present)', async () => {
  const dir = tempDir();
  try {
    const archivePath = path.join(dir, 'pack.zip');
    writeZip(archivePath, [
      ['modrinth.index.json', '{"formatVersion":1,"game":"minecraft"}'],
      ['overrides/config/a.cfg', 'x'],
    ]);
    const result = await normalizeArchive(archivePath);
    assert.equal(result.unwrapped, false, 'a recognized root format must never be unwrapped');
    assert.equal(result.effectivePath, archivePath);
    assert.ok(result.index.names.has('modrinth.index.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeArchive: reports a single wrapping directory without mutating names', async () => {
  const dir = tempDir();
  try {
    const archivePath = path.join(dir, 'wrapped.zip');
    writeZip(archivePath, [['PackName/mods/a.jar', 'A'], ['PackName/config/b.cfg', 'B']]);
    const result = await normalizeArchive(archivePath);
    assert.equal(result.strippedPrefix, 'PackName');
    // Raw index keeps full names; callers choose the stripped view deliberately.
    assert.ok(result.index.names.has('PackName/mods/a.jar'));
    const stripped = stripPrefixFromIndex(result.index, 'PackName');
    assert.ok(stripped.names.has('mods/a.jar'));
    assert.equal(await stripped.readText('config/b.cfg'), 'B');
    assert.deepEqual(stripped.under('mods/'), ['mods/a.jar']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeArchive: refuses a depth-2 nesting instead of recursing', async () => {
  const dir = tempDir();
  try {
    const level2 = path.join(dir, 'l2.zip');
    writeZip(level2, [['mods/a.jar', 'A']]);
    const level1 = path.join(dir, 'l1.zip');
    writeZip(level1, [['payload.zip', fs.readFileSync(level2)], ['readme.txt', 'x']]);
    const level0 = path.join(dir, 'l0.zip');
    writeZip(level0, [['pack.zip', fs.readFileSync(level1)], ['readme.txt', 'x']]);

    await assert.rejects(
      () => normalizeArchive(level0),
      /Only a single wrapper level is supported/,
      'the bound must be explicit, not silently ignored',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeArchive: a plain payload archive is a no-op', async () => {
  const dir = tempDir();
  try {
    const archivePath = path.join(dir, 'plain.zip');
    writeZip(archivePath, [['mods/a.jar', 'A'], ['config/b.cfg', 'B']]);
    const result = await normalizeArchive(archivePath);
    assert.equal(result.unwrapped, false);
    assert.equal(result.strippedPrefix, null);
    assert.equal(result.effectivePath, archivePath);
    assert.equal(result.tempPath, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

