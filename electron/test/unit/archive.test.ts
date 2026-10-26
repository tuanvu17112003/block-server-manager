// WP-4.4 archive-hardening tests (INST-019): reserved Windows names, trailing dot/space,
// case-insensitive duplicates, symlink/reparse entries, entry-count and path-length caps.
// Fixtures are raw ZIP buffers (so hostile names/attributes can be expressed) plus the shared writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_PATH_LENGTH, extractZip, unsafeArchiveEntryReason } from '../../services/installer/core';
import { collectInputs, writeZip } from '../../services/zip';
import { tempRoot } from '../harness';

interface RawEntry { name: string; data?: Buffer | string; symlink?: boolean; dir?: boolean }

/** Minimal ZIP writer that can express hostile names and unix/reparse external attributes. */
function buildZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = entry.dir ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
    const compressed = deflateRawSync(body);
    const checksum = crc32(body) >>> 0;
    const mode = entry.dir ? 0o040755 : entry.symlink ? 0o120777 : 0o100644;
    const external = (((mode << 16) >>> 0) | (entry.dir ? 0x10 : 0x20)) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([local, name, compressed]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function listing(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

test('extractZip: normal archives (shared writer) still round-trip', async () => {
  const temp = tempRoot('msm-unit-archive-ok');
  try {
    const src = path.join(temp.root, 'src');
    fs.mkdirSync(path.join(src, 'config'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(src, 'config', 'b.json'), '{"b":2}');
    const zip = path.join(temp.root, 'ok.zip');
    await writeZip(zip, await collectInputs(src, ['a.txt', 'config']));
    const out = path.join(temp.root, 'out');
    const result = await extractZip(zip, out, { skipExisting: false });
    assert.deepEqual(result.written.sort(), ['a.txt', 'config/b.json']);
    assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'alpha');
  } finally {
    temp.cleanup();
  }
});

test('unsafeArchiveEntryReason: rejects reserved Windows device names and trailing dot/space segments', () => {
  for (const name of ['CON', 'con.txt', 'sub/NUL', 'PRN.log', 'aux/', 'COM1.jar', 'lpt9.txt', 'dir/COM5']) {
    assert.match(String(unsafeArchiveEntryReason(name)), /reserved Windows device name/, name);
  }
  for (const name of ['trailing.', 'dir./a.txt', 'trailing ', 'dir /a.txt', 'a.txt.']) {
    assert.match(String(unsafeArchiveEntryReason(name)), /trailing dot or space/, name);
  }
  assert.equal(unsafeArchiveEntryReason('mods/example.jar'), null);
  assert.equal(unsafeArchiveEntryReason('config/deep/file.toml'), null);
  assert.match(String(unsafeArchiveEntryReason('a'.repeat(ARCHIVE_MAX_PATH_LENGTH + 1))), /path too long/);
});

test('extractZip: reserved names and trailing dot/space entries fail closed with no extracted file', async () => {
  const temp = tempRoot('msm-unit-archive-names');
  try {
    for (const hostile of ['CON.txt', 'NUL', 'sub/COM1.jar', 'trailing.', 'dir /file.txt']) {
      const zip = path.join(temp.root, 'hostile.zip');
      fs.writeFileSync(zip, buildZip([{ name: hostile, data: 'payload' }]));
      const out = path.join(temp.root, `out-${hostile.replaceAll(/[^a-z0-9]/gi, '_')}`);
      await assert.rejects(
        () => extractZip(zip, out, { skipExisting: false }),
        /unsafe archive entry: (reserved Windows device name|archive entry segment has a trailing dot or space)/,
        hostile,
      );
      assert.deepEqual(listing(out), [], `no file may be extracted for ${hostile}`);
    }
  } finally {
    temp.cleanup();
  }
});

test('extractZip: case-insensitive duplicate paths are rejected', async () => {
  const temp = tempRoot('msm-unit-archive-dup');
  try {
    const zip = path.join(temp.root, 'dup.zip');
    fs.writeFileSync(zip, buildZip([
      { name: 'mods/Example.JAR', data: 'first' },
      { name: 'mods/example.jar', data: 'second' },
    ]));
    await assert.rejects(() => extractZip(zip, path.join(temp.root, 'out'), { skipExisting: false }), /duplicate archive path \(case-insensitive\): mods\/example\.jar/);
  } finally {
    temp.cleanup();
  }
});

test('extractZip: symlink/reparse entries are rejected', async () => {
  const temp = tempRoot('msm-unit-archive-link');
  try {
    const zip = path.join(temp.root, 'link.zip');
    fs.writeFileSync(zip, buildZip([
      { name: 'safe.txt', data: 'ok' },
      { name: 'world/link', data: '..\\..\\outside', symlink: true },
    ]));
    await assert.rejects(() => extractZip(zip, path.join(temp.root, 'out'), { skipExisting: false }), /symlink\/reparse entry not allowed/);
  } finally {
    temp.cleanup();
  }
});

test('extractZip: entry-count and path-length caps are enforced', async () => {
  const temp = tempRoot('msm-unit-archive-limits');
  try {
    const many = path.join(temp.root, 'many.zip');
    fs.writeFileSync(many, buildZip([1, 2, 3, 4].map((index) => ({ name: `f${index}.txt`, data: String(index) }))));
    await assert.rejects(
      () => extractZip(many, path.join(temp.root, 'out-many'), { skipExisting: false, maxEntries: 3 }),
      /archive has too many entries \(> 3\)/,
    );
    // The default cap is the documented 100k limit.
    assert.equal(ARCHIVE_MAX_ENTRIES, 100_000);

    const longName = `${'a'.repeat(60)}.txt`;
    const longZip = path.join(temp.root, 'long.zip');
    fs.writeFileSync(longZip, buildZip([{ name: longName, data: 'x' }]));
    await assert.rejects(
      () => extractZip(longZip, path.join(temp.root, 'out-long'), { skipExisting: false, maxPathLength: 40 }),
      /path too long/,
    );
    const defaultLong = path.join(temp.root, 'default-long.zip');
    fs.writeFileSync(defaultLong, buildZip([{ name: `${'b'.repeat(ARCHIVE_MAX_PATH_LENGTH)}.txt`, data: 'x' }]));
    await assert.rejects(
      () => extractZip(defaultLong, path.join(temp.root, 'out-default-long'), { skipExisting: false }),
      /path too long/,
    );
  } finally {
    temp.cleanup();
  }
});

