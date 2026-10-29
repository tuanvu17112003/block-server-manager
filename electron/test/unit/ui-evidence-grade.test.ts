// Item 4 (docs/audit/26): the evidence grade must reach the user, and a below-E2 format must never read as
// supported. If only the code knows a format is merely schema-derived (E3), the "no unsupported claim" principle
// is half-done — the person choosing a pack is the one who needs to know.
//
// This pins the presentation rule. The renderer imports the same function; keeping it in services/ lets the rule
// be tested without a DOM, following the repo's mirror-plus-contract-test pattern (electron/services/validate-ipc.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEvidence } from '../../services/evidence-grade';

test('E2 renders as supported with the success tone', () => {
  const shown = describeEvidence({ grade: 'E2' });
  assert.equal(shown.supported, true);
  assert.equal(shown.tone, 'green');
  assert.match(shown.label, /Verified format \(E2\)/);
});

test('E1 renders as supported', () => {
  const shown = describeEvidence({ grade: 'E1' });
  assert.equal(shown.supported, true);
  assert.equal(shown.tone, 'green');
});

test('E3 does NOT render as supported and never uses the success tone', () => {
  const shown = describeEvidence({ grade: 'E3' });
  assert.equal(shown.supported, false, 'E3 must never be presented as supported');
  assert.equal(shown.tone, 'amber', 'a below-E2 grade must not use the success tone');
  assert.match(shown.label, /not yet proven/i);
  assert.doesNotMatch(shown.label, /Verified/);
});

test('E4 (design only) also does NOT render as supported', () => {
  const shown = describeEvidence({ grade: 'E4' });
  assert.equal(shown.supported, false);
  assert.equal(shown.tone, 'amber');
});

test('an unrecognised or future grade fails closed as unsupported', () => {
  for (const grade of ['', 'E0', 'E5', 'e2', 'E2 ', 'unknown']) {
    const shown = describeEvidence({ grade });
    assert.equal(shown.supported, false, `grade "${grade}" must not be treated as supported`);
    assert.equal(shown.tone, 'amber', `grade "${grade}" must not use the success tone`);
  }
});
