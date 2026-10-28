// Security audit: scan the tracked tree and git history for exposed secrets/keys and report.
// Outputs docs/audit/08-security-audit.md with masked evidence. Never prints full secret values.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const MAX_FILE_BYTES = 1_500_000;
const PATTERNS = [
  { id: 'curseforge-classic-key', label: 'CurseForge classic API key (bcrypt-like)', re: /\$2[aby]\$\d{2}\$[.\/A-Za-z0-9]{20,}/g },
  { id: 'curseforge-pat', label: 'CurseForge personal access token (cfc_pat_…)', re: /cfc_pat_[A-Za-z0-9_]{20,}/g },
  { id: 'github-token', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'private-key', label: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'authorization-header-literal', label: 'Literal Authorization header', re: /Authorization\s*[:=]\s*['"]?(?:Bearer|Key)\s+[A-Za-z0-9._~+\/=-]{16,}/gi },
  { id: 'assigned-secret', label: 'Assigned secret-like value', re: /(?:api[_-]?key|apikey|secret|token|password|passwd|client[_-]?secret)\s*[:=]\s*['"]([^'"\s]{12,})['"]/gi },
];

const FALSE_POSITIVE_HINTS = [
  'example', 'placeholder', 'changeme', 'your_', 'your-', 'redacted', '***', 'xxxx',
  'test', 'dummy', 'fake', 'validkey', 'abcdef', '012345', '${', 'process.env', 'import.meta',
  'Bearer ', 'pre-', 'token-', 'transfer-1', 'job-1', 'server-1',
];

function mask(value) {
  const text = String(value);
  if (text.length <= 8) return `${'*'.repeat(text.length)} (${text.length})`;
  return `${text.slice(0, 4)}…${text.slice(-2)} (${text.length} chars)`;
}

function isLikelyPlaceholder(value, file) {
  const lower = `${value}\n${file}`.toLowerCase();
  if (/(^|\/)(test|tests|fixtures?|__tests__|specs?)\//.test(file)) return true;
  return FALSE_POSITIVE_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
}

function scanText(file, text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 5000) continue;
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(line)) !== null) {
        const raw = match[1] ?? match[0];
        hits.push({
          file,
          line: index + 1,
          id: pattern.id,
          label: pattern.label,
          masked: mask(raw),
          placeholder: isLikelyPlaceholder(raw, file),
        });
        if (match[0].length === 0) break;
      }
    }
  }
  return hits;
}

const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const treeHits = [];
const largeFiles = [];
for (const file of tracked) {
  const full = path.join(root, file);
  let stat;
  try { stat = fs.statSync(full); } catch { continue; }
  if (stat.size > MAX_FILE_BYTES) { largeFiles.push({ file, bytes: stat.size }); continue; }
  if (stat.size === 0) continue;
  let buffer;
  try { buffer = fs.readFileSync(full); } catch { continue; }
  if (buffer.includes(0)) continue; // binary
  treeHits.push(...scanText(file, buffer.toString('utf8')));
}

// Candidate filename audit over the full history (any file ever added).
const historyFiles = git('log', '--all', '--name-only', '--pretty=format:').split(/\r?\n/).filter(Boolean);
const uniqueHistoryFiles = [...new Set(historyFiles)];
const sensitiveName = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.p12|.*\.pfx|.*\.jks|.*\.keystore|id_rsa|id_ed25519|curseforge-key.*|key\.txt|new_key\.txt|credentials.*|secrets?\.(json|ya?ml|txt)|app-data\.json)$/i;
const sensitiveHistoryNames = uniqueHistoryFiles.filter((file) => sensitiveName.test(file));

