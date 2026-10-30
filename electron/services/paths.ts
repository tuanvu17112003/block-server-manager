// Data-root resolution.
//
// Three deployment shapes, three different answers for "where does user data live":
//
//   dev        — inside the project (`.app-data/`), so a developer sees what the app writes and it is git-ignored.
//   installed  — under Electron's userData (`%APPDATA%/Block Server Manager/data`), the platform-correct location that
//                survives an app update and is cleaned up as the OS expects.
//   portable   — beside the executable, in `data/`, because the entire point of a portable build is that copying the
//                folder to a USB stick carries the servers with it. Before this, a "portable" build would still have
//                written to %APPDATA%, so moving it to another machine silently lost every server — the exact thing
//                portable users are trying to avoid.
//
// Portable detection uses `PORTABLE_EXECUTABLE_DIR`, which electron-builder's portable target sets at launch to the
// directory the user actually ran the exe from (which is the real location, not the temporary extraction directory the
// exe unpacks itself into).
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

let cached: string | null = null;

/** True when running from an electron-builder portable build. Exported so diagnostics can report the mode. */
export function isPortable(): boolean {
  return typeof process.env.PORTABLE_EXECUTABLE_DIR === 'string' && process.env.PORTABLE_EXECUTABLE_DIR !== '';
}

/** Directory that holds `data/` for the current deployment shape. Exported for tests and diagnostics. */
export function dataRootParent(): string {
  if (isPortable()) return process.env.PORTABLE_EXECUTABLE_DIR as string;
  return app.isPackaged ? app.getPath('userData') : app.getAppPath();
}

export function dataRoot(): string {
  if (cached) return cached;
  // Portable keeps data beside the exe; installed uses userData; dev uses the project folder (as `.app-data`).
  if (isPortable()) {
    cached = path.join(process.env.PORTABLE_EXECUTABLE_DIR as string, 'data');
  } else if (app.isPackaged) {
    cached = path.join(app.getPath('userData'), 'data');
  } else {
    cached = path.join(app.getAppPath(), '.app-data');
  }
  fs.mkdirSync(cached, { recursive: true });
  return cached;
}

/** Test hook: forget the memoised root so a test can change the environment and resolve again. */
export function resetDataRootForTest(): void {
  cached = null;
}

/**
 * Best-effort check that the portable data folder is writable.
 *
 * A portable build often runs from a USB stick, a network share, or `C:\Program Files` where it cannot write. Failing
 * at the first server download with "EACCES" is a confusing way to learn that; this probes up front so the app can say
 * something useful instead.
 */
export function portableDataRootIsWritable(): { writable: boolean; detail: string } {
  if (!isPortable()) return { writable: true, detail: 'not a portable build' };
  const root = dataRoot();
  const probe = path.join(root, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return { writable: true, detail: root };
  } catch (error) {
    return { writable: false, detail: `${root}: ${(error as Error).message}` };
  }
}
