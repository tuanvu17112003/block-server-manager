# Backend-015 Console Performance and Server Start Test

Date: 2026-10-09  
Task: `backend-015-console-log-performance`

## Build and review

- `npm run build`: PASS (`tsc` and Vite production bundle). Initial sandbox build hit Windows `EPERM`; the required final build passed with the permitted elevated retry.
- Independent reviewer: PASS. Verified per-server 10,000-line cap, queue ordering/clear behavior, 22 px virtual rows with eight-row overscan, retained-history search/export, and provider-unmount cleanup.

## Desktop console smoke

- Launched the rebuilt Tauri app through Windows MCP using the project-local `tauri dev` path.
- Selected `Prominence 4.0.5 All Files Test` (Modrinth version `iqWrFu7S`, port `25511`, 8,192 MB).
- Started the server. Live Java output appeared in the console. The `config` search filtered the visible log view, and clearing the query restored the recent output promptly. Auto-scroll remained enabled.
- This smoke test exercised real server output and UI filtering. It did not synthesize a 10,000-line burst; the retention and viewport bounds were independently reviewed in source.

## Server result

- Startup log stopped advancing at approximately `22:29:31` after `Necronomicon Initialized` and `NecronomiconConfig read successfully`; no Minecraft `Done` message appeared.
- Sent `help` from the console at approximately `22:31:19`. The command appeared in the app log, but Java returned no response.
- The Java process used about 2.38 GiB of working set and showed 0% CPU in Task Manager. Port `25511` was not listening.
- Pressed the app's Stop control. The UI logged `Stopping server...` and transitioned to stopped/detached. The Java process lingered briefly, then exited; the final process check found no Java process for this test server and port `25511` remained closed.
- A read-only `jcmd Thread.print` attempt returned `no such process` because the process had exited before attachment. No thread dump was obtained.
- The app's Kill control was not used. Windows MCP auto-review rejected the unlabeled coordinate action because it could trigger a destructive kill; the process exited naturally, so no force-kill was needed.

## Conclusion

The console remained responsive during the tested live log/search interaction. The server did not reach ready state, so this does not prove the all-files Prominence II server can start. The Java startup stall is separate from the React console-rendering fix and remains unexplained.

