// Java provisioning — the single Java module (Phase 3 WP-3.2): requirement resolution, discovery,
// inspection/validation and app-local Temurin installation.
//
// PURE NODE MODULE: no `electron` import. It reuses the installer engine's pure helpers
// (`fetchOk`/`download`/`extractZip`) and exposes injectable effect seams so every parsing/filtering
// rule is unit-testable without network, a real JDK, or Windows tools.
//
// Rust parity: `legacy/src-tauri/src/java/mod.rs` (supported majors 8/17/21/25, Mojang metadata first with
// the documented offline fallback, PATH/JAVA_HOME/registry/known-location discovery, 64-bit filter,
// `major >= required` compatibility, SHA-256+size verified Adoptium install).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { download, extractZip, fetchOk } from './installer/core';

// ------------------------------------------------------------------------------------------------
// Public constants / types
// ------------------------------------------------------------------------------------------------

/** Temurin runtimes this app can provision (D12: Java 25 for Minecraft 26.x is supported). */
export const SUPPORTED_MAJORS = [8, 17, 21, 25] as const;
export type SupportedMajor = (typeof SUPPORTED_MAJORS)[number];

export const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const JAVA_INSPECT_TIMEOUT_MS = 5_000;
export const DISK_HEADROOM_BYTES = 512 * 1024 * 1024;
/** A lock older than this is assumed to belong to a crashed installer and is taken over. */
export const JAVA_INSTALL_LOCK_STALE_MS = 10 * 60_000;
/** How long a second installer waits for a live install lock before failing with io. */
export const JAVA_INSTALL_LOCK_WAIT_MS = 120_000;

/** DTO shape consumed by `src/tauri.ts` (JavaCandidate: path/major/architectureBits/source). */
export interface JavaCandidate {
  path: string;
  major: number;
  architectureBits: number;
  source: string;
}

/** Adoptium v3 `/assets/latest/{major}` JSON, validated and flattened. */
export interface AdoptiumPackage {
  link: string;
  name: string;
  size: number;
  sha256: string;
}

export type JavaProgress = (update: { phase: string; pct?: number }) => void;

function javaError(code: 'validation' | 'io', message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}

export function validationError(message: string): Error {
  return javaError('validation', message);
}

export function ioError(message: string): Error {
  return javaError('io', message);
}

export function isSupportedMajor(major: number): major is SupportedMajor {
  return (SUPPORTED_MAJORS as readonly number[]).includes(major);
}

/**
 * Lowest provisionable Temurin major that satisfies `required` (Rust
 * `install_major_for_requirement`): 16→17, 8→8, 21→21, 25→25. `null` when the app needs an update.
 */
export function installMajorFor(required: number): SupportedMajor | null {
  return SUPPORTED_MAJORS.find((major) => major >= required) ?? null;
}

export function unsupportedMajorError(major: number): Error {
  return validationError(
    `Java ${major} is outside this app's supported runtime set (${SUPPORTED_MAJORS.join(', ')}). ` +
    'Minecraft versions requiring a newer Java major need an app update.',
  );
}

// ------------------------------------------------------------------------------------------------
// Mojang Java requirement resolution
// ------------------------------------------------------------------------------------------------

/** Network-level Mojang failure (offline, timeout, 5xx): an offline fallback is allowed. */
export class MojangNetworkError extends Error {
  readonly kind = 'network' as const;
}

/** Request/metadata-level failure (4xx, malformed JSON/shape): never falls back. */
export class MojangRequestError extends Error {
  readonly kind = 'request' as const;
}

export interface RequiredJavaDeps {
  /** Inject in tests. The default fetch classifies failures as network (fallback-eligible) or request. */
  fetchJson?: (url: string) => Promise<unknown>;
}

