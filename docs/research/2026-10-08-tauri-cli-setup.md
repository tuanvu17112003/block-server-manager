# Tauri CLI Setup Research

Date: 2026-10-08

## Findings

- The project already has the Tauri 2 Rust backend and `@tauri-apps/api` 2.12.1. The compiled Tauri binary also passed the existing Phase 4 build gate.
- At initial inspection, the project had no `@tauri-apps/cli` npm package, and `cargo tauri --version` reported that the Cargo CLI command was unavailable. The local npm CLI was installed during this follow-up.
- Tauri’s official project setup and CLI references recommend adding the npm CLI as a development dependency with `npm install -D @tauri-apps/cli@latest`. The CLI is used across the Tauri development lifecycle. Installing `@tauri-apps/cli@^2.12.0` in this project resolved version 2.12.1, matching the installed `@tauri-apps/api` 2.12.1.
- The official CLI `icon` command accepts a square transparent SVG or PNG and generates platform icon assets into the `icons` folder beside `tauri.conf.json` by default. It supports an explicit output directory.
- `src-tauri/tauri.conf.json` points `devUrl` to `http://localhost:1420`, and Vite is already configured for port 1420 with `strictPort: true`.

## Runtime detection finding

- The project’s custom `isTauri()` checks for `window.__TAURI__`. Tauri’s official JavaScript API docs say that global is injected only when `app.withGlobalTauri` is enabled; the project config omits that option, whose default is `false`.
- Tauri’s API package exports `isTauri()` from `@tauri-apps/api/core` specifically to detect a Tauri webview. The custom check can therefore select browser-mock UI while the app is hosted in a native Tauri window.
- This task replaces the custom global check with the official helper, keeping `withGlobalTauri` disabled.
- The user screenshots show the mock UI path, but that evidence alone cannot distinguish a browser tab from a native shell running that path.

## Local launch findings

- `npm exec -- tauri --version` reports `tauri-cli 2.12.1`.
- Sandboxed `npm exec -- tauri dev` fails Vite dependency scanning with the documented host `realpath` EPERM.
- Before icon generation, the elevated launch started Vite on port 1420 but Rust compilation failed because `src-tauri/icons/icon.ico` was missing.
- The Tauri CLI icon generator created `src-tauri/icons/icon.ico` and platform image variants from the new square SVG source.
- After the approved icon and runtime-detection fixes, elevated `npm exec -- tauri dev` completed Rust compilation and launched a responsive app process. Vite remains bound to port 1420. Native UI interaction is unavailable in this session.

## Decision for this setup task

Add the Tauri 2 CLI as a local npm development dependency so the project can launch with `npm exec -- tauri dev`. Do not add a global Cargo install or change the existing Rust/API versions. Use the app’s existing Tauri config and Vite port.

## Sources

- [Tauri: Create a Project](https://v2.tauri.app/start/create-project/) — npm installation command for the CLI.
- [Tauri: Command Line Interface](https://v2.tauri.app/reference/cli/) — CLI role and package-manager installation methods.
- [Tauri: Command Line Interface — icon](https://v2.tauri.app/reference/cli/) — accepted SVG/PNG input and generated icon output directory.
- [Tauri: JavaScript API reference](https://v2.tauri.app/reference/javascript/api/) — `window.__TAURI__` global and the `core.isTauri()` helper.
- [Tauri: Configuration reference](https://v2.tauri.app/reference/config/) — `withGlobalTauri` default and behavior.
