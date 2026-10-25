# Research — Install Every File in the Selected Modrinth Pack

Date: 2026-10-09  
Trigger: After a live Prominence II 4.0.5 install, server startup failed because Fabric could not find `modmenu` and `s_lib`. The user explicitly requests removing environment-based file filtering so the server install receives every file in the selected pack.

## Current application behavior

`parse_manifest_json` currently includes only entries whose `env.server` is `required`. It skips `optional`, `unsupported`, client-required/server-unsupported, and missing-server-environment entries. The exact 4.0.5 manifest for version `iqWrFu7S` was inspected from the existing investigation artifact: it contains 561 entries, including 211 marked `server=unsupported`; the missing `modmenu-7.2.2.jar` and `s-lib-fabric-2.1.0+1.20.1.jar` are among them. The UI and install log report those skipped entries.

## Provider semantics and user policy

Modrinth defines file environment values as `required`, `optional`, and `unsupported`; its example says a client-required/server-unsupported file is client-only, and it recommends allowing a choice for optional files. Modrinth's project page lists the Prominence II 4.0.5 pack as supporting both client and server. The specific manifest's environment flags conflict with the startup dependencies observed in the live test.

The user explicitly directs the app to ignore those environment labels for server selection and install every `files[]` entry. The installation will still validate and honor each entry's path, trusted URL, SHA-1/SHA-512, file size, redirect, cancellation, staging, and rollback requirements. `overrides/` and `server-overrides/` remain layered as before.

This policy intentionally includes files marked client-only or unsupported. Modrinth lists Mod Menu as client-side, so including it can still prevent a dedicated server from starting. Installing all manifest files fulfills the requested installation policy; it does not guarantee that every pack will run on a server.

## Sources

- Modrinth, [`.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) — file environment values and override semantics.
- Modrinth, [Prominence II: Hasturian Era 4.0.5](https://modrinth.com/modpack/prominence-2-fabric/version/iqWrFu7S) — release page lists client and server support.
- Modrinth, [Mod Menu](https://modrinth.com/mod/modmenu) — lists the mod as client-side.
- Modrinth, [S-Lib 2.1.0+1.20.1](https://modrinth.com/mod/s-lib/version/qf2mIL1z) — version page lists client/server support.
- Local exact-manifest investigation: `.workflow/artifacts/investigation/prominence-2-v4.0.5-iqWrFu7S-index-range.bin`, with inspection reports `inspect_v405_manifest.py` and `inspect_v405_deps.py`.

## Decision pointer

See [ADR-0008](../architecture/adr/0008-install-all-modrinth-pack-files.md) for the accepted policy change and its consequences.
