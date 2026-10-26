#!/usr/bin/env node
// Copies the curated L4 runtime data (itzg lists, env overrides, learned entries) into the compiled
// main-process output. `tsc` only emits .js, so without this step every built app silently ships a
// 3-layer client-mod defense (audit INST-001 / P0-6). Fails the build if the source data is missing.
import fs from 'node:fs';
import path from 'node:path';

const source = path.join('electron', 'services', 'installer', 'data');
const target = path.join('dist-electron', 'services', 'installer', 'data');
const required = [
  'itzg-modrinth-exclude-include.json',
  'itzg-cf-exclude-include.json',
  'env-overrides.json',
  'env-overrides-learned.json',
];

if (!fs.existsSync(source)) {
  console.error(`[runtime-data] missing curated data dir: ${source}`);
  process.exit(1);
}
fs.mkdirSync(target, { recursive: true });
const copied = [];
for (const name of required) {
  const from = path.join(source, name);
  if (!fs.existsSync(from)) {
    console.error(`[runtime-data] missing required file: ${from}`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(target, name));
  copied.push(name);
}
console.log(`[runtime-data] copied ${copied.length} files -> ${target}`);
