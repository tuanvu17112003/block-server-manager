# Implementation Guide — Backend Phase 4 Server Installs

> Historical Phase 4 handoff. For the active release-catalogue and loader scope, follow [`new-server-improvements.md`](new-server-improvements.md). Quilt creation and the seven-version cap described below are retired; saved Quilt process support remains.

Read first: [`../specs/server-installs.md`](../specs/server-installs.md), [`backend-plan.md`](backend-plan.md), [`../architecture/adr/0004-server-installation-jobs.md`](../architecture/adr/0004-server-installation-jobs.md), and [`../research/2026-10-08-phase4-server-installs.md`](../research/2026-10-08-phase4-server-installs.md).

## Ordered steps and owned paths

1. **Rust installer and commands** — `src-tauri/src/installer/**`, `src-tauri/src/cmds/**`, `src-tauri/src/lib.rs`, and `src-tauri/src/servers/**` for atomic publication plus loader-aware process launch. Implement provider metadata, compatibility resolution, artifact verification, staging, cancellation, progress, installer logs, cleanup, and start/stop for every published loader.
2. **Typed IPC** — `src/tauri.ts`: version discovery, loader resolution, install request/cancel wrappers, and progress payload types. Preserve the existing strict invoke error path.
3. **Create wizard** — `src/tabs/Create.tsx` and any narrowly required types/store files: use real supported versions/loaders on Tauri; wire progress, log, cancel, retry, and success; retain browser mocks. Tauri must not simulate modpack success before Phase 5.
4. **Documentation sync** — update the backend plan/checklist only if implementation differs from this spec; state the exact divergence before doing so.

## Constraints

- Keep the user-approved seven-version Minecraft catalogue and Java 8/17/21 scope.
- Do not add Rust dependencies. Reuse `curl.exe`, `serde_json`, the validated Java path, and `std::process` patterns.
- Use unique job IDs, path-safe staging names, hidden child processes, bounded log capture, and fail-closed artifact validation.
- Persist a server only after successful installation. Any failure after publication begins must remove both DB row and files.
- Validate a provider-specific launch mode before publication; preserve direct-child Java PID identity, process events, stdin/stdout, EULA and stop/kill behavior.
- Update orphan PID verification to compare the process command line against the persisted provider-specific launch mode plus exact server marker; preserve fail-closed CIM behavior.
- Quilt installation output includes the nested Minecraft server JAR and the root Quilt launcher; validate both.
- Use one shared path guard to reject a reparse point or junction in Quilt's nested `server/` directory both before publication and again at Start; leaf-only checks can follow the parent elsewhere.
- EULA is never auto-accepted. Keep phase 2 DB/file consistency and start refusal.
- Preserve the existing first-run Create component mount and completion actions.

## Verification checklist

- Independently review provider-specific compatibility logic and the cancellation/publication race paths.
- Exercise metadata parsing and integrity failure paths, cancellation while downloading and while a Java installer is running, failure cleanup, stale job IDs, and successful Vanilla/Paper/Fabric installs.
- Verify the Tauri flow has no mock progress/success path, while browser mocks still work.
- Run the applicable Rust checks and TypeScript/build checks when authorized by the task workflow; document unavailable tooling and any external live-download limits.
