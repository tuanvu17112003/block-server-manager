# WORKFLOW_STATE (archived 2026-10-10 — curseforge-inspect-unicode-path)

## Current Goal
Fix CurseForge ZIP inspection failing with os error 267 at the free-disk-space check for staged filenames containing non-ASCII characters (e.g., ™ in the Prominence II server pack).

## Acceptance Criteria
- [x] Inspect succeeds for staged ZIPs with non-ASCII names (e.g., `Prominence™_II_...cf.zip`); the reported 1.1 GB file inspects instead of failing at the disk-space check.
- [x] The free-space preflight resolves the containing volume/directory rather than depending on the file path itself.
- [x] Regression coverage for Unicode file paths in the disk-space check; ASCII behavior unchanged.
- [x] Existing CurseForge, Modrinth, and Java provisioning flows preserved.
- [x] Independent review, Rust regression tests, Cargo check, formatting, and frontend build pass.
- [x] Clearly distinguish code verification from an on-device inspect smoke test with the staged 1.1 GB file.

## Status
Phase: Done
Last updated: 2026-10-10
Owner: PQM
Active Task ID: none

## Lifecycle summary
1. Explorer mapped the inspect flow: `inspect_staged_zip` (`curseforge_import.rs:327`) passed the staged FILE path to `free_disk_space`, which calls Win32 `GetDiskFreeSpaceExW` (`java/mod.rs:955-989`) — a directory-only API → ERROR_DIRECTORY 267. The ™ leaf removed the accidental ASCII tolerance. Second latent file-path caller at `:1669` (`.part` observer); all other call sites pass directories.
2. Documenter materialized `docs/research/2026-10-10-curseforge-inspect-unicode-path.md` + `docs/implementation/curseforge-inspect-unicode-path.md`, indexed in `docs/README.md` (docs gate PASS; no ADR — bug fix).
3. Implementer applied both call-site resolution (`staged_file_space_dir`) and hardened `free_disk_space` (`disk_space_query_path`), plus 8 regression tests with small synthetic ™ fixtures.
4. Reviewer PASS (all criteria, file:line evidence). Tester PASS (85/85 lib, check, fmt, build; 0 regressions).

## Recent Handoffs
### 2026-10-10 Explorer → PQM
Task: `curseforge-inspect-unicode-path` root-cause map | Result: complete — file-vs-directory mismatch + ™ tolerance analysis, 6 call sites audited | Files: `src-tauri/src/modpacks/curseforge_import.rs`, `src-tauri/src/java/mod.rs:955-989`, `src-tauri/src/installer/mod.rs:1636-1644`
### 2026-10-10 Documenter → PQM
Task: `curseforge-inspect-unicode-path-docs` | Result: complete — research + implementation checklist, README indexed | Files: `docs/research/2026-10-10-curseforge-inspect-unicode-path.md`, `docs/implementation/curseforge-inspect-unicode-path.md`, `docs/README.md`
### 2026-10-10 Implementer → PQM
Task: `curseforge-inspect-unicode-path-fix` | Result: complete — call-site resolution + hardened function, 8 new tests | Files: `src-tauri/src/java/mod.rs`, `src-tauri/src/modpacks/curseforge_import.rs`
### 2026-10-10 Reviewer → PQM
Task: `curseforge-inspect-unicode-path-review` | Result: PASS on all criteria | Files: changed backend + docs
### 2026-10-10 Tester → PQM
Task: `curseforge-inspect-unicode-path-test` | Result: PASS — lib 85/85, check PASS, fmt PASS, build PASS | Files: changed backend + inline tests

## Decisions & Constraints (durable — retained in live state)
- Set both initial and maximum JVM heap from each server's configured RAM; see `docs/architecture/adr/0010-match-configured-initial-server-heap.md`.
- Managed server commands use attached stdin only; detached RCON remains deferred until loopback-only binding is verified.
- Keep the newest 100 successful commands per server in SQLite; Clear is view-local and never truncates `logs/latest.log`.
- Child stdout/stderr pumping reads newline-delimited bytes, decodes lossily, preserves the `server://log/{id}` contract, and warns on real I/O errors.
- Preserve bounded console logging, process tracking, and explicit EULA behavior.
- Do not send commands to a user's live server or alter its process/log/database without explicit authorization.
- Rust MSRV is 1.90 to match Tauri 2.12.1. Approved dependencies: `tauri-plugin-dialog` 2.8.1, `tauri-plugin-opener` 2.7.0, `webview2-com` 0.39.1, and Windows `windows-core` 0.62.2.
- CurseForge Core API/key integration and client-export file resolution remain gated. The website + local server-pack import flow does not use the API.
- Initial CurseForge import support is limited to validated Forge/NeoForge packs. Vanilla/Paper/Fabric remain unsupported pending exact markers; Quilt imports remain unsupported while saved Quilt server behavior is preserved.
- CurseForge ZIPs stage under app data, are preserved by default, and only the app-managed copy may be deleted after successful publication when the user enables the setting. Archive-provided scripts are never executed.
- Embedded CurseForge browser permits HTTPS `curseforge.com` + `forgecdn.net` (exact + true subdomains) only; `on_new_window=Deny`; capabilities remain `windows:["main"]`. See `.workflow/archive/2026-10-10_curseforge-embedded-download-handoff.md`.
- Free-space queries resolve the containing directory before the Win32 call; file-leaf Unicode content never affects volume resolution. See `docs/research/2026-10-10-curseforge-inspect-unicode-path.md`.

## Task-specific notes (not carried to live state)
- Code verification only: synthetic ™ fixtures prove no 267; the real 1.1 GB `Prominence™_II` pack was never touched by workers. On-device Inspect smoke in the app is user-owned.
- Windows-gated tests (`free_disk_space_tm_leaf_matches_directory`, `free_disk_space_insufficient_space_stays_a_validation_message`) run only on Windows/x86_64; portable pure-path tests are the backstop elsewhere.
- Repo has no git commits (all files untracked); no tracked-base diff available.

## Quality Gate Results
- Reviewer: PASS (all criteria, file:line evidence; live-smoke gap noted)
- Tests (incl. regression): PASS — lib 85/85 (77 baseline + 8 new), `curseforge_import` 16/16, `disk_space` 5/5, `tm_leaf` 4/4, navigation 4/4; 0 failures, 0 ignored
- Cargo check: PASS (2 pre-existing dead-code warnings in `src/util/events.rs`, unrelated)
- Formatting: PASS (`cargo fmt --check`, no diffs)
- Frontend build (`npm run build`): PASS (49 modules)
- On-device smoke: NOT exercised (user-owned)
- Rework attempts: 0/3
