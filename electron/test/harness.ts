// Shared test harness helpers. Node-only (no Electron import) so it can be used by
// `node --test` unit suites and by the Electron service/contract/UI runners.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Check {
  suite: string;
  name: string;
  ok: boolean;
  detail?: string;
}

export class TestRun {
  readonly checks: Check[] = [];
  constructor(readonly suite: string) {}

  check(name: string, ok: boolean, detail?: unknown): void {
    this.checks.push({
      suite: this.suite,
      name,
      ok: Boolean(ok),
      detail: detail === undefined ? undefined : String(detail).slice(0, 600),
    });
  }

  /** Run `fn`; record pass unless it throws. */
  async must(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      this.check(name, true);
    } catch (error) {
      this.check(name, false, error instanceof Error ? (error.stack ?? error.message) : error);
    }
  }

  get failed(): Check[] { return this.checks.filter((check) => !check.ok); }
  get ok(): boolean { return this.checks.length > 0 && this.failed.length === 0; }

  lines(): string[] {
    return this.checks.map((check) =>
      `${check.ok ? 'PASS' : 'FAIL'} ${check.suite}/${check.name}${!check.ok && check.detail ? ` — ${check.detail}` : ''}`);
  }
}

export interface TempRoot {
  root: string;
  cleanup: () => void;
}

export function tempRoot(label = 'msm-test'): TempRoot {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return {
    root,
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }); }
      catch {
        // Windows can briefly hold handles; a leaked temp dir must not fail a test run.
      }
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `fn` until it returns a truthy value or the timeout expires. */
export function waitFor<T>(
  fn: () => T | null | undefined | false,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const { timeoutMs = 10_000, intervalMs = 50, label = 'condition' } = opts;
  const started = Date.now();
  return new Promise<T>((resolve, reject) => {
    const timer = setInterval(() => {
      let value: T | null | undefined | false = null;
      try { value = fn(); } catch { value = null; }
      if (value) { clearInterval(timer); resolve(value as T); return; }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${label}`));
      }
    }, intervalMs);
  });
}

/** Wait until an async predicate is truthy (for polling IPC/UI state). */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 50, label = 'condition' } = opts;
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`);
    await sleep(intervalMs);
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch { return fallback; }
}