async function fetchJsonDefault(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchOk(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new MojangNetworkError((error as Error).message);
  }
  if (response.status >= 500) throw new MojangNetworkError(`Mojang metadata request failed with HTTP ${response.status}.`);
  if (!response.ok) throw new MojangRequestError(`Mojang metadata request returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch (error) {
    throw new MojangRequestError(`Mojang metadata was invalid JSON: ${(error as Error).message}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Documented offline fallback table (Rust `fallback_java_major`), used only for release-shaped 1.x
 * versions and 26.1. Unknown/new families return `null` → the caller fails closed.
 */
export function offlineJavaMajor(mcVersion: string): number | null {
  const raw = mcVersion.trim();
  if (raw === '') return null;
  const parts = raw.split('.').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part)) || parts.length < 2 || parts.length > 3) return null;
  const major = parts[0]!;
  const minor = parts[1]!;
  const patch = parts[2] ?? 0;
  if (major === 1 && minor <= 16) return 8;
  if (major === 1 && minor === 17) return 16; // provisioned as Java 17 (nearest supported)
  if (major === 1 && minor >= 18 && minor <= 19) return 17;
  if (major === 1 && minor === 20) return patch <= 4 ? 17 : 21;
  if (major === 1 && minor === 21) return 21;
  if (major === 26 && minor === 1) return 25; // Rust parity: offline Start mapping for 26.1
  return null;
}

function parseJavaMajorMetadata(versionJson: unknown, version: string): number | null {
  if (typeof versionJson !== 'object' || versionJson === null || Array.isArray(versionJson)) {
    throw validationError(`Mojang reported malformed metadata for Minecraft ${version}.`);
  }
  const javaVersion = (versionJson as { javaVersion?: unknown }).javaVersion;
  if (javaVersion === undefined || javaVersion === null) return null;
  if (typeof javaVersion !== 'object' || Array.isArray(javaVersion)) {
    throw validationError(`Mojang reported malformed Java metadata for Minecraft ${version}.`);
  }
  const raw = (javaVersion as { majorVersion?: unknown }).majorVersion;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw validationError(`Mojang reported an invalid Java requirement for Minecraft ${version}.`);
  }
  return raw;
}

/**
 * Resolve the Minecraft version's required Java major.
 *
 * Metadata first (`javaVersion.majorVersion`). A network/5xx failure may use the documented offline
 * fallback; 4xx/malformed metadata, an unknown version, or an unsupported Java major fail closed.
 * Returns the *required minimum* (e.g. 16 for 1.17.x); use {@link installMajorFor} for the runtime to
 * install/offer.
 */
export async function requiredJavaMajor(
  mcVersion: string,
  deps: RequiredJavaDeps = {},
): Promise<number> {
  const version = mcVersion.trim();
  if (version === '') throw validationError('Minecraft version is required.');

  const fetchJson = deps.fetchJson ?? fetchJsonDefault;
  const fallback = offlineJavaMajor(version);
  const fallbackIfSatisfiable = (): number | null => {
    if (fallback === null) return null;
    return installMajorFor(fallback) === null ? null : fallback;
  };

  let manifest: unknown;
  try {
    manifest = await fetchJson(MOJANG_MANIFEST_URL);
  } catch (error) {
    const offline = fallbackIfSatisfiable();
    if (error instanceof MojangNetworkError && offline !== null) return offline;
    throw javaError('io', errorMessage(error));
  }

  const versions = (manifest as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions)) throw ioError('Mojang version manifest has no version list.');
  const entry = versions.find(
    (row): row is { id: string; url: string } =>
      typeof row === 'object' && row !== null
      && (row as { id?: unknown }).id === version
      && typeof (row as { url?: unknown }).url === 'string',
  );
  if (!entry) {
    throw validationError(`Minecraft version '${version}' was not found in Mojang's version manifest.`);
  }

  let versionJson: unknown;
  try {
    versionJson = await fetchJson(entry.url);
  } catch (error) {
    const offline = fallbackIfSatisfiable();
    if (error instanceof MojangNetworkError && offline !== null) return offline;
    throw javaError('io', errorMessage(error));
  }

  const declared = parseJavaMajorMetadata(versionJson, version);
  if (declared !== null) {
    if (installMajorFor(declared) === null) throw unsupportedMajorError(declared);
    return declared;
  }

  const offline = fallbackIfSatisfiable();
  if (offline === null) {
    throw validationError(
      `Mojang metadata does not declare a Java requirement for Minecraft ${version}, and no known fallback is available.`,
    );
  }
  return offline;
}

// ------------------------------------------------------------------------------------------------
// Java settings parsing / inspection
// ------------------------------------------------------------------------------------------------

export interface JavaRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code; `null` when it could not run or timed out. */
  status: number | null;
  error?: string;
  timedOut?: boolean;
}

export interface JavaInspectDeps {
  /** Inject in tests. Default: spawnSync `java.exe -XshowSettings:properties -version` (5 s). */
  run?: (executable: string) => JavaRunResult;
}

