// Shared ZIP writer for verification harnesses.
//
// Both the packwiz audit and the packwiz live harness need to materialise fetched metadata into a real archive.
// This is a *transport* concern (build a valid zip), not a format assumption: the bytes being zipped come from
// the internet, so the archive is real evidence even though the container is produced here.
import fs from 'node:fs';

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Write a stored (uncompressed) zip from [name, textOrBuffer] pairs. */
export function writeRealZip(zipPath, entries) {
  const chunks = [];
  const central = [];
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
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, data);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(0, 10);
    centralEntry.writeUInt16LE(0, 12);
    centralEntry.writeUInt16LE(0, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(data.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(nameBuffer.length, 28);
    // Byte 42 is the LOCAL HEADER OFFSET. It must point at this entry's own local header — writing 0 here made
    // every entry resolve to the first local header, so readZipEntry('index.toml') returned pack.toml's bytes.
    // (Harness defect, not a product defect; found because the audit compared fetched bytes to parsed bytes.)
    centralEntry.writeUInt32LE(startOffset, 42);
    central.push(Buffer.concat([centralEntry, nameBuffer]));

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
