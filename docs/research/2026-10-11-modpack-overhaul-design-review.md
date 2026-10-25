# Modpack Setup Overhaul — Research Review

Date: 2026-10-11  
Inputs: the full `H:\TESTMultiAI\24\research-handoff` package, the current app's CodeGraph paths, and the user's scope decisions in this task.

## Product and dependency fit

The survey found no mature Windows desktop product that covers both pack families, safe local publication, and managed server lifecycle. Keep the Tauri/Rust app as the product. Rebuild the installation pipeline inside it and use established projects as behavior references rather than bundling a second installer runtime.

- `itzg/mc-image-helper` is MIT-licensed and the strongest maintained reference for provider resolution, side selection, manual-download reporting, exact pins, and stale-file cleanup. Its orchestration is Docker/container-oriented. A hardening deep read also found unsafe override extraction in one path, so copy reviewed policy only and retain this app's own archive guards.
- `nothub/mrpack-install` is MIT-licensed and useful for `.mrpack` server semantics and override ordering. Its visible releases are beta-only; the source review found a stub update command, no URL host allowlist, and non-fatal required-download failures. Do not bundle it or copy those failure behaviors.
- `packwiz` provides a useful `client|server|both` side model and optional-file concept. Reimplement the model in the existing Rust app; do not add a Java runtime.
- ServerPackCreator is a generator for local modpack instances, not a server manager. Keep its narrowly validated archive format as an import input; do not bundle the LGPL tool.
- Do not adopt McPacker (AGPL-3.0, documented auto-EULA and continue-on-download-failure behavior), MC-Pack2Server (no license), or Docker-backed server panels as dependencies.

## Technical direction

- Normalize each provider input into an immutable, exact-pinned install plan before any target mutation.
- Use one typed side-selection and per-file decision model, then provider adapters for CurseForge server ZIPs and Modrinth project/local `.mrpack` inputs.
- Install exact loader versions only. Verify runtime completeness from artifacts and parsed launch arguments; never treat a successful installer exit code or a single JAR as sufficient evidence.
- Keep file selection, download verification, staging, launch parsing, publication, readiness evidence, and reports as explicit stages.
- Track each pipeline-owned file and its installed hash. Updates remove only files the previous plan owned and the new plan no longer owns; preserve untracked files and user-modified files unless the user explicitly chooses replacement after backup.
- Use startup log evidence to classify known missing-dependency, corrupt-JAR, client-only leakage, Java, and mixin failures. Report evidence and stop; do not auto-inject/remove/downgrade mods.
- Keep the existing EULA consent, no-script-execution, Windows path/ZIP safety, and managed Start/process boundaries.

## User decisions for this overhaul

- CurseForge remains keyless. Accept author-provided server ZIPs; identify client exports and explain that this workflow does not resolve them.
- Modrinth supports exact project/version selection and local `.mrpack` input.
- Quilt is a disabled/planned placeholder for new installs. Saved Quilt server management remains unchanged.
- The installer references upstream behavior; it does not add a new third-party runtime or dependency as part of the design.

## Cautions to preserve

- Modrinth `env.server=unsupported` remains excluded by default. Do not hide missing hard dependencies by fetching unlisted files or silently removing dependent mods; surface the pack conflict and exact evidence.
- Do not infer client/server sides from filenames. Missing metadata defaults to retain with a warning; optional files require a visible choice (default keep); conflicting signals require a user decision and block unattended installation.
- A bad CurseForge transfer stays unpromoted. ZIP parsing remains authoritative; bounded prefix inspection only improves the error message.
- No key, pack file, mod, or arbitrary archive script is bundled or executed.
- Modrinth archive and per-file hashes must verify SHA-1, SHA-512, and declared file size. Every download hop must remain HTTPS on the provider allowlist, with a bounded redirect count.

## Source documents

- [Open-source comparison](2026-10-11-open-source-solutions-review.md)
- [Initial runtime symptom triage](2026-10-11-reported-modpack-setup-failures.md)
- `H:\TESTMultiAI\24\research-handoff\research\2026-10-10-unified-modpack-server-research.md`
- `H:\TESTMultiAI\24\research-handoff\research\2026-10-10-production-implementations.md`
- `H:\TESTMultiAI\24\research-handoff\research\2026-10-10-hardening-impl-deepread.md`
- `H:\TESTMultiAI\24\research-handoff\research\2026-10-10-hardening-edge-failure.md`
- `H:\TESTMultiAI\24\research-handoff\specs\modpack-server-installer.md`
- `H:\TESTMultiAI\24\research-handoff\architecture\overview.md` and `adr/0002-server-pack-first-env-policy.md`
- [Microsoft Windows filename rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) and [Windows path-length behavior](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)