/** Parse `-XshowSettings:properties -version` output into major + architecture bits. */
export function parseJavaSettings(text: string): { major: number; architectureBits: number } {
  const lines = text.split(/\r?\n/);
  let major: number | null = null;
  let architectureBits: number | null = null;
  let osArch: string | null = null;

  const toMajor = (version: string): number | null => {
    const cleaned = version.trim().replace(/^["']|["']$/g, '');
    const first = cleaned.split(/[._+\-]/)[0] ?? '';
    if (first === '1') {
      const rest = cleaned.slice(2).split(/[._+\-]/)[0] ?? '';
      const legacy = Number(rest);
      return Number.isInteger(legacy) && legacy > 0 ? legacy : null;
    }
    const parsed = Number(first);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const assignment = trimmed.split('=');
    if (assignment.length >= 2) {
      const key = assignment[0]!.trim();
      const value = assignment.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      if (key === 'java.specification.version' && major === null) {
        major = toMajor(value);
      } else if (key === 'sun.arch.data.model') {
        const parsed = Number(value);
        if (parsed === 32 || parsed === 64) architectureBits = parsed;
      } else if (key === 'os.arch') {
        osArch = value.toLowerCase();
      }
    }
    if (major === null) {
      const banner = trimmed.match(/^(?:java|openjdk) version "([^"]+)"/i);
      if (banner) major = toMajor(banner[1]!);
    }
  }

  if (architectureBits === null && osArch !== null) {
    if (/amd64|x86_64|aarch64|ppc64|s390x/.test(osArch)) architectureBits = 64;
    else if (/^(x86|i[3-6]86)$/.test(osArch)) architectureBits = 32;
  }
  if (major === null) {
    throw validationError('Java did not report a usable specification version.');
  }
  if (architectureBits === null) {
    throw validationError('Java did not report its architecture; use a 64-bit JDK.');
  }
  return { major, architectureBits };
}

const JAVA_EXE_NAME = 'java.exe';

/** Resolve a JDK home directory or `java.exe` path to the real executable path. */
export function resolveJavaExecutable(pathOrHome: string): string {
  const raw = pathOrHome.trim();
  if (raw === '') throw validationError('Java path is required.');
  const supplied = path.resolve(raw);
  let executable = supplied;
  try {
    if (fs.statSync(supplied).isDirectory()) {
      executable = path.join(supplied, 'bin', JAVA_EXE_NAME);
    }
  } catch {
    // Not found: treat the value as a JDK home and fall through to the actionable error below.
    executable = path.join(supplied, 'bin', JAVA_EXE_NAME);
  }
  let isFile = false;
  try {
    isFile = fs.statSync(executable).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw validationError(
      `Java executable was not found at '${executable}'; enter a JDK home or its bin\\java.exe.`,
    );
  }
  if (path.basename(executable).toLowerCase() !== JAVA_EXE_NAME) {
    throw validationError('Java path must be a JDK home directory or a java.exe file.');
  }
  return executable;
}

function runJavaSettingsDefault(executable: string): JavaRunResult {
  const result = spawnSync(executable, ['-XshowSettings:properties', '-version'], {
    encoding: 'utf8',
    timeout: JAVA_INSPECT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    error: result.error?.message,
    timedOut: errorCode === 'ETIMEDOUT',
  };
}

/**
 * Inspect an installed Java runtime: resolves the executable, runs it with a 5 s timeout, parses the
 * major and 64-bit flag, and returns the renderer `JavaCandidate` DTO shape.
 *
 * @throws validation when missing/not runnable/not parseable/32-bit-unreported.
 */
export function inspectJava(
  pathOrHome: string,
  source = 'manual override',
  deps: JavaInspectDeps = {},
): JavaCandidate {
  const executable = resolveJavaExecutable(pathOrHome);
  const run = deps.run ?? runJavaSettingsDefault;
  const result = run(executable);
  if (result.timedOut) {
    throw validationError(
      `Java at '${executable}' did not respond within ${JAVA_INSPECT_TIMEOUT_MS / 1000} seconds; use a working 64-bit JDK.`,
    );
  }
  if (result.status === null || result.error) {
    throw validationError(`Could not execute Java at '${executable}': ${result.error ?? 'process did not start'}.`);
  }
  if (result.status !== 0) {
    throw validationError(`Java at '${executable}' could not be run successfully (exit ${result.status}).`);
  }
  let parsed: { major: number; architectureBits: number };
  try {
    parsed = parseJavaSettings(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    throw validationError(`Java at '${executable}': ${errorMessage(error)}`);
  }
  return { path: executable, major: parsed.major, architectureBits: parsed.architectureBits, source };
}

// ------------------------------------------------------------------------------------------------
// Discovery
// ------------------------------------------------------------------------------------------------

/** Source labels (Rust parity) used in the Java candidates list. */
export const JAVA_SOURCES = {
  javaHome: 'JAVA_HOME',
  path: 'PATH',
  registry: 'Windows registry',
  temurin: 'Temurin (app managed)',
  appRuntime: 'App runtime location',
} as const;

const REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\JavaSoft\\JDK',
  'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
  'HKLM\\SOFTWARE\\Eclipse Adoptium',
  'HKLM\\SOFTWARE\\Microsoft\\JDK',
  'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK',
  'HKCU\\SOFTWARE\\JavaSoft\\JDK',
  'HKCU\\SOFTWARE\\Eclipse Adoptium',
  'HKCU\\SOFTWARE\\Microsoft\\JDK',
] as const;

export interface JavaDiscoveryDeps extends JavaInspectDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Default: `readdirSync` (errors → []). */
  listDir?: (dir: string) => string[];
  /** Default: `where.exe java.exe` / `which -a java`. Returns executable/home paths. */
  findOnPath?: () => string[];
  /** Default: `reg.exe query <key> /s` parsed to REG_SZ/REG_EXPAND_SZ values. */
  queryRegistry?: (key: string) => string[];
}

function expandWindowsEnvVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole);
}

