// Encoding guard: fail if any SOURCE file contains double-encoded UTF-8 (mojibake).
//
// Why this is a gate step and not a manual script (docs/audit/24 DV-40): a session's worth of PowerShell
// `Set-Content -Encoding utf8` round-trips corrupted 65 lines across 16 source files — including user-facing
// error messages and diagnostic log strings — and **no test caught it**, because mojibake inside a string literal
// compiles and passes. A guard that depends on remembering to run it is not a guard (the same reasoning that put
// conformance in the gate, DV-32).
//
// Scope decision — this is the part that makes the check trustworthy:
//
//   SOURCE (must be clean, hard failure):  electron/**, src/**, shared/**, and non-doc scripts/*.mjs
//   DOCS   (allowed to quote corruption):  docs/**, plus the two tools that must CONTAIN the marker strings to
//                                          detect/report them.
//
// A documentation file legitimately needs to show what the corruption looked like — DV-40 in the deviations
// register quotes the exact mangled sequence as evidence. Flagging that would force us to delete the evidence to
// satisfy the tool, which is the wrong direction (DV-29 precedent: fix the ruler, not the prose). So docs are
// excluded from the hard failure, and the marker-containing tooling is excluded by explicit name.
//
// Usage:
//   node scripts/check-encoding.mjs            # scan, exit 1 on any source file hit
//   node scripts/check-encoding.mjs --all      # also report docs (informational, still exit 0 if only docs hit)
import fs from 'node:fs';
import path from 'node:path';

// Sequences that only appear when UTF-8 bytes were decoded as CP1252 and re-encoded as UTF-8, possibly repeated.
// Kept as an array of code-point strings so this file itself stays valid ASCII-safe UTF-8.
const MARKERS = [
  '\u00c3\u0192\u00c2\u00a2',   // triple-encoded lead
  '\u00c3\u00a2\u00e2\u201a\u00ac', // double-encoded lead (Ã¢â‚¬)
  '\u00c3\u00a2\u00e2\u20ac',     // double-encoded lead (Ã¢â€)
  '\u00c3\u201a\u00c2\u00a7',     // Ã‚§
  '\u00c3\u00a2\u2020\u2019',     // â†'
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.git', '.archify', 'artifacts', '.tmp']);
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mjs', '.js']);
const SOURCE_ROOTS = ['electron', 'src', 'shared', 'scripts'];
const DOC_ROOTS = ['docs'];

// Files that must contain the marker strings in order to do their job.
const TOOL_ALLOWLIST = new Set(['check-encoding.mjs', 'repair-mojibake.mjs']);

function collect(roots, exts) {
  const files = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!exts.has(path.extname(entry.name))) continue;
      if (TOOL_ALLOWLIST.has(entry.name)) continue;
      files.push(full);
    }
  }
  for (const root of roots) walk(path.join(process.cwd(), root));
  return files;
}

function scan(files) {
  const hits = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let found = false;
    for (const marker of MARKERS) { if (text.includes(marker)) { found = true; break; } }
    if (!found) continue;
    const lines = [];
    text.split('\n').forEach((line, index) => {
      if (MARKERS.some(marker => line.includes(marker))) lines.push(index + 1);
    });
    hits.push({ file: path.relative(process.cwd(), file), lineCount: lines.length, first: lines.slice(0, 5) });
  }
  return hits;
}

const showDocs = process.argv.includes('--all');
const sourceHits = scan(collect(SOURCE_ROOTS, SOURCE_EXT));
const docHits = showDocs ? scan(collect(DOC_ROOTS, new Set(['.md', '.json']))) : [];

console.log('encoding guard — double-encoded UTF-8 in source');
console.log(`  scanned roots: ${SOURCE_ROOTS.join(', ')} (${SOURCE_EXT.size} extensions)`);

if (sourceHits.length === 0) {
  console.log('  PASS: no source file contains mojibake');
} else {
  console.log(`  FAIL: ${sourceHits.length} source file(s) corrupted`);
  for (const hit of sourceHits) {
    console.log(`    ${hit.file} — ${hit.lineCount} line(s), first at ${hit.first.join(', ')}`);
  }
  console.log('  fix: node scripts/repair-mojibake.mjs --write');
}

if (showDocs) {
  console.log(`\n  docs (informational — quoting corruption as evidence is legitimate): ${docHits.length} file(s)`);
  for (const hit of docHits) console.log(`    ${hit.file} — ${hit.lineCount} line(s)`);
}

if (sourceHits.length > 0) process.exitCode = 1;
