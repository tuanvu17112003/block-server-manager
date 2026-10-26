// Server-input validation + game-port helpers (WP-2.3).
//
// PURE NODE MODULE: this file imports only `node:net` and a *type* from store.ts, so it can be used
// by `node --test` unit suites and by store.ts without a CommonJS require cycle (store.ts requires
// this module at runtime; this module requires only the erased type back).
//
// Error contract (kept identical to the Rust AppError codes): validation problems throw an Error
// with `code: 'validation'`, occupied/duplicate ports throw `code: 'conflict'`.
import net from 'node:net';
import type { CreateServerInput } from './store';

/** Loaders a new server may be created with (ADR-0005: Quilt is no longer offered). */
export const ALLOWED_LOADERS = ['Vanilla', 'Paper', 'Fabric', 'Forge', 'NeoForge'] as const;
export type AllowedLoader = (typeof ALLOWED_LOADERS)[number];

/** Explicit game ports must be in the non-privileged range (Rust `ports::claim_port`). */
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;
/** Auto-allocation starts here (Rust `FIRST_GAME_PORT`). */
export const AUTO_PORT_START = 25565;
export const RAM_MIN_MB = 512;
export const RAM_MAX_MB = 65536;
export const NAME_MAX_LENGTH = 64;
export const MC_VERSION_MAX_LENGTH = 32;

/**
 * Resolve whether a TCP port can currently be bound on loopback. `true` = available.
 * Injected into `Store.allocatePort`/`assertPortAvailable` by tests; production uses
 * {@link probePortAvailable}.
 *
 * Windows caveat: Minecraft binds 0.0.0.0 while this probe binds 127.0.0.1, so a service bound to a
 * different interface only can still make the real game port fail later. Start-time failures are
 * surfaced as `conflict` by `assertPortAvailable`.
 */
export type PortAvailabilityProbe = (port: number) => Promise<boolean>;

export interface NormalizeCreateOptions {
  /**
   * Keep the caller's loader spelling when it case-insensitively matches the allowlist instead of
   * canonicalising it. Used by `Store.createServer` so the legacy Tauri importer keeps records
   * verbatim (its contract test asserts `loader === 'fabric'` for a prototype DB row); UI and IPC
   * paths canonicalise.
   */
  preserveLoaderCase?: boolean;
}

export function validationError(message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = 'validation';
  return error;
}

export function conflictError(message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = 'conflict';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validationError(`${field} is required.`);
  return value;
}

/** Server names are interpolated into `server.properties` text by some paths; keep them inert. */
export function validateServerName(value: unknown): string {
  const raw = requireString(value, 'Server name').trim();
  if (raw === '') throw validationError('Server name is required.');
  if (raw.length > NAME_MAX_LENGTH) {
    throw validationError(`Server name must be ${NAME_MAX_LENGTH} characters or fewer.`);
  }
  if (/[\r\n=]/.test(raw)) {
    throw validationError("Server name must not contain newlines or '='.");
  }
  if (raw.includes('\u0000')) throw validationError('Server name contains an invalid character.');
  return raw;
}

/**
 * Loader must be one of {@link ALLOWED_LOADERS} (case-insensitive). Quilt gets a dedicated
 * ADR-0005 message because saved-Quilt records are still startable but new Quilt creation is gone.
 */
export function validateLoader(value: unknown, options: NormalizeCreateOptions = {}): string {
  const raw = requireString(value, 'Loader').trim();
  if (raw === '') throw validationError('Loader is required.');
  const canonical = ALLOWED_LOADERS.find((loader) => loader.toLowerCase() === raw.toLowerCase());
  if (canonical) return options.preserveLoaderCase ? raw : canonical;
  if (raw.toLowerCase() === 'quilt') {
    throw validationError(
      'Quilt servers can no longer be created (ADR-0005). Choose Vanilla, Paper, Fabric, Forge or NeoForge.',
    );
  }
  throw validationError(`Unknown loader "${raw}". Allowed loaders: ${ALLOWED_LOADERS.join(', ')}.`);
}

/**
 * Minecraft version IDs from the Mojang manifest: releases (`1.21.1`), snapshots (`24w14a`), old
 * alpha/beta (`a1.2.6`, `b1.7.3`), early (`c0.30_01c`, `rd-132211`, `inf-20100618`) and prefixed
 * variants (`1.21.11-rc3`, `26.1.0.19-beta`). Deliberately syntax-only: availability is the
 * installer's job.
 */
