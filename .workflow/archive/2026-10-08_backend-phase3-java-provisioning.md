# WORKFLOW_STATE

## Current Goal
Complete backend Phase 3 Java provisioning, including runtime discovery, app-local Temurin installation, server-specific selection, and UI progress/override.

## Acceptance Criteria
- [x] Detect compatible Java from PATH, `JAVA_HOME`, Windows registry, and known Adoptium/Microsoft OpenJDK locations; validate executable, major version, and 64-bit architecture.
- [x] Resolve Minecraft's minimum Java from Mojang version metadata, with a fallback for known versions; support Temurin 8/17/21 on Windows x64.
- [x] Download on demand with resumable partial-file handling, metadata SHA-256 verification, disk-space preflight, and progress events; install app-locally without changing global PATH/JAVA_HOME/registry.
- [x] Persist a validated Java path per server; reject incompatible Java clearly when starting a server.
- [x] Create and Settings show the required/selected Java, allow install and a manual override, and display real download progress; browser mocks remain intact.
- [x] Acceptance mappings: MC 1.12.2 → Java 8, 1.20.1 → Java 17, 1.21 → Java 21; unsupported Java majors fail clearly.
- [x] TypeScript/build checks and relevant Rust checks pass, or unavailable tooling is reported.

## Status
Phase: Done
Last updated: 2026-10-08
Owner: PQM
Active Task ID: backend-003

## Active Plan
1. DONE restore Phase 2 context and CodeGraph map of Rust registration/process/store/UI paths.
2. DONE external research from Adoptium, Mojang, Microsoft, and RFC sources; materialize research, spec, ADR, implementation plan, and checklist.
3. DONE implement Phase 3 within approved Java 8/17/21 scope; preserve browser mocks and Phase 2 safety/EULA behavior.
4. FAIL independent review: P2 saved-runtime start requires Mojang connectivity; P2 Settings Java state can leak across server switch; P3 range parser ignores Content-Range unit.
5. DONE independent TypeScript/build verification (native Vite EPERM; documented external shim build passes); Cargo/Rust tooling unavailable.
6. DONE scoped rework attempt 1/3: offline fallback for known MC versions, Settings operation-state isolation, byte unit check, and focused Rust tests.
7. FAIL post-R1 review confirmed the three original fixes but found a P2 online-start latency risk: Start re-fetched Mojang metadata before spawning.
8. DONE scoped rework attempt 2/3: Start now uses local mapping for the seven Create catalogue versions, validates without Mojang HTTP, and rejects unknown versions.
9. PASS post-R2 review; two P3 follow-ups remain: directly test the local start mapping and clarify the research note's fallback policy.
10. DONE scoped rework attempt 3/3: added a direct unit test for all seven local Start mappings and unknown/26.1 rejection; added the research clarification.
11. FAIL final read-only check after R3: research/spec wording conflates the metadata fallback with the local Start map.
12. DONE one additional docs-only correction, explicitly authorized by the user, clarifying metadata fallback versus the local Start map.
13. DONE final read-only doc consistency review: PASS.
14. DONE Rust verification after locating the user-installed toolchain: all 5 tests pass, cargo check passes, Clippy exits 0; compile fixes reviewed and Java module rustfmt passes.
15. DONE full-crate format gate: after the user's authorization for format-only changes to the three flagged files, `cargo fmt` was applied and `cargo fmt --check` passes.
16. DONE final verification: TypeScript, Rust tests (5/5), cargo check, Clippy, crate-wide rustfmt, and Vite production build with the documented temporary realpath workaround pass.
17. DONE desktop runtime smoke: built and launched the Tauri executable with a temporary icon fixture, removed the fixture, and confirmed the app process is responsive with the `Block Server Manager` window and its Vite URL returns HTTP 200. The Java installer has no live Temurin download/extraction smoke.

## Recent Handoffs (last 3–5 only)
- 2026-10-08 PQM → Implementer backend-003-R3 — DONE: added direct coverage for all seven local Start mappings and unknown/26.1 rejection; Cargo unavailable.
- 2026-10-08 PQM → Reviewer backend-003-final — PASS after the user-authorized docs-only correction; documents distinguish metadata fallback from local Start mapping.
- 2026-10-08 PQM → Rust Tester — PASS: full Cargo tests 5/5, cargo check, and Clippy; temporary icon fixture removed.
- 2026-10-08 PQM → Rust formatter — PASS: user-authorized format-only changes to the three flagged files; crate-wide `cargo fmt --check` passes.
- 2026-10-08 PQM → Runtime smoke — PASS: Tauri desktop process is responsive and its configured Vite URL returns HTTP 200.

## Decisions & Constraints (current only)
- Platform: Windows-first desktop; stack: Tauri 2 + React/Vite + Tailwind + shadcn-style, Electron fallback (ADR-0002).
- Visual direction: original Minecraft-inspired CSS; no Mojang logos/assets/fonts; pixel font for headings/buttons only and clean body/log text.
- Navigation: 7 per-server tabs plus global Create; EULA and RAM gates stay mandatory and warnings readable.
- EULA is never auto-accepted. RCON binds `127.0.0.1`; no secrets in the binary and no Mojang assets bundled.
- Phase 3 scope: Windows x64 Temurin 8/17/21, matching the current Create version catalogue (through 1.21). Minecraft 26.1 requires Java 25; do not label it Java 21 or expand supported majors without a later approved plan update.
- Follow `WORKFLOW.md` and `AGENTS.md`: CodeGraph first for structural work, research before implementation, docs materialized before code, bounded review rework.
- Git hygiene: `.gitignore` excludes build outputs and the user-approved vendored `.opencode/skills/` tree remains on disk.

## Quality Gate Results (current task)
- Research: DONE; see `docs/research/2026-10-08-phase3-java-provisioning.md`.
- Docs gate: PASS — README/index, research note, ADR, spec, implementation plan, and acceptance checklist are present.
- Reviewer: production code PASS after R2; final documentation consistency review PASS after the user-authorized correction; Rust compile fixes received a final read-only PASS.
- Tests/build: `npx tsc --noEmit` PASS; native `npm run build` hits the host's Vite/Node `realpath` EPERM, while the same build with a temporary external Node fallback passes (48 modules); full `cargo test` 5/5 PASS; `cargo check` PASS; `cargo clippy --all-targets` PASS with warnings for planned events and an existing `map_or`; full crate `cargo fmt --check` PASS after authorized formatting. No live Temurin download/extraction E2E.
- Runtime smoke: built the Tauri binary using a temporary 1×1 icon fixture required by the build script, removed the fixture, launched the app, confirmed process responsiveness and the `Block Server Manager` main window, and received HTTP 200 from the configured local Vite page. The native Tauri window was not automated; browser-mock UI was inspected, where Java selection correctly remains mocked.
- Rework attempts: 3/3 plus one user-authorized docs-only correction complete.
