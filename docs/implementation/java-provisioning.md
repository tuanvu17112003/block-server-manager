# Implementation Plan — Java Provisioning (Phase 3)

## Owned paths

- `src-tauri/src/java/**`
- `src-tauri/src/lib.rs`
- `src-tauri/src/cmds/servers.rs`
- `src-tauri/src/servers/mod.rs`
- `src-tauri/src/servers/process.rs`
- `src/tauri.ts`, `src/types.ts`, `src/store.tsx`
- `src/tabs/Create.tsx`, `src/tabs/Settings.tsx`
- `docs/**` for Phase 3 documentation updates

Do not modify Phase 4 version/install APIs, server loader selection, EULA behavior, or unrelated UI. No new Rust dependencies in this phase; use documented Windows inbox tools and Win32 disk-space API. Browser mode retains mocks.

## Ordered steps

1. Implement Minecraft Java requirement resolution: fetch Mojang manifest and version JSON and prefer `javaVersion.majorVersion`. For a known version, use the documented fallback only when that field is absent or Mojang cannot be reached because of a network failure or HTTP 5xx; reject malformed metadata, unknown versions, HTTP 4xx, and explicit unsupported majors without fallback.
2. Implement candidate enumeration from PATH, `JAVA_HOME`, Windows registry, and common Adoptium/Microsoft locations. Validate candidates by executing the resolved `java.exe` and reading major/architecture.
3. Implement Temurin asset lookup and on-demand Windows x64 JDK ZIP install for 8/17/21: disk-space preflight, checksum-keyed `.part`, resume attempt, byte length/SHA-256 verification, extraction to staging, executable verification, and app-local publication.
4. Add Tauri `java_detect` and `java_ensure` commands and progress events. Use the existing app-data and job progress patterns.
5. Add validated per-server Java path persistence using the existing `java_path` database column; refuse changes while the server is running.
6. Route server start through a local Java requirement mapping for each version in the current Create catalogue; validate a recorded/detected runtime locally and fail clearly when none is valid. Start must never fetch or wait on Mojang metadata. Unknown Minecraft versions fail closed until their local mapping is added.
7. Wire Create and Settings to show required/selected Java, install progress, and a manual executable/home override. Preserve browser mocks and all EULA/Start behavior.
8. Update docs to match the implementation, then run independent review, TypeScript/build checks, and available Rust checks. Report the known host limitation if `cargo`/`rustc` remain unavailable.

## Key constraints

- Exact supported Temurin majors: 8, 17, 21. Metadata requirements can be higher; do not silently clamp them to 21.
- Mojang metadata remains authoritative during Create/Settings detection and override validation. Start uses the local catalogue mapping so an already-configured server can start without Mojang network access.
- 26.1 requires Java 25 and remains unsupported until a later explicit plan update.
- No machine-wide installer, registry write, PATH edit, or JAVA_HOME edit.
- Do not trust registry/PATH values without executing and validating the candidate.
- Never accept the Minecraft EULA automatically; preserve the database/file agreement from Phase 2.
- A range response is optional per HTTP; append partial bytes only for a valid resumed representation and verify the final package hash.
- Do not add new crate dependencies or touch paths outside the owned set without stopping for approval.

## Verification handoff references

- Specification: `docs/specs/java-provisioning.md`
- Research: `docs/research/2026-10-08-phase3-java-provisioning.md`
- General regression checklist: `docs/implementation/checklist.md`