function listDirDefault(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function findOnPathDefault(platform: NodeJS.Platform): string[] {
  const command = platform === 'win32' ? 'where.exe' : 'which';
  const args = platform === 'win32' ? ['java.exe'] : ['-a', 'java'];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
}

function queryRegistryDefault(key: string, env: NodeJS.ProcessEnv): string[] {
  const result = spawnSync('reg.exe', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  const values: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/);
    if (!match) continue;
    const value = expandWindowsEnvVariables(match[1]!.trim(), env);
    if (value !== '') values.push(value);
  }
  return values;
}

function programFilesRoots(env: NodeJS.ProcessEnv): { dir: string; source: string }[] {
  const roots: { dir: string; source: string }[] = [];
  const programFiles = env.ProgramW6432 ?? env.ProgramFiles;
  if (programFiles) {
    roots.push(
      { dir: path.join(programFiles, 'Eclipse Adoptium'), source: 'Adoptium location' },
      { dir: path.join(programFiles, 'Microsoft'), source: 'Microsoft OpenJDK location' },
      { dir: path.join(programFiles, 'Java'), source: 'Java install location' },
      { dir: path.join(programFiles, 'Zulu'), source: 'Zulu install location' },
      { dir: path.join(programFiles, 'Amazon Corretto'), source: 'Amazon Corretto location' },
      { dir: path.join(programFiles, 'GraalVM'), source: 'GraalVM location' },
    );
  }
  if (env.LOCALAPPDATA) {
    roots.push(
      { dir: path.join(env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'), source: 'Adoptium user location' },
      { dir: path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft'), source: 'Microsoft OpenJDK user location' },
    );
  }
  return roots;
}

export interface JavaHomeCandidate {
  path: string;
  source: string;
}

/** Collect raw home/executable candidates (not yet inspected). Exported for tests. */
export function discoverJavaHomes(
  extraRoots: string[] = [],
  deps: JavaDiscoveryDeps = {},
): JavaHomeCandidate[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const listDir = deps.listDir ?? listDirDefault;
  const findOnPath = deps.findOnPath ?? (() => findOnPathDefault(platform));
  const queryRegistry = deps.queryRegistry ?? ((key: string) => queryRegistryDefault(key, env));
  const homes: JavaHomeCandidate[] = [];

  const javaHome = env.JAVA_HOME?.trim();
  if (javaHome) homes.push({ path: javaHome, source: JAVA_SOURCES.javaHome });
  for (const found of findOnPath()) homes.push({ path: found, source: JAVA_SOURCES.path });

  if (platform === 'win32') {
    for (const key of REGISTRY_KEYS) {
      for (const value of queryRegistry(key)) homes.push({ path: value, source: JAVA_SOURCES.registry });
    }
    for (const root of programFilesRoots(env)) {
      // The root itself may be a JDK home, and each child directory may be one.
      homes.push({ path: root.dir, source: root.source });
      for (const child of listDir(root.dir)) {
        if (child.trim() === '') continue;
        homes.push({ path: path.join(root.dir, child), source: root.source });
      }
    }
  }

  for (const root of extraRoots) {
    if (!root || root.trim() === '') continue;
    const sourceFor = (name: string): string => (name.startsWith('temurin-') ? JAVA_SOURCES.temurin : JAVA_SOURCES.appRuntime);
    homes.push({ path: root, source: sourceFor(path.basename(root)) });
    for (const child of listDir(root)) {
      if (child.trim() === '') continue;
      homes.push({ path: path.join(root, child), source: sourceFor(child) });
    }
  }
  return homes;
}

export interface PickCandidatesOptions {
  /** `true` = only the exact required major (Create's "install this major" prompt); default = Rust compatibility (>=). */
  exactMajor?: boolean;
}

/**
 * Pure filter for inspected candidates: 64-bit, provisionable major, and either the exact required
 * major or (default, Rust parity) any supported major >= required. Dedupes by normalized path and
 * sorts by major ascending, preserving discovery order within a major.
 */
export function pickCandidates(
  entries: JavaCandidate[],
  requiredMajor: number,
  options: PickCandidatesOptions = {},
): JavaCandidate[] {
  const seen = new Set<string>();
  const picked: JavaCandidate[] = [];
  for (const entry of entries) {
    if (entry.architectureBits !== 64) continue;
    if (!isSupportedMajor(entry.major)) continue;
    if (options.exactMajor) {
      if (entry.major !== requiredMajor) continue;
    } else if (entry.major < requiredMajor) {
      continue;
    }
    const key = entry.path.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ ...entry });
  }
  return picked.sort((left, right) => left.major - right.major);
}

export interface DetectJavaOptions extends JavaDiscoveryDeps, PickCandidatesOptions {
  /** Max inspected candidates (Rust caps discovery at 32). */
  maxCandidates?: number;
}

/**
 * Discover installed 64-bit Java runtimes compatible with `requiredMajor`.
 *
 * Sources: JAVA_HOME, PATH, Windows registry (JavaSoft/Adoptium/Microsoft), known install locations,
 * and the app runtime roots passed by the caller. Dedupes, inspects each candidate, filters to
 * supported 64-bit majors (exact or Rust-compatible `>= required`), and sorts by major.
 */
export async function detectJava(
  requiredMajor: number,
  extraRoots: string[] = [],
  options: DetectJavaOptions = {},
): Promise<JavaCandidate[]> {
  if (!Number.isInteger(requiredMajor) || requiredMajor <= 0) {
    throw validationError(`Invalid required Java major: ${String(requiredMajor)}.`);
  }
  const maxCandidates = options.maxCandidates ?? 32;
  const seen = new Set<string>();
  const inspected: JavaCandidate[] = [];
  for (const home of discoverJavaHomes(extraRoots, options)) {
    let executable: string;
    try {
      executable = resolveJavaExecutable(home.path);
    } catch {
      continue;
    }
    const key = executable.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > maxCandidates) break;
    try {
      inspected.push(inspectJava(executable, home.source, options));
    } catch {
      // Unusable candidates (stub launchers, broken installs, 32-bit) are skipped, not fatal.
    }
  }
  return pickCandidates(inspected, requiredMajor, options);
}

