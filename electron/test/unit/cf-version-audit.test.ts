// Exhaustive audit: every place the CurseForge version choice must survive.
//
// This exists because the fix was applied three times in three layers (request, preview, display) and each time another
// source was found to ignore it. Rather than react to the next report, this enumerates the whole path and asserts each
// link, so a future edit that drops the choice fails loudly here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(p, 'utf8');

const renderer = read('src/tauri.ts');
const create = read('src/tabs/Create.tsx');
const hook = read('src/tabs/create/useCreateCurseforgeImport.ts');
const stepsType = read('src/tabs/create/StepsType.tsx');
const stepsBrowse = read('src/tabs/create/StepsBrowse.tsx');
const stepsConfigure = read('src/tabs/create/StepsConfigure.tsx');
const stepConfigure = read('src/tabs/create/StepConfigure.tsx');
const picker = read('src/tabs/create/CurseForgeVersionPicker.tsx');
const pipeline = read('electron/services/pipeline.ts');
const installer = read('electron/services/installer/curseforge.ts');

// ---- link 1: the request can express a version ----
test('L1 renderer request type accepts fileId', () => {
  assert.match(renderer, /kind: 'curseforgeProject'; projectId: number; fileId\?: number/);
});

// ---- link 2: the UI sends it, and the preview key distinguishes it ----
test('L2 activePipelineSource sends fileId and keys the preview by it', () => {
  assert.match(create, /curseforge\.activeCfVersion\?\.fileId/);
  assert.match(create, /fileId !== undefined \? \{ fileId \}/);
  assert.match(create, /:\$\{fileId\}/, 'previews are cached by key; a new version must not reuse the old plan');
});

// ---- link 3: navigation reaches the picker ----
test('L3 both entry buttons land on Browse, where the picker lives', () => {
  assert.match(stepsType, /pickSearchedCurseforgeModpack\(projectId\)\.then\(\(ok\) => \{ if \(ok\) setStep\(2\); \}\)/);
  assert.match(stepsType, /onContinueToConfigure=\{\(\) => \{ if \(curseforge\.cfProjectId !== null\) setStep\(2\); \}\}/);
});

// ---- link 4: the picker can advance ----
test('L4 the picker renders a Continue that is disabled without a selection', () => {
  assert.match(picker, /onContinue\?: \(\) => void/);
  assert.match(picker, /disabled=\{props\.selectedFileId === null\}/);
  // The picker's own Continue handler must advance the wizard. Located by its guard on the selection, because StepsBrowse
  // has a second onContinue for the ZIP list.
  assert.match(
    stepsBrowse,
    /onContinue=\{\(\) => \{[\s\S]{0,200}curseforge\.activeCfVersion !== null[\s\S]{0,40}setStep\(3\)/,
  );
});

// ---- link 5: the preview resolves the chosen file ----
test('L5 the preview passes fileId to inspectCurseForgeProject', () => {
  assert.match(pipeline, /const chosenFileId = source\.kind === 'curseforgeProject' \? source\.fileId : undefined;/);
  assert.match(pipeline, /inspectCurseForgeProject\(Number\(source\.projectId\), this\.ctx\.dataRoot, chosenFileId\)/);
});

test('L5b inspectCurseForgeProject resolves the requested file, not newest', () => {
  assert.match(installer, /fileId\?: number,\n\): Promise<CfProjectMeta>/);
  assert.match(installer, /if \(fileId !== undefined\) \{[\s\S]{0,200}\/files\/\$\{fileId\}/);
});

// ---- link 6: the install downloads the chosen file ----
test('L6 the install forwards and honours fileId', () => {
  assert.match(pipeline, /const fileId = held\.source\.kind === 'curseforgeProject' \? held\.source\.fileId : undefined;/);
  assert.match(pipeline, /\.\.\.\(fileId !== undefined \? \{ fileId \} : \{\}\)/);
  assert.match(installer, /fileId\?: number;/);
  assert.match(installer, /o\.fileId !== undefined[\s\S]{0,160}\/files\/\$\{o\.fileId\}/);
});

test('L6b the keyless route also honours fileId', () => {
  assert.match(installer, /const targetId = o\.fileId;/);
  assert.match(installer, /files\/\$\{targetId\}/);
});

// ---- link 7: what the user reads matches what will happen ----
test('L7 Configure reads the chosen version before any staged ZIP', () => {
  // `activeCfVersion` is the branch-derived value: non-null only when the project branch is live, so a stale API version
  // cannot be displayed beside a freshly chosen ZIP.
  assert.match(stepsConfigure, /const chosen = curseforge\.activeCfVersion;/);
  assert.match(stepsConfigure, /cfChosenVersion=\{props\.kind === 'curseforge' \? curseforge\.activeCfVersion : null\}/);
  // Both the title and the target field must be driven by the choice, not by the inspection.
  assert.match(stepConfigure, /cfChosenVersion: CurseForgeProjectVersionDto \| null/);
  assert.match(stepConfigure, /props\.cfChosenVersion\.minecraftVersion/);
});

test('L7b the synthesised inspection names the chosen version and stops claiming "latest"', () => {
  assert.match(hook, /name: cfSelectedVersion\?\.displayName \?\? cfProjectMeta\.name/);
  assert.match(hook, /server pack for the selected version/);
  assert.match(hook, /has no server pack; its client manifest is resolved/);
});

test('L7c the pipeline warning names the selected version', () => {
  assert.match(pipeline, /the server pack for the selected version "\$\{meta\.name\}" will be installed/);
  assert.match(pipeline, /The selected version "\$\{meta\.name\}" has no server pack/);
});

// ---- link 8: stale choices cannot leak ----
test('L8 a chosen version is cleared on project switch and on session reset', () => {
  // Two separate leaks: switching project (old fileId sent as a pin for a new project) and resetting the create session.
  assert.match(hook, /setCfProjectId\(meta\.projectId\);[\s\S]{0,400}setCfSelectedVersion\(null\);/);
  assert.match(hook, /resetForSourceChange: \(\) => \{[^}]*setCfSelectedVersion\(null\)/);
});

// ---- the picker must never default silently to newest ----
test('L9 the recommended row is the newest WITH a server pack, not simply the newest', () => {
  assert.match(picker, /const withServerPack = versions\.find\(\(version\) => version\.hasServerPack\);/);
  assert.match(picker, /withServerPack\?\.fileId \?\? versions\[0\]\?\.fileId/);
});
