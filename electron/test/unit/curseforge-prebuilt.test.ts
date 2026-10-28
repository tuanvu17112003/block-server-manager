// CurseForge route-A prebuilt detection (serverpack-tools.md §3 shapes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packShipsRunnableServer } from '../../services/installer/curseforge';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msm-cf-prebuilt-'));
}

test('detects prebuilt Forge/NeoForge layouts (libraries is the launch evidence)', () => {
  const dir = tempDir();
  try {
    assert.equal(packShipsRunnableServer(dir), false);
    fs.writeFileSync(path.join(dir, 'run.bat'), 'java @user_jvm_args.txt');
    assert.equal(packShipsRunnableServer(dir), false, 'a run script alone is not enough');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const dir2 = tempDir();
  try {
    fs.mkdirSync(path.join(dir2, 'libraries'), { recursive: true });
    assert.equal(packShipsRunnableServer(dir2), true);
  } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
});

test('detects prebuilt Fabric/Quilt launchers and old Forge universal jars', () => {
  const fabric = tempDir();
  try {
    fs.writeFileSync(path.join(fabric, 'fabric-server-launch.jar'), 'jar');
    assert.equal(packShipsRunnableServer(fabric), true);
  } finally { fs.rmSync(fabric, { recursive: true, force: true }); }
  const oldForge = tempDir();
  try {
    fs.writeFileSync(path.join(oldForge, 'forge-1.12.2-14.23.5.2860-universal.jar'), 'jar');
    assert.equal(packShipsRunnableServer(oldForge), true);
  } finally { fs.rmSync(oldForge, { recursive: true, force: true }); }
});

test('a bare server.jar is prebuilt only when the pack has no mods/plugins', () => {
  const vanilla = tempDir();
  try {
    fs.writeFileSync(path.join(vanilla, 'server.jar'), 'jar');
    assert.equal(packShipsRunnableServer(vanilla), true);
    fs.mkdirSync(path.join(vanilla, 'mods'));
    assert.equal(packShipsRunnableServer(vanilla), false);
  } finally { fs.rmSync(vanilla, { recursive: true, force: true }); }
});

test('run scripts / user_jvm_args alone are not prebuilt evidence (SF5-style packs ship an installer)', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'run.bat'), 'java @user_jvm_args.txt');
    fs.writeFileSync(path.join(dir, 'user_jvm_args.txt'), '-Xmx4G');
    fs.writeFileSync(path.join(dir, 'forge-1.20.1-47.4.0-installer.jar'), 'installer');
    assert.equal(packShipsRunnableServer(dir), false, 'the shipped installer must still be executed');
    fs.mkdirSync(path.join(dir, 'libraries'), { recursive: true });
    assert.equal(packShipsRunnableServer(dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