// ------------------------------------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------------------------------------

/**
 * Validate a user-supplied JDK home / `java.exe` against a Minecraft Java requirement.
 *
 * Rust parity rules: 64-bit, provisionable major, and `major >= required` (e.g. Java 25 is valid for
 * a Java 21 requirement; Java 17 is valid for the Java 16 minimum of 1.17.x). Errors are `validation`
 * and actionable.
 */
export async function validateJava(
  pathOrHome: string,
  requiredMajor: number,
  deps: JavaInspectDeps = {},
): Promise<JavaCandidate> {
  const candidate = inspectJava(pathOrHome, 'manual override', deps);
  if (candidate.architectureBits !== 64) {
    throw validationError(
      `Java at '${candidate.path}' is ${candidate.architectureBits}-bit; Minecraft server runtimes must be 64-bit.`,
    );
  }
  if (!isSupportedMajor(candidate.major)) throw unsupportedMajorError(candidate.major);
  if (candidate.major < requiredMajor) {
    throw validationError(
      `Java ${candidate.major} at '${candidate.path}' is too old for this Minecraft version; ` +
      `Java ${requiredMajor} or later is required.`,
    );
  }
  return candidate;
}

// ------------------------------------------------------------------------------------------------
// Adoptium / Temurin provisioning
// ------------------------------------------------------------------------------------------------

