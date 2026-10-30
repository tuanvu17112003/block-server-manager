// Auto-update.
//
// This service wraps `electron-updater` and exposes the small, honest surface the UI needs: what version is running,
// whether an update exists, how far a download has got, and when it is safe to restart. Everything here fails soft —
// an update check is a convenience, never a reason the app stops working. A machine with no network, or a user who
// declined, must still get a fully functional server manager.
//
// Design decisions worth stating, because each one is a place auto-update usually goes wrong:
//
//  * The check is opt-out and non-blocking. It runs once at startup, after the window is usable, and never on a timer
//    that could interrupt a running server.
//  * Downloads are explicit. The app does not silently pull ~116 MB in the background while someone is playing; the
//    user is told, and decides.
//  * Installing restarts the app, which must never happen with a server running. `canInstallNow` is false unless the
//    caller confirms no server is active — the restart is the destructive part, not the download.
//  * Errors are reported as data, not thrown across IPC. `error` is a human-readable string, because "checkForUpdates
//    failed" with a stack trace helps nobody.
//
// Portable builds are deliberately excluded: electron-updater installs by replacing an installed application, and a
// portable exe has no installation to replace. Rather than appearing to update and then leaving a stale exe beside a
// fresh data folder, the service reports `supported: false` with the reason.
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import { app } from 'electron';
import { isPortable } from './paths';
import { log } from './installer/core';

/** How far the update lifecycle has got. Renderers switch on this rather than inferring from flags. */
export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported';

export interface UpdateState {
  /** Whether this build can self-update at all (false for portable and for dev builds). */
  supported: boolean;
  /** Why it cannot, when `supported` is false. Shown verbatim to the user. */
  unsupportedReason?: string;
  stage: UpdateStage;
  /** Version currently running. */
  currentVersion: string;
  /** Version that would be installed, when known. */
  availableVersion?: string;
  /** 0-100 while downloading; undefined otherwise. */
  percent?: number;
  /** Human-readable failure, only set when stage === 'error'. */
  error?: string;
  /** Release notes for the available version, sanitised to plain text. */
  releaseNotes?: string;
  /** ISO timestamp of the last completed check, so the UI can say "checked 3 minutes ago". */
  lastCheckedAt?: string;
}

let updaterInstance: AppUpdater | null = null;
let state: UpdateState = {
  supported: false,
  stage: 'idle',
  currentVersion: app.getVersion(),
};

/** Listeners the IPC layer subscribes to so state changes reach the renderer as events, not polling. */
type StateListener = (next: UpdateState) => void;
const listeners = new Set<StateListener>();

export function onUpdateState(listener: StateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    try { listener(state); } catch { /* a broken listener must not break the updater */ }
  }
  return state;
}

/** Strip HTML from release notes: they come from GitHub and are rendered as text. */
function plainNotes(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (typeof notes !== 'string') return undefined;
  const text = notes.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  return text.slice(0, 2000);
}

export function updateState(): UpdateState {
  return state;
}

/**
 * Initialise the updater. Safe to call once at startup; idempotent afterwards.
 *
 * Returns the state so the caller can log why updating is unavailable, which is the single most useful diagnostic when
 * a user reports "it says no updates".
 */
