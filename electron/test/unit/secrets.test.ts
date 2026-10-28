// WP-7.3 CurseForge key storage tests. Pure `secrets-core` is exercised with an in-memory
// filesystem and a fake safeStorage backend; the Electron binding (secrets.ts) is not imported so
// this suite runs under plain `node --test` without an Electron process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CF_KEY_ENCRYPTED_FILE,
  CF_KEY_PLAIN_FILE,
  clearCurseForgeKey,
  curseForgeKeySync,
  curseForgeKeySummary,
  keyPaths,
  readCurseForgeKey,
  setCurseForgeKey,
  validateCurseForgeKey,
  type SecretCryptoLike,
  type SecretStorageLike,
  type SecretStoreDeps,
} from '../../services/secrets-core';

const VALID_KEY = 'cfc_0123456789abcdefABCDEF';

class MemoryFs implements SecretStorageLike {
  readonly files = new Map<string, Buffer>();
  readonly modes = new Map<string, number>();
  mkdirCalls = 0;

  exists(file: string): boolean { return this.files.has(file); }
  readText(file: string): string { return (this.files.get(file) ?? Buffer.alloc(0)).toString('utf8'); }
  writeText(file: string, text: string, mode: number): void { this.files.set(file, Buffer.from(text, 'utf8')); this.modes.set(file, mode); }
  readBinary(file: string): Buffer { return Buffer.from(this.files.get(file) ?? Buffer.alloc(0)); }
  writeBinary(file: string, data: Buffer): void { this.files.set(file, Buffer.from(data)); }
  remove(file: string): void { this.files.delete(file); }
  mkdirp(): void { this.mkdirCalls += 1; }
}

class FakeCrypto implements SecretCryptoLike {
  corrupt = false;
  constructor(private readonly enabled: boolean) {}
  available(): boolean { return this.enabled; }
  encrypt(plain: string): Buffer { return Buffer.from(`enc:${plain}`, 'utf8'); }
  decrypt(data: Buffer): string {
    if (this.corrupt) throw new Error('corrupt encrypted blob');
    const text = data.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not a safeStorage blob');
    return text.slice(4);
  }
}

function makeDeps(cryptoEnabled: boolean, dataRoot = '/data'): { deps: SecretStoreDeps; fs: MemoryFs; crypto: FakeCrypto } {
  const fs = new MemoryFs();
  const crypto = new FakeCrypto(cryptoEnabled);
  return { deps: { dataRoot, fs, crypto }, fs, crypto };
}

