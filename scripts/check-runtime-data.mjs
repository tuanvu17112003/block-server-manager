#!/usr/bin/env node
// Build-contract check: the compiled app must ship the curated L4 data next to curated.js.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join('dist-electron', 'services', 'installer', 'data');
const files = [
  'itzg-modrinth-exclude-include.json',
  'itzg-cf-exclude-include.json',
  'env-overrides.json',
  'env-overrides-learned.json',
];
const missing = files.filter((name) => !fs.existsSync(path.join(dir, name)));
if (missing.length > 0) {
  console.error(`[runtime-data] FAIL: built app is missing ${missing.join(', ')} in ${dir}`);
  process.exit(1);
}
const curated = fs.readFileSync(path.join('dist-electron', 'services', 'installer', 'curated.js'), 'utf8');
if (!curated.includes("'data'") && !curated.includes('"data"')) {
  console.error('[runtime-data] FAIL: curated.js does not reference a data directory');
  process.exit(1);
}
console.log(`[runtime-data] PASS: ${files.length} curated files present in the built app`);
