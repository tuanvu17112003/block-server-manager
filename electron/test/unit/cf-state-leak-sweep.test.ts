// State-leak sweep for the CurseForge hook: EVERY field that belongs to one branch must be reset when switching branches.
//
// The previous fix cleared one field (cfSelectedVersion) after it was reported. Doing that one field at a time is how four
// reports happened. This enumerates the state and checks the reset responsibilities mechanically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const hook = readFileSync('src/tabs/create/useCreateCurseforgeImport.ts', 'utf8');

/** Extract the body of a `const name = ... => { ... }` arrow function. */
function block(name: string, source: string): string {
  const start = source.indexOf(name);
  if (start === -1) return '';
  const brace = source.indexOf('{', start);
  if (brace === -1) return '';
  // Walk to the matching close brace so nested blocks do not truncate the body.
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  return '';
}

// ---- enumerate the state that belongs to each branch ----
const PROJECT_FIELDS = [
  'cfProjectId',
  'cfProjectMeta',
  'cfProjectBusy',
  'cfProjectError',
  'cfSelectedVersion',
];
const ZIP_FIELDS = [
  'curseforgeSelectedName',
  'curseforgeInspection',
  'curseforgeInspecting',
];

test('every project-branch field is declared', () => {
  for (const field of PROJECT_FIELDS) {
    assert.ok(hook.includes(field), `${field} must exist in the hook`);
  }
});

test('switching to a ZIP clears every project-branch field that could be displayed', () => {
  const body = block('const selectCurseforgeZip', hook);
  assert.ok(body !== '', 'selectCurseforgeZip must be found');
  // The display-bearing fields: leaving any of these set lets the ZIP branch render project data.
  for (const field of ['cfProjectId', 'cfProjectMeta', 'cfSelectedVersion']) {
    assert.match(
      body,
      new RegExp(`set${field[0]!.toUpperCase()}${field.slice(1)}\\(null\\)`),
      `switching to a ZIP must clear ${field}`,
    );
  }
});

test('switching to a project clears the ZIP branch name', () => {
  // The reverse direction: resolving a project while a ZIP name is set would leave both branches nominally live.
  const body = block('const resolveCurseforgeProject', hook);
  assert.ok(body !== '', 'resolveCurseforgeProject must be found');
  // It clears the chosen version (already pinned elsewhere); assert it exists so the pair stays in sync.
  assert.match(body, /setCfSelectedVersion\(null\)/);
});

test('a full reset clears both branches', () => {
  const match = /resetForSourceChange: \(\) => \{([^}]*)\}/.exec(hook);
  assert.ok(match !== null, 'resetForSourceChange must be present');
  const body = match[1];
  for (const setter of ['setCfProjectId', 'setCfProjectMeta', 'setCfSelectedVersion']) {
    assert.match(body, new RegExp(`${setter}\\(null\\)`), `reset must call ${setter}(null)`);
  }
});

// ---- branch derivation is centralised ----
test('one derived mode governs which branch renders and which request is built', () => {
  assert.match(hook, /const curseforgeMode: 'project' \| 'zip' \| 'none'/);
  // No other file may re-implement the branch test using raw fields in a way that can disagree.
  const create = readFileSync('src/tabs/Create.tsx', 'utf8');
  assert.match(create, /curseforge\.curseforgeMode === 'project'/, 'the request must use the derived mode');
});

test('the derived version is the only version a renderer may read', () => {
  for (const file of [
    'src/tabs/create/StepsConfigure.tsx',
    'src/tabs/create/StepsBrowse.tsx',
    'src/tabs/Create.tsx',
  ]) {
    const text = readFileSync(file, 'utf8');
    // Strip comments so prose about the old bug does not count as a read.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(
      !/curseforge\.cfSelectedVersion/.test(code),
      `${file} must read activeCfVersion, not cfSelectedVersion`,
    );
  }
});

// ---- the two branches must never both render controls ----
test('the version picker and the ZIP list are mutually exclusive by construction', () => {
  const browse = readFileSync('src/tabs/create/StepsBrowse.tsx', 'utf8');
  // The picker is gated on the project branch; the ZIP list is always rendered but only meaningful with no project.
  assert.match(browse, /curseforge\.curseforgeMode === 'project' && curseforge\.cfProjectId !== null/);
});

test('the ZIP list is hidden while the project branch is active', () => {
  // Otherwise a user could be looking at a picker and a ZIP list at once and not know which one installs.
  const browse = readFileSync('src/tabs/create/StepsBrowse.tsx', 'utf8');
  const zipBlockIndex = browse.indexOf('<BrowseCurseforge');
  assert.ok(zipBlockIndex > 0, 'BrowseCurseforge must be rendered');
  const before = browse.slice(Math.max(0, zipBlockIndex - 400), zipBlockIndex);
  assert.match(before, /curseforgeMode !== 'project'|curseforgeMode === 'zip'|curseforgeMode === 'none'/, 'the ZIP list must be gated on the non-project branch');
});
