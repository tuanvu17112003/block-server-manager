// Repair mojibake by the standard inverse transform, applied only where it provably round-trips.
//
// The bug: PowerShell `Set-Content -Encoding utf8` read these files with the wrong codepage and re-encoded them, so
// every non-ASCII character became a run of mangled characters. Some files went through this twice.
//
// The inverse: the mangled text, interpreted as single bytes in CP1252 (or Latin-1), IS the original UTF-8 byte
// sequence. Decoding those bytes as UTF-8 recovers the original text.
//
// Acceptance rule for every line: the repaired line must (a) contain no U+FFFD, (b) re-encode to exactly the
// bytes we started from, and (c) be strictly shorter. Anything else is left untouched and reported. This means a
// line with a real code change can never be silently altered.
//
// Run: node scripts/repair-mojibake.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.git', '.archify', 'artifacts']);
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.md']);

// CP1252 0x80-0x9F -> code point, so we can map back to raw bytes.
const CP1252_HIGH = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C],
  [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B],
  [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F],
]);

/** Interpret a JS string as CP1252 bytes. Returns null if any char is not representable. */
function asCp1252Bytes(text) {
  const bytes = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const mapped = CP1252_HIGH.get(cp);
    if (mapped !== undefined) { bytes.push(mapped); continue; }
    if (cp <= 0xFF) { bytes.push(cp); continue; }
    return null;
  }
  return Buffer.from(bytes);
}

/**
 * Try to undo one layer of mangling on a single line.
 * Returns the repaired line, or null when the line cannot be repaired safely.
 */
function repairLine(line) {
  // Only ASCII-representable-in-CP1252 characters can be mangled; a line already pure ASCII is fine.
  if (!/[\u0080-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u20AC\u2122\u02C6\u02DC\u0160\u0161\u0152\u0153\u017D\u017E\u0178\u0192\u2030\u2039\u203A\u2020\u2021\u2022]/.test(line)) {
    return null;
  }
  const bytes = asCp1252Bytes(line);
  if (!bytes) return null;
  const decoded = bytes.toString('utf8');
  if (decoded.includes('\uFFFD')) return null;                       // not a valid UTF-8 byte sequence
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) return null;      // must round-trip exactly
  if (Buffer.byteLength(decoded, 'utf8') >= Buffer.byteLength(line, 'utf8')) return null; // must shrink
  if (decoded === line) return null;
  return decoded;
}

/** Repair a whole file, up to MAX_LAYERS times. Returns null when nothing changed. */
const MAX_LAYERS = 4;
function repairText(text) {
  const lines = text.split('\n');
  let anyChange = false;
  const repaired = lines.map((line) => {
    let current = line;
    let changed = false;
    for (let i = 0; i < MAX_LAYERS; i += 1) {
      const next = repairLine(current);
      if (next === null) break;
      current = next;
      changed = true;
    }
    if (changed) anyChange = true;
    return current;
  });
  return anyChange ? repaired.join('\n') : null;
}

const SUSPECT = /\u00c3|\u00e2\u20ac/;

const files = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!EXT.has(path.extname(entry.name))) continue;
    if (/repair-mojibake|fix-encoding|check-encoding/.test(entry.name)) continue;
    files.push(full);
  }
}
for (const root of ['electron', 'src', 'scripts', 'shared', 'docs']) walk(path.join(process.cwd(), root));

const write = process.argv.includes('--write');
let fixed = 0;
let partial = 0;
let clean = 0;

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!SUSPECT.test(text)) { clean += 1; continue; }
  const repaired = repairText(text);
  const rel = path.relative(process.cwd(), file);
  if (repaired === null) {
    console.log(`UNREPAIRED  ${rel} — no line could be repaired safely`);
    partial += 1;
    continue;
  }
  const residue = SUSPECT.test(repaired);
  if (residue) {
    console.log(`PARTIAL     ${rel} — some lines still contain mangled text`);
    partial += 1;
  } else {
    fixed += 1;
    console.log(`${write ? 'FIXED' : 'WOULD FIX'}       ${rel}`);
  }
  if (write) fs.writeFileSync(file, repaired, 'utf8');
}

console.log(`\n${write ? 'done' : 'dry run (pass --write)'}: fixed=${fixed} partial=${partial} already-clean=${clean}`);
