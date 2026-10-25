# Implementation Plan — Modpack Server Setup Overhaul

The coder starts only after the docs gate, user loader-scope decision, and independent plan review are complete.

## Ordered phases and owned paths

### 0. Inventory and contract lock

- Read current `WORKFLOW_STATE.md`, ADR-0016, and `docs/specs/modpack-server-setup-overhaul.md`.
- Preserve existing Create/Start/DB/EULA/process contracts.
- Confirm Quilt remains a disabled placeholder and CurseForge remains keyless.
- Paths: docs and state only.

### 1. Shared model and plan

- Add typed provider/source, exact pin, side, selection action, install stage/state, plan, report, and launch-config models.
- Add schema/version fields for the JSON artifacts.
- Paths: `src-tauri/src/modpacks/pipeline/model.rs`, `plan.rs`, and module wiring.

### 2. Archive classification and manifest validation

- Reuse proven safe ZIP primitives; add CurseForge server-pack/client-export/invalid classification and local `.mrpack` parsing.
- Keep current strict path, bounds, case-collision, symlink, and reserved-path checks.
- The only inner-ZIP unwrap accepted is one wrapper containing exactly one recognized ServerPackCreator Fabric server archive; reject generic `server_files/`, multi-inner, or deeper nested layouts. The accepted SPSC shape requires its exact manifest fields and a nonempty file inventory.
- Paths: `src-tauri/src/modpacks/pipeline/classify.rs`, `validate.rs`, fixtures.

### 3. Provider resolution and file policy

- Adapt existing Modrinth exact ID/version resolution and local-file path into the shared plan.
- Keep CurseForge keyless and accept only supported author server ZIPs.
- Implement a shared file decision engine and visible optional/conflict choices; do not auto-fetch absent dependencies. Rebuild the active plan from exact source data; do not treat edited `install-plan.json` decisions as authority. Optional-file checkboxes remain valid explicit choices; policy overrides beyond optional selection are accepted only for paths reclassified as conflicts.
- Paths: `src-tauri/src/modpacks/pipeline/providers/{modrinth,curseforge}.rs`, `selection.rs`; focused Create UI/types.

### 4. Exact loader preparation

- Resolve exact Mojang/Fabric/Forge/NeoForge metadata. Keep Quilt as a disabled placeholder.
- Validate the selected Java executable and required major before metadata or staging work. Validate every loader metadata/artifact redirect hop against a source-specific official host allowlist; allow at most three redirects, use the system-directory curl executable, disable curl's default config for pipeline calls, and never execute an artifact from an unapproved host.
- Detect complete runtimes; otherwise install the exact coordinate and parse every generated args/library reference.
- Paths: `src-tauri/src/modpacks/pipeline/loader.rs`, existing metadata/installer adapters only where their behavior is reusable.

### 5. Download and filesystem transaction

- Use a same-volume staging transaction with preflight, verified downloads, ordered overrides, backups for update flows, promote, rollback, and cleanup.
- For each archive source, preflight free space on the temporary volume, create a bounded private snapshot with a handle that denies other handles write/delete access, and calculate SHA-1 + SHA-512 from the same byte stream. Retain that handle through parsing and do not write through it after the copy. Remote Modrinth snapshots must match API SHA-1 + SHA-512 + size. For local archives, record a calculated fingerprint without claiming trusted archive authenticity. In both modes, verify each indexed file's manifest SHA-1 + SHA-512 + size. Check cancellation during copy and after parser/selection stages. Do not add pending-choice files to download metadata. Require HTTPS, validate each redirect hop against the explicit provider allowlist, and stop after three redirects.
- Record per-file and per-stage results. Never mutate worlds or final server paths before commit.
- Write a versioned managed-file ownership manifest. Remove stale files only from the prior managed set; retain untracked paths. Back up user-modified managed files and preserve them by default; require an explicit choice before replacement.
- Preserve `world/`, EULA acceptance, and user-owned `server.properties` keys; retain the newest two successful backups. Rollback restores the prior server tree and corresponding database record.
- Paths: `src-tauri/src/modpacks/pipeline/transaction.rs`, `download.rs`, `report.rs`.
- Add an additive `managed_server_files` SQLite table keyed by server ID and normalized relative path. Update it in the same publication transaction as server metadata; emit `managed-files.json` as a matching audit snapshot, never sole authority. Before each write/delete, bind persisted targets to the current server ID/canonical app-data directory, enforce `<240` absolute path length and reparse containment, verify registry/manifest agreement and actual installed hashes, and reject protected paths. Missing/mismatched ownership stops cleanup. Legacy servers require a reviewed adoption preview before pruning.
- Never overwrite or stale-delete `world/`, `eula.txt`, `logs/`, `backups/`, manager plan/report files, or `user_jvm_args.txt`; preserve EULA state. Merge only manager-owned `server.properties` keys.

### 6. Launch and readiness