/** Adoptium `/assets/latest/{major}` endpoint for the Windows x64 JDK ZIP (GA, Eclipse vendor). */
export function adoptiumAssetsUrl(major: number): string {
  return `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=windows&architecture=x64&image_type=jdk&release_type=ga&vendor=eclipse`;
}

/** Pure: validate/flatten the Adoptium v3 assets payload into the ZIP package metadata. */
export function adoptiumPackageFrom(assetsJson: unknown): AdoptiumPackage {
  if (!Array.isArray(assetsJson)) {
    throw ioError('Adoptium returned an unexpected asset payload (expected an array).');
  }
  const pkg = assetsJson
    .map((item) => (typeof item === 'object' && item !== null
      ? (item as { binary?: { package?: unknown } }).binary?.package
      : undefined))
    .find((candidate) => typeof candidate === 'object' && candidate !== null);
  if (pkg === undefined) {
    throw ioError('Adoptium did not return a Temurin JDK package for Windows x64.');
  }
  const { link, name, size, checksum } = pkg as {
    link?: unknown; name?: unknown; size?: unknown; checksum?: unknown;
  };
  if (typeof link !== 'string' || !link.startsWith('https://')) {
    throw ioError('Adoptium package did not include an HTTPS download link.');
  }
  if (typeof name !== 'string' || !name.toLowerCase().endsWith('.zip')) {
    throw ioError('Adoptium did not return a ZIP archive for Windows x64.');
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw ioError('Adoptium package did not include a valid expected size.');
  }
  if (typeof checksum !== 'string' || !/^[0-9a-fA-F]{64}$/.test(checksum)) {
    throw ioError('Adoptium package did not include a valid SHA-256 checksum.');
  }
  return { link, name, size, sha256: checksum.toLowerCase() };
}

export interface DiskPreflightInput {
  availableBytes: number;
  packageSizeBytes: number;
  /** Keep the archive on disk too (download + extracted tree ≈ 3× ZIP); default false. */
  archiveAlreadyDownloaded?: boolean;
  headroomBytes?: number;
}

export interface DiskPreflightResult {
  ok: boolean;
  requiredBytes: number;
  availableBytes: number;
  deficitBytes: number;
}

/**
 * Pure disk-space math (Rust `preflight_disk_space`): the verified archive plus the expanded tree is
 * budgeted at 2× the ZIP size (3× when the archive still must be downloaded), plus 512 MiB headroom.
 */
export function diskPreflight(input: DiskPreflightInput): DiskPreflightResult {
  const headroom = input.headroomBytes ?? DISK_HEADROOM_BYTES;
  const archiveSize = Math.max(0, Math.trunc(input.packageSizeBytes));
  const multiplier = input.archiveAlreadyDownloaded ? 2 : 3;
  const requiredBytes = archiveSize * multiplier + headroom;
  const availableBytes = Math.max(0, Math.trunc(input.availableBytes));
  const deficitBytes = Math.max(0, requiredBytes - availableBytes);
  return { ok: availableBytes >= requiredBytes, requiredBytes, availableBytes, deficitBytes };
}

/** `<runtimeRoot>/.java-install-{major}.lock` */
export function lockPathFor(runtimeRoot: string, major: number): string {
  return path.join(runtimeRoot, `.java-install-${major}.lock`);
}

export interface JavaInstallLock {
  path: string;
  release(): void;
}