const MC_VERSION_PATTERN =
  /^(?:(?:a|b)\d+(?:\.\d+)+|(?:rd|inf|pre)-\d+|c\d+\.\d+(?:_\d+)?[a-z]?|\d{2}w\d{2}[a-z]|\d{1,2}\.\d{1,2}(?:\.\d{1,3}){0,2}(?:[-.][A-Za-z0-9]+)*)$/;

export function validateMcVersion(value: unknown): string {
  const raw = requireString(value, 'Minecraft version').trim();
  if (raw === '') throw validationError('Minecraft version is required.');
  if (raw.length > MC_VERSION_MAX_LENGTH) {
    throw validationError(`Minecraft version must be ${MC_VERSION_MAX_LENGTH} characters or fewer.`);
  }
  if (!MC_VERSION_PATTERN.test(raw)) {
    throw validationError(`"${raw}" is not a valid Minecraft version ID.`);
  }
  return raw;
}

export function validateRamMb(value: unknown): number {
  const ram = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(ram) || ram < RAM_MIN_MB || ram > RAM_MAX_MB) {
    throw validationError(`RAM must be an integer between ${RAM_MIN_MB} and ${RAM_MAX_MB} MB.`);
  }
  return ram;
}

/** Explicit game ports: integers in 1024–65535. 0/null/undefined mean "auto-allocate". */
export function validatePortNumber(value: unknown, field = 'Port'): number {
  const port = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw validationError(`${field} must be an integer between ${PORT_MIN} and ${PORT_MAX}.`);
  }
  return port;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw validationError(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > maxLength) throw validationError(`${field} must be ${maxLength} characters or fewer.`);
  if (/[\r\n\u0000]/.test(trimmed)) throw validationError(`${field} must not contain newlines.`);
  if (pattern && !pattern.test(trimmed)) throw validationError(`${field} contains invalid characters.`);
  return trimmed;
}

/**
 * Normalise + validate the `CreateServerInput` shape (renderer/IPC input is `unknown`).
 * Fields not in the DTO are ignored (forward compatibility); known fields are type-checked.
 */
export function normalizeCreateServerInput(value: unknown, options: NormalizeCreateOptions = {}): CreateServerInput {
  if (!isRecord(value)) throw validationError('Create input must be an object.');
  const input: CreateServerInput = {
    name: validateServerName(value.name),
    loader: validateLoader(value.loader, options),
    mcVersion: validateMcVersion(value.mcVersion),
    ramMb: validateRamMb(value.ramMb),
  };

  const loaderVersion = optionalString(value.loaderVersion, 'Loader version', 64, /^[A-Za-z0-9._+-]+$/);
  if (loaderVersion !== undefined) input.loaderVersion = loaderVersion;
  const modpackId = optionalString(value.modpackId, 'Modpack id', 128, /^[A-Za-z0-9._:-]+$/);
  if (modpackId !== undefined) input.modpackId = modpackId;
  if (value.port !== undefined && value.port !== null && value.port !== 0) {
    input.port = validatePortNumber(value.port);
  }
  const javaPath = optionalString(value.javaPath, 'Java path', 512);
  if (javaPath !== undefined) input.javaPath = javaPath;
  if (value.eulaAccepted !== undefined && value.eulaAccepted !== null) {
    if (typeof value.eulaAccepted !== 'boolean') throw validationError('eulaAccepted must be a boolean.');
    input.eulaAccepted = value.eulaAccepted;
  }
  return input;
}

/**
 * Real OS bind probe on 127.0.0.1. Resolves `true` when the port can be bound right now.
 * Never rejects; a probe error is reported as "not available" so callers fail closed.
 */
export function probePortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const settle = (available: boolean): void => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* never started listening */ }
      resolve(available);
    };
    server.once('error', () => settle(false));
    server.once('listening', () => settle(true));
    try {
      server.listen({ port, host: '127.0.0.1', exclusive: true });
    } catch {
      settle(false);
    }
  });
}

/**
 * Fail-closed start-time port check: validates the range, rejects a port that another tracked
 * process/blocker holds, and returns the same port on success (never silently rewrites it).
 *
 * @throws `validation` when the port is outside 1024–65535, `conflict` when it is in use.
 */
export async function assertPortAvailable(
  port: number,
  probe: PortAvailabilityProbe = probePortAvailable,
): Promise<number> {
  const validated = validatePortNumber(port, 'Server port');
  if (typeof probe !== 'function') throw validationError('Port probe must be a function.');
  let available: boolean;
  try {
    available = await probe(validated);
  } catch (error) {
    throw conflictError(`Could not verify port ${validated} is free: ${(error as Error).message}`);
  }
  if (!available) {
    throw conflictError(
      `Port ${validated} is already in use on this machine. Stop the other server or change this server's port in Settings.`,
    );
  }
  return validated;
}