export function initUpdater(options: { feedUrl?: string } = {}): UpdateState {
  if (updaterInstance !== null) return state;

  // Portable: no installation to replace.
  if (isPortable()) {
    state = publish({
      supported: false,
      stage: 'unsupported',
      unsupportedReason:
        'This is the portable build, which updates by replacing itself rather than installing over a previous version. '
        + 'Download the new version from the releases page and replace the exe; your data folder is untouched.',
    });
    return state;
  }

  // Unpackaged (npm run dev): there is no published artefact to compare against.
  if (!app.isPackaged) {
    state = publish({
      supported: false,
      stage: 'unsupported',
      unsupportedReason: 'Updates are only available in packaged builds.',
    });
    return state;
  }

  // Loaded lazily so a packaging mistake only breaks the update feature, not app startup.
  let autoUpdater: AppUpdater;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as { autoUpdater: AppUpdater };
    autoUpdater = mod.autoUpdater;
  } catch (error) {
    state = publish({
      supported: false,
      stage: 'unsupported',
      unsupportedReason: `The updater is unavailable in this build: ${(error as Error).message}`,
    });
    return state;
  }

  // Never download without asking: the request would compete with server traffic and can be hundreds of MB.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  if (options.feedUrl) {
    autoUpdater.setFeedURL({ provider: 'generic', url: options.feedUrl });
  }

  autoUpdater.on('checking-for-update', () => {
    publish({ stage: 'checking', error: undefined });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    publish({
      stage: 'available',
      availableVersion: info.version,
      releaseNotes: plainNotes(info.releaseNotes),
      error: undefined,
      lastCheckedAt: new Date().toISOString(),
    });
    log(`[update] available: ${info.version} (running ${app.getVersion()})`);
  });

  autoUpdater.on('update-not-available', () => {
    publish({
      stage: 'not-available',
      availableVersion: undefined,
      releaseNotes: undefined,
      error: undefined,
      lastCheckedAt: new Date().toISOString(),
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    publish({ stage: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    publish({ stage: 'downloaded', availableVersion: info.version, percent: 100 });
    log(`[update] downloaded ${info.version}; ready to install on restart`);
  });

  autoUpdater.on('error', (error: Error) => {
    // A failed update check is not an app failure. Report it, keep running.
    publish({ stage: 'error', error: error.message, lastCheckedAt: new Date().toISOString() });
    log(`[update] error: ${error.message}`);
  });

  updaterInstance = autoUpdater;
  state = publish({ supported: true, stage: 'idle' });
  return state;
}

/**
 * Ask GitHub for the latest release.
 *
 * `allowPrerelease` is false: this project tags stable releases, and pulling a prerelease into a server manager
 * uninvited is not a good trade.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  if (updaterInstance === null) return state;
  try {
    await updaterInstance.checkForUpdates();
  } catch (error) {
    // electron-updater also emits 'error', but a throw here means the check never started; report it once.
    publish({ stage: 'error', error: (error as Error).message, lastCheckedAt: new Date().toISOString() });
  }
  return state;
}

/** Begin downloading the available update. No-op unless one is available. */
export async function downloadUpdate(): Promise<UpdateState> {
  if (updaterInstance === null) return state;
  if (state.stage !== 'available') return state;
  try {
    await updaterInstance.downloadUpdate();
  } catch (error) {
    publish({ stage: 'error', error: (error as Error).message });
  }
  return state;
}

/**
 * Whether installing right now is safe.
 *
 * The restart kills every child process, which would take a running Minecraft server with it. The caller passes what it
 * knows about active servers; this refuses rather than trusting the renderer to have checked.
 */
export function canInstallNow(activeServerCount: number): { ok: boolean; reason?: string } {
  if (state.stage !== 'downloaded') {
    return { ok: false, reason: 'No update has finished downloading yet.' };
  }
  if (activeServerCount > 0) {
    return {
      ok: false,
      reason: 'Stop all servers before installing the update — the app restarts to apply it.',
    };
  }
  return { ok: true };
}

/**
 * Quit and install the downloaded update.
 *
 * Returns false (without quitting) when it is unsafe, so the caller can show the reason. `isSilent: false` and
 * `isForceRunAfter: true` mean the user sees the installer progress and the app comes back afterwards.
 */
export function installUpdate(activeServerCount: number): boolean {
  if (updaterInstance === null) return false;
  const allowed = canInstallNow(activeServerCount);
  if (!allowed.ok) {
    log(`[update] install refused: ${allowed.reason}`);
    return false;
  }
  setImmediate(() => {
    try {
      updaterInstance!.quitAndInstall(false, true);
    } catch (error) {
      publish({ stage: 'error', error: (error as Error).message });
    }
  });
  return true;
}

/** Test hook: drop the singleton so a test can re-initialise under different conditions. */
export function resetUpdaterForTest(): void {
  updaterInstance = null;
  listeners.clear();
  state = { supported: false, stage: 'idle', currentVersion: app.getVersion() };
}