- Parse launch sources in documented precedence; save/show argv, CWD, and Java. Do not execute pack scripts.
- Add loader-init/`Done (...)!` readiness tracking and EULA-pending state without auto-starting or auto-accepting.
- Classify known missing-dependency, corrupt-JAR, client-only leakage, Java mismatch, mixin conflict, invalid launch, and readiness-timeout evidence. Report exact files/mod IDs/log excerpts where available; leave server files untouched and do not auto-repair.
- For `latest.log` and crash reports, validate the opened file handle's resolved path beneath the canonical server root before reading; path checks followed by a separate open are insufficient. Fail closed on targets without a verified handle-path check. If the bounded scan reaches 128 entries, encounters an entry error, or a previously enumerated report disappears before inspection/read, disclose that crash-report evidence may be incomplete.
- Paths: `src-tauri/src/modpacks/pipeline/launch.rs`, `runtime.rs`, narrow Start integration.

### 7. UI migration and removal of old path

- Replace old Create wizard install invocations only after the new provider pipelines meet the same acceptance surface.
- Keep progress/cancel and clear recovery text; show optional choices, conflicts, skipped files, and reports.
- Remove obsolete duplicate handlers only after code review verifies there are no remaining callers.
- Add Tauri MCP Bridge 0.13.1 with the compatible Tauri 2.12.2 patch only for debug builds, bind its WebSocket to `127.0.0.1`, enable `withGlobalTauri`, and grant `mcp-bridge:default` only to the `main` capability. Use it to inspect the UI/backend state; keep the smoke test read-only and do not start a server or invoke install commands.
- Run the app with `npx tauri dev` and a temporary `--config` overlay with a unique test `identifier` and dedicated scratch `appDirectoriesOverride`, then connect through `driver_session` and inspect the main window/DOM. Do not use or mutate the user's saved server database. A production build must not register the bridge plugin.
- Paths: `src/tabs/Create.tsx`, `src/tauri.ts`, `src-tauri/src/modpacks/**`, command registration.

### Phase 7 verification record — 2026-10-12–13

- `npm run build`: PASS (TypeScript and Vite production bundle).
- `cargo check --lib --offline`: PASS; remaining warnings are phase-gated/dead-code warnings from the inactive legacy install implementation and unconnected pipeline helpers.
- Focused Rust regressions: `modpacks::pipeline` 103/103 and `servers::process` 14/14 passed, including picker-token release and preview/source association cases.
- Scoped `rustfmt --check`: PASS for `lib.rs`, `modpacks/pipeline/{commands,transaction,mod}.rs`.
- Tauri MCP smoke: PASS twice with bridge 0.13.1 and Tauri 2.12.2. The final run used debug app identifier `com.blockserver.manager.mcpsmoke20261012b`, `127.0.0.1:9223`, and a dedicated scratch app-directory root. Read-only backend metadata and main-window DOM inspection succeeded. No install or server-start command was sent; the app and MCP session were stopped after inspection.
- Independent Phase 7 review: PASS after closing the local `.mrpack` picker-token lifecycle finding.
- No live pack install or server process startup was run. The Tauri MCP smoke stayed read-only; provider and transaction behavior was exercised with isolated generated fixtures.

## Quality gates

- Independent reviewer checks provider pins, server-side policy, archive security, concurrency/cancellation, data preservation, no-script execution, launch parsing, rollback, and UI/API contract.
- Run focused unit tests for models, classification, resolution, selection, downloader integrity, loader completeness, launch parsing, transaction rollback, and readiness. Run the relevant Rust and frontend regression suites before replacing old handlers.
- Candidate pinned end-to-end seeds: CurseForge SERVER file 9094783 (Prominence II 4.1.3; positive recognized ServerPackCreator Fabric + one wrapper, only if its original ZIP is already available) and Modrinth Better MC Fabric project/version `shFhR8Vx`/`M5BnAIQy` plus Better MC Forge `4BV47HRn`/`bdRIjRgs`. Add negative fixtures for client exports, generic `server_files/`, multi-inner/deep wrappers, malformed manifests, and a valid Forge inner ZIP wrapped as the single outer `server.jar` (must remain Unsupported). These are research candidates, not verified test results; fetch full current artifact hashes before use. Use generated isolated fixtures when original artifacts are unavailable.
- Regression cases must include corrupt/truncated/HTML CurseForge files, Modrinth hash/size/path/redirect failure, environment conflicts, missing hard dependencies, unavailable/incomplete loader pins, stale managed-file cleanup with user/untracked retention, rollback, world/EULA/server.properties preservation, backup retention, EULA-pending, and `Done` readiness.
- Tamper cases must edit the saved plan's side decisions and target path and the JSON managed-file snapshot; none may bypass provider policy, escape the selected server root, or authorize deletion without matching SQLite ownership plus installed hashes.
- Execute the handoff's reproducible pack matrix only with pinned IDs, full hashes, logs, and user-provided test artifacts. Do not claim live server compatibility from metadata alone; do not alter or launch the user's existing servers for test coverage.

## Constraints

- Do not add a runtime/dependency from the candidate survey without explicit user approval; use the reviewed patterns inside the existing Rust app.
- No CurseForge API key or client-export resolution.
- No hidden change to saved servers, processes, logs, or databases during implementation review.
- No `--latest` or nearby-version substitutions, scripts, auto-EULA, silent missing-file skips, or destructive rollback.
