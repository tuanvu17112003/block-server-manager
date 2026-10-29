// P1b tests: the format-agnostic recipe installer's planning rules.
//
// These are the rules that decide what a *server* gets, so they are tested without touching disk or
// network: side mapping, plan exclusions, optional defaults, manager-owned protection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRecipeFiles } from '../../services/installer/recipe';
import type { PackRecipe, PlannedFile } from '../../services/adapters/types';

function file(path: string, side: PlannedFile['side']): PlannedFile {
  return { path, source: { urls: [`https://example.test/${path}`] }, side, sideProvenance: 'test' };
}

function recipe(files: PlannedFile[]): PackRecipe {
  return {
    formatId: 'ftb.app',
    name: 'P',
    mc: '1.20.1',
    loader: 'forge',
    loaderVersion: '47.2.0',
    javaMajor: 17,
    files,
    overrides: [],
    launchShape: 'generated-args',
    managerOwned: [],
    warnings: [],
    resolution: [],
    evidenceGrade: 'E3',
    evidenceNote: 'test fixture',
  };
}

test('planRecipeFiles: required and unknown install, unsupported is skipped and counted', () => {
  const plan = planRecipeFiles(recipe([
    file('mods/a.jar', 'required'),
    file('mods/b.jar', 'unknown'),
    file('mods/c.jar', 'unsupported'),
    file('mods/d.jar', 'optional'),
  ]));
  assert.deepEqual(plan.install.map(entry => entry.path), ['mods/a.jar', 'mods/b.jar']);
  assert.equal(plan.skippedUnsupported, 1);
  assert.equal(plan.skippedOptional, 1, 'optional is skipped unless force-included');
  assert.equal(plan.skippedUserExcluded, 0);
});

test('planRecipeFiles: `unknown` is never collapsed into `unsupported`', () => {
  const plan = planRecipeFiles(recipe([file('mods/mystery.jar', 'unknown')]));
  assert.equal(plan.install.length, 1, 'an undeclared side must stay a server candidate');
  assert.equal(plan.skippedUnsupported, 0);
});

test('planRecipeFiles: a reviewed-plan exclusion wins over every side', () => {
  const plan = planRecipeFiles(
    recipe([file('mods/a.jar', 'required'), file('mods/b.jar', 'optional')]),
    { excludeFiles: new Set(['mods/a.jar']) },
  );
  assert.deepEqual(plan.install.map(entry => entry.path), []);
  assert.equal(plan.skippedUserExcluded, 1);
});

test('planRecipeFiles: force-include installs an optional file', () => {
  const plan = planRecipeFiles(
    recipe([file('mods/opt.jar', 'optional')]),
    { includeFiles: new Set(['mods/opt.jar']) },
  );
  assert.deepEqual(plan.install.map(entry => entry.path), ['mods/opt.jar']);
  assert.equal(plan.skippedOptional, 0);
});

test('planRecipeFiles: manager-owned state is never installed from a pack', () => {
  const plan = planRecipeFiles(recipe([
    file('eula.txt', 'required'),
    file('server.properties', 'required'),
    file('ops.json', 'required'),
    file('mods/ok.jar', 'required'),
  ]));
  assert.deepEqual(plan.install.map(entry => entry.path), ['mods/ok.jar'],
    'a pack must never overwrite eula/properties/ops');
});

