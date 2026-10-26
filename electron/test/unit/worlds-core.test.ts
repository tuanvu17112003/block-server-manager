// Unit tests for the pure world planning helpers and the minimal level.dat NBT parser.
// NBT fixtures are written programmatically (no binary assets) and read back through both
// `parseLevelDat` (raw bytes) and `readLevelDat` (gzip file on disk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  planWorldDeleteBackup,
  planWorldDuplicate,
  planWorldExport,
  planWorldImport,
  safeWorldName,
  slugify,
  backupTimestamp,
  worldDeleteBackupFileName,
  dimensionSuffixOf,
  isDimensionFolderName,
  uniqueName,
  uniqueWorldUnitBase,
  unitTargetName,
  worldUnitFolderNames,
  type ImportArchiveDirectory,
} from '../../services/worlds-core';
import { parseLevelDat, readLevelDat } from '../../services/world-nbt';
import { tempRoot } from '../harness';

// ---------- minimal NBT writer for fixtures ----------
function u8(value: number): Buffer { return Buffer.from([value & 0xff]); }
function u16(value: number): Buffer { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; }
function i32(value: number): Buffer { const buffer = Buffer.alloc(4); buffer.writeInt32BE(value); return buffer; }
function i64(value: bigint): Buffer { const buffer = Buffer.alloc(8); buffer.writeBigInt64BE(value); return buffer; }
function nbtString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([u16(body.length), body]);
}
function named(type: number, name: string, payload: Buffer): Buffer {
  return Buffer.concat([u8(type), nbtString(name), payload]);
}
function compound(children: Buffer[], end = true): Buffer {
  return Buffer.concat(end ? [...children, u8(0)] : children);
}
const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_LONG = 4;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;

function levelDatBytes(options: { levelName?: string | null; seed?: bigint | null; version?: string | null; extra?: Buffer[] } = {}): Buffer {
  const children: Buffer[] = [];
  if (options.levelName !== null) children.push(named(TAG_STRING, 'LevelName', nbtString(options.levelName ?? 'world')));
  if (options.seed !== null) children.push(named(TAG_LONG, 'RandomSeed', i64(options.seed ?? 0n)));
  children.push(named(TAG_BYTE, 'initialized', u8(1)));
  children.push(named(TAG_BYTE_ARRAY, 'thunderTime', Buffer.concat([i32(0)])));
  children.push(named(TAG_LIST, 'PlayerList', Buffer.concat([u8(TAG_COMPOUND), i32(0)])));
  if (options.version !== null) {
    children.push(named(TAG_COMPOUND, 'Version', compound([named(TAG_STRING, 'Name', nbtString(options.version ?? '19133'))])));
  }
  children.push(...(options.extra ?? []));
  const data = named(TAG_COMPOUND, 'Data', compound(children));
  return Buffer.concat([u8(TAG_COMPOUND), nbtString(''), data, u8(TAG_END)]);
}

function validationError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'validation');
    assert.match((error as Error).message, pattern);
    return true;
  });
}

// ---------- NBT parser ----------
test('parseLevelDat: reads LevelName, signed long seed and Version.Name', () => {
  const parsed = parseLevelDat(levelDatBytes({ levelName: 'Survival World', seed: -1234567890123n, version: '19133' }));
  assert.deepEqual(parsed, { name: 'Survival World', seed: '-1234567890123', version: '19133' });
});

test('parseLevelDat: seed > Number.MAX_SAFE_INTEGER keeps exact decimal and tolerates unknown tags', () => {
  const extra = [named(11, 'IntArray', Buffer.concat([i32(2), i32(1), i32(2)])), named(TAG_LIST, 'Nested', Buffer.concat([u8(TAG_LONG), i32(2), i64(5n), i64(-6n)]))];
  const parsed = parseLevelDat(levelDatBytes({ seed: 9223372036854775807n, extra }));
  assert.equal(parsed?.seed, '9223372036854775807');
  assert.equal(parsed?.name, 'world');
  assert.equal(parsed?.version, '19133');
});

test('parseLevelDat: missing optional fields become null; missing Data is invalid', () => {
  const parsed = parseLevelDat(levelDatBytes({ levelName: null, seed: null, version: null }));
  assert.deepEqual(parsed, { name: null, seed: null, version: null });
  const noData = Buffer.concat([u8(TAG_COMPOUND), nbtString(''), u8(TAG_END)]);
  assert.equal(parseLevelDat(noData), null);
});

