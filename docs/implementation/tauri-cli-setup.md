# Project-local Tauri CLI Setup

## Goal

Make the existing Tauri 2 desktop project directly launchable through its npm toolchain, then use that launch to continue the live Create smoke test.

## Existing wiring

- `@tauri-apps/api` and the Rust `tauri` crate are already present.
- `src-tauri/tauri.conf.json` uses `http://localhost:1420` as its development URL.
- `vite.config.ts` binds Vite to port 1420 and fails if that port is occupied.
- The project-local Tauri CLI is installed at 2.12.1; `cargo tauri` is not installed globally.

## Ordered steps

1. Add `@tauri-apps/cli` as an npm development dependency, keeping the dependency on Tauri 2. **Done:** installed 2.12.1.
2. Verify the local command with `npm exec -- tauri --version`. **Done:** reports `tauri-cli 2.12.1`.
3. Launch with `npm exec -- tauri dev`. The sandbox hits Vite `realpath` EPERM; use elevated access in this host.
4. Create a minimal square transparent SVG icon and use `npm exec -- tauri icon src-tauri/icons/app-icon.svg --output src-tauri/icons` to generate the Windows ICO and standard platform variants. **Done.**
5. Replace the custom `window.__TAURI__` check with `isTauri` from `@tauri-apps/api/core`. Tauri’s config defaults `withGlobalTauri` to false; the official helper detects a Tauri webview without enabling the global API. **Done.**
6. Relaunch with `npm exec -- tauri dev`. **Done with elevated access:** Rust compilation succeeds and the native process is responsive; Vite listens on port 1420. Native UI control is unavailable here, so the real server install/start smoke remains pending. Do not accept the Minecraft EULA for the user.
7. Independent review: **PASS** for the local CLI, runtime detection, and icon assets.

## Acceptance criteria

- The local Tauri CLI is installed and reports its version.
- The elevated Tauri development command compiles and starts the native app; the project-local CLI reports version 2.12.1.
- The official runtime helper keeps browser mode on mocks while routing native Tauri windows to backend IPC.
- The live install/start gate remains open until the native UI reaches real provider-backed server creation and start; browser mock progress does not count.
