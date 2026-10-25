# Tauri MCP Bridge Setup

Date: 2026-10-12
Task: `modpack-server-setup-overhaul` Phase 7 developer smoke testing

The app is Tauri 2. The installed MCP server reports version 0.13.1 and says the app plugin must be updated to 0.13. The bridge 0.13.1 release requires Tauri 2.12.2 or later in the 2.12 line; Cargo metadata also aligns its Windows bindings with this project's `webview2-com` 0.39.1 and `windows-core` 0.62.2 pins. Plugin 0.13.0 is incompatible here: it depends on `webview2-com` 0.38, producing duplicate WebView2 interface types at compile time. Use `tauri-plugin-mcp-bridge` 0.13.1 and upgrade the app's exact Tauri pin to 2.12.2. The [0.13.0 crate guide](https://docs.rs/crate/tauri-plugin-mcp-bridge/0.13.0) describes registration, `withGlobalTauri`, and the `mcp-bridge:default` capability; the [maintainer's 0.13.1 package notes](https://www.npmjs.com/package/@hypothesi/tauri-plugin-mcp-bridge) specify the newer Tauri requirement.

The plugin binds to all network interfaces by default. Use its documented custom builder to bind to `127.0.0.1`; keep registration under `cfg(debug_assertions)` and grant the bridge capability only to the main development window. Tauri describes capabilities as the boundary controlling a window's IPC access in its [configuration reference](https://v2.tauri.app/reference/config/#capability). `withGlobalTauri` injects APIs into `window.__TAURI__` as documented in the [Tauri configuration reference](https://v2.tauri.app/reference/config/#withglobaltauri).

Smoke testing should connect the driver, inspect the window and DOM, and read backend metadata. It should not invoke installation, persistence, process-start, or other state-changing app commands.

The app's startup hook performs orphan recovery, which updates server statuses and can act on stale lock files. Therefore run the smoke test with a temporary Tauri CLI `--config` overlay that sets a unique test `identifier` and `app.appDirectoriesOverride` to a dedicated scratch directory. Tauri documents that identifiers determine app-specific system paths, the CLI merges JSON config overlays, and `appDirectoriesOverride` redirects app-data and related paths. This isolates both single-instance identity and app storage from the user's installed app, saved server database, and processes.

- [Tauri CLI configuration overlays](https://v2.tauri.app/develop/configuration-files/)
- [Tauri `appDirectoriesOverride`](https://v2.tauri.app/reference/config/#appdirectoriesoverride)
