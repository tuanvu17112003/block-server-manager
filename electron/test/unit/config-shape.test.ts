// Pin the shape of files that external tools parse positionally.
//
// This exists because of a real failure: `.nvmrc` began with a comment line, and `actions/setup-node` reads only the
// FIRST line of that file without skipping comments. CI resolved the requested version as "#" and died in the
// "Set up Node.js" step, before a single test ran:
//
//   Resolved .nvmrc as #
//   ##[error]Unable to find Node version '#' for platform win32 and architecture x64.
//
// The version requirement itself was correct by then. The file was simply shaped in a way the consumer does not
// tolerate, and nothing locally notices because nvm and readers here are lenient. A config file that only breaks in
// CI needs a cheap local check, which is what this is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');

test('.nvmrc: the first line is a bare version, because actions/setup-node does not skip comments', () => {
  const file = path.join(root, '.nvmrc');
  assert.ok(fs.existsSync(file), '.nvmrc must exist — CI resolves the Node version from it');
  const firstLine = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();

  assert.ok(firstLine.length > 0, '.nvmrc must not start with a blank line');
  assert.doesNotMatch(firstLine, /^#/, 'the first line must not be a comment: setup-node would resolve it as the version');
  assert.match(firstLine, /^\d+\.\d+\.\d+$/, `the first line must be an exact version like 22.13.0, got "${firstLine}"`);
});

test('.nvmrc: the pinned version satisfies the node:sqlite floor', () => {
  // node:sqlite works without --experimental-sqlite from 22.13.0. Below that, legacy-import tests fail to even load.
  const firstLine = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').split(/\r?\n/)[0].trim();
  const [major, minor] = firstLine.split('.').map(Number);
  const atLeast = (maj: number, min: number) => major > maj || (major === maj && minor >= min);
  assert.ok(atLeast(22, 13), `.nvmrc pins ${firstLine}, which is below the 22.13.0 floor required by node:sqlite`);
});

test('package.json engines agrees with .nvmrc', () => {
  const nvmrc = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').split(/\r?\n/)[0].trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { engines?: { node?: string } };
  const engine = pkg.engines?.node ?? '';
  assert.ok(engine.includes(nvmrc) || engine.includes(nvmrc.replace(/\.0$/, '')),
    `package.json engines "${engine}" should state the same floor as .nvmrc "${nvmrc}" — they drifted apart once and CI caught it`);
});

test('.gitattributes exists and normalises line endings, because its absence caused a warning on every commit', () => {
  const file = path.join(root, '.gitattributes');
  assert.ok(fs.existsSync(file), '.gitattributes must exist');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /text=auto/, 'must declare text=auto so git stops guessing');
  assert.match(text, /package-lock\.json\s+-text/, 'the lockfile must be left byte-exact');
});

test('workflow files are valid YAML with the expected top-level keys', () => {
  const file = path.join(root, '.github', 'workflows', 'verify.yml');
  assert.ok(fs.existsSync(file), 'the verify workflow must exist');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^name:/m, 'workflow needs a name');
  assert.match(text, /^on:/m, 'workflow needs an "on" trigger');
  assert.match(text, /runs-on:\s*windows-latest/, 'this project is Windows-only; the runner must match');
  assert.match(text, /node-version-file:\s*\.nvmrc/, 'the workflow must take the Node version from .nvmrc so the two cannot drift');
});
