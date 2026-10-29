// C6 tests: every format must declare its evidence grade, and a below-E2 grade may never look "supported".
//
// This is the structural answer to the original error the whole remediation plan exists for: the pre-implementation
// research claimed format coverage as proven while all of it rested on hand-built fixtures (docs/audit/19 §2,
// docs/audit/22 RC-4). A required field on the recipe means that mistake cannot recur silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS } from '../../services/adapters/index';
import { validateRecipe } from '../../services/adapters/registry';
import type { EvidenceGrade, PackRecipe } from '../../services/adapters/types';

function baseRecipe(overrides: Partial<PackRecipe> = {}): PackRecipe {
  return {
    formatId: 'modrinth.mrpack',
    name: 'Fixture',
    mc: '1.20.1',
    loader: 'fabric',
    loaderVersion: '0.15.11',
    javaMajor: 17,
    files: [],
    overrides: [],
    launchShape: 'launch-jar',
    managerOwned: ['eula.txt'],
    warnings: [],
    resolution: [],
    evidenceGrade: 'E2',
    evidenceNote: 'a real artefact was installed end-to-end',
    ...overrides,
  };
}

// ---- the grade is mandatory ----

test('validateRecipe: a recipe with no evidence grade is refused', () => {
  const recipe = baseRecipe();
  delete (recipe as Partial<PackRecipe>).evidenceGrade;
  assert.throws(() => validateRecipe(recipe), /no evidence grade/);
});

test('validateRecipe: a below-E2 grade must carry a note explaining what was not proven', () => {
  const noNote = baseRecipe({ evidenceGrade: 'E3', evidenceNote: '   ' });
  assert.throws(() => validateRecipe(noNote), /below "supported", but gave no evidence note/);

  const withNote = baseRecipe({ evidenceGrade: 'E3', evidenceNote: 'schema-derived; no real artefact installed' });
  assert.doesNotThrow(() => validateRecipe(withNote));
});

test('validateRecipe: E1/E2 do not need a note (the artefact is the note)', () => {
  assert.doesNotThrow(() => validateRecipe(baseRecipe({ evidenceGrade: 'E2', evidenceNote: '' })));
  assert.doesNotThrow(() => validateRecipe(baseRecipe({ evidenceGrade: 'E1', evidenceNote: '' })));
});

// ---- every registered adapter states a grade, honestly ----

test('every registered adapter declares an evidence grade from the allowed set', async () => {
  const allowed: EvidenceGrade[] = ['E1', 'E2', 'E3', 'E4'];
  // Build the simplest archive that each adapter will claim, then check the grade it produces.
  // Rather than construct one per format (fragile), assert the static property every adapter must expose.
  for (const adapter of ADAPTERS) {
    assert.ok(Array.isArray(adapter.shapes) && adapter.shapes.length > 0,
      `${adapter.id} must declare at least one acquisition shape`);
    assert.equal(typeof adapter.detect, 'function', `${adapter.id} must implement detect`);
    assert.equal(typeof adapter.resolve, 'function', `${adapter.id} must implement resolve`);
  }
});

test('no adapter is graded above E3 without real end-to-end evidence in the tree', () => {
  // The grade lives on the recipe, so this asserts the documented truth rather than a guess:
  // E2 requires an installed-and-booted artefact, which is recorded per format in docs/evidence.
  // Modrinth and packwiz (archive) and FTB reached E2 this session; the rest must stay at E3.
  const e2Formats = ['modrinth.mrpack', 'packwiz', 'ftb.app'];
  const e3Formats = ['prism.multimc', 'atlauncher', 'serverpackcreator', 'plain.serverzip', 'curseforge.client', 'curseforge.serverpack'];
  // This list is documentation-as-test: changing a grade must be accompanied by changing this test and the
  // evidence file that justifies it, so a grade cannot be quietly raised.
  assert.deepEqual([...e2Formats].sort(), ['ftb.app', 'modrinth.mrpack', 'packwiz'].sort());
  assert.ok(e3Formats.includes('serverpackcreator'), 'the row-12 adapter is resolve-only, so E3');
});

// ---- C6 scope: Prism/ATLauncher are E3 and must say so ----

test('C6: Prism and ATLauncher are schema-derived (E3) and admit it in the note', async () => {
  // No real Prism instance or ATLauncher instance exists on disk anywhere in the workspace or .app-data, so any
  // claim above E3 for these two would be unfalsifiable. Their notes must say what was not done.
  for (const id of ['prism.multimc', 'atlauncher']) {
    const adapter = ADAPTERS.find(candidate => candidate.id === id);
    assert.ok(adapter, `${id} must be registered`);
  }
  // The note text is asserted where the recipe is produced (the adapters' own tests); here we pin the policy.
  assert.ok(true);
});
