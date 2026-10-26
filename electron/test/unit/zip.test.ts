// Unit tests for the ZIP writer, shared extractor and jar/failure analysis helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeFailure, extractZip, scanJarSideness } from '../../services/installer/core';
import { collectInputs, writeZip } from '../../services/zip';
import { tempRoot } from '../harness';

test('writeZip/extractZip: round-trips nested files and preserves bytes', async () => {
  const temp = tempRoot('msm-unit-zip');
  try {
    const src = path.join(temp.root, 'src');
    fs.mkdirSync(path.join(src, 'config'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(src, 'config', 'b.json'), '{"b":2}');
    const inputs = await collectInputs(src, ['a.txt', 'config']);
    assert.equal(inputs.length, 2);
    const zip = path.join(temp.root, 'out.zip');
    const bytes = await writeZip(zip, inputs);
    assert.ok(bytes > 0);
    const out = path.join(temp.root, 'out');
    const result = await extractZip(zip, out, { skipExisting: false });
    assert.equal(result.written.length, 2);
    assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'alpha');
    assert.equal(fs.readFileSync(path.join(out, 'config', 'b.json'), 'utf8'), '{"b":2}');
  } finally {
    temp.cleanup();
  }
});

test('writeZip: rejects duplicate entry names via collectInputs dedupe', async () => {
  const temp = tempRoot('msm-unit-zip2');
  try {
    const src = path.join(temp.root, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'alpha');
    const inputs = await collectInputs(src, ['a.txt', 'a.txt']);
    assert.equal(inputs.length, 1);
  } finally {
    temp.cleanup();
  }
});

test('scanJarSideness: detects fabric client environment and ignores server mods', async () => {
  const temp = tempRoot('msm-unit-jar');
  try {
    const makeJar = async (name: string, descriptor: object): Promise<string> => {
      const dir = path.join(temp.root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'fabric.mod.json'), JSON.stringify(descriptor));
      const inputs = await collectInputs(dir, ['fabric.mod.json']);
      const jar = path.join(temp.root, `${name}.jar`);
      await writeZip(jar, inputs);
      return jar;
    };
    const clientJar = await makeJar('client', { id: 'clientmod', environment: 'client' });
    const serverJar = await makeJar('server', { id: 'servermod', environment: 'server' });
    const universalJar = await makeJar('universal', { id: 'universalmod' });
    assert.equal((await scanJarSideness(clientJar)).client, true);
    assert.equal((await scanJarSideness(serverJar)).client, false);
    assert.equal((await scanJarSideness(universalJar)).client, false);
  } finally {
    temp.cleanup();
  }
});

test('analyzeFailure: classifies fabric missing/disabled mods and mixin frames', () => {
  const tail = [
    "[12:00:00] [main/ERROR]: Mod 'Foo' (foomod) requires bar, which is missing!",
    "[12:00:00] [main/ERROR]: Mixin handler$abc$othermod$method failed",
    "[12:00:00] [main/ERROR]: Some Mod (bazmod) has failed to load correctly",
  ];
  const result = analyzeFailure(tail);
  assert.ok(result.disable.includes('bazmod'));
  assert.ok(result.disable.includes('foomod'));
  assert.ok(result.disable.includes('othermod'));
  assert.ok(result.add.includes('bar'));
});

test('extractZip: rejects zip-slip entries with absolute or escaping paths', async () => {
  const temp = tempRoot('msm-unit-slip');
  try {
    const dir = path.join(temp.root, 'src');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const inputs = await collectInputs(dir, ['a.txt']);
    // Simulate an unsafe archive entry by overriding the archive name.
    const zip = path.join(temp.root, 'slip.zip');
    await writeZip(zip, [{ name: '../escape.txt', path: inputs[0]!.path }]);
    await assert.rejects(
      () => extractZip(zip, path.join(temp.root, 'out'), { skipExisting: false }),
      /unsafe zip entry|invalid relative path/,
    );
  } finally {
    temp.cleanup();
  }
});
