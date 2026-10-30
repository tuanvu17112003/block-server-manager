// Portable-build data-root rule.
//
// Why this test exists: the first version of this feature would have shipped a "portable" exe that still wrote its
// servers to %APPDATA%. The app would run, appear to work, and silently lose every server the moment the user copied
// the folder to another machine — which is the one thing portable users are trying to do. A build that boots is not
// evidence that it is portable; the data location is the actual contract, so the contract is pinned here.
//
// The rule under test (electron/services/paths.ts):
//   portable (PORTABLE_EXECUTABLE_DIR set) -> <exe dir>/data
//   installed (app.isPackaged, no portable) -> <userData>/data
//   dev (neither)                           -> <project>/.app-data
//
// This re-derives the decision from the same inputs rather than importing Electron, which cannot be loaded in a plain
// Node test process. That mirrors the pattern used for the renderer/electron mirror in ui-evidence-grade.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

interface Env {
  portableDir: string | undefined;
  packaged: boolean;
  userData: string;
  appPath: string;
}

/** Mirrors dataRoot() in electron/services/paths.ts. */
function resolveDataRoot(env: Env): string {
  if (typeof env.portableDir === 'string' && env.portableDir !== '') {
    return path.join(env.portableDir, 'data');
  }
  if (env.packaged) return path.join(env.userData, 'data');
  return path.join(env.appPath, '.app-data');
}

const BASE: Env = {
  portableDir: undefined,
  packaged: true,
  userData: 'C:\\Users\\someone\\AppData\\Roaming\\Block Server Manager',
  appPath: 'C:\\projects\\block-server-manager',
};

test('portable build keeps its data beside the executable, not in %APPDATA%', () => {
  const exeDir = 'D:\\Games\\BlockServerManager';
  const root = resolveDataRoot({ ...BASE, portableDir: exeDir });
  assert.equal(root, path.join(exeDir, 'data'),
    'a portable build must write next to the exe so the folder can be moved with its servers');
  assert.ok(!root.toLowerCase().includes('appdata'),
    'a portable build must never fall back to %APPDATA% — that is what made the first attempt not actually portable');
});

test('portable on another drive still resolves on that drive (the move-to-USB case)', () => {
  const usb = 'E:\\Block Server Manager';
  assert.equal(resolveDataRoot({ ...BASE, portableDir: usb }), path.join(usb, 'data'));
});

test('installed build keeps using userData', () => {
  const root = resolveDataRoot({ ...BASE, packaged: true });
  assert.equal(root, path.join(BASE.userData, 'data'));
});

test('dev build keeps using the project folder', () => {
  const root = resolveDataRoot({ ...BASE, packaged: false });
  assert.equal(root, path.join(BASE.appPath, '.app-data'));
});

test('portable wins over the packaged flag (a portable exe IS packaged, so order matters)', () => {
  // This is the precedence bug that would silently reintroduce the %APPDATA% behaviour: PORTABLE_EXECUTABLE_DIR is set
  // on a build where app.isPackaged is also true, so checking `packaged` first would ignore portable entirely.
  const root = resolveDataRoot({ ...BASE, packaged: true, portableDir: 'F:\\portable' });
  assert.equal(root, path.join('F:\\portable', 'data'));
  assert.notEqual(root, path.join(BASE.userData, 'data'));
});

test('an empty PORTABLE_EXECUTABLE_DIR string is treated as not portable', () => {
  // electron-builder sets the variable for portable builds only; an empty value must not produce a relative path like
  // "data" that would land in the process working directory (often System32 when launched from a shortcut).
  assert.equal(resolveDataRoot({ ...BASE, portableDir: '' }), path.join(BASE.userData, 'data'));
});

test('the portable data folder name is exactly "data" — it is documented to users', () => {
  const root = resolveDataRoot({ ...BASE, portableDir: 'G:\\x' });
  assert.equal(path.basename(root), 'data');
});
