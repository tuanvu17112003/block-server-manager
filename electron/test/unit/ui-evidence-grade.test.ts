// Evidence-grade presentation rule, now including DV-44: a proven format whose plan downloads nothing must NOT
// render as a green "verified".
//
// Two rules are pinned here, both about not promising more than the evidence supports:
//   1. a below-E2 grade never reads as supported (Item 4);
//   2. E2 means "a real artefact was recognised", NOT "installing this will populate the server" — a
//      Prism/MultiMC instance is a genuine E2 artefact built by a third party, yet it ships launcher config plus a
//      packwiz updater jar and no mods, so its recipe legitimately plans zero files. Rendering that green would
//      promise a server full of mods and deliver an empty one.
//
// The renderer mirrors this function (see the note in src/tabs/create/helpers.ts); keeping the rule here lets it be
// tested without a DOM, following the repo's mirror-plus-contract-test pattern (electron/services/validate-ipc.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEvidence } from '../../services/evidence-grade';

// ---- rule 1: below E2 is never supported ----

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

test('an unrecognised or future grade fails closed, even with a populated plan', () => {
  for (const grade of ['', 'E0', 'E5', 'e2', 'E2 ', 'unknown']) {
    const shown = describeEvidence({ grade, selfContained: true, plannedFileCount: 5 });
    assert.equal(shown.supported, false, `grade "${grade}" must not be treated as supported`);
    assert.equal(shown.tone, 'amber', `grade "${grade}" must not use the success tone`);
  }
});

// ---- rule 2: E2 + empty plan is not "ready" ----

test('E2 with a populated plan renders as supported and green', () => {
  const shown = describeEvidence({ grade: 'E2', selfContained: true, plannedFileCount: 565 });
  assert.equal(shown.supported, true);
  assert.equal(shown.tone, 'green');
  assert.match(shown.label, /Verified format \(E2\)/);
});

test('E2 with an EMPTY plan does not render as supported and never green', () => {
  // The Prism/MultiMC case: recognised correctly, but there is nothing to install.
  const shown = describeEvidence({ grade: 'E2', selfContained: false, plannedFileCount: 0 });
  assert.equal(shown.supported, false, 'a plan with no files must not read as verified-and-ready');
  assert.equal(shown.tone, 'amber');
  assert.match(shown.label, /Launcher instance/);
  assert.match(shown.label, /no files to install/);
  assert.doesNotMatch(shown.label, /Verified format/);
});

test('E1 with an empty plan is treated the same way (grade alone is not enough)', () => {
  const shown = describeEvidence({ grade: 'E1', selfContained: false, plannedFileCount: 0 });
  assert.equal(shown.supported, false);
  assert.equal(shown.tone, 'amber');
});

test('E1 with a populated plan renders as supported', () => {
  const shown = describeEvidence({ grade: 'E1', selfContained: true, plannedFileCount: 100 });
  assert.equal(shown.supported, true);
  assert.equal(shown.tone, 'green');
});

test('omitting selfContained keeps the previous behaviour (back-compat for callers without the flag)', () => {
  // Only an explicit `false` downgrades the badge, so a caller that cannot supply the field is not silently
  // downgraded; every caller that CAN supply it does.
  const shown = describeEvidence({ grade: 'E2' });
  assert.equal(shown.supported, true);
  assert.equal(shown.tone, 'green');
});