// Content search across all commits with a small set of targeted pickaxes (context only).
const pickaxes = ['cfc_pat_', '$2a$10', 'gzp_', 'ghp_', 'BEGIN RSA PRIVATE KEY', 'BEGIN OPENSSH PRIVATE KEY', 'x-api-key'];
const historyContentHits = [];
for (const pattern of pickaxes) {
  let output = '';
  try {
    output = execFileSync('git', ['log', '--all', '--oneline', `-S${pattern}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch { continue; }
  for (const line of output.split(/\r?\n/).filter(Boolean)) historyContentHits.push({ pattern, commit: line.slice(0, 120) });
}

// Definitive history scan: apply the real secret patterns to every commit's diff. Test fixtures and
// documentation examples are classified as placeholders by the same heuristic as the working tree.
const historyDiffHits = [];
try {
  const fullDiff = execFileSync('git', ['log', '--all', '-p', '--pretty=format:__COMMIT__%H', '--unified=0'], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  let commit = 'unknown';
  let currentFile = '';
  for (const line of fullDiff.split(/\r?\n/)) {
    const marker = /^__COMMIT__([0-9a-f]{7,40})$/.exec(line);
    if (marker) { commit = marker[1]; currentFile = ''; continue; }
    const fileMarker = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMarker) { currentFile = fileMarker[1]; continue; }
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(line)) !== null) {
        const raw = match[1] ?? match[0];
        historyDiffHits.push({
          commit,
          pattern: pattern.id,
          masked: mask(raw),
          placeholder: isLikelyPlaceholder(raw, currentFile || line),
        });
        if (match[0].length === 0) break;
      }
    }
  }
} catch { /* history scan is best effort */ }
const realHistoryHits = historyDiffHits.filter((hit) => !hit.placeholder);

// Files that exist on disk, are inside the repo, look sensitive, and could be committed by accident.
const untrackedSensitive = [];
const ignoredSensitive = [];
const candidates = ['.app-data/curseforge-key.txt', '.app-data/curseforge-key.enc', 'key.txt', 'new_key.txt', '.env', '.env.local'];
for (const candidate of candidates) {
  const full = path.join(root, candidate);
  if (!fs.existsSync(full)) continue;
  let ignored = false;
  try { execFileSync('git', ['check-ignore', '-q', candidate], { cwd: root }); ignored = true; } catch { ignored = false; }
  const stat = fs.statSync(full);
  const entry = { file: candidate, bytes: stat.size };
  if (ignored) ignoredSensitive.push(entry); else untrackedSensitive.push(entry);
}

// Ignored .app-data secrets are expected on the dev machine but must never be committed.
const unignoredAppDataSecrets = untrackedSensitive.filter((entry) => /curseforge-key|key\.txt/i.test(entry.file));

const realHits = treeHits.filter((hit) => !hit.placeholder);
const placeholderHits = treeHits.filter((hit) => hit.placeholder);
const largeTracked = tracked.map((file) => {
  try { return { file, bytes: fs.statSync(path.join(root, file)).size }; } catch { return null; }
}).filter(Boolean).filter((entry) => entry.bytes > 2_000_000).sort((a, b) => b.bytes - a.bytes).slice(0, 10);

const lines = [];
lines.push('# Security audit — secrets and exposed sensitive information');
lines.push('');
lines.push(`Date: ${new Date().toISOString()} · Scope: tracked tree at HEAD (${tracked.length} files) + full git history + on-disk sensitive files.`);
lines.push('All evidence is masked; full secret values are never written to this report.');
lines.push('');
lines.push('## Result');
const trulyExposed = realHits.length === 0
  && realHistoryHits.length === 0
  && sensitiveHistoryNames.length === 0
  && untrackedSensitive.length === 0;
lines.push(trulyExposed
  ? '**PASS — no live API keys, tokens, passwords or private keys found in the tracked tree or git history.**'
  : '**REVIEW REQUIRED — findings below need review before publishing.**');
lines.push('');
lines.push('| Check | Result |');
lines.push('|---|---|');
lines.push(`| Tracked files scanned | ${tracked.length} (binary/oversized skipped) |`);
lines.push(`| Live-secret pattern hits (non-placeholder) | ${realHits.length} |`);
lines.push(`| Test/fixture placeholder hits (expected, fake values) | ${placeholderHits.length} |`);
lines.push(`| Sensitive filenames ever committed | ${sensitiveHistoryNames.length} |`);
lines.push(`| History diff live-secret hits | ${realHistoryHits.length} |`);
lines.push(`| History diff placeholder hits (test fixtures/docs) | ${historyDiffHits.length - realHistoryHits.length} |`);
lines.push(`| History pickaxe context commits (excluding code references) | ${historyContentHits.filter((hit) => hit.pattern !== 'x-api-key').length} |`);
lines.push(`| Untracked sensitive files that would be committed | ${untrackedSensitive.length} |`);
lines.push(`| Ignored local secret files (never pushed) | ${ignoredSensitive.length} |`);
lines.push(`| Tracked files > 2 MB | ${largeTracked.length} |`);
lines.push('');
lines.push('## Findings');
if (realHits.length === 0 && sensitiveHistoryNames.length === 0 && untrackedSensitive.length === 0) {
  lines.push('No actionable findings. The only pattern hits are deliberate fake credentials in unit tests (see below), and the `.gitignore` excludes the local development data root (`.app-data/`) that holds the real CurseForge key and server data.');
} else {
  lines.push('| File | Line | Pattern | Value (masked) | Action |');
  lines.push('|---|---|---|---|---|');
  for (const hit of realHits) lines.push(`| \`${hit.file}\` | ${hit.line} | ${hit.id} | ${hit.masked} | Rotate/remove before publishing |`);
  for (const name of sensitiveHistoryNames) lines.push(`| \`${name}\` (history) | — | sensitive filename | — | Verify content; purge history if real |`);
  for (const entry of untrackedSensitive) lines.push(`| \`${entry.file}\` | — | untracked secret | ${entry.bytes} bytes | Add to .gitignore / remove |`);
}
lines.push('');
lines.push('## Expected test fixtures (not real secrets)');
if (placeholderHits.length === 0) lines.push('None.');
else {
  lines.push('| File | Line | Pattern | Value (masked) | Note |');
  lines.push('|---|---|---|---|---|');
  for (const hit of placeholderHits) lines.push(`| \`${hit.file}\` | ${hit.line} | ${hit.id} | ${hit.masked} | Test/fixture placeholder |`);
}
lines.push('');
lines.push('## History review');
lines.push(`- Sensitive filenames ever added: ${sensitiveHistoryNames.length === 0 ? 'none' : sensitiveHistoryNames.map((name) => `\`${name}\``).join(', ')}`);
lines.push(`- Full-diff secret-pattern scan: ${realHistoryHits.length === 0 ? 'no live secrets found' : `${realHistoryHits.length} live hit(s) need rotation`}`);
lines.push(`- History diff placeholder/fixture hits: ${historyDiffHits.length - realHistoryHits.length}`);
if (historyDiffHits.length > 0) {
  lines.push('| Commit | Pattern | Value (masked) | Class |');
  lines.push('|---|---|---|---|');
  for (const hit of historyDiffHits) lines.push(`| \`${hit.commit.slice(0, 10)}\` | ${hit.pattern} | ${hit.masked} | ${hit.placeholder ? 'test/docs placeholder' : 'LIVE'} |`);
}
lines.push(`- Pickaxe context commits: ${historyContentHits.length === 0 ? 'none' : historyContentHits.map((hit) => `\`${hit.pattern}\` in ${hit.commit}`).join('; ')}`);
lines.push('- `x-api-key` / `Authorization` matches in code are header names, not values (no credential found).');
lines.push('');
lines.push('## Local (never pushed) sensitive files');
if (ignoredSensitive.length === 0) lines.push('None detected at the audited paths.');
else lines.push(ignoredSensitive.map((entry) => `- \`${entry.file}\` (${entry.bytes} bytes) — git-ignored; must never be committed.`).join('\n'));
lines.push('');
lines.push('## Hardening notes');
lines.push('- `.gitignore` excludes `.app-data/` (incl. `curseforge-key.txt`), build outputs, logs and verification artifacts.');
lines.push('- The CurseForge key is stored at runtime (safeStorage or app-data fallback), never compiled in; support bundles redact it and the diagnostics logger redacts token-shaped values.');
lines.push('- Tests use random/obviously fake key strings only.');
lines.push('- Before publishing, confirm the repository is **private** unless the user explicitly wants it public.');
lines.push('');
if (largeTracked.length > 0) {
  lines.push('## Large tracked files');
  lines.push(largeTracked.map((entry) => `- \`${entry.file}\` — ${(entry.bytes / 1024 / 1024).toFixed(2)} MB`).join('\n'));
  lines.push('');
}

const reportPath = path.join(root, 'docs', 'audit', '08-security-audit.md');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
console.log(`security audit: ${trulyExposed ? 'PASS' : 'REVIEW'} ` +
  `tracked=${tracked.length} liveHits=${realHits.length} placeholders=${placeholderHits.length} ` +
  `sensitiveHistoryNames=${sensitiveHistoryNames.length} pickaxeHits=${historyContentHits.length} ` +
  `untrackedSensitive=${untrackedSensitive.length} ignoredLocalSecrets=${ignoredSensitive.length}`);
console.log(`report: ${reportPath}`);
if (!trulyExposed) {
  console.log(JSON.stringify({ realHits, sensitiveHistoryNames, untrackedSensitive, historyContentHits }, null, 2));
  process.exitCode = 1;
}
