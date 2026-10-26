// Minimal NBT reader for `level.dat` — pure Node (zlib/fs), no dependencies.
// `level.dat` is a gzip-compressed NBT compound: root compound → Data compound with
// LevelName (string), RandomSeed (long) and Version (compound with Name string).
// The parser is intentionally small and fail-closed: any malformed/truncated input
// returns null so callers can flag a corrupt world instead of crashing the main process.
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';

export interface LevelDatInfo {
  /** Data.LevelName (world folder name Minecraft recorded); null when absent. */
  name: string | null;
  /** Data.RandomSeed as a decimal string (NBT longs are signed 64-bit); null when absent. */
  seed: string | null;
  /** Data.Version.Name (NBT data version, e.g. "19133"); null when absent. */
  version: string | null;
}

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;
const MAX_DEPTH = 512;
/** Guard against absurd list lengths before allocating; bounded by remaining bytes anyway. */
const MAX_COLLECTION_ITEMS = 10_000_000;

type Compound = Map<string, { type: number; value: unknown }>;

class NbtReader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  private need(count: number): void {
    if (count < 0 || this.offset + count > this.buffer.length) throw new RangeError('truncated NBT payload');
  }

  u8(): number { this.need(1); const value = this.buffer.readUInt8(this.offset); this.offset += 1; return value; }
  i8(): number { this.need(1); const value = this.buffer.readInt8(this.offset); this.offset += 1; return value; }
  i16(): number { this.need(2); const value = this.buffer.readInt16BE(this.offset); this.offset += 2; return value; }
  i32(): number { this.need(4); const value = this.buffer.readInt32BE(this.offset); this.offset += 4; return value; }
  i64(): bigint { this.need(8); const value = this.buffer.readBigInt64BE(this.offset); this.offset += 8; return value; }
  f32(): number { this.need(4); const value = this.buffer.readFloatBE(this.offset); this.offset += 4; return value; }
  f64(): number { this.need(8); const value = this.buffer.readDoubleBE(this.offset); this.offset += 8; return value; }
  bytes(length: number): Buffer { this.need(length); const value = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return value; }
  string(): string {
    this.need(2);
    const size = this.buffer.readUInt16BE(this.offset); this.offset += 2;
    this.need(size);
    const value = this.buffer.toString('utf8', this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
}

function readPayload(reader: NbtReader, type: number, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('NBT nesting too deep');
  switch (type) {
    case TAG_BYTE: return reader.i8();
    case TAG_SHORT: return reader.i16();
    case TAG_INT: return reader.i32();
    case TAG_LONG: return reader.i64();
    case TAG_FLOAT: return reader.f32();
    case TAG_DOUBLE: return reader.f64();
    case TAG_BYTE_ARRAY: {
      const length = reader.i32();
      if (length < 0 || length > MAX_COLLECTION_ITEMS) throw new Error('invalid NBT byte array length');
      return reader.bytes(length);
    }
    case TAG_STRING: return reader.string();
    case TAG_LIST: {
      const elementType = reader.u8();
      const length = reader.i32();
      if (length < 0 || length > MAX_COLLECTION_ITEMS) throw new Error('invalid NBT list length');
      const values: unknown[] = [];
      for (let index = 0; index < length; index += 1) values.push(readPayload(reader, elementType, depth + 1));
      return values;
    }
    case TAG_COMPOUND: {
      const values: Compound = new Map();
      for (;;) {
        const childType = reader.u8();
        if (childType === TAG_END) break;
        const name = reader.string();
        values.set(name, { type: childType, value: readPayload(reader, childType, depth + 1) });
      }
      return values;
    }
    case TAG_INT_ARRAY: {
      const length = reader.i32();
      if (length < 0 || length > MAX_COLLECTION_ITEMS) throw new Error('invalid NBT int array length');
      const values: number[] = [];
      for (let index = 0; index < length; index += 1) values.push(reader.i32());
      return values;
    }
    case TAG_LONG_ARRAY: {
      const length = reader.i32();
      if (length < 0 || length > MAX_COLLECTION_ITEMS) throw new Error('invalid NBT long array length');
      const values: bigint[] = [];
      for (let index = 0; index < length; index += 1) values.push(reader.i64());
      return values;
    }
    default: throw new Error(`unknown NBT tag type ${type}`);
  }
}

function asCompound(value: unknown): Compound | null {
  return value instanceof Map ? (value as Compound) : null;
}

function compoundChild(compound: Compound | null, name: string): { type: number; value: unknown } | null {
  return compound?.get(name) ?? null;
}

function stringChild(compound: Compound | null, name: string): string | null {
  const child = compoundChild(compound, name);
  return child !== null && child.type === TAG_STRING && typeof child.value === 'string' ? child.value : null;
}

function decodeSeed(child: { type: number; value: unknown } | null): string | null {
  if (child === null) return null;
  if (child.type === TAG_LONG && typeof child.value === 'bigint') return child.value.toString();
  if (child.type === TAG_INT && typeof child.value === 'number') return String(child.value);
  if (child.type === TAG_SHORT && typeof child.value === 'number') return String(child.value);
  return null;
}

/** Parse raw (already gunzipped) NBT bytes; returns null for any malformed or non-level shape. */
export function parseLevelDat(buffer: Buffer): LevelDatInfo | null {
  try {
    if (buffer.length < 3) return null;
    const reader = new NbtReader(buffer);
    const rootType = reader.u8();
    if (rootType !== TAG_COMPOUND) return null;
    reader.string(); // root compound name (normally ""), read for structure validation
    const root = asCompound(readPayload(reader, TAG_COMPOUND, 0));
    if (root === null) return null;
    const data = asCompound(compoundChild(root, 'Data')?.value ?? null);
    if (data === null) return null;
    const versionCompound = asCompound(compoundChild(data, 'Version')?.value ?? null);
    return {
      name: stringChild(data, 'LevelName'),
      seed: decodeSeed(compoundChild(data, 'RandomSeed')),
      version: stringChild(versionCompound, 'Name'),
    };
  } catch {
    return null;
  }
}

/** Read and gunzip a level.dat file; returns null for a missing/corrupt/non-gzip file. */
export function readLevelDat(file: string): LevelDatInfo | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  // Gzip magic; a plain-text or truncated file is corrupt by definition here.
  if (raw.length < 18 || raw[0] !== 0x1f || raw[1] !== 0x8b) return null;
  try {
    return parseLevelDat(gunzipSync(raw));
  } catch {
    return null;
  }
}
