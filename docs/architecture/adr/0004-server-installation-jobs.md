# ADR 0004 — Staged Server Installation Jobs

Status: Accepted for Phase 4 (2026-10-08)

## Context

Create currently animates mock progress and creates the persistent record afterward. Phase 4 must download provider artifacts, run external loader installers, stream progress/logs, support cancellation, and guarantee that a failed job does not leave a broken server record. Installer processes do not share a common progress or cancellation protocol. The app is Windows x64, already provisions Java through Windows inbox tools, and the current crate has no HTTP/archive dependencies. The project requires approval before adding dependencies.

## Decision

Keep provider-specific metadata resolution in the Rust installer module and use the exact resolved version/build for each job. Run jobs in isolated staging directories and keep cancellation state in managed app state. Use the existing `curl.exe`, selected Java executable, Rust process APIs, and `serde_json`; do not add Rust dependencies in this phase. Emit `job://progress/{jobId}` updates with stage progress and plain installer output. Publish files and create the DB record only after validation; cancellation or failure removes staged output and rolls back any partial publication. Paper exposes STABLE builds only, Forge promotions are labeled recommended/latest, and provider results are intersected with the Phase 3 Minecraft catalogue.

The EULA remains false unless the user explicitly checked the Create EULA box. Modpack install behavior remains Phase 5; the Tauri flow may not label a mock pack install as successful.

At Start, the process manager remains the owner of lifecycle tracking. Select a validated launch mode from installed loader artifacts: runnable JARs use the direct Java JAR path; modern Forge/NeoForge use their generated Windows argument files with the selected Java, preserving the process identity marker and normal stdin/stdout handling. Reject publication when no supported launch mode can be resolved.

Orphan recovery verifies the saved server's exact launch shape and JVM identity marker. Keep the existing fail-closed behavior whenever Windows process inspection is unavailable.

Validate nested installer output and revalidate it at Start without following reparse points in parent directories; a leaf-only metadata check is insufficient for Quilt's nested payload.

## Consequences

- Installer code can be stopped and cleaned without leaving visible partial servers.
- Vanilla/Paper can show byte progress; external installer jobs show truthful stage progress and captured logs.
- The app remains within its current Java/Minecraft scope and does not require a new crate dependency.
- Provider-specific metadata/version formats remain isolated behind the resolver; unsupported or ambiguous compatibility fails closed.
- Modrinth client-only file filtering will be implemented with Phase 5 pack manifest extraction, when those files and environment metadata exist.
