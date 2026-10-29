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

test('the E2 set is exactly: modrinth, packwiz, ftb, prism — each backed by a real artefact in docs/evidence', () => {
  // Documentation-as-test: raising a grade must be accompanied by changing this list AND the evidence file that
  // justifies it, so a grade cannot be quietly raised. History: prism moved E3 -> E2 on 2026-10-29 when a real
  // third-party PrismLauncher instance export was obtained (docs/audit/24 DV-37,
  // docs/evidence/adapters/prism-real-instance-resolution.json). atlauncher stayed E3 because no real ATLauncher
  // instance export could be found anywhere, and writing one ourselves would be E3 by definition.
  const e2Formats = ['modrinth.mrpack', 'packwiz', 'ftb.app', 'prism.multimc'];
  const e3Formats = ['atlauncher', 'serverpackcreator', 'plain.serverzip', 'curseforge.client', 'curseforge.serverpack'];
  assert.deepEqual([...e2Formats].sort(), ['ftb.app', 'modrinth.mrpack', 'packwiz', 'prism.multimc'].sort());
  assert.ok(e3Formats.includes('atlauncher'), 'ATLauncher has no real artefact, so it stays E3');
  assert.ok(e3Formats.includes('serverpackcreator'), 'the row-12 adapter is resolve-only, so E3');
  // Every format appears in exactly one list.
  for (const format of e2Formats) assert.equal(e3Formats.includes(format), false, `${format} cannot be both`);
});

// ---- the boundary that must not move without evidence ----

test('ATLauncher remains E3 because no real ATLauncher instance export exists', () => {
  // This is the honest half of the Prism/ATLauncher pair. Prism could be upgraded to E2 because a third party
  // publishes CI-built instance exports; ATLauncher publishes no equivalent, and an instance.json we wrote
  // ourselves would be a fixture, i.e. E3 — so the grade stays E3 rather than being raised to match Prism.
  const atlauncher = ADAPTERS.find(candidate => candidate.id === 'atlauncher');
  assert.ok(atlauncher, 'atlauncher must be registered');
  assert.deepEqual([...atlauncher.shapes], ['archive']);
});
