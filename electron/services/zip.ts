// Classic ZIP writer for backups/world exports (deflated, temp+rename, 4 GiB ceiling).
// Reading stays with yauzl (`extractZip` in installer/core); this only adds the missing writer.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';
import { appError } from './store';

export interface ZipInput {
  name: string;
  path: string;
}

const ZIP_LIMIT_BYTES = 4 * 1024 ** 3;
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
    let stats: fs.Stats;
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

/** Writes a deflated ZIP and answers its byte size. Peak memory is one file, not the archive. */
export async function writeZip(dest: string, inputs: ZipInput[], opts: { limit?: number } = {}): Promise<number> {
  const limit = opts.limit ?? ZIP_LIMIT_BYTES;
  if (inputs.length > 0xffff) throw appError('backup-failed', `too many entries for a classic ZIP: ${inputs.length}`);

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const temp = `${dest}.tmp`;
  const handle = await fsp.open(temp, 'w');
  try {
    const central: Buffer[] = [];
    let offset = 0;
    let total = 0;

    for (const input of inputs) {
      const body = await fsp.readFile(input.path);
      total += body.length;
      if (body.length > limit || total > limit) throw appError('backup-failed', `archive exceeds ${limit} bytes`);
      const checksum = crc32(body) >>> 0;
      const compressed = await deflate(body);
      const name = Buffer.from(input.name, 'utf8');

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(8, 8);
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
      record.writeUInt32LE(checksum, 16);
      record.writeUInt32LE(compressed.length, 20);
      record.writeUInt32LE(body.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);

      offset += local.length + name.length + compressed.length;
      if (offset > 0xffffffff) throw appError('backup-failed', 'archive exceeds the classic ZIP offset range');
    }

    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(inputs.length, 8);
    end.writeUInt16LE(inputs.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await handle.write(directory);
    await handle.write(end);
    await handle.close();
    await fsp.rename(temp, dest);
    return offset + directory.length + end.length;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.rm(temp, { force: true });
    throw error;
  }
}