test('parseLevelDat: corrupt/truncated/wrong-shape payloads return null (never throw)', () => {
  const valid = levelDatBytes();
  assert.equal(parseLevelDat(valid.subarray(0, valid.length - 6)), null);
  assert.equal(parseLevelDat(Buffer.from('not an nbt file')), null);
  assert.equal(parseLevelDat(Buffer.concat([u8(TAG_BYTE), nbtString(''), u8(1)])), null);
  // Unknown tag id inside Data.
  const badTag = Buffer.concat([
    u8(TAG_COMPOUND), nbtString(''),
    named(TAG_COMPOUND, 'Data', compound([Buffer.concat([u8(13), nbtString('Weird'), Buffer.from([0, 0, 0, 0])])])),
    u8(TAG_END),
  ]);
  assert.equal(parseLevelDat(badTag), null);
  // Absurd list length must be rejected before allocation.
  const hugeList = Buffer.concat([
    u8(TAG_COMPOUND), nbtString(''),
    named(TAG_COMPOUND, 'Data', compound([named(TAG_LIST, 'Huge', Buffer.concat([u8(TAG_BYTE), i32(2_000_000_000)]))])),
    u8(TAG_END),
  ]);
  assert.equal(parseLevelDat(hugeList), null);
});

test('readLevelDat: reads a gzip file and fails closed for plain/corrupt/missing files', () => {
  const temp = tempRoot('msm-unit-nbt');
  try {
    const good = path.join(temp.root, 'good.dat');
    fs.writeFileSync(good, gzipSync(levelDatBytes({ levelName: 'world', seed: 8675309n, version: '19133' })));
    assert.deepEqual(readLevelDat(good), { name: 'world', seed: '8675309', version: '19133' });

    const plain = path.join(temp.root, 'plain.dat');
    fs.writeFileSync(plain, 'this is not gzip');
    assert.equal(readLevelDat(plain), null);

    const wrongMagic = path.join(temp.root, 'wrong.dat');
    fs.writeFileSync(wrongMagic, Buffer.from([0x1f, 0x8c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(readLevelDat(wrongMagic), null);

    const truncated = path.join(temp.root, 'truncated.dat');
    fs.writeFileSync(truncated, gzipSync(levelDatBytes()).subarray(0, 10));
    assert.equal(readLevelDat(truncated), null);

    assert.equal(readLevelDat(path.join(temp.root, 'missing.dat')), null);
  } finally {
    temp.cleanup();
  }
});

// ---------- naming / unit helpers ----------
test('safeWorldName/unit helpers: sanitize, detect dimensions and build unit names', () => {
  assert.equal(safeWorldName('  ..bad:name  '), 'bad-name');
  assert.equal(safeWorldName(''), 'world');
  assert.equal(safeWorldName('..'), 'world');
  assert.equal(isDimensionFolderName('world_nether'), true);
  assert.equal(isDimensionFolderName('World_The_End'), true);
  assert.equal(isDimensionFolderName('_nether'), false);
  assert.equal(isDimensionFolderName('world'), false);
  assert.equal(dimensionSuffixOf('w_the_end'), '_the_end');
  assert.equal(dimensionSuffixOf('w'), null);
  assert.deepEqual(worldUnitFolderNames('w'), ['w', 'w_nether', 'w_the_end']);
  assert.equal(unitTargetName('copy', '_nether'), 'copy_nether');
  assert.equal(unitTargetName('copy', null), 'copy');
});

test('uniqueName/uniqueWorldUnitBase: avoid base and dimension collisions', () => {
  assert.equal(uniqueName([], 'world'), 'world');
  assert.equal(uniqueName(['world'], 'world'), 'world-2');
  assert.equal(uniqueName(['world', 'world-2'], 'world'), 'world-3');
  assert.equal(uniqueWorldUnitBase([], 'world'), 'world');
  assert.equal(uniqueWorldUnitBase(['world'], 'world'), 'world-2');
  assert.equal(uniqueWorldUnitBase(['world-2_nether'], 'world'), 'world');
  assert.equal(uniqueWorldUnitBase(['world', 'world-2'], 'world'), 'world-3');
});

// ---------- import layout classification ----------
function dir(name: string, hasLevelDat: boolean): ImportArchiveDirectory { return { name, hasLevelDat }; }

test('planWorldImport: root level.dat archive uses the zip stem as the base hint', () => {
  const plan = planWorldImport({ zipFileName: 'My World.zip', rootHasLevelDat: true, directories: [] });
  assert.deepEqual(plan, { mode: 'root', targetBaseHint: 'My World' });
});

test('planWorldImport: one folder (single-player zip) is a unit with its folder name', () => {
  const plan = planWorldImport({ zipFileName: 'download.zip', rootHasLevelDat: false, directories: [dir('spworld', true)] });
  assert.equal(plan.mode, 'unit');
  if (plan.mode !== 'unit') return;
  assert.equal(plan.sourceBase, 'spworld');
  assert.equal(plan.targetBaseHint, 'spworld');
  assert.deepEqual(plan.parts, [{ sourceName: 'spworld', suffix: null }]);
});

test('planWorldImport: server-style world/ + sibling dimensions (each may hold level.dat) is one unit', () => {
  const plan = planWorldImport({
    zipFileName: 'server-export.zip',
    rootHasLevelDat: false,
    directories: [dir('w', true), dir('w_nether', true), dir('w_the_end', true), dir('config', false)],
  });
  assert.equal(plan.mode, 'unit');
  if (plan.mode !== 'unit') return;
  assert.equal(plan.sourceBase, 'w');
  assert.deepEqual(plan.parts.map((part) => part.suffix), [null, '_nether', '_the_end']);
  assert.deepEqual(plan.parts.map((part) => part.sourceName), ['w', 'w_nether', 'w_the_end']);
});

test('planWorldImport: mixed, multi-world, dimension-only and world-less archives throw validation errors', () => {
  validationError(
    () => planWorldImport({ zipFileName: 'mixed.zip', rootHasLevelDat: true, directories: [dir('w', true)] }),
    /level\.dat at its root together with nested world folder/,
  );
  validationError(
    () => planWorldImport({ zipFileName: 'mixed-dims.zip', rootHasLevelDat: true, directories: [dir('w_nether', false)] }),
    /plus dimension folder/,
  );
  validationError(
    () => planWorldImport({ zipFileName: 'multi.zip', rootHasLevelDat: false, directories: [dir('w1', true), dir('w2', true)] }),
    /multiple world folders/,
  );
  validationError(
    () => planWorldImport({ zipFileName: 'dims.zip', rootHasLevelDat: false, directories: [dir('w_nether', true)] }),
    /only contains dimension folder/,
  );
  validationError(
    () => planWorldImport({ zipFileName: 'empty.zip', rootHasLevelDat: false, directories: [dir('nope', false)] }),
    /does not contain a world/,
  );
  validationError(
    () => planWorldImport({ zipFileName: 'orphan.zip', rootHasLevelDat: false, directories: [dir('w', true), dir('other_nether', true)] }),
    /do not belong to world folder "w"/,
  );
  validationError(
    () => planWorldImport({ zipFileName: 'reserved.zip', rootHasLevelDat: false, directories: [dir('.mcsm-hidden', true)] }),
    /reserved by the server manager/,
  );
});

// ---------- export / delete / duplicate plans ----------
test('planWorldExport/planWorldDeleteBackup: include existing dimensions only and reject unknown worlds', () => {
  const folders = ['world', 'world_nether', 'world_the_end', 'other'];
  assert.deepEqual(planWorldExport(folders, 'world'), ['world', 'world_nether', 'world_the_end']);
  assert.deepEqual(planWorldExport(['world', 'world_nether'], 'world'), ['world', 'world_nether']);
  assert.deepEqual(planWorldDeleteBackup(['world', 'world_the_end'], 'world'), ['world', 'world_the_end']);
  // Case-only differences from external archives still resolve to the on-disk folders.
  assert.deepEqual(planWorldExport(['World', 'world_nether'], 'world'), ['World', 'world_nether']);
  validationError(() => planWorldExport(folders, 'missing'), /Not a world folder: missing/);
});

test('planWorldDuplicate: maps dimensions and avoids existing copy unit names', () => {
  const plan = planWorldDuplicate(['world', 'world_nether'], 'world');
  assert.equal(plan.targetBase, 'world-copy');
  assert.deepEqual(plan.copies, [
    { source: 'world', target: 'world-copy' },
    { source: 'world_nether', target: 'world-copy_nether' },
  ]);
  const collided = planWorldDuplicate(['world', 'world-copy', 'world-copy_nether'], 'world');
  assert.equal(collided.targetBase, 'world-copy-2');
  assert.deepEqual(collided.copies, [
    { source: 'world', target: 'world-copy-2' },
  ]);
  const mixedCase = planWorldDuplicate(['World', 'world_nether'], 'world');
  assert.equal(mixedCase.targetBase, 'World-copy');
  assert.deepEqual(mixedCase.copies, [
    { source: 'World', target: 'World-copy' },
    { source: 'world_nether', target: 'World-copy_nether' },
  ]);
  validationError(() => planWorldDuplicate(['world'], 'nope'), /Not a world folder: nope/);
});

test('slugify/backupTimestamp/worldDeleteBackupFileName: deterministic backup archive names', () => {
  assert.equal(slugify('My Server!'), 'my-server');
  assert.equal(slugify(''), 'server');
  const at = new Date('2026-10-26T19:35:19.123Z');
  assert.equal(backupTimestamp(at), '2026-10-26T19-35-19-123Z');
  assert.equal(worldDeleteBackupFileName('My Server', at), 'my-server-2026-10-26T19-35-19-123Z-world-delete.zip');
});
