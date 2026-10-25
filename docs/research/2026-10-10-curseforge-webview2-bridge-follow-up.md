# Research Follow-up — CurseForge WebView2 Bridge and Import Validation

**Date:** 2026-10-10  
**Related:** [`2026-10-10-curseforge-server-pack-import.md`](2026-10-10-curseforge-server-pack-import.md)

## WebView2 binding dependency

During implementation, Tauri exposed the WebView2 controller through `with_webview`, while the `webview2-com` 0.39.1 crate did not re-export the `windows_core::Interface` trait needed to cast the COM interface. A Windows-only direct dependency on `windows-core` 0.62.2 was required. The user approved it together with the previously approved dialog/opener/WebView2 dependencies and Rust 1.90 MSRV alignment.

The native observer reports byte/state updates and retains the live download operation for cancellation. Tauri's high-level `on_download` callback supplies the destination and a path-correlated completion result. A download is promoted from its temporary `.part` name only after the native and Tauri completion states agree and the file is a readable ZIP. Live CurseForge/WebView2 interaction was not exercised in this task.

## Code-review follow-up

Independent code review found four import-safety/lifecycle gaps and one selection race. The implementation was tightened to:

- Parse Forge/NeoForge argument files and require every referenced JAR payload to exist in the ZIP before classifying it as supported.
- Require the Forge 1.12.2 universal JAR at the exact runtime root expected by the existing Start resolver.
- Register external-file copy `.part` paths before creating them and hold the active-path registry while Refresh removes abandoned temporary files.
- Invalidate pending archive inspection requests on selection changes and require the inspected filename to match the current selected ZIP before Configure or Install.
- Surface WebView download staging failures as transfer events with a safe message.

Focused tests cover supported Forge/NeoForge fixtures, missing referenced JAR payloads, nested legacy Forge paths, and Refresh during external ZIP copy. The final Rust library suite passed 73 tests; the focused importer tests passed 9. Rust formatting, Cargo check, and the TypeScript/Vite build passed. The frontend project has no dedicated test runner.

## Sources

- [`webview2-com` 0.39.1](https://docs.rs/webview2-com/0.39.1/webview2_com/)
- [`windows-core` 0.62.2 `Interface` trait](https://docs.rs/windows-core/0.62.2/windows_core/trait.Interface.html)
- [Tauri `with_webview`](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindow.html#method.with_webview)
