// Every rendered state of the version picker must offer a way forward (and the step must offer a way back).
//
// The picker returned early in three states — loading, error, empty — and the early returns had no action row. That made
// step 2 a dead end: while loading there was no Continue, and in the error/empty states the user could never proceed at
// all. Combined with the back button having moved out of the ZIP panel, a user could reach a screen with no exit at all.
//
// This test asserts the action row is defined once and rendered in every branch, so a new early return cannot silently
// reintroduce the dead end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const picker = readFileSync('src/tabs/create/CurseForgeVersionPicker.tsx', 'utf8');

/** All the early `return (...)` blocks and the final return, as source text. */
function returnBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /return\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) { blocks.push(source.slice(start, i + 1)); break; }
      }
    }
  }
  return blocks;
}

test('the action row is defined in exactly one place', () => {
  const occurrences = (picker.match(/const renderActions = /g) ?? []).length;
  assert.equal(occurrences, 1, 'renderActions must be defined once so every branch can share it');
});

test('every renderable state calls renderActions', () => {
  const blocks = returnBlocks(picker);
  assert.ok(blocks.length >= 4, `expected loading, error, empty and list states, found ${blocks.length}`);
  // Only TOP-LEVEL returns are state blocks. Nested returns (inside `.map` callbacks) render a single row and must not be
  // expected to render the whole action row.
  const topLevel = blocks.filter((block) => !/^\s*\(\s*<li/.test(block));
  const states = topLevel.filter((block) => /className|<p|<div|<ul/.test(block) && !/onClick=\{props\.onContinue\}/.test(block));
  assert.ok(states.length >= 4, `expected at least four state blocks, found ${states.length}`);
  for (const [index, block] of states.entries()) {
    assert.match(block, /renderActions\(\)/, `state block ${index} must render the action row`);
  }
});

test('Continue stays disabled until a version is chosen', () => {
  assert.match(picker, /disabled=\{props\.selectedFileId === null\}/);
});

test('the picker does not itself render a back button', () => {
  // Back belongs to the step container so it survives every branch; a second copy here would be redundant and could drift.
  assert.ok(!/← Back/.test(picker), 'the picker must not own navigation');
});

test('loading, error and empty states all still render the row', () => {
  // Named explicitly because these are the three early returns that lost it.
  const loadingBlock = /if \(loading\) \{([\s\S]*?)\n  \}/.exec(picker);
  const errorBlock = /if \(error !== null\) \{([\s\S]*?)\n  \}/.exec(picker);
  const emptyBlock = /if \(versions\.length === 0\) \{([\s\S]*?)\n  \}/.exec(picker);
  for (const [name, match] of [['loading', loadingBlock], ['error', errorBlock], ['empty', emptyBlock]] as const) {
    assert.ok(match !== null, `${name} branch must exist`);
    assert.match(match[1], /renderActions\(\)/, `the ${name} branch must render the action row`);
  }
});
