#!/usr/bin/env node
// Executable spec-conformance check — plan step C0 of docs/audit/23-synthesis-correct-design.md §5.
//
// MEASURE ONLY. This script reads sources and reports; it never writes product code, never edits a
// file, and never modifies the tree. Its job is to answer "did the implementation follow the
// specification?" mechanically instead of from memory (doc 23 §4.4), because the research doc sat
// unread while the adapter layer was written and that produced RD-1..RD-7.
//
// Specification inputs (design authority order, docs/audit/24-deviations-register.md):
//   1. docs/research/2026-10-29-universal-modpack-install.md   §2 format table, §6 step 2, §7 gap table
//   2. docs/audit/23-synthesis-correct-design.md               plan C0..C8
//
// Exit code 1 while anything is open, 0 only when every check is closed.
//
// WHAT IS *NOT* MECHANICAL HERE (stated rather than approximated):
//  - The mapping research-format → adapter id (COVERAGE below) is a hand-authored judgement table.
//    The adapter list itself is parsed from source, but "does `plain.serverzip` really implement the
//    CF author server pack format?" is NOT decidable by this script; coverage means only "an adapter
//    is registered for that row". It is not evidence of a working install (invariant I3).
//  - A negative grep proves the cited identifier is absent; it cannot prove no equivalent mechanism
//    exists under another name. gap4 is therefore reported as "grep-negative", not as "proven absent".
//  - gap3 checks that the cited predicate is gone, not that a correct platform-dependency rule exists.
//  - gap9 checks that the sidecar's payload records hash/size keys; whether a diff can actually be
//    computed from it is a design property this script cannot evaluate.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const RESEARCH = 'docs/research/2026-10-29-universal-modpack-install.md';
const ADAPTER_INDEX = 'electron/services/adapters/index.ts';
const ADAPTER_DIR = 'electron/services/adapters';
const WAIVERS_FILE = 'scripts/conformance-waivers.json';
const INSTALLER_DIR = 'electron/services/installer';
const CORE = 'electron/services/installer/core.ts';
const CURATED = 'electron/services/installer/curated.ts';
const RECIPE = 'electron/services/installer/recipe.ts';
const TYPES = 'electron/services/adapters/types.ts';
const PIPELINE = 'electron/services/pipeline.ts';

