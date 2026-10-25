# Plan — Full UI Code (MVP frontend, Tauri-ready)

Stack: Tauri 2 + React (Vite) + Tailwind + shadcn (ADR-0002). MVP = frontend only with mocks; no Rust/Java spawn yet (stub commands).

1. Scaffold Vite React TS + Tailwind + shadcn (light/dark), sidebar layout: server list (status dot, players, search, +New) + header (status + Start/Stop/Restart + Copy IP) + 8 tabs (Overview/Create/Console/Players/Worlds/Backups/Metrics/Settings). Owned: src/**.
2. Mock data: servers (vanilla, paper, forge pack), modpack search results (CF/MR cards), players, worlds, backups, metrics series, logs. File: src/mocks/*.
3. Overview: cards + quick actions + empty CTA → Create.
4. Create wizard: 3 steps + filters + RAM slider + port check (mock) + EULA gate (blocks Start) + progress mock + parity notice.
5. Console: log view (color, search, auto-scroll, Clear/Export mock) + cmd history + quick chips.
6. Players/Worlds/Backups/Metrics/Settings per specs/app-tabs.md with disabled-when-stopped + confirms + empty states.
7. Polish: responsive 1280+, keyboard (Enter send, Up history), toasts, confirm dialogs, skeletons + error retry.
Constraints: no backend edits outside src/; no secrets; EULA never auto-accept; Java Auto read-only; CF key field placeholder (MR default); ports mock.
