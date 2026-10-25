# Post-validation Server Publication

## Goal

Complete a validated Tauri server install by moving the staged directory into its final server folder on Windows.

## Evidence

The live Tauri Vanilla install passed provider artifact validation and failed with Windows OS error 5 before database publication. A focused Windows Rust probe reproduced the failure when `installer.log` was still open inside the staged directory; dropping that handle made the directory rename succeed.

Research: [`../research/2026-10-09-post-validation-access-denied.md`](../research/2026-10-09-post-validation-access-denied.md).

## Ordered steps

1. Scope the append handle so it is dropped immediately after the publication log line is written. **Done.**
2. Keep the existing staged-directory rename, database insert order, and staging cleanup on failure. **Preserved.**
3. Add a focused Rust regression test that appends the publication log, moves a staged folder containing `server.jar`, and verifies the destination contents. **Done.**
4. Run Rust unit/build gates and relaunch the Tauri app for a live Vanilla retry. **Done:** Rust tests 11/11, formatter check, elevated Tauri dev build, reviewer PASS; responsive app running. Live retry remains pending because native UI input is unavailable in this session. Start still requires the user’s explicit EULA acceptance.

## Acceptance criteria

- The append log file handle is closed before moving its parent directory.
- The regression test passes on Windows and confirms the staged payload is at the final destination after publication.
- Failed publication still removes staging output and does not insert a server row.
- The live Tauri install no longer fails at 94% with access denied.
