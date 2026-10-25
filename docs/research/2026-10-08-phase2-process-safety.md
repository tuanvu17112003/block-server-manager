# Phase 2 Process Safety Rework — Research Notes

Research for the scoped backend-002 review rework. Findings are source material; the implementation decisions below are limited to the existing Tauri/Rust process manager and do not add dependencies.

## Findings

- Windows PIDs can be reused. Checking only that a PID currently names `java.exe` does not prove it is the launcher’s old server process. The launcher must positively match its own process marker and server arguments, and must fail closed when process inspection fails or returns no command line.
- WMIC is deprecated and Microsoft documents that it is removed from Windows 11 24H2/25H2 starting August 2026. Windows PowerShell’s `Get-CimInstance` is the documented way to query CIM/WMI process instances and properties. [WMIC status](https://learn.microsoft.com/en-us/windows/win32/wmisdk/wmic), [Get-CimInstance](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance?view=powershell-5.1)
- Microsoft documents `taskkill /T` as ending the selected process and its child processes; `/F` forces termination. This is the smallest built-in process-tree cleanup for the current Windows-first implementation. [taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
- Rust `Mutex` provides synchronized exclusive access to shared state, so a start reservation must be acquired before spawning. Rust also documents that dropping `Child` does not stop the child; cleanup after a failed lockfile write must explicitly kill and wait for it. [Mutex](https://doc.rust-lang.org/std/sync/poison/struct.Mutex.html), [Child](https://doc.rust-lang.org/std/process/struct.Child.html)

## Rework decisions

1. Serialize start attempts before checking live state and spawning; propagate a poisoned registry lock instead of silently skipping process registration.
2. Add a non-secret, per-server JVM system-property marker and require a successful CIM query to show a Java image, `server.jar`, and that exact marker before orphan termination. Missing PowerShell/CIM or incomplete output means skip the kill and report it.
3. Use Windows `taskkill /T /F /PID` for forced process-tree termination, with the retained Rust `Child` handle as the direct-process fallback. This narrows, but does not eliminate, the PID check-to-termination race; a Windows Job Object/handle-based implementation would be a separate larger design.
4. If the PID lockfile cannot be written after spawn, terminate and wait for the new child, remove any partial lockfile, and return the I/O error.
5. On the Tauri frontend, load and create server records through strict real IPC commands. Keep mock records and local creation in browser mode. When the persisted Tauri list is empty, show the global Create view until a real server record exists so no fake ID reaches process commands.

## Scope

All findings map to Phase 2’s documented requirements: tracked starts, stop-all, PID lockfile recovery, and the Windows process-tree risk. The Tauri store correction is needed for lifecycle commands to address the database-backed records created by Phase 1. No new package or Cargo dependency is required by this rework plan.
