// QA instrument: find mojibake (double-encoded UTF-8) in source and docs.
// The session's PowerShell Set-Content round-trips re-encoded UTF-8 as CP1252 in several files, turning
// em-dashes and arrows into sequences like "Ã¢â‚¬â€". This script measures the damage so the fix is scoped by
// evidence rather than guessed.
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['electron', 'src', 'scripts', 'shared', 'docs'];
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.md']);
// Sequences that only appear when UTF-8 bytes were decoded as CP1252 and re-encoded as UTF-8.
const MARKERS = ['ÃƒÂ', 'Ã¢â€šÂ¬', 'Ã¢â‚¬', 'Ã¢â€', 'ÃƒÂ¢', 'Â§', 'Ã‚Â§'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.git', '.archify', 'artifacts']);

const hits = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!EXT.has(path.extname(entry.name))) continue;
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const found = MARKERS.filter(marker => text.includes(marker));
    if (found.length === 0) continue;
    const lines = text.split(/\r?\n/);
    const lineHits = [];
    lines.forEach((line, index) => {
      if (MARKERS.some(marker => line.includes(marker))) lineHits.push(index + 1);
    });
    hits.push({ file: full, markers: found, lineCount: lineHits.length, firstLines: lineHits.slice(0, 5) });
  }
}

for (const root of ROOTS) walk(path.join(process.cwd(), root));

hits.sort((a, b) => b.lineCount - a.lineCount);
console.log(`mojibake report — ${hits.length} file(s) affected\n`);
let total = 0;
for (const hit of hits) {
  total += hit.lineCount;
  console.log(`${hit.lineCount.toString().padStart(4)} line(s)  ${path.relative(process.cwd(), hit.file)}`);
  console.log(`          first at ${hit.firstLines.join(', ')}  markers: ${hit.markers.join(' ')}`);
}
console.log(`\ntotal corrupted lines: ${total}`);
console.log(hits.length === 0
  ? 'CLEAN — no double-encoded UTF-8 found'
  : 'FIX NEEDED — restore these files from git history before the corruption and re-apply edits with the edit tool, not Set-Content');