test('validateCurseForgeKey: accepts real classic key formats and rejects malformed input', () => {
  assert.equal(validateCurseForgeKey(VALID_KEY).ok, true);
  assert.equal(validateCurseForgeKey('a'.repeat(16)).ok, true);
  assert.equal(validateCurseForgeKey('A-1_2.3a'.repeat(4)).ok, true);
  // Real classic keys are bcrypt-ish (`$2a$10$...`) and may contain `/`, `+`, `=`.
  assert.equal(validateCurseForgeKey('$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV').ok, true);
  assert.equal(validateCurseForgeKey('abc/def+ghi=jkl$mno-pqr_stu.vwx1234567890').ok, true);
  const rejected: unknown[] = [
    undefined, null, 42, {}, [],
    '', '   ',
    'short',
    `${VALID_KEY} extra`,
    `${VALID_KEY}\n`,
    'bad key with spaces 123456',
    'x'.repeat(513),
    `validkey1234567890\u00a7`, // non-ASCII (§)
    `validkey1234567890\u0000`, // control character
  ];
  for (const value of rejected) {
    const result = validateCurseForgeKey(value);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(value)?.slice(0, 60)}`);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  }
});

test('file fallback: set/read/clear writes 0600 plaintext when safeStorage is unavailable', () => {
  const { deps, fs } = makeDeps(false);
  const plainPath = keyPaths(deps.dataRoot).plain;
  assert.match(plainPath, /curseforge-key\.txt$/);
  assert.deepEqual(readCurseForgeKey(deps), { key: null, source: null, encrypted: false });

  const written = setCurseForgeKey(deps, `  ${VALID_KEY}  `);
  assert.deepEqual(written, { source: 'file', encrypted: false });
  assert.equal(fs.readText(plainPath), `${VALID_KEY}\n`, 'key is trimmed and newline-terminated');
  assert.equal(fs.modes.get(plainPath), 0o600, 'plaintext fallback is written with 0600 intent');
  assert.equal(fs.exists(keyPaths(deps.dataRoot).encrypted), false);

  assert.deepEqual(readCurseForgeKey(deps), { key: VALID_KEY, source: 'file', encrypted: false });
  assert.equal(curseForgeKeySync(deps), VALID_KEY);
  assert.deepEqual(curseForgeKeySummary(deps), { configured: true, source: 'file', encrypted: false });

  assert.deepEqual(clearCurseForgeKey(deps), { cleared: true });
  assert.deepEqual(readCurseForgeKey(deps), { key: null, source: null, encrypted: false });
  assert.deepEqual(clearCurseForgeKey(deps), { cleared: false });
});

test('safeStorage preferred: key is encrypted and the plaintext fallback is removed', () => {
  const { deps, fs } = makeDeps(true);
  const paths = keyPaths(deps.dataRoot);
  fs.writeText(paths.plain, 'legacy-plaintext-key-value-1234\n', 0o600);

  const written = setCurseForgeKey(deps, VALID_KEY);
  assert.deepEqual(written, { source: 'safeStorage', encrypted: true });
  assert.equal(fs.exists(paths.plain), false, 'plaintext fallback removed once encrypted storage succeeds');
  assert.equal(fs.exists(paths.encrypted), true);
  assert.equal(fs.readBinary(paths.encrypted).toString('utf8'), `enc:${VALID_KEY}`);
  assert.equal(CF_KEY_ENCRYPTED_FILE, 'curseforge-key.enc');
  assert.equal(CF_KEY_PLAIN_FILE, 'curseforge-key.txt');

  assert.deepEqual(readCurseForgeKey(deps), { key: VALID_KEY, source: 'safeStorage', encrypted: true });
  assert.deepEqual(curseForgeKeySummary(deps), { configured: true, source: 'safeStorage', encrypted: true });

  // Reading through a crypto-unavailable session reports the encrypted config but no key material.
  const { deps: locked } = makeDeps(false, deps.dataRoot);
  (locked.fs as MemoryFs).files.set(paths.encrypted, fs.readBinary(paths.encrypted));
  assert.deepEqual(readCurseForgeKey(locked), { key: null, source: 'safeStorage', encrypted: true });
  assert.equal(curseForgeKeySync(locked), null);
});

test('read: corrupt encrypted blob falls back to the plaintext file, then to not-configured', () => {
  const { deps, fs, crypto } = makeDeps(true);
  const paths = keyPaths(deps.dataRoot);
  setCurseForgeKey(deps, VALID_KEY);
  crypto.corrupt = true;
  assert.deepEqual(readCurseForgeKey(deps), { key: null, source: null, encrypted: false });
  assert.deepEqual(curseForgeKeySummary(deps), { configured: false, source: null, encrypted: false });

  fs.writeText(paths.plain, 'fallback-key-value-1234567890\n', 0o600);
  assert.deepEqual(readCurseForgeKey(deps), { key: 'fallback-key-value-1234567890', source: 'file', encrypted: false });
});

test('set: rejects malformed keys with a validation-coded error and writes nothing', () => {
  const { deps, fs } = makeDeps(false);
  assert.throws(() => setCurseForgeKey(deps, 'too short'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'validation');
    assert.match((error as Error).message, /Invalid CurseForge API key/);
    return true;
  });
  assert.equal(fs.files.size, 0);
});

test('keyPaths: joins Windows and POSIX data roots without leaving a doubled separator', () => {
  assert.equal(keyPaths('/data').plain, '/data/curseforge-key.txt');
  assert.equal(keyPaths('/data/').plain, '/data/curseforge-key.txt');
  assert.equal(keyPaths('C:\\Users\\me\\AppData').plain, 'C:\\Users\\me\\AppData\\curseforge-key.txt');
});
