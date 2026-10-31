// Verify the version choice actually reaches the installer, and that it changes behaviour correctly.
//
// Reported flow: the picker was cosmetic. Choosing a version highlighted a row, but the install request carried only
// `projectId`, so the engine re-derived "newest" and installed a different file than the one on screen. This checks the
// three places the choice must survive: the UI request, the preview key, and the engine option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync('src/tabs/Create.tsx', 'utf8');
const renderer = readFileSync('src/tauri.ts', 'utf8');
const pipeline = readFileSync('electron/services/pipeline.ts', 'utf8');
const installer = readFileSync('electron/services/installer/curseforge.ts', 'utf8');

test('the renderer request type carries an optional fileId', () => {
  assert.match(
    renderer,
    /\{ kind: 'curseforgeProject'; projectId: number; fileId\?: number \}/,
    'the renderer request must be able to express a chosen version',
  );
});

test('the UI includes the chosen version in the request AND in the preview key', () => {
  // The key matters separately: previews are cached by key, so a different version must not reuse the previous plan.
  // Reads `activeCfVersion` rather than the raw state: that value is null unless the project branch is live, which is what
  // stops a version chosen via "Use pack" from surviving a switch to a local ZIP.
  assert.match(ui, /curseforge\.activeCfVersion\?\.fileId/, 'the UI must read the active chosen version');
  assert.match(ui, /\.\.\.\(fileId !== undefined \? \{ fileId \} : \{\}\)/, 'the fileId must be spread into the request');
  assert.match(ui, /:\$\{fileId\}/, 'the preview key must distinguish versions');
});

test('the pipeline forwards fileId to the installer', () => {
  assert.match(pipeline, /fileId\?: number \}/, 'the pipeline source type must accept fileId');
  assert.match(pipeline, /held\.source\.fileId/, 'the pipeline must read the chosen file');
  assert.match(pipeline, /\.\.\.\(fileId !== undefined \? \{ fileId \} : \{\}\)/, 'it must be forwarded to installCurseforge');
});

test('the installer accepts fileId and resolves THAT file', () => {
  assert.match(installer, /fileId\?: number;/, 'InstallCfOpts must accept fileId');
  assert.match(installer, /o\.fileId !== undefined[\s\S]{0,120}\/files\/\$\{o\.fileId\}/, 'it must fetch the chosen file');
  // A chosen file with no server pack must still be downloaded rather than replaced by another version's pack.
  assert.match(installer, /chosen file \$\{o\.fileId\} has no server pack/, 'it must download the chosen file directly');
});

test('the keyless route honours fileId too', () => {
  // Otherwise the picker would behave differently depending only on whether an API key happens to be saved.
  assert.match(installer, /const targetId = o\.fileId;/, 'the keyless path must read the choice');
  assert.match(installer, /files\/\$\{targetId\}/, 'and fetch that file id');
});