/** The §2 format-catalogue section only (other sections also contain numbered tables). */
function formatSection() {
  const lines = read(RESEARCH).split('\n');
  const start = lines.findIndex((l) => /^##\s+2\.\s/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\d+\.\s/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/**
 * research §2 priority → the adapter ids that would implement that row.
 *
 * `candidates` are drawn from the declared `PackFormatId` union in electron/services/adapters/types.ts.
 * Coverage is decided by whether a REGISTERED adapter's id appears in a row's candidate list — so if
 * someone registers `modrinthAdapter` tomorrow, this script sees the row as covered without any edit
 * here, and reports the now-stale waiver instead of silently accepting it.
 *
 * Hand-authored part (declared, not hidden): which row a given format id belongs to.
 */
const COVERAGE = new Map([
  [1, { candidates: ['mcbbs'], label: 'MCBBS' }],
  [2, { candidates: ['curseforge.client'], label: 'CurseForge client' }],
  [3, { candidates: ['modrinth.mrpack'], label: 'Modrinth .mrpack' }],
  [4, { candidates: ['hmcl.server'], label: 'HMCL server' }],
  [5, { candidates: ['atlauncher'], label: 'ATLauncher' }],
  [6, { candidates: ['prism.multimc'], label: 'Prism/MultiMC' }],
  [7, { candidates: ['packwiz'], label: 'packwiz' }],
  [8, { candidates: ['ftb.app'], label: 'FTB App' }],
  [9, { candidates: ['gdlauncher'], label: 'GDLauncher' }],
  [10, { candidates: ['technic'], label: 'Technic' }],
  [11, { candidates: ['curseforge.serverpack', 'plain.serverzip'], label: 'CF author server pack' }],
  [12, { candidates: ['serverpackcreator'], label: 'SPC output' }],
  [13, { candidates: ['plain.serverzip'], label: 'Bare zip' }],
]);

// ---------------------------------------------------------------- io helpers
const abs = (p) => path.join(ROOT, p);
const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');
const read = (p) => fs.readFileSync(abs(p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(abs(p));
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
const stripBom = (s) => s.replace(/^\uFEFF/, '');

/** Match a balanced bracket starting at `open` (index of `{`/`(`). Returns index of the closer. */
function matchBracket(text, open) {
  const opener = text[open];
  const closer = opener === '{' ? '}' : ')';
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl === -1 ? text.length : nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 1; continue; }
    if (c === opener) depth += 1;
    else if (c === closer) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** The text of an object literal / call argument list beginning at the first bracket after `from`. */
function bracketBodyAfter(text, from) {
  const open = text.indexOf(text[from] === '{' ? '{' : '{', from);
  const paren = text.indexOf('(', from);
  const start = open !== -1 && (paren === -1 || open < paren) ? open : paren;
  if (start === -1) return null;
  const end = matchBracket(text, start);
  if (end === -1) return null;
  return { start, end, body: text.slice(start, end + 1) };
}

// ---------------------------------------------------------------- reporting
const checks = [];
function record(id, title, detail, open = [], extra = {}) {
  checks.push({ id, title, status: open.length === 0 ? 'CLOSED' : 'OPEN', detail, open, ...extra });
}
const h = (t) => `\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`;
const bullet = (s) => `  ${s}`;

function snapshot() {
  let head = '(git unavailable)';
  try {
    head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { /* not a git checkout: measurement still stands */ }
  return { at: new Date().toISOString(), head };
}

// ---------------------------------------------------------------- check 1
function checkFormatCoverage() {
  const doc = read(RESEARCH);
  const docLines = doc.split('\n');
  const section = formatSection();
  const formats = [];
  if (section) {
    for (let i = section.start + 1; i < section.end; i += 1) {
      const m = docLines[i].match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/);
      if (m) formats.push({ priority: Number(m[1]), name: m[2].replaceAll('`', '').replace(/\*\*/g, '').trim(), line: i + 1 });
    }
  }

  const idxText = read(ADAPTER_INDEX);
  const idxLines = idxText.split('\n');
  const arrStart = idxText.indexOf('export const ADAPTERS');
  const arrEnd = idxText.indexOf('];', arrStart);
  const block = arrText(idxText, arrStart, arrEnd);
  const registered = [];
  for (const { line, name, comment } of block) {
    const file = findAdapterFile(name);
    const text = file ? read(file) : null;
    const decl = text ? text.indexOf(`export const ${name}`) : -1;
    const id = decl === -1 ? null : (text.slice(decl).match(/id:\s*'([^']+)'/) ?? [])[1] ?? null;
    const priority = decl === -1 ? null : Number((text.slice(decl).match(/priority:\s*(\d+)/) ?? [])[1] ?? NaN);
    registered.push({ name, id, priority, file, line, comment });
  }

  const waivers = readWaivers();
  const byPriority = new Map(waivers.items.filter((w) => Number.isInteger(w.priority)).map((w) => [w.priority, w]));
  const byName = new Map(waivers.items.filter((w) => !Number.isInteger(w.priority)).map((w) => [w.format.toLowerCase(), w]));

  const open = [];
  const covered = [];
  const uncovered = [];
  const usedWaivers = new Set();

  console.log(h('CHECK 1 — format coverage: research §2 table ↔ adapters registered in index.ts'));
  console.log(bullet(`research formats parsed from ${RESEARCH} §2`));
  for (const f of formats) console.log(bullet(`  [${String(f.priority).padStart(2)}] ${f.name}  (${RESEARCH}:${f.line})`));
  console.log(bullet(`  → ${formats.length} formats`));
  console.log(bullet(`registered adapters parsed from ${ADAPTER_INDEX}: ADAPTERS array`));
  for (const a of registered) {
    console.log(bullet(`  ${a.id ?? '(no id found)'}  priority=${a.priority}  ${a.file ?? '(source not found)'}  (${ADAPTER_INDEX}:${a.line})`));
  }
  console.log(bullet(`  → ${registered.length} adapters`));

  const registeredIds = new Set(registered.map((a) => a.id).filter(Boolean));

  for (const f of formats) {
    const map = COVERAGE.get(f.priority);
    const waiver = byPriority.get(f.priority) ?? byName.get(f.name.toLowerCase());
    if (waiver) usedWaivers.add(waiver);
    if (!map) {
      open.push({ ref: `${RESEARCH}:${f.line}`, msg: `§2 priority ${f.priority} "${f.name}" is not in the script's COVERAGE map — the research table changed; update the mapping.` });
      continue;
    }
    // An adapter already registered for this row wins over the hand-authored expectation.
    const registeredHit = map.candidates.find((id) => registeredIds.has(id)) ?? null;
    if (registeredHit) {
      covered.push(`${f.name} → ${registeredHit}`);
      if (waiver) {
        // A format that now has an adapter must not stay deferred: that is how a waiver goes silently stale.
        open.push({ ref: `${WAIVERS_FILE}:${waiver.line}`, msg: `stale waiver: "${waiver.format}" is now covered by adapter "${registeredHit}", so it must be removed from the waiver list.` });
      }
    } else {
      uncovered.push(f.name);
      if (!waiver) {
        open.push({ ref: `${RESEARCH}:${f.line}`, msg: `format "${f.name}" (priority ${f.priority}) has no adapter and no entry in ${WAIVERS_FILE}.` });
      } else if (!waiver.reason || waiver.reason.trim() === '') {
        open.push({ ref: `${WAIVERS_FILE}:${waiver.line}`, msg: `waiver for "${waiver.format}" has no reason — a silent deferral.` });
      }
    }
  }

  for (const w of waivers.items) {
    if (!usedWaivers.has(w)) {
      open.push({ ref: `${WAIVERS_FILE}:${w.line}`, msg: `waiver names "${w.format}" (priority ${w.priority ?? 'n/a'}), which matches no row of the research §2 table.` });
    }
  }

  console.log(bullet(`covered by a registered adapter (${covered.length}): ${covered.join(', ') || '(none)'}`));
  console.log(bullet(`NOT covered and NOT waived (${uncovered.length}): ${uncovered.join(', ') || '(none)'}`));
  if (!exists(WAIVERS_FILE)) {
    console.log(bullet(`waivers: ${WAIVERS_FILE} does not exist`));
    open.push({ ref: WAIVERS_FILE, msg: 'waiver file is missing, so every deferral is silent.' });
  }
  console.log(bullet(`waivers: ${waivers.items.length} entries read from ${WAIVERS_FILE}`));

  record('C1', 'format coverage (research §2 ↔ registered adapters)', [
    `${formats.length} formats, ${registered.length} adapters, ${covered.length} covered, ${uncovered.length} uncovered, ${waivers.items.length} waived`,
  ], open, { formats, registered, covered, uncovered });
}

function arrText(text, start, end) {
  if (start === -1 || end === -1) return [];
  const out = [];
  const base = lineAt(text, start);
  text.slice(start, end).split('\n').forEach((raw, i) => {
    const m = raw.match(/^\s*([A-Za-z_$][\w$]*),\s*(?:\/\/\s*(.*))?$/);
    if (m) out.push({ name: m[1], comment: (m[2] ?? '').trim(), line: base + i });
  });
  return out;
}

function findAdapterFile(name) {
  for (const file of fs.readdirSync(abs(ADAPTER_DIR)).filter((f) => f.endsWith('.ts'))) {
    const p = `${ADAPTER_DIR}/${file}`;
    if (read(p).includes(`export const ${name}`)) return p;
  }
  return null;
}

function readWaivers() {
  if (!exists(WAIVERS_FILE)) return { items: [], note: null };
  let json;
  try {
    json = JSON.parse(stripBom(read(WAIVERS_FILE)));
  } catch (error) {
    return { items: [], note: `unparseable: ${error.message}` };
  }
  const raw = Array.isArray(json) ? json : json.waivers ?? json.deferrals ?? [];
  const items = raw.map((w) => ({ ...w, line: findWaiverLine(w.format) }));
  return { items, note: json.note ?? null };
}

function findWaiverLine(format) {
  if (!format || !exists(WAIVERS_FILE)) return 0;
  const all = read(WAIVERS_FILE).split('\n');
  const i = all.findIndex((l) => l.includes(`"${format}"`));
  return i === -1 ? 0 : i + 1;
}

// ---------------------------------------------------------------- check 2
function checkNormalization() {
  const files = fs.readdirSync(abs(ADAPTER_DIR)).filter((f) => f.endsWith('.ts'));
  const hits = [];
  for (const file of files) {
    const p = `${ADAPTER_DIR}/${file}`;
    read(p).split('\n').forEach((text, i) => {
      if (/nested|wrap|unwrap/i.test(text)) hits.push({ file: p, line: i + 1, text: text.trim() });
    });
  }

  const normalizerExports = [];
  for (const file of files) {
    const p = `${ADAPTER_DIR}/${file}`;
    const text = read(p);
    for (const m of text.matchAll(/export (?:async )?function ([A-Za-z0-9_$]+)\s*\(/g)) {
      // Archive normalization only. `normalizePath`/`normalizeFtbPath` are path-string helpers and
      // must not count as evidence that §6 step 2 exists.
      const name = m[1];
      const isArchiveNormalizer = /^(normalizeArchive|cleanupNormalized|findWrapperZip|findWrapperPrefix|stripPrefixFromIndex|hasRootFormatMarker)$/.test(name);
      if (isArchiveNormalizer) normalizerExports.push({ file: p, line: lineAt(text, m.index), name });
    }
  }

  console.log(h('CHECK 2 — normalization: research §6 step 2 "unwrap single nested zip; strip a single wrapping directory"'));
  console.log(bullet(`grep -nE 'nested|wrap|unwrap' ${ADAPTER_DIR}/ → ${hits.length} hits`));
  for (const hit of hits.slice(0, 40)) console.log(bullet(`  ${hit.file}:${hit.line}: ${hit.text}`));
  if (hits.length > 40) console.log(bullet(`  … ${hits.length - 40} more`));

  const open = [];
  const hasModule = normalizerExports.length > 0;
  console.log(bullet('2a — does a shared normalizer module exist in the adapter layer?'));
  if (hasModule) {
    console.log(bullet(`  YES — exported normalizer functions:`));
    for (const e of normalizerExports) console.log(bullet(`    ${e.file}:${e.line}: export function ${e.name}()`));
  } else {
    console.log(bullet('  NO — no exported normalizer found in the adapter layer.'));
    open.push({ ref: ADAPTER_DIR, msg: 'no shared normalizer module exists in the adapter layer (research §6 step 2).' });
  }

  // 2b: is it reachable from the detection path, or is it a module nothing calls?
  const callers = [];
  const names = normalizerExports.map((e) => e.name);
  if (names.length > 0) {
    const callRe = new RegExp(`\\b(?:${names.join('|')})\\s*\\(`);
    const importRe = /from\s+['"][^'"]*adapters\/normalize['"]/;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(abs(dir), { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (/(^|\/)(node_modules|dist-electron|\.git)$/.test(entry.name)) continue;
          walk(p);
          continue;
        }
        if (!/\.(ts|mjs)$/.test(entry.name)) continue;
        // The module itself and its own tests are not evidence of production reach.
        if (p === `${ADAPTER_DIR}/normalize.ts`) continue;
        if (p.startsWith('electron/test/')) continue;
        read(p).split('\n').forEach((text, i) => {
          if (callRe.test(text) || importRe.test(text)) callers.push({ file: p, line: i + 1, text: text.trim() });
        });
      }
    };
    walk('electron');
  }

  console.log(bullet('2b — is it reached by the detection path (research places normalization BEFORE detect)?'));
  if (callers.length > 0) {
    console.log(bullet(`  YES — ${callers.length} call site(s) outside the module and its tests:`));
    for (const c of callers.slice(0, 20)) console.log(bullet(`    ${c.file}:${c.line}: ${c.text}`));
  } else {
    console.log(bullet('  NO — no production file imports or calls it; it is reachable only from its own unit test.'));
    console.log(bullet(`  Evidence: ${PIPELINE} builds its detection index with buildArchiveIndex() directly:`));
    read(PIPELINE).split('\n').forEach((text, i) => {
      if (/buildArchiveIndex\(|adapterRegistry\.resolve\(/.test(text)) console.log(bullet(`    ${PIPELINE}:${i + 1}: ${text.trim()}`));
    });
    console.log(bullet('  The only unwrap that actually runs is the CurseForge engine\'s own, on a different path:'));
    const cf = read(`${INSTALLER_DIR}/curseforge.ts`).split('\n');
    cf.forEach((text, i) => {
      if (/findNestedServerPackZip/.test(text) && !/^\s*\*/.test(text)) console.log(bullet(`    ${INSTALLER_DIR}/curseforge.ts:${i + 1}: ${text.trim()}`));
    });
    open.push({ ref: `${PIPELINE}:519`, msg: 'detection index is built with buildArchiveIndex() directly; the normalizer (unwrap/strip) is never invoked, so §6 step 2 is not in the pipeline.' });
  }

  record('C2a', 'normalizer module exists in adapters/', [`${normalizerExports.length} exported normalizer function(s), ${hits.length} keyword hits`], hasModule ? [] : open.filter((o) => o.ref === ADAPTER_DIR));
  record('C2b', 'normalizer is wired before detect', [`${callers.length} production call site(s)`], open.filter((o) => o.ref !== ADAPTER_DIR));
}

// ---------------------------------------------------------------- check 3: gaps
function checkGap3() {
  const text = read(CORE);
  const open = [];
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (/sides\.every\(\s*s\s*=>\s*s\s*===\s*'CLIENT'\s*\)/.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  console.log(h('CHECK 3a — gap3: Forge side rule must not use the all-`side=` CLIENT predicate'));
  console.log(bullet(`${CORE} — research §7 gap 3, RD-4`));
  if (hits.length === 0) {
    console.log(bullet('CLOSED — pattern `sides.every(s => s === \'CLIENT\')` is absent.'));
  } else {
    for (const hh of hits) console.log(bullet(`  ${CORE}:${hh.line}: ${hh.text}`));
    console.log(bullet('OPEN — the client-only verdict is still derived by "every side= is CLIENT", which research §3.1 shows disagrees with ServerPackCreator (platform-dependency `side`).'));
    open.push({ ref: `${CORE}:${hits[0].line}`, msg: "gap3: Forge client-only predicate is still `sides.every(s => s === 'CLIENT')` (research §7 gap 3)." });
  }
  record('gap3', 'Forge side rule (all-side=CLIENT predicate removed)', [`${hits.length} occurrence(s) in ${CORE}`], open);
}

function checkGap4() {
  const files = fs.existsSync(abs(INSTALLER_DIR)) ? fs.readdirSync(abs(INSTALLER_DIR)).filter((f) => f.endsWith('.ts')) : [];
  const hits = [];
  const re = /provides|rescue/i;
  for (const file of files) {
    const p = `${INSTALLER_DIR}/${file}`;
    read(p).split('\n').forEach((text, i) => {
      if (re.test(text)) hits.push({ file: p, line: i + 1, text: text.trim() });
    });
  }
  const open = [];
  console.log(h('CHECK 3b — gap4: dependency rescue (provides-alias matching) must exist'));
  console.log(bullet(`grep -nE 'provides|rescue' ${INSTALLER_DIR}/ → ${hits.length} hits (${files.length} files scanned)`));
  if (hits.length === 0) {
    console.log(bullet('OPEN — no provides-alias / rescue matching anywhere in the installer.'));
    console.log(bullet('  The acknowledged substitute is hand data, which research §7 gap 4 says does not replace rescue:'));
    read(CURATED).split('\n').forEach((text, i) => {
      if (/unlessPresent/.test(text)) console.log(bullet(`  ${CURATED}:${i + 1}: ${text.trim()}`));
    });
    open.push({ ref: `${INSTALLER_DIR}/`, msg: 'gap4: zero provides/rescue matches in installer/ — excluding a mod can still strand its dependents (research §7 gap 4).' });
  } else {
    for (const hh of hits.slice(0, 20)) console.log(bullet(`  ${hh.file}:${hh.line}: ${hh.text}`));
  }
  record('gap4', 'dependency rescue exists', [`${hits.length} provides/rescue hits in ${files.length} installer files (grep-negative is not proof of absence)`], open);
}

function checkGap5() {
  const text = read(CURATED);
  const start = text.indexOf('const resolve = ');
  const open = [];
  const hits = [];
  let scanned = 0;
  if (start !== -1) {
    const brace = text.indexOf('{', start);
    const end = matchBracket(text, brace);
    if (end !== -1) {
      const body = text.slice(brace, end + 1);
      const base = lineAt(text, brace) - 1;
      body.split('\n').forEach((line, i) => {
        // A comment that *describes* the removed defect is not the defect. Grepping raw lines counted the
        // explanatory comment at curated.ts:85 as a live `includes(` call and kept gap5 falsely OPEN (DV-07).
        // Strip line comments before testing, so the instrument measures code rather than prose — deleting the
        // comment to make the checker green would have been gaming it.
        const code = line.replace(/\/\/.*$/, '');
        if (/\.includes\(/.test(code)) hits.push({ line: base + i + 1, text: code.trim() });
        scanned += 1;
      });
    }
  }
  console.log(h('CHECK 3c — gap5: hand/learned exclusion lookups must not use bare includes('));
  console.log(bullet(`${CURATED} — research §7 gap 5, RD-6 (the figura/configurable over-exclusion class)`));
  console.log(bullet(`scanned the body of makeCuratedResolver's resolve() (${scanned} lines)`));
  if (hits.length === 0) {
    console.log(bullet('CLOSED — no bare includes( in the hand/learned/exclusion lookup path.'));
  } else {
    for (const hh of hits) console.log(bullet(`  ${CURATED}:${hh.line}: ${hh.text}`));
    console.log(bullet('OPEN — hand/learned entries are matched by substring on a normalized path, so `figura` matches `configurable`.'));
    console.log(bullet('  The correctly anchored matcher already exists in the same file and is used only for the itzg lists:'));
    read(CURATED).split('\n').forEach((line, i) => {
      if (/entryTest = /.test(line) || /\(\\\^\|\\\/\)/.test(line)) console.log(bullet(`  ${CURATED}:${i + 1}: ${line.trim().slice(0, 110)}`));
    });
    open.push({ ref: `${CURATED}:${hits[0].line}`, msg: `gap5: ${hits.length} bare includes( in hand/learned matching (${hits.map((x) => x.line).join(', ')}); also no rule id is logged (research §7 gap 5).` });
  }
  record('gap5', 'hand/learned matching is anchored', [`${hits.length} bare includes( in resolve() of ${CURATED}`], open);
}

function checkGap6() {
  const typeText = read(TYPES);
  const typeLines = typeText.split('\n');
  const open = [];
  const decl = typeLines.findIndex((l) => /export type FileSide\s*=/.test(l));
  const hasUnknown = decl !== -1 && /'unknown'/.test(typeLines.slice(decl, decl + 3).join(' '));

  // Collapse test: any line in installer/ that names both values in one predicate.
  const collapse = [];
  for (const file of fs.readdirSync(abs(INSTALLER_DIR)).filter((f) => f.endsWith('.ts'))) {
    const p = `${INSTALLER_DIR}/${file}`;
    read(p).split('\n').forEach((text, i) => {
      const code = text.replace(/\/\/.*$/, '');
      if (/'unknown'/.test(code) && /'unsupported'/.test(code)) collapse.push({ file: p, line: i + 1, text: text.trim() });
    });
  }
  const skipLine = (() => {
    const all = read(RECIPE).split('\n');
    const i = all.findIndex((l) => /if \(file\.side === 'unsupported'\)/.test(l));
    return i === -1 ? null : { line: i + 1, text: all[i].trim() };
  })();

  console.log(h("CHECK 3d — gap6: FileSide must include 'unknown' and must not collapse it to 'unsupported'"));
  if (decl === -1) {
    console.log(bullet(`OPEN — no \`export type FileSide =\` found in ${TYPES}.`));
    open.push({ ref: TYPES, msg: 'gap6: FileSide type declaration not found.' });
  } else {
    console.log(bullet(`  ${TYPES}:${decl + 1}: ${typeLines[decl].trim()}`));
    console.log(bullet(hasUnknown ? "  'unknown' IS a member of the union." : "  'unknown' is NOT a member of the union."));
    if (!hasUnknown) open.push({ ref: `${TYPES}:${decl + 1}`, msg: "gap6: FileSide does not include 'unknown' (research §7 gap 6)." });
  }
  console.log(bullet(`skip predicate in ${RECIPE}:${skipLine ? skipLine.line : '?'}: ${skipLine ? skipLine.text : 'not found'}`));
  console.log(bullet(`lines naming both 'unknown' and 'unsupported' in ${INSTALLER_DIR}/: ${collapse.length}`));
  for (const c of collapse) console.log(bullet(`  ${c.file}:${c.line}: ${c.text}`));
  if (collapse.length > 0) {
    open.push({ ref: `${collapse[0].file}:${collapse[0].line}`, msg: "gap6: 'unknown' is collapsed into 'unsupported'." });
  } else if (skipLine) {
    const unknownInstalls = read(RECIPE).split('\n').some((l) => /`required` and `unknown` both install/.test(l));
    console.log(bullet(unknownInstalls ? "  'unknown' installs (recipe.ts planRecipeFiles skips only 'unsupported')." : "  no explicit statement that 'unknown' installs."));
    if (!unknownInstalls) open.push({ ref: RECIPE, msg: "gap6: could not confirm 'unknown' is installed rather than skipped." });
  }
  record('gap6', "FileSide includes 'unknown' and it is not collapsed", [`unknown in union: ${hasUnknown}`, `collapse sites: ${collapse.length}`], open);
}

function checkGap7() {
  const text = read(PIPELINE);
  const open = [];
  const sites = [];
  let from = 0;
  while (true) {
    const i = text.indexOf('makeCuratedResolver(', from);
    if (i === -1) break;
    const paren = text.indexOf('(', i);
    const end = matchBracket(text, paren);
    const body = end === -1 ? '' : text.slice(paren, end + 1);
    sites.push({ line: lineAt(text, i), learned: /learnedFile/.test(body) });
    from = i + 1;
  }
  console.log(h('CHECK 3e — gap7: pipeline.ts must pass a learnedFile into the curated resolver'));
  console.log(bullet(`${PIPELINE} — research §7 gap 7 ("resolver calls omit learnedFile"), RD-6b`));
  console.log(bullet(`makeCuratedResolver call sites: ${sites.length}`));
  for (const s of sites) console.log(bullet(`  ${PIPELINE}:${s.line}: learnedFile ${s.learned ? 'PRESENT' : 'absent'}`));
  if (sites.length === 0) {
    console.log(bullet('INCONCLUSIVE — no makeCuratedResolver call site found; the resolver may have been renamed.'));
    open.push({ ref: PIPELINE, msg: 'gap7: no makeCuratedResolver call site found; check could not evaluate.' });
  } else if (sites.some((s) => s.learned)) {
    console.log(bullet('CLOSED — at least one resolver receives a learnedFile.'));
  } else {
    console.log(bullet('OPEN — every call site omits learnedFile, so learning still improves only server start, not downloads.'));
    open.push({ ref: `${PIPELINE}:${sites[0].line}`, msg: `gap7: ${sites.length}/${sites.length} makeCuratedResolver calls omit learnedFile (research §7 gap 7).` });
  }
  record('gap7', 'learnedFile is passed at install', [`${sites.filter((s) => s.learned).length}/${sites.length} call sites pass learnedFile`], open);
}

function checkGap9() {
  const text = read(PIPELINE);
  const open = [];
  const literals = [];
  let from = 0;
  while (true) {
    const i = text.indexOf('sidecarData = {', from);
    if (i === -1) break;
    const brace = text.indexOf('{', i);
    const end = matchBracket(text, brace);
    const body = end === -1 ? '' : text.slice(brace, end + 1);
    literals.push({
      line: lineAt(text, i),
      recordsHashes: /sha1|sha512|hash/i.test(body),
      recordsSizes: /size|bytes/i.test(body),
      perFile: /files:\s*\[?\s*\]/.test(body) && body.includes('files: []'),
    });
    from = i + 1;
  }
  const writer = text.split('\n').findIndex((l) => /private writeSidecar\(/.test(l));
  const recipeHashes = (() => {
    const all = read(TYPES).split('\n');
    const out = [];
    all.forEach((l, i) => { if (/^\s*(sha1|sha512|size)\?:/.test(l)) out.push({ line: i + 1, text: l.trim() }); });
    return out;
  })();

  console.log(h('CHECK 3f — gap9: install sidecar must record per-file hashes/sizes (diffable manifest)'));
  console.log(bullet(`${PIPELINE} — research §6 step 9 ("a sidecar able to *diff* next time (hashes, provider IDs, file list)"), §7 gap 9`));
  console.log(bullet(`sidecar writer: ${writer === -1 ? 'not found' : `${PIPELINE}:${writer + 1}`}`));
  console.log(bullet(`sidecarData object literals found: ${literals.length}`));
  for (const l of literals) {
    console.log(bullet(`  ${PIPELINE}:${l.line}: hashes=${l.recordsHashes ? 'yes' : 'no'} sizes=${l.recordsSizes ? 'yes' : 'no'}${l.perFile ? ' files=[] (empty list!)' : ''}`));
  }
  console.log(bullet('the data exists upstream — PlannedFile already carries it:'));
  for (const r of recipeHashes) console.log(bullet(`  ${TYPES}:${r.line}: ${r.text}`));
  const ok = literals.length > 0 && literals.every((l) => l.recordsHashes && l.recordsSizes);
  if (literals.length === 0) {
    console.log(bullet('INCONCLUSIVE — no `sidecarData = {` literal found; the sidecar shape may have changed.'));
    open.push({ ref: PIPELINE, msg: 'gap9: no sidecarData literal found; check could not evaluate.' });
  } else if (ok) {
    console.log(bullet('CLOSED — every sidecar payload records hashes and sizes.'));
  } else {
    console.log(bullet(`OPEN — ${literals.filter((l) => !(l.recordsHashes && l.recordsSizes)).length}/${literals.length} sidecar payloads record paths only (no hashes, no sizes), so a reinstall cannot diff.`));
    open.push({ ref: `${PIPELINE}:${literals[0].line}`, msg: `gap9: ${literals.length} sidecar payloads record file paths only; none records per-file hashes or sizes (research §6 step 9 / §7 gap 9).` });
  }
  record('gap9', 'install sidecar records per-file hashes/sizes', [`${literals.length} sidecar literals, ${literals.filter((l) => l.recordsHashes || l.recordsSizes).length} with hash/size`], open);
}

// ---------------------------------------------------------------- waivers
function printWaivers() {
  const waivers = readWaivers();
  console.log(h('WAIVERS — explicit deferrals recorded in scripts/conformance-waivers.json'));
  if (!exists(WAIVERS_FILE)) {
    console.log(bullet('FILE MISSING — no deferral is recorded, so every gap above is silent.'));
    return;
  }
  if (waivers.note) console.log(bullet(`note: ${waivers.note}`));
  if (waivers.items.length === 0) { console.log(bullet('(no waivers)')); return; }
  const rows = waivers.items.map((w) => ({
    priority: w.priority ?? '',
    format: w.format ?? '',
    status: w.reason && w.reason.trim() ? 'waived' : 'NO REASON',
    reason: (w.reason ?? '').trim(),
    line: w.line,
  }));
  const widths = {
    p: Math.max(8, ...rows.map((r) => String(r.priority).length)),
    f: Math.max(6, ...rows.map((r) => r.format.length)),
  };
  console.log(bullet(`${'PRIORITY'.padEnd(widths.p)}  ${'FORMAT'.padEnd(widths.f)}  REASON`));
  for (const r of rows) {
    console.log(bullet(`${String(r.priority).padEnd(widths.p)}  ${r.format.padEnd(widths.f)}  ${r.reason}${r.status === 'NO REASON' ? '  <-- NO REASON' : ''}`));
    console.log(bullet(`${' '.repeat(widths.p + widths.f + 4)}(${WAIVERS_FILE}:${r.line})`));
  }
  console.log(bullet(`→ ${rows.length} deferred format(s); ${rows.filter((r) => r.status === 'NO REASON').length} without a reason`));
}

// ---------------------------------------------------------------- main
const snap = snapshot();
console.log('conformance-spec.mjs — MEASURE ONLY (reads sources, writes nothing)');
console.log(`measured at ${snap.at}   HEAD ${snap.head}`);

checkFormatCoverage();
checkNormalization();
checkGap3();
checkGap4();
checkGap5();
checkGap6();
checkGap7();
checkGap9();
printWaivers();

const openCount = checks.filter((c) => c.status === 'OPEN').length;
const closedCount = checks.length - openCount;
console.log(h('SUMMARY'));
for (const c of checks) console.log(bullet(`[${c.status.padEnd(6)}] ${c.id.padEnd(5)} ${c.title}`));
console.log(bullet(`checks: ${checks.length}   CLOSED: ${closedCount}   OPEN: ${openCount}`));

// C1 can close through waivers alone. Say so plainly, or "CLOSED" reads as "implemented".
const cov = checks.find((c) => c.id === 'C1');
if (cov && cov.status === 'CLOSED') {
  console.log(bullet(`note: C1 is CLOSED only because every uncovered format is waived — ${cov.covered.length} of ${cov.formats.length} formats have an adapter, ${cov.uncovered.length} are deferred, not implemented.`));
}

const allOpen = checks.flatMap((c) => c.open.map((o) => ({ id: c.id, ...o })));
if (allOpen.length > 0) {
  console.log('\nOPEN ITEMS (file:line):');
  for (const o of allOpen) console.log(`  [${o.id}] ${o.ref} — ${o.msg}`);
}
console.log(`\nverdict: ${openCount === 0 ? 'PASS — spec and code agree on every checkable claim' : `FAIL — ${openCount} open check(s), ${allOpen.length} open item(s)`}`);
process.exitCode = openCount === 0 ? 0 : 1;
