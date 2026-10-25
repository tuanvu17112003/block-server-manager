# Research 2026-10-08 — Desktop Stack (Explorer-stack, research-001-A)

## Summary
- No web-panel stack fits Windows desktop single-click. Crafty = Python Tornado + AdminLTE/SQLite portable exe; Pterodactyl = PHP/Laravel + React/Tailwind + Go Wings + Docker Linux-only; AMP = proprietary C# + JS with Temurin JDK auto-install. All prove REST + background Java process model, none gives desktop Tailwind velocity.
- Launcher precedent favors lightweight native + web UI: Prism C++/Qt (~10.5k stars), ATLauncher Java Swing (~844 stars), GDLauncher Electron+React/Redux+Node with auto Java + updater, Modrinth App Theseus = Tauri Rust + Vue + SQLite — proof Tauri manages Java runtimes, instances, Modrinth API on Windows.
- Size/RAM gap 10-25x: Tauri 2 hello-world 8.6-14.2 MB vs Electron 30 180-244 MB; idle 42-58 MB vs 168-480 MB; 6-window 172 vs 409 MB; cold 120-140ms vs 460-520ms Win11.
- Java sidecar: Electron `child_process.spawn('java -jar server.jar')` trivial; Tauri 2 `tauri-plugin-shell + sidecar` + CommandEvent::Stdout; must detect/bundle JRE + handle NSIS not killing sidecar on upgrade. Wails Go os/exec similar.
- Tailwind/shadcn speed only in web stacks (Electron, Tauri 2, Wails v3, Nextron same Vite+React). .NET MAUI/Avalonia/WPF/WinUI3 XAML, no Tailwind — 2-3x slower prototype.
- Auto-update both solved, no server needed: electron-updater + electron-builder (NSIS diff, GitHub/S3 latest.yml); tauri-plugin-updater (signed NSIS/MSI via latest.json, pubkey mandatory, passive/basicUi/quiet).
- .NET risk is roadmap: WPF Win-only mature; WinUI3 Win-only uncertain; MAUI mobile-first (no official Linux); Avalonia 11.2 cold 1.6s vs MAUI 2.1s, only serious .NET Linux option.

## Comparison
| Stack | Pros | Cons | Size/RAM | Precedent |
|---|---|---|---|---|
| Electron + React + Tailwind | fastest JS prototype, full Node, mature updater, hiring pool | 150-250MB, 180-480MB idle, Chromium CVE churn | 187-190MB / 186-480MB, 520ms | GDLauncher, VSCode |
| Tauri 2 + React + Tailwind (RECOMMENDED) | 8-15MB, 42-60MB idle, WebView2 preinstalled, Rust safety + caps, signed updater | Rust toolchain, WebView skew, sidecar lifecycle, 80s first compile | 14.2MB / 42-58MB, 140ms | Modrinth App Theseus |
| .NET WPF/WinUI/MAUI/Avalonia | single exe, NativeAOT 0.6-0.9s, Process.Start(java) first-class, MSIX | no Tailwind, XAML rewrite, MAUI desktop weak | 20-50MB / 80-125MB | AMP (C# backend) |
| Wails v3 Go + React | ~15MB, ~10MB base, <0.5s, Go->TS bindings 0.12ms IPC | v3 beta 2026, smaller ecosystem, updater less turnkey | 15MB / 10-40MB | small prod apps |
| Nextron | zero-config Next+Electron | unmaintained wrapper — do not pick | same as Electron | none |

Single-click: Electron NSIS + Tauri NSIS passive both one-click; .NET MSIX also one-click but cert overhead.
APIs equal (plain REST): Modrinth open (User-Agent required), CurseForge x-api-key approval + revenue-share.
Dev speed Full UI: Electron == Tauri == Wails (same Vite React); .NET 2-3x slower if shadcn design.

## Recommendation
Tauri 2 + React (Vite) + Tailwind + shadcn + Rust tauri-plugin-shell for Java + tauri-plugin-updater (NSIS) + SQLite (like Theseus).
1. Windows fit: 92% smaller + 58-75% less RAM leaves budget for java -Xmx4G while manager idles ~50MB.
2. Speed preserved: same React/Tailwind velocity + type-safe Rust commands; Modrinth App proves shape.
3. Ops: signed auto-update via static latest.json on GitHub Releases, NSIS passive single-click.
Risks: Rust learning + sidecar lifecycle (on_before_exit stop servers, Temurin fallback like AMP); WebView2 skew (pin bootstrapper, test Win10 1809+); fallback if zero Rust → Electron + same React code (main.rs → ipcMain port).

## Sources
- https://johal.in/tauri-20-vs-electron-30-desktop-app-bundle
- https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4
- https://rustify.rs/articles/rust-tauri-vs-electron-2026
- https://v2.tauri.app/plugin/updater/
- https://github.com/electron/electron/blob/main/docs/tutorial/updates.md
- https://github.com/rbonett/crafty / https://gitlab.com/crafty-controller/crafty-4/-/tree/master / https://craftycontrol.com/
- https://github.com/pterodactyl/panel / https://pterodactyl.io/
- https://cubecoders.com/amp / https://cubecoders.com/AMP/Minecraft
- https://prismlauncher.org/ / https://github.com/PrismLauncher/PrismLauncher
- https://github.com/ATLauncher/ATLauncher / https://atlauncher.com/
- https://github.com/gorilla-devs/GDLauncher/blob/master/README.md
- https://docs.modrinth.com/contributing/theseus/ / https://github.com/modrinth/code/blob/main/apps/app/README.md
- https://docs.modrinth.com/api/operations/searchprojects/ / https://modrinth-code.mintlify.app/api/overview
- https://docs.curseforge.com/rest-api
- https://v3.wails.io/ / https://avaloniaui.net/maui-compare / https://avaloniaui.net/blog/wpf-modernization-in-2026