export interface AcquireJavaInstallLockOptions {
  staleMs?: number;
  waitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Cross-process install lock. Creates the lock file exclusively; a lock older than `staleMs` is taken
 * over (crashed installer), a fresh one is awaited up to `waitMs` and then reported as `io`.
 */
export async function acquireJavaInstallLock(
  runtimeRoot: string,
  major: number,
  options: AcquireJavaInstallLockOptions = {},
): Promise<JavaInstallLock> {
  const lockPath = lockPathFor(runtimeRoot, major);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const staleMs = options.staleMs ?? JAVA_INSTALL_LOCK_STALE_MS;
  const waitMs = options.waitMs ?? JAVA_INSTALL_LOCK_WAIT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();

  for (;;) {
    try {
      const handle = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }));
      } finally {
        fs.closeSync(handle);
      }
      return {
        path: lockPath,
        release(): void {
          try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw ioError(`Could not create the Java install lock at '${lockPath}': ${errorMessage(error)}`);
      }
    }

    let ageMs = 0;
    try {
      ageMs = now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      continue; // Lock vanished between attempts — retry immediately.
    }
    if (ageMs > staleMs) {
      try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
      continue;
    }
    if (now() - startedAt > waitMs) {
      throw ioError(
        `Another Temurin Java ${major} installation is still running (lock '${lockPath}'). Retry when it finishes.`,
      );
    }
    await sleep(500);
  }
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function cachedArchiveMatches(
  archivePath: string,
  pack: AdoptiumPackage,
): Promise<boolean> {
  try {
    const stats = fs.statSync(archivePath);
    if (!stats.isFile() || stats.size !== pack.size) return false;
    return (await sha256File(archivePath)).toLowerCase() === pack.sha256;
  } catch {
    return false;
  }
}

function freeDiskBytes(dir: string): number {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    throw ioError(`Could not check free disk space for '${dir}': ${errorMessage(error)}`);
  }
}

export interface EnsureJavaDeps {
  /** Inject in tests; defaults to the real network/core helpers. */
  fetchJson?: (url: string) => Promise<unknown>;
  download?: typeof download;
  extractZip?: typeof extractZip;
  listDir?: (dir: string) => string[];
  /** Injectable disk probe (`availableBytes` for the target volume). */
  freeDiskBytes?: (dir: string) => number;
  /** Injectable inspection used for reuse + staged publishing verification. */
  inspect?: (pathOrHome: string, source?: string) => JavaCandidate;
  /** Forwarded to detectJava (discovery seams) for reuse checks. */
  detectOptions?: DetectJavaOptions;
  lock?: AcquireJavaInstallLockOptions;
}

