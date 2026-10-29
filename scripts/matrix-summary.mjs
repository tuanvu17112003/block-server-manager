// Consolidate the per-pack matrix evidence files into one durable summary + markdown table.
// Run after `--matrixtest`:  node scripts/matrix-summary.mjs
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'docs', 'evidence', 'matrix');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
const REFERENCE = {
  // Reference outcome from H:\TestAI\modrinth-curseforge\modpack-install-results.md
  'skyblock-enhanced': { platform: 'modrinth', mc: '26.2', loader: 'fabric', java: 25, files: 15, reference: 'PASS Done(2.044s)' },
  cobbleverse: { platform: 'modrinth', mc: '1.21.1', loader: 'fabric', java: 21, files: 168, reference: 'PASS Done(9.670s)' },
  battlearmorytacz: { platform: 'modrinth', mc: '1.20.1', loader: 'forge', java: 17, files: 88, reference: 'PASS Done(8.638s)' },
  'prominence-2-fabric': { platform: 'modrinth', mc: '1.20.1', loader: 'fabric', java: 17, files: 341, reference: 'PASS Done(37.310s)' },
  'slimes-adventure': { platform: 'modrinth', mc: '1.21.1', loader: 'fabric', java: 21, files: 105, reference: 'PASS Done(11.502s)' },
  'zombie-invade-100-days': { platform: 'modrinth', mc: '1.20.1', loader: 'forge', java: 17, files: null, reference: 'PASS Done(21.694s)' },
  'dungeon-heroes': { platform: 'curseforge', mc: '1.21.1', loader: 'fabric', java: 21, files: 214, reference: 'PASS Done(50.984s)' },
  rlcraft: { platform: 'curseforge', mc: '1.12.2', loader: 'forge', java: 8, files: 182, reference: 'PASS Done(11.237s)' },
  'skyfactory-5': { platform: 'curseforge', mc: '1.20.1', loader: 'forge', java: 17, files: 268, reference: 'PASS Done(7.231s)' },
  'dawn-craft': { platform: 'curseforge', mc: '1.18.2', loader: 'forge', java: 17, files: 278, reference: 'PASS Done(71.137s)' },
  'otherworld-dnd': { platform: 'curseforge', mc: '1.20.1', loader: 'forge', java: 17, files: 377, reference: 'PASS Done(44.789s)' },
  'prominence-2-hasturian-era': { platform: 'curseforge', mc: '1.20.1', loader: 'fabric', java: 17, files: 576, reference: 'PASS Done(34.511s)' },
};

const rows = [];
for (const file of files) {
  const slug = path.basename(file, '.json');
  const ev = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const ref = REFERENCE[slug] ?? {};
  const jars = ev.published?.jarsEnabled ?? 0;
  const disabled = ev.published?.jarsDisabled ?? 0;
  rows.push({
    slug,
    platform: ev.platform ?? ref.platform ?? '?',
    verdict: ev.verdict,
    loader: `${ev.preview?.loader?.kind ?? '?'} ${ev.preview?.loader?.minecraftVersion ?? ''}`.trim(),
    expectedLoader: `${ref.loader ?? '?'} ${ref.mc ?? ''}`.trim(),
    verifiedBoot: ev.published?.verifiedBoot ?? (ev.report?.stages ?? []).find((s) => s.stage === 'verify-boot')?.outcome ?? null,
    jars,
    disabled,
    totalJars: jars + disabled,
    referenceFiles: ref.files,
    reference: ref.reference ?? null,
    durationSeconds: ev.durationSeconds,
    error: ev.error ?? null,
  });
}

const passed = rows.filter((r) => r.verdict === 'PASS').length;
const summary = {
  generatedAt: new Date().toISOString(),
  source: 'electron/matrix-test.ts (--matrixtest)',
  reference: 'H:\\TestAI\\modrinth-curseforge\\modpack-install-results.md',
  totals: { packs: rows.length, pass: passed, fail: rows.length - passed },
  rows,
};
fs.writeFileSync(path.join(dir, '_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const pad = (v, n) => String(v ?? '').padEnd(n);
const lines = [
  `# Live acceptance matrix — app vs reference spike`,
  '',
  `Generated ${summary.generatedAt} by \`node node_modules/electron/cli.js . --matrixtest\`.`,
  `Reference: \`H:\\TestAI\\modrinth-curseforge\\modpack-install-results.md\` (the spike's own sweep).`,
  '',
  `**${passed}/${rows.length} packs PASS** through this app's real pipeline (staged install → L2/L3 verified boot → publish).`,
  '',
  '| Pack | Platform | Loader (app) | Expected | Verified boot | Jars (enabled/disabled) | Reference | Verdict |',
  '|---|---|---|---|---|---|---|---|',
];
for (const r of rows) {
  const jars = r.totalJars ? `${r.jars}/${r.disabled}${r.referenceFiles ? ` (ref ${r.referenceFiles})` : ''}` : '—';
  lines.push(`| ${r.slug} | ${r.platform} | ${r.loader} | ${r.expectedLoader} | ${r.verifiedBoot ?? '—'} | ${jars} | ${r.reference ?? '—'} | **${r.verdict}** |`);
}
if (rows.some((r) => r.error)) {
  lines.push('', '## Failures', '');
  for (const r of rows.filter((row) => row.error)) lines.push(`- **${r.slug}**: ${String(r.error).split('\n')[0]}`);
}
lines.push('', 'Per-pack evidence JSON (preview plan, report stages/files, published counts) sits beside this file.', '');
fs.writeFileSync(path.join(dir, 'README.md'), lines.join('\n'));
console.log(`${passed}/${rows.length} PASS`);
for (const r of rows) console.log(`  ${r.verdict.padEnd(6)} ${r.slug.padEnd(30)} ${r.loader.padEnd(16)} verify=${r.verifiedBoot ?? '-'} jars=${r.jars}/${r.disabled}`);
console.log(`\nsummary: ${path.join(dir, '_summary.json')}`);
console.log(`table:   ${path.join(dir, 'README.md')}`);
