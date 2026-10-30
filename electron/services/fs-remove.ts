// Tolerant removal of a directory tree.
//
// Written because the plain `fs.rmSync(dir, { recursive: true, force: true })` is not tolerant at all: `force` only
// suppresses ENOENT, and on Windows a directory cannot be removed while any process holds a handle inside it or has it as
// its working directory. Measured on this machine:
//
//   fs.rmSync(dir, { recursive: true, force: true })                  -> EPERM, directory still present
//   fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })   -> EPERM, directory still present
//
// `maxRetries` does not help either, because Node's retry loop still gives up against a live process. What does help is
// waiting longer and retrying at a higher level, which is what this module does.
//
// The callers care about one question: did the directory actually go away? A caller that deletes a store record before
// confirming the directory is gone can end up with an invisible 100 MB folder — which is exactly the delete bug this was
// written to fix. So the return value reports the outcome rather than throwing an opaque code, and the caller decides.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';

export interface RemoveDirectoryResult {
  /** True when the directory is no longer present. */
  removed: boolean;
  /** Number of top-level entries still present when removal failed; 0 when removed. */
  leftover: number;
  /** Last error code seen, when removal failed. */
  code?: string;
}

/** Remove a directory tree, retrying while a transient lock clears. Synchronous: used from sync IPC handlers. */
export function removeDirectorySync(dir: string, options: { attempts?: number; baseDelayMs?: number } = {}): RemoveDirectoryResult {
  const attempts = options.attempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 150;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!fs.existsSync(dir)) return { removed: true, leftover: 0 };
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      // Fall through to the presence check: partial removal is common, so the answer is whether it is gone.
    }
    if (!fs.existsSync(dir)) return { removed: true, leftover: 0 };
    if (attempt < attempts - 1) {
      // Blocking sleep is acceptable here: this is a bounded, user-initiated operation (delete a server), the total budget
      // is about 3 seconds, and the alternative is leaving a large orphaned folder behind.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, baseDelayMs + attempt * baseDelayMs);
    }
  }

  let leftover = 0;
  let code: string | undefined;
  try {
    leftover = fs.readdirSync(dir).length;
  } catch (error) {
    // The directory went away between the last attempt and this check.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true, leftover: 0 };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code;
  }
  return { removed: !fs.existsSync(dir), leftover, ...(code !== undefined ? { code } : {}) };
}

/** Async variant, for callers already in an async context (keeps the event loop free during the retry waits). */
export async function removeDirectory(dir: string, options: { attempts?: number; baseDelayMs?: number } = {}): Promise<RemoveDirectoryResult> {
  const attempts = options.attempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 150;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!fs.existsSync(dir)) return { removed: true, leftover: 0 };
    try {
      await fsPromises.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      // Presence check below decides.
    }
    if (!fs.existsSync(dir)) return { removed: true, leftover: 0 };
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, baseDelayMs + attempt * baseDelayMs));
  }

  let leftover = 0;
  try {
    leftover = fs.readdirSync(dir).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true, leftover: 0 };
  }
  return { removed: !fs.existsSync(dir), leftover };
}

/**
 * Explain why a directory could not be removed, in terms a user can act on.
 *
 * Returns the reasons that actually apply on Windows, most likely first, rather than a generic "permission denied".
 */
export function describeRemovalFailure(dir: string): string {
  const name = dir.split(/[\\/]/).filter((part) => part !== '').pop() ?? dir;
  return `Could not remove the server folder "${name}". A process is still using files inside it — most often a server `
    + 'that has not finished shutting down, or an antivirus scan reading the jars. The server has been kept in the list '
    + 'so nothing is lost: press Delete again in a few seconds.';
}
