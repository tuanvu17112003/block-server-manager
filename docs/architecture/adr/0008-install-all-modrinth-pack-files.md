# ADR-0008: Install All Files in a Selected Modrinth Pack

- Status: Superseded on 2026-10-10 by [ADR-0013](0013-server-pack-format-and-server-mod-policy.md). The all-files directive remains historical; server-unsupported files are now skipped.
- Date: 2026-10-09
- Research: `docs/research/2026-10-09-modrinth-all-pack-files.md`

## Context

The server installer currently treats `.mrpack` `env` metadata as a selection gate and downloads only entries marked `server=required`. Prominence II 4.0.5 (`iqWrFu7S`) has 561 manifest entries, with 211 marked `server=unsupported`; the installed server then failed on missing `modmenu` and `s_lib` dependencies. The user directs the app to install the exact selected pack's complete `files[]` list without environment filtering.

Modrinth documents `unsupported` as a server exclusion and marks Mod Menu as client-side. This decision intentionally overrides those labels at the user's request.

## Decision

- Include every validated `files[]` entry in the selected `.mrpack`, regardless of `env.client`, `env.server`, optionality, or missing environment metadata.
- Keep all existing path, duplicate, reserved-path, trusted URL, redirect, hash, size, concurrency, cancellation, staging, and rollback checks.
- Continue applying `overrides/` followed by `server-overrides/`; keep `client-overrides/` outside this `files[]` policy.
- Update progress logs and UI copy so they no longer claim client-only or optional files are skipped.

## Consequences

- Installs may now download client-only or unsupported entries, increasing disk use and possibly making a dedicated server fail at startup if a mod is truly client-only.
- Modrinth compatibility flags remain in pack metadata but no longer control this app's server file list.
- The app installs the exact selected pack payload and does not substitute or alter individual entries.
