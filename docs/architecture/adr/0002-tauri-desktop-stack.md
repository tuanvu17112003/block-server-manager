# ADR 0002 — Tauri 2 + React Desktop Stack

Status: Accepted (2026-10-08, from research-001-A)
Context: Windows-first desktop, Full UI code deliverable, empty repo, need Tailwind speed + low footprint while java servers run, single-click install + auto-update.
Decision: Tauri 2 + React (Vite) + Tailwind + shadcn + tauri-plugin-shell (java sidecar) + tauri-plugin-updater (NSIS passive) + SQLite later. Frontend MVP first with mocks; Rust/backend later.
Alternatives: Electron (same UI, 10-25x size/RAM, fallback if zero Rust), .NET Avalonia/WPF (no Tailwind, 2-3x slower), Wails v3 beta.
Consequences: Need Rust toolchain + WebView2 bootstrapper in NSIS + on_before_exit stop servers + Temurin JRE detect/bundle + signed latest.json updates. Frontend portable to Electron if needed.
