// Every create-wizard step must have a way back. Losing one is a trap, and it has now happened once.
//
// Reported: "now the Back button is gone too". Cause: the step-2 back button lived inside BrowseCurseforge, so hiding that
// component on the project branch removed the only exit. The top-right "← Back" is CreateHeader's onCancel, which exits the
// whole wizard — a different action that cannot substitute.
//
// This test enumerates the steps and asserts each renders its own back control, so a future conditional cannot silently
// remove one again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(p, 'utf8');
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('step 1 (Type) has a back-less design by contract, and step 2 can return to it', () => {
  // Step 1 is the first screen; its "back" is the outer cancel. What matters is that step 2 can reach step 1.
  const browse = stripComments(read('src/tabs/create/StepsBrowse.tsx'));
  assert.match(browse, /setStep\(1\)/, 'step 2 must be able to return to step 1');
});

test('step 2 renders a Back control OUTSIDE every branch conditional', () => {
  const browse = read('src/tabs/create/StepsBrowse.tsx');
  const code = stripComments(browse);
  // The back button must be present in the CurseForge block, and must not sit inside the mode-gated ZIP list.
  const backIndex = code.indexOf('← Back');
  assert.ok(backIndex > 0, 'step 2 must render a ← Back control');
  // It must appear AFTER the ZIP-list conditional closes, i.e. at the same level as the branch gates.
  const zipClose = code.indexOf('onContinue={() => {');
  assert.ok(backIndex > zipClose, 'the Back control must come after the ZIP list block, not inside it');
});

test('BrowseCurseforge no longer owns the back button', () => {
  // Ownership was the defect: the button disappeared with its container.
  const zipPanel = stripComments(read('src/tabs/create/BrowseCurseforge.tsx'));
  assert.ok(!/onBack/.test(zipPanel), 'the ZIP panel must not own navigation');
  assert.ok(!/← Back/.test(zipPanel), 'the ZIP panel must not render the back control');
});

test('the ZIP panel props no longer require onBack', () => {
  const zipPanel = read('src/tabs/create/BrowseCurseforge.tsx');
  const props = /interface BrowseCurseforgeProps \{([\s\S]*?)\n\}/.exec(zipPanel);
  assert.ok(props !== null, 'props interface must exist');
  assert.ok(!/onBack/.test(props[1]), 'onBack must not be part of the props');
});

test('step 3 (Configure) has its own back to step 2', () => {
  const configure = stripComments(read('src/tabs/create/StepsConfigure.tsx'));
  assert.match(configure, /onBack=\{\(\) => setStep\(/, 'Configure must navigate back');
  assert.match(configure, /kind === 'vanilla' \? 1 : 2/, 'back target depends on whether step 2 exists for that kind');
});

test('step 4 (Install) can return to Configure', () => {
  const install = stripComments(read('src/tabs/create/StepsInstall.tsx'));
  assert.match(install, /onBackToConfigure=\{\(\) => props\.setStep\(3\)\}/);
  assert.match(install, /onBack=\{\(\) => props\.setStep\(3\)\}/);
});

test('the Modrinth and mock browse screens keep their own back controls', () => {
  // They are separate components with their own navigation; the CurseForge change must not have touched them.
  assert.match(stripComments(read('src/tabs/create/BrowseModrinth.tsx')), /onBack/);
  assert.match(stripComments(read('src/tabs/create/BrowseMock.tsx')), /onBack/);
});

test('the header back exits the wizard, which is a different action and cannot substitute', () => {
  // Documented so nobody "fixes" a missing step-back by pointing at CreateHeader.
  const layout = stripComments(read('src/components/layout.tsx'));
  assert.match(layout, /export function CreateHeader\(\{ onCancel \}/);
  assert.match(layout, /onClick=\{onCancel\}/);
});

test('every CurseForge branch state still shows a back control', () => {
  // The three states: project branch (picker only), zip branch (list), and neither.
  const browse = read('src/tabs/create/StepsBrowse.tsx');
  const code = stripComments(browse);
  const curseforgeBlock = code.slice(code.indexOf("props.kind === 'curseforge'"), code.indexOf("props.kind === 'modrinth'"));
  assert.match(curseforgeBlock, /← Back/, 'the CurseForge step must always render a back control');
  // And it must not be nested inside the mode gate.
  const modeGateStart = curseforgeBlock.indexOf("curseforgeMode !== 'project' && (");
  const modeGateEnd = curseforgeBlock.indexOf(')}', curseforgeBlock.indexOf('onContinue={() => {'));
  const backPos = curseforgeBlock.indexOf('← Back');
  assert.ok(
    modeGateEnd === -1 || backPos > modeGateEnd,
    'the back control must be outside the ZIP-list conditional',
  );
});