function findJdkHome(extractRoot: string, listDir: (dir: string) => string[]): string | null {
  for (const child of listDir(extractRoot)) {
    if (!child.startsWith('jdk-')) continue;
    const home = path.join(extractRoot, child);
    try {
      if (fs.statSync(path.join(home, 'bin', JAVA_EXE_NAME)).isFile()) return home;
    } catch {
      // keep looking
    }
  }
  try {
    if (fs.statSync(path.join(extractRoot, 'bin', JAVA_EXE_NAME)).isFile()) return extractRoot;
  } catch {
    // not a JDK root
  }
  return null;
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * Reuse a detected runtime or provision the requested supported Temurin JDK under `runtimeRoot`.
 *
 * Sequence: unsupported-major reject → reuse detected (app-managed) → Adoptium asset lookup →
 * SHA-256/size verified download (or verified cache reuse) → disk preflight → install lock with stale
 * takeover → extract to staging → verify the inner jdk-* folder's bin\\java.exe by execution →
 * atomic publish to `<runtimeRoot>/temurin-{major}` → final re-validation with progress phases.
 */
export async function ensureJava(
  major: number,
  runtimeRoot: string,
  cacheDir: string,
  onProgress?: JavaProgress,
  deps: EnsureJavaDeps = {},
): Promise<JavaCandidate> {
  if (!isSupportedMajor(major)) throw unsupportedMajorError(major);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const progress = onProgress ?? (() => undefined);
  const fetchJson = deps.fetchJson ?? fetchJsonDefault;
  const doDownload = deps.download ?? download;
  const doExtract = deps.extractZip ?? extractZip;
  const listDir = deps.listDir ?? listDirDefault;
  const inspect = deps.inspect ?? ((target: string, source?: string) => inspectJava(target, source ?? JAVA_SOURCES.temurin));
  const freeBytes = deps.freeDiskBytes ?? freeDiskBytes;

  progress({ phase: `Checking for an installed Temurin Java ${major}...`, pct: 1 });
  const existing = await detectJava(major, [runtimeRoot], {
    ...(deps.detectOptions ?? {}),
    exactMajor: true,
  });
  if (existing[0]) {
    progress({ phase: `Temurin Java ${major} is ready.`, pct: 100 });
    return existing[0];
  }

  progress({ phase: `Looking up the latest GA Temurin Java ${major}...`, pct: 5 });
  let assetsJson: unknown;
  try {
    assetsJson = await fetchJson(adoptiumAssetsUrl(major));
  } catch (error) {
    throw ioError(`Adoptium asset lookup failed: ${errorMessage(error)}`);
  }
  const pack = adoptiumPackageFrom(assetsJson);
  const archivePath = path.join(cacheDir, `temurin-${major}.zip`);
  const archiveReady = await cachedArchiveMatches(archivePath, pack);

  const preflight = diskPreflight({
    availableBytes: freeBytes(runtimeRoot),
    packageSizeBytes: pack.size,
    archiveAlreadyDownloaded: archiveReady,
  });
  if (!preflight.ok) {
    throw validationError(
      `Not enough free disk space to install Temurin Java ${major}: need about ${gib(preflight.requiredBytes)} GiB; ` +
      `${gib(preflight.availableBytes)} GiB available.`,
    );
  }

  const installLock = await acquireJavaInstallLock(runtimeRoot, major, deps.lock);
  let staging: string | null = null;
  try {
    // Another process may have finished while we waited for the lock.
    if (archiveReady) {
      progress({ phase: `Using the verified Temurin Java ${major} archive...`, pct: 8 });
    }
    const installedWhileWaiting = await detectJava(major, [runtimeRoot], {
      ...(deps.detectOptions ?? {}),
      exactMajor: true,
    });
    if (installedWhileWaiting[0]) {
      progress({ phase: `Temurin Java ${major} is ready.`, pct: 100 });
      return installedWhileWaiting[0];
    }

    if (!archiveReady) {
      progress({ phase: `Downloading ${pack.name}...`, pct: 10 });
      try {
        await doDownload(pack.link, archivePath, { size: pack.size, sha256: pack.sha256 });
      } catch (error) {
        throw ioError(`Temurin download failed: ${errorMessage(error)}`);
      }
    }
    progress({ phase: 'Checking Temurin archive size and SHA-256...', pct: 80 });
    if (!(await cachedArchiveMatches(archivePath, pack))) {
      try { fs.rmSync(archivePath, { force: true }); } catch { /* best effort */ }
      throw ioError('Temurin archive did not match the release metadata (size/SHA-256); it was removed. Retry the installation.');
    }

    const stagingName = `temurin-${major}-staging-${process.pid}-${Date.now()}`;
    staging = path.join(runtimeRoot, stagingName);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    progress({ phase: `Extracting ${pack.name} into a staging folder...`, pct: 85 });
    try {
      await doExtract(archivePath, staging, { skipExisting: false });
    } catch (error) {
      throw ioError(`Temurin archive extraction failed: ${errorMessage(error)}`);
    }

    const extractedHome = findJdkHome(staging, listDir);
    if (!extractedHome) throw ioError('The Temurin archive did not contain a JDK with bin\\java.exe.');

    progress({ phase: 'Verifying the extracted Java runtime...', pct: 93 });
    let staged: JavaCandidate;
    try {
      staged = inspect(extractedHome, JAVA_SOURCES.temurin);
    } catch (error) {
      throw validationError(`The downloaded Temurin runtime is not usable: ${errorMessage(error)}`);
    }
    if (staged.major !== major || staged.architectureBits !== 64) {
      throw validationError(
        `The downloaded Temurin package reported Java ${staged.major} (${staged.architectureBits}-bit); ` +
        `Java ${major} 64-bit was expected.`,
      );
    }

    const finalDir = path.join(runtimeRoot, `temurin-${major}`);
    fs.rmSync(finalDir, { recursive: true, force: true });
    try {
      fs.renameSync(extractedHome, finalDir);
    } catch (error) {
      throw ioError(`Could not publish the verified Java runtime: ${errorMessage(error)}`);
    }

    const executable = path.join(finalDir, 'bin', JAVA_EXE_NAME);
    let published: JavaCandidate;
    try {
      published = inspect(finalDir, JAVA_SOURCES.temurin);
    } catch (error) {
      throw ioError(`The published Temurin runtime is not usable: ${errorMessage(error)}`);
    }
    if (published.major !== major || published.architectureBits !== 64) {
      throw validationError('The published Temurin runtime did not pass final Java validation.');
    }
    try { fs.rmSync(archivePath, { force: true }); } catch { /* best effort */ }
    progress({ phase: `Temurin Java ${major} is ready.`, pct: 100 });
    return { path: executable, major: published.major, architectureBits: published.architectureBits, source: JAVA_SOURCES.temurin };
  } finally {
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    installLock.release();
  }
}
