# Backend Phase 2 Review — 2026-10-08

Task: `backend-002`  
Gate: **FAIL**  
Reviewer: independent read-only review

## Findings

1. **[P1] Concurrent starts can leave a server untracked.** `src-tauri/src/servers/process.rs:145-147, 225-231, 321-324` checks `is_live` before spawning, then inserts unconditionally. Two start requests can both pass the check and spawn; when one child exits, its finalizer removes the map entry by server ID, potentially removing the other child’s handle. Stop/kill can then lose access to a live process.
2. **[P1] Windows orphan recovery can kill an unrelated Java process.** `src-tauri/src/servers/process.rs:635-660, 714-725` treats unavailable WMI—or an empty command line—as sufficient identification after only checking the image is Java. A recycled PID belonging to another `java.exe` may be terminated.
3. **[P1] The Tauri UI supplies mock server IDs to real process commands.** `src/store.tsx:3-4, 52-55` initializes from `initialServers`; `src/tabs/Create.tsx:77-109` creates `srv-${Date.now()}` records through local `addServer`. The UI does not load or create records through `servers_list`/`servers_create`, so Tauri lifecycle calls target IDs absent from the backend database.
4. **[P2] Windows termination does not cover process descendants.** `src-tauri/src/servers/process.rs:395-406, 532-539, 714-725` uses `Child::kill` and `taskkill /F /PID` without tree termination.
5. **[P2] Lockfile write failures are silently accepted.** `src-tauri/src/servers/process.rs:230-231` ignores failure to write `server.lock` and still reports start success, leaving a process that cannot be found by stale-lock recovery after an unclean shutdown.

## Areas checked

Command registration, event names/payloads, EULA DB/file enforcement and scaffold sync, MOTD injection rejection, Tauri error propagation, browser mock fallback, and preserved EULA gate, kill confirmation, Start pulse, and stopped-state command disablement.

No files changed and no tests/builds run during review.
