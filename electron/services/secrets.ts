// Electron binding for CurseForge key storage (WP-7.3 / D11).
//
// Preferred storage is the OS keystore via `safeStorage` (encrypted `curseforge-key.enc`); when the
// OS store is unavailable we fall back to the legacy plaintext `<dataRoot>/curseforge-key.txt`
// (mode 0600 intent). Key material never leaves the main process: the renderer only receives the
// `CurseForgeKeyStatusDto` summary. Nothing in this module logs key contents.
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import {
  CF_KEY_ENCRYPTED_FILE,
  CF_KEY_PLAIN_FILE,
  clearCurseForgeKey as clearCore,
  curseForgeKeySync as syncCore,
  curseForgeKeySummary,
  readCurseForgeKey as readCore,
  setCurseForgeKey as setCore,
  validateCurseForgeKey as validateCore,
  type CurseForgeKeySource,
  type CurseForgeKeyStatus,
  type CurseForgeKeySummary,
  type KeyValidation,
  type SecretCryptoLike,
  type SecretStorageLike,
  type SecretStoreDeps,
} from './secrets-core';

export type { CurseForgeKeySource, CurseForgeKeyStatus, CurseForgeKeySummary, KeyValidation };
export { CF_KEY_ENCRYPTED_FILE, CF_KEY_PLAIN_FILE };

const realFs: SecretStorageLike = {
  exists: (file) => fs.existsSync(file),
  readText: (file) => fs.readFileSync(file, 'utf8'),
  writeText: (file, text, mode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { encoding: 'utf8', mode });
    // Best-effort 0600 intent; Windows ACLs are inherited from the per-user app-data folder.
    try { fs.chmodSync(file, 0o600); } catch { /* not supported on all platforms */ }
  },
  readBinary: (file) => fs.readFileSync(file),
  writeBinary: (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  },
  remove: (file) => { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } },
  mkdirp: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
};

const electronCrypto: SecretCryptoLike = {
  available: () => {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data),
};

function deps(dataRoot: string): SecretStoreDeps {
  return { dataRoot, fs: realFs, crypto: electronCrypto };
}

/** Renderer-safe status DTO for `curseforge_key_status` (never includes the key). */
export interface CurseForgeKeyStatusDto {
  configured: boolean;
  source: CurseForgeKeySource;
  encrypted: boolean;
  /** Human-readable provenance hint for the Settings UI. */
  hint: string;
}

export function readCurseForgeKey(dataRoot: string): CurseForgeKeyStatus {
  return readCore(deps(dataRoot));
}

export function setCurseForgeKey(dataRoot: string, key: string): { source: Exclude<CurseForgeKeySource, null>; encrypted: boolean } {
  return setCore(deps(dataRoot), key);
}

export function clearCurseForgeKey(dataRoot: string): { cleared: boolean } {
  return clearCore(deps(dataRoot));
}

export function validateCurseForgeKey(key: unknown): KeyValidation {
  return validateCore(key);
}

/**
 * Synchronous accessor for installer call sites (replaces the legacy direct file read in
 * `installer/curseforge.ts`): returns the decrypted safeStorage key when available, else the
 * plaintext fallback, else null. Lead wires the install site.
 */
export function curseForgeKeySync(dataRoot: string): string | null {
  return syncCore(deps(dataRoot));
}

export function curseForgeKeySummaryFor(dataRoot: string): CurseForgeKeySummary {
  return curseForgeKeySummary(deps(dataRoot));
}

export function curseForgeKeyStatus(dataRoot: string): CurseForgeKeyStatusDto {
  const summary = curseForgeKeySummaryFor(dataRoot);
  const hint = !summary.configured
    ? 'No key configured - keyless CurseForge routes still work.'
    : summary.source === 'safeStorage'
      ? 'Configured with OS-encrypted storage.'
      : 'Configured in the app data folder (curseforge-key.txt).';
  return { ...summary, hint };
}
