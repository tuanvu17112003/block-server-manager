// Launch argument extraction for Forge/NeoForge run.bat scripts.
//
// This is a regression test for a reported install failure. After 1.20.4, Forge writes a run.bat that checks the JVM with a
// shim BEFORE the real launch:
//
//   java -jar forge-1.20.4-49.2.13-shim.jar --onlyCheckJava   <- exits 0
//   if %ERRORLEVEL% NEQ 0 ( ... goto :exit )
//   java @user_jvm_args.txt @libraries/.../win_args.txt %*
//
// The old parser collected every line containing `java`, so the JVM ran the shim, exited 0, and the installer reported
// "process exited (code 0) before Done (" — a boot verification failure on a perfectly good install.
//
// The second bug the same parser had was subtler: it applied the .bat filter recursively to @argument files, which never
// contain the word `java`, so every token was dropped and the launch became `java nogui` with no jar and no classpath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCommand } from '../../services/installer/core';

/** Build a server dir with the given run.bat and supporting files. */
function makeServer(batLines: string[], files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  fs.writeFileSync(path.join(dir, 'run.bat'), batLines.join('\r\n'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

test('the shim pre-flight line is skipped and the real launch line is used', () => {
  // The exact shape Forge 1.20.4+ writes, copied from a real staging folder on this machine.
  const dir = makeServer(
    [
      '@echo off',
      'REM Add custom JVM arguments (such as RAM allocation) to the user_jvm_args.txt',
      '',
      'java -jar forge-1.20.4-49.2.13-shim.jar --onlyCheckJava',
      'if %ERRORLEVEL% NEQ 0 (',
      '    echo.',
      "    echo If you're struggling to fix the error above, ask for help on the forums.",
      '    goto :exit',
      ')',
      '',
      'REM Add custom program arguments (such as nogui) to the next line before the %* or pass them to this script',
      'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.4-49.2.13/win_args.txt %*',
      '',
      ':exit',
      'pause',
    ],
    {
      'user_jvm_args.txt': '-Xmx4G\n-Xms1G',
      'libraries/net/minecraftforge/forge/1.20.4-49.2.13/win_args.txt': 'net.minecraftforge.server.ServerMain\n--nogui',
    },
  );
  try {
    const cmd = launchCommand(dir, 'java.exe');
    const text = cmd.args.join(' ');
    assert.ok(!/shim/i.test(text), `the shim must not be launched: ${text}`);
    assert.ok(!/onlyCheckJava/i.test(text), `the JVM pre-flight check must not be launched: ${text}`);
    // The real args are present, so java has a main class and a heap size.
    assert.ok(cmd.args.some((a) => a.includes('ServerMain')), `main class missing from ${JSON.stringify(cmd.args)}`);
    assert.ok(cmd.args.includes('-Xmx4G'), `heap arg missing from ${JSON.stringify(cmd.args)}`);
    assert.ok(cmd.args.includes('nogui'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a classic Forge 1.20.1 run.bat still resolves its @args files', () => {
  // Forge <=1.20.1 has no shim, but it does use @file references exactly like the newer script.
  const dir = makeServer(
    [
      '@echo off',
      'REM Forge requires a configured set of both JVM and program arguments.',
      'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.4.23/win_args.txt nogui %*',
      'pause',
    ],
    {
      'user_jvm_args.txt': '-Xmx8G',
      'libraries/net/minecraftforge/forge/1.20.1-47.4.23/win_args.txt':
        '-p libraries/cpw/mods/bootstraplauncher.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n--launchTarget forgeserver',
    },
  );
  try {
    const cmd = launchCommand(dir, 'java.exe');
    assert.ok(cmd.args.includes('-Xmx8G'), `user_jvm_args must be expanded: ${JSON.stringify(cmd.args)}`);
    assert.ok(cmd.args.some((a) => a.includes('bootstraplauncher.jar')), 'win_args classpath must be expanded');
    assert.ok(cmd.args.some((a) => a.includes('BootstrapLauncher')), 'main class must survive');
    assert.ok(cmd.args.includes('nogui'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('batch control flow is never forwarded as JVM arguments', () => {
  // `if`, `goto`, `echo`, labels and parens are script syntax. Passing them to java produces a cryptic class-not-found
  // error instead of a working server, and this is what a naive line scan did.
  const dir = makeServer(
    [
      '@echo off',
      'if %ERRORLEVEL% NEQ 0 (',
      '    goto :exit',
      ')',
      ':exit',
      'java -jar server.jar nogui',
      'pause',
    ],
    {},
  );
  try {
    const cmd = launchCommand(dir, 'java.exe');
    assert.deepEqual(cmd.args, ['-jar', 'server.jar', 'nogui']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing @args file is dropped rather than passed through literally', () => {
  // Passing "@user_jvm_args.txt" through makes java fail with "Could not find or load main class @user_jvm_args.txt",
  // which tells the user nothing about the real problem.
  const dir = makeServer(
    ['@echo off', 'java @does_not_exist.txt -jar server.jar nogui', 'pause'],
    {},
  );
  try {
    const cmd = launchCommand(dir, 'java.exe');
    assert.ok(!cmd.args.some((a) => a.startsWith('@')), `a literal @file must not reach the JVM: ${JSON.stringify(cmd.args)}`);
    assert.ok(cmd.args.includes('-jar'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Fabric and vanilla still launch from their jars', () => {
  const fabric = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-fabric-'));
  fs.writeFileSync(path.join(fabric, 'fabric-server-launch.jar'), 'jar');
  try {
    assert.deepEqual(launchCommand(fabric, 'java.exe').args, ['-jar', 'fabric-server-launch.jar', 'nogui']);
  } finally {
    fs.rmSync(fabric, { recursive: true, force: true });
  }

  const vanilla = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-vanilla-'));
  fs.writeFileSync(path.join(vanilla, 'server.jar'), 'jar');
  try {
    assert.deepEqual(launchCommand(vanilla, 'java.exe').args, ['-jar', 'server.jar', 'nogui']);
  } finally {
    fs.rmSync(vanilla, { recursive: true, force: true });
  }
});

test('old Forge (1.12.x) universal jar is still found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-oldforge-'));
  fs.writeFileSync(path.join(dir, 'forge-1.12.2-14.23.5.2860-universal.jar'), 'jar');
  try {
    const cmd = launchCommand(dir, 'java.exe');
    assert.ok(cmd.args.some((a) => a.includes('14.23.5.2860-universal.jar')), JSON.stringify(cmd.args));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
