// Classic ZIP writer for backups/world exports (deflated, temp+rename, fsynced, 4 GiB ceiling).
// Reading stays with yauzl (`extractZip` in installer/core); this only adds the missing writer.
// Hardening: metadata preflight (count/name-length/total size) runs before any file is read;
// entries carry DOS timestamps from the source mtime; the temp file is fsynced before rename.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';
import { appError } from './store';
import { checkZipBudget, dosDateTime, ZIP_LIMIT_BYTES } from './backups-core';

export interface ZipInput {
  name: string;
  path: string;
}

const deflate = promisify(deflateRaw);

async function walk(root: string, dir: string, out: Map<string, ZipInput>): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = path.relative(root, full).split(path.sep).join('/');
    out.set(name, { name, path: full });
  }
}

/** Regular files under each existing name, deduplicated by archive entry name. */
export async function collectInputs(root: string, names: string[]): Promise<ZipInput[]> {
  const out = new Map<string, ZipInput>();
  for (const name of names) {
    const full = path.join(root, name);
    let stats: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stats = await fsp.stat(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stats.isDirectory()) {
      await walk(root, full, out);
      continue;
    }
    if (!stats.isFile()) continue;
    const entry = path.relative(root, full).split(path.sep).join('/');
    out.set(entry, { name: entry, path: full });
  }
  return [...out.values()];
}

interface PreparedEntry {
  input: ZipInput;
  size: number;
  mtimeMs: number;
  nameBytes: Buffer;
}

/** Stat every input and enforce the classic-ZIP budget before reading any file body. */
async function prepareInputs(inputs: readonly ZipInput[], limit: number): Promise<PreparedEntry[]> {
  const prepared: PreparedEntry[] = [];
  for (const input of inputs) {
    const stats = await fsp.stat(input.path);
    if (!stats.isFile()) throw appError('backup-failed', `not a regular file while archiving: ${input.name}`);
    prepared.push({ input, size: stats.size, mtimeMs: stats.mtimeMs, nameBytes: Buffer.from(input.name, 'utf8') });
  }
  checkZipBudget(prepared.map((entry) => ({ name: entry.input.name, size: entry.size })), { limit });
  return prepared;
}

/** Writes a deflated ZIP and answers its byte size. Peak memory is one file, not the archive. */
export async function writeZip(dest: string, inputs: ZipInput[], opts: { limit?: number } = {}): Promise<number> {
  const limit = opts.limit ?? ZIP_LIMIT_BYTES;
  const prepared = await prepareInputs(inputs, limit);

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp`;
  const handle = await fsp.open(temp, 'w');
  try {
    const central: Buffer[] = [];
    let offset = 0;

    for (const entry of prepared) {
      const body = await fsp.readFile(entry.input.path);
      if (body.length !== entry.size) {
        throw appError('backup-failed', `file changed while archiving: ${entry.input.name}`);
      }
      const checksum = crc32(body) >>> 0;
      const compressed = await deflate(body);
      const name = entry.nameBytes;
      const stamp = dosDateTime(entry.mtimeMs);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(body.length, 22);
      local.writeUInt16LE(name.length, 26);
      await handle.write(local);
      await handle.write(name);
      await handle.write(compressed);

      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE((3 << 8) | 20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(stamp.time, 12);
      record.writeUInt16LE(stamp.date, 14);
      record.writeUInt32LE(checksum, 16);
      record.writeUInt32LE(compressed.length, 20);
      record.writeUInt32LE(body.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);

      offset += local.length + name.length + compressed.length;
      if (offset > 0xffffffff) {
        throw appError('backup-failed', 'archive exceeds the classic ZIP offset range (4 GiB); use a smaller backup set');
      }
    }

    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(prepared.length, 8);
    end.writeUInt16LE(prepared.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await handle.write(directory);
    await handle.write(end);
    // Durability: the rename below only becomes crash-safe once the bytes are on disk.
    await handle.sync();
    await handle.close();
    await fsp.rename(temp, dest);
    return offset + directory.length + end.length;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.rm(temp, { force: true });
    throw error;
  }
}
