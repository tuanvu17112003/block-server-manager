#!/usr/bin/env node
// Deterministic unit-test launcher: `node --test` needs explicit files on this Node version,
// and Windows shells do not expand globs. Discovers compiled *.test.js under the unit dir.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('dist-electron', 'test', 'unit');
if (!fs.existsSync(dir)) {
  console.error(`unit test dir missing: ${dir} (run npm run build:electron first)`);
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.test.js')).map((name) => path.join(dir, name));
if (files.length === 0) {
  console.error('no unit test files found');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
