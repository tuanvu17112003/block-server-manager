// The CurseForge branch switch: two install paths share one hook, and state must not leak between them.
//
// Reported: "after choosing a version with Use pack, going back and picking a different ZIP still shows the version I had
// chosen — but the review panel shows the right one."
//
// Cause: selectCurseforgeZip cleared the project id and meta but NOT cfSelectedVersion, while the Configure title read
// cfSelectedVersion directly. So the screen named the stale API version and everything else described the ZIP.
//
// This is a STATE-LEAK test, not a display test. The previous audit covered nine links inside the one-click branch and
// missed this entirely because the defect lives at the boundary between the two branches — which is why the fix here is a
// single derived `curseforgeMode`/`activeCfVersion` pair rather than another local condition at each read site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(p, 'utf8');
const hook = read('src/tabs/create/useCreateCurseforgeImport.ts');
const stepsConfigure = read('src/tabs/create/StepsConfigure.tsx');
const stepsBrowse = read('src/tabs/create/StepsBrowse.tsx');
const create = read('src/tabs/Create.tsx');
const stepsType = read('src/tabs/create/StepsType.tsx');

// ---- the leak itself ----
test('choosing a ZIP clears the project id, meta AND the chosen version', () => {
  const body = /const selectCurseforgeZip = \(name: string\): void => \{([\s\S]*?)\n  \};/.exec(hook);
  assert.ok(body !== null, 'selectCurseforgeZip must be present');
  const text = body[1];
  // The guard must consider the version too, or a stale version with no project would be left set.
  assert.match(text, /cfProjectId !== null \|\| cfSelectedVersion !== null/, 'the guard must include the chosen version');
  assert.match(text, /setCfProjectId\(null\)/);
  assert.match(text, /setCfProjectMeta\(null\)/);
  assert.match(text, /setCfSelectedVersion\(null\)/, 'the chosen version must be cleared when switching to a ZIP');
});

// ---- one place decides the branch ----
test('a single derived mode identifies the active branch', () => {
  assert.match(hook, /const curseforgeMode: 'project' \| 'zip' \| 'none'/);
  assert.match(hook, /cfProjectId !== null\s*\n?\s*\? 'project'/);
  assert.match(hook, /curseforgeSelectedName !== '' \? 'zip' : 'none'/);
});

test('activeCfVersion is null unless the project branch is live', () => {
  // This is the guard that makes a stale version structurally unable to reach the UI.
  assert.match(hook, /const activeCfVersion: CurseForgeProjectVersionDto \| null = curseforgeMode === 'project' \? cfSelectedVersion : null;/);
});

test('the hook exports mode and active version for renderers', () => {
  assert.match(hook, /^\s+curseforgeMode,/m);
  assert.match(hook, /^\s+activeCfVersion,/m);
});

// ---- renderers must use the derived values, never the raw state ----
test('the Configure title reads the derived version, not the raw state', () => {
  const titleBlock = /title=\{\(\(\) => \{([\s\S]*?)\}\)\(\)\}/.exec(stepsConfigure);
  assert.ok(titleBlock !== null, 'the title expression must be present');
  assert.match(titleBlock[1], /curseforge\.activeCfVersion/);
  assert.ok(!/curseforge\.cfSelectedVersion/.test(titleBlock[1]), 'the title must not read the raw state');
});

test('cfChosenVersion prop receives the derived version', () => {
  assert.match(stepsConfigure, /cfChosenVersion=\{props\.kind === 'curseforge' \? curseforge\.activeCfVersion : null\}/);
});

test('the version picker is only rendered while the project branch is live', () => {
  assert.match(stepsBrowse, /curseforge\.curseforgeMode === 'project' && curseforge\.cfProjectId !== null/);
  assert.match(stepsBrowse, /selectedFileId=\{curseforge\.activeCfVersion\?\.fileId \?\? null\}/);
});

test('the install request uses the derived version and the derived branch', () => {
  assert.match(create, /curseforge\.curseforgeMode === 'project'/);
  assert.match(create, /const fileId = curseforge\.activeCfVersion\?\.fileId;/);
});

// ---- the ZIP branch must still work unchanged ----
test('the ZIP branch remains reachable and is not gated on project fields', () => {
  // A regression in the other direction would be just as bad: breaking local ZIP import.
  assert.match(create, /kind: 'curseForgeServerZip', zipName: curseforge\.curseforgeSelectedName/);
  assert.match(create, /cfInstallable\(curseforge\.selectedCurseforgeInspection\)/);
});

test('selecting a ZIP keeps cfProjectId null so the project branch cannot win', () => {
  // Confirms the ordering assumption: once a ZIP is chosen the project branch is dead, which is what lets
  // activeCfVersion return null.
  const body = /const selectCurseforgeZip = \(name: string\): void => \{([\s\S]*?)\n  \};/.exec(hook);
  assert.ok(body !== null);
  assert.match(body[1], /setCfProjectId\(null\)/);
});

// ---- navigation still lands on the picker ----
test('both CurseForge entry points still land on Browse', () => {
  assert.match(stepsType, /pickSearchedCurseforgeModpack\(projectId\)\.then\(\(ok\) => \{ if \(ok\) setStep\(2\); \}\)/);
  assert.match(stepsType, /onContinueToConfigure=\{\(\) => \{ if \(curseforge\.cfProjectId !== null\) setStep\(2\); \}\}/);
});
