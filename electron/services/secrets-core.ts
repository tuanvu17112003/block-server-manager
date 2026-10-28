// Pure CurseForge API-key storage logic (WP-7.3 / D11).
//
// No Electron import: node:test unit suites exercise every branch by injecting a filesystem and an
// optional encryption backend. `electron/services/secrets.ts` binds these helpers to the real fs and
// Electron `safeStorage`; nothing here logs or returns key material to the renderer.
export const CF_KEY_PLAIN_FILE = 'curseforge-key.txt';
export const CF_KEY_ENCRYPTED_FILE = 'curseforge-key.enc';

export type CurseForgeKeySource = 'safeStorage' | 'file' | null;
export type CurseForgeKeyOrigin = Exclude<CurseForgeKeySource, null>;

export interface CurseForgeKeyStatus {
  /** Key material (main process only; the renderer IPC DTO never includes it). */
  key: string | null;
  source: CurseForgeKeySource;
  encrypted: boolean;
}

export interface CurseForgeKeySummary {
  configured: boolean;
  source: CurseForgeKeySource;
  encrypted: boolean;
}

export interface KeyValidation { ok: boolean; reason?: string }

/** Minimal filesystem surface so tests can use an in-memory implementation. */
export interface SecretStorageLike {
  exists(file: string): boolean;
  readText(file: string): string;
  writeText(file: string, text: string, mode: number): void;
  readBinary(file: string): Buffer;
  writeBinary(file: string, data: Buffer): void;
  remove(file: string): void;
  mkdirp(dir: string): void;
}

/** OS-encryption surface (`safeStorage` in production); `available()` false forces file fallback. */
export interface SecretCryptoLike {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SecretStoreDeps {
  dataRoot: string;
  fs: SecretStorageLike;
  crypto: SecretCryptoLike;
}

export interface KeyPaths { plain: string; encrypted: string }

export interface CurseForgeKeyWriteResult {
  source: CurseForgeKeyOrigin;
  encrypted: boolean;
}

const KEY_MIN_LENGTH = 16;
const KEY_MAX_LENGTH = 512;
/**
 * CurseForge "classic" keys are not URL-safe only: real console keys use the bcrypt-ish form
 * `$2a$10$...` and may also contain `/`, `+`, `=` (verified against the reference project's
 * `new_key.txt`). Accept any single-line printable ASCII token; only whitespace/control/Unicode
 * characters are rejected.
 */
const KEY_PATTERN = /^[!-~]+$/;

/** Basic format validation (no network): single-line printable ASCII token of 16-512 chars. */
export function validateCurseForgeKey(value: unknown): KeyValidation {
  if (typeof value !== 'string') return { ok: false, reason: 'CurseForge API key must be a string.' };
  if (value.trim().length === 0) return { ok: false, reason: 'CurseForge API key is empty.' };
  if (/\s/.test(value)) return { ok: false, reason: 'CurseForge API key must not contain whitespace.' };
  if (value.length < KEY_MIN_LENGTH) return { ok: false, reason: `CurseForge API key is too short (minimum ${KEY_MIN_LENGTH} characters).` };
  if (value.length > KEY_MAX_LENGTH) return { ok: false, reason: `CurseForge API key is too long (maximum ${KEY_MAX_LENGTH} characters).` };
  if (!KEY_PATTERN.test(value)) return { ok: false, reason: 'CurseForge API key must be printable ASCII without spaces (letters, digits, and symbols such as $ / + =).' };
  return { ok: true };
}

export function keyPaths(dataRoot: string): KeyPaths {
  const join = (name: string): string => `${String(dataRoot).replace(/[\\/]+$/, '')}${separator(dataRoot)}${name}`;
  return { plain: join(CF_KEY_PLAIN_FILE), encrypted: join(CF_KEY_ENCRYPTED_FILE) };
}

// path.join is Node-only; a tiny separator keeps this module portable for tests.
function separator(root: string): string {
  return /\\/.test(root) && !/\//.test(root) ? '\\' : '/';
}

/** Encrypted (safeStorage) key when readable, then the plaintext fallback file. */
export function readCurseForgeKey(deps: SecretStoreDeps): CurseForgeKeyStatus {
  const paths = keyPaths(deps.dataRoot);
  if (deps.fs.exists(paths.encrypted)) {
    if (!deps.crypto.available()) {
      // Configured earlier by the OS keystore but this session cannot decrypt it.
      return { key: null, source: 'safeStorage', encrypted: true };
    }
    try {
      const plain = deps.crypto.decrypt(deps.fs.readBinary(paths.encrypted)).trim();
      if (plain.length > 0) return { key: plain, source: 'safeStorage', encrypted: true };
    } catch {
      // Corrupt/unreadable encrypted blob: fall through to the plaintext fallback if present.
    }
  }
  if (deps.fs.exists(paths.plain)) {
    try {
      const plain = deps.fs.readText(paths.plain).trim();
      if (plain.length > 0) return { key: plain, source: 'file', encrypted: false };
    } catch {
      // Unreadable file: treat as not configured.
    }
  }
  return { key: null, source: null, encrypted: false };
}

/**
 * Persist the key: OS-encrypted blob when `safeStorage` is available, otherwise a plaintext
 * `<dataRoot>/curseforge-key.txt` (0600 intent). The other representation is removed so the key
 * exists in exactly one place. Throws a `validation`-coded error for malformed keys.
 */
export function setCurseForgeKey(deps: SecretStoreDeps, key: string): CurseForgeKeyWriteResult {
  const trimmed = typeof key === 'string' ? key.trim() : key;
  const validation = validateCurseForgeKey(trimmed);
  if (!validation.ok) {
    const error = new Error(`Invalid CurseForge API key: ${validation.reason ?? 'unsupported value'}`);
    (error as Error & { code?: string }).code = 'validation';
    throw error;
  }
  const paths = keyPaths(deps.dataRoot);
  deps.fs.mkdirp(deps.dataRoot);
  if (deps.crypto.available()) {
    const encrypted = deps.crypto.encrypt(trimmed);
    deps.fs.writeBinary(paths.encrypted, encrypted);
    deps.fs.remove(paths.plain);
    return { source: 'safeStorage', encrypted: true };
  }
  deps.fs.writeText(paths.plain, `${trimmed}\n`, 0o600);
  deps.fs.remove(paths.encrypted);
  return { source: 'file', encrypted: false };
}

/** Remove both representations; `cleared` is true when at least one existed. */
export function clearCurseForgeKey(deps: SecretStoreDeps): { cleared: boolean } {
  const paths = keyPaths(deps.dataRoot);
  const existed = deps.fs.exists(paths.plain) || deps.fs.exists(paths.encrypted);
  deps.fs.remove(paths.plain);
  deps.fs.remove(paths.encrypted);
  return { cleared: existed };
}

/** Renderer-safe status DTO: configured flag + provenance, never the key itself. */
export function curseForgeKeySummary(deps: SecretStoreDeps): CurseForgeKeySummary {
  const status = readCurseForgeKey(deps);
  return { configured: status.key !== null, source: status.source, encrypted: status.encrypted };
}

/** Synchronous accessor for installer call sites (Electron main process). */
export function curseForgeKeySync(deps: SecretStoreDeps): string | null {
  return readCurseForgeKey(deps).key;
}
