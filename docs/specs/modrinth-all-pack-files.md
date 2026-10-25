# Modrinth All-Files Installation Specification

> Historical policy, superseded on 2026-10-10 by [server-pack-install-correctness.md](server-pack-install-correctness.md) and [ADR-0013](../architecture/adr/0013-server-pack-format-and-server-mod-policy.md). New server installs skip explicit `env.server=unsupported` entries.

## Behavior

- Install every file listed in the exact selected `.mrpack` `files[]` array. Do not use `env.client`, `env.server`, optionality, or missing environment metadata to skip entries.
- Apply the existing integrity and security checks to every entry: normalized unique path, reserved-path rejection, provider URL allowlist, redirect validation, SHA-1/SHA-512, declared size, cancellation, staging, and rollback.
- Apply `overrides/`, then `server-overrides/`; preserve existing handling of `client-overrides/` and never execute pack contents.
- Report that all manifest files are installed; do not show skipped-entry counts for environment flags.

## Acceptance criteria

- [x] `required`, `optional`, `unsupported`, client-only, and missing-environment manifest entries all become installation download entries.
- [x] Invalid paths, untrusted URLs, invalid hashes, oversized files, cancellation, and staging rollback retain their current behavior.
- [x] Install log and UI no longer claim files were skipped due to environment flags.
- [x] The exact selected pack version and its override layers remain unchanged.

See [`../research/2026-10-09-modrinth-all-pack-files.md`](../research/2026-10-09-modrinth-all-pack-files.md) and [ADR-0008](../architecture/adr/0008-install-all-modrinth-pack-files.md).
