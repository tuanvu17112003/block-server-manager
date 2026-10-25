# Modrinth Server Override Specification

## Behavior

- Install shared `overrides/` entries first, then `server-overrides/` entries so server-specific files win on path collisions.
- Ignore `client-overrides/` during server installation.
- After removing the layer directory prefix, a single filename is a valid destination at the staging root. Nested paths create their parent directories before writing.
- Apply overrides only as files. Never execute pack contents.
- Keep existing path validation, manager-reserved-path exclusions, reparse-point protections, regular-file conflict handling, cancellation checks, progress reporting, and staging/rollback behavior.

## Acceptance criteria

- [x] A root-level shared override file installs at the staging root.
- [x] A root-level server override file installs at the staging root.
- [x] Nested shared/server override files still create their parent directories and preserve layer order.
- [x] Invalid, reserved, symlink/reparse, or escaping paths remain rejected.
- [x] Any failure still prevents publication of a partial server.

## Research

See [`../research/2026-10-09-modrinth-root-level-overrides.md`](../research/2026-10-09-modrinth-root-level-overrides.md) for the code trace and primary-source references.
