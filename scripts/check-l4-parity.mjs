// L4 parity check: run the spike's curated resolver and the app's resolver over the same real pack
// manifest, and diff every verdict. Any disagreement is a policy divergence that changes installs.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const spike = await import('file:///H:/TestAI/modrinth-curseforge/sample/core.mjs');
const dist = path.join(process.cwd(), 'dist-electron');
const { makeCuratedResolver } = require(path.join(dist, 'services/installer/curated.js'));

const PACK = '.app-data/cache/mrpack/Prominence™ II Hasturian Era v4.1.5hf.mrpack';

function readIndex() {
  return new Promise((resolve, reject) => {
    yauzl.open(PACK, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'modrinth.index.json') { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          let body = '';
          stream.on('data', (chunk) => { body += chunk; });
          stream.on('end', () => resolve(JSON.parse(body)));
        });
      });
    });
  });
}

const index = await readIndex();
const paths = index.files.map((f) => f.path);
const slug = 'prominence-2-fabric';

const spikeResolver = spike.makeCuratedResolver({ platform: 'modrinth', packSlug: slug, presentPaths: paths });
const appResolver = makeCuratedResolver({ platform: 'modrinth', packSlug: slug, presentPaths: paths });

const diffs = [];
const tally = { same: 0 };
for (const file of index.files) {
  const declared = file.env?.server ?? 'required';
  const s = spikeResolver.resolve(file.path, declared);
  const a = appResolver.resolve(file.path, declared);
  if (s.env !== a.env || s.protect !== a.protect) {
    diffs.push({ path: file.path, declared, spike: `${s.env}${s.protect ? '+protect' : ''} (${s.why})`, app: `${a.env}${a.protect ? '+protect' : ''} (${a.why})` });
  } else tally.same++;
}
console.log(`files compared: ${index.files.length}  identical verdicts: ${tally.same}  divergent: ${diffs.length}`);
for (const d of diffs.slice(0, 25)) console.log(`  ${d.path}\n     declared=${d.declared}\n     spike=${d.spike}\n     app  =${d.app}`);

// install-count effect of the divergence
let spikeInstalled = 0, appInstalled = 0;
for (const file of index.files) {
  const declared = file.env?.server ?? 'required';
  if (spikeResolver.resolve(file.path, declared).env !== 'unsupported') spikeInstalled++;
  if (appResolver.resolve(file.path, declared).env !== 'unsupported') appInstalled++;
}
console.log(`\nwould-install (no user choices): spike=${spikeInstalled} app=${appInstalled}`);

// Compare protect sets too (they gate L2).
const sProtect = [...spikeResolver.protectBasenames].sort();
const aProtect = [...appResolver.protectBasenames].sort();
console.log(`protect basenames: spike=${JSON.stringify(sProtect)} app=${JSON.stringify(aProtect)}`);
