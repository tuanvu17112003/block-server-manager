# Implementation Guide — CurseForge Server Pack Browser and ZIP Import

Read first:

- [`../specs/curseforge-server-pack-import.md`](../specs/curseforge-server-pack-import.md)
- [`../research/2026-10-10-curseforge-server-pack-import.md`](../research/2026-10-10-curseforge-server-pack-import.md)
- [`../architecture/adr/0012-curseforge-server-pack-import.md`](../architecture/adr/0012-curseforge-server-pack-import.md)
- [`../specs/modpack-installation.md`](../specs/modpack-installation.md)
- [`../architecture/adr/0004-server-installation-jobs.md`](../architecture/adr/0004-server-installation-jobs.md)

## Implementation status and gates

- **Implemented:** user approved raising the declared Rust MSRV to 1.90, retaining Tauri 2.12.1, and adding `tauri-plugin-dialog = "=2.8.1"`, `tauri-plugin-opener = "=2.7.0"`, Windows `webview2-com = "=0.39.1"`, and Windows `windows-core = "=0.62.2"`. The latter provides the `Interface` trait needed for the WebView2 controller bridge because `webview2-com` does not re-export it.
- Independent design review and independent code review passed after two scoped implementation rework rounds.
- Verification: `cargo check --offline --manifest-path src-tauri/Cargo.toml` PASS; `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib` PASS (73 tests, including 9 focused CurseForge tests); Rust formatting PASS; `npm run build` PASS (TypeScript + Vite). Two existing dead-code warnings remain. The package has no frontend test runner.
- Runtime limitation: no live CurseForge page or WebView2 download was exercised. Non-Windows platforms use the external-browser + browse-to-stage flow. Current import support is validated Forge/NeoForge layouts plus recognized ServerPackCreator Fabric archives (including one nested ZIP wrapper); arbitrary Fabric and other loaders remain unsupported.
- **Embedded-download follow-up:** the current navigation allowlist permits HTTPS `curseforge.com` and the true `forgecdn.net` root/subdomain tree, with unit coverage for `edge.forgecdn.net`, HTTPS-only behavior, and lookalike rejection. The original live WebView2 redirect/completion flow was not smoke-tested. The user's newer invalid-format symptom is not yet tied to this earlier redirect issue; retain the failed transfer message/log and exact file ID to diagnose it.
- Keep the feature API-independent. Do not add `keyring`, CurseForge API requests, project/file ID resolution, or API data caching.

## Implemented paths

- Backend implemented in `src-tauri/src/modpacks/curseforge_import.rs`, `src-tauri/src/installer/mod.rs`, `src-tauri/src/servers/process.rs`, `src-tauri/src/modpacks/mod.rs`, and `src-tauri/src/lib.rs`; no server database schema change was needed.
- Frontend: `src/tabs/Create.tsx`, `src/tauri.ts`, `src/tabs/Settings.tsx` (or the existing settings preference surface), and narrowly required store/types changes.
- Tauri configuration: `src-tauri/capabilities/default.json` and `src-tauri/tauri.conf.json` only for the dedicated browser's permissions or lifecycle. Never grant the remote CurseForge window main-app IPC/filesystem capabilities.
- Docs: the linked Phase 5 spec, research, ADR, implementation guide, and indexes.
- Do not change existing Modrinth search/install, standalone installers/catalogues, or current Quilt management/Start behavior.

## Ordered work

### 0. Verify the platform bridge and dependencies

1. After dependency approval, wire the native dialog/opener plugins through typed Tauri commands and required main-window capabilities; do not expose them to the remote browser window.
2. Build a dedicated `curseforge-browser` `WebviewWindow` for the fixed official URL. Enforce safe navigation/new-window behavior and register no broad app commands in that window.
3. Add one WebView2 `DownloadStarting` handler. Route downloads to unique absolute `.part` paths, set the suggested filename only after sanitization, and retain the operation handle keyed by a transfer ID.
4. Bridge `BytesReceivedChanged` and `StateChanged` to progress events. Use a nullable total; cancel with the operation handle; distinguish user cancellation from interruption. Coordinate this with Tauri `on_download` so only one event path owns each file and the finish event cannot promote a failed transfer.
5. If Tauri's current `with_webview`/controller lifecycle cannot attach the native handler safely, stop and report the concrete incompatibility before changing architecture or dependencies.

### 1. Staging and browser UX

1. Resolve the Tauri app-data directory and create `imports/curseforge/` using the existing path helper. Keep it separate from `installer-staging/` and all server folders.
2. Allocate collision-free, sanitized filenames. Reserve active paths and use `.part` files that do not match the ZIP scanner's inclusion rules.
3. On completed state, cross-check the Tauri success flag, WebView2 state, file existence/size, and readable ZIP structure. Atomically rename to a stable `.zip` filename; on interrupted/cancelled/error states remove only the partial.
4. In Create, expose official URL, concise Additional Files → SERVER instructions, browser open, external browser fallback, and accessible download progress/cancel/failure state.
5. Explicitly handle non-Windows platforms as external-browser + browse, unless their native API has been separately implemented and reviewed.

### 2. Listing and selecting imports

1. Add typed backend IPC to list staged completed ZIPs and refresh them. Ignore hidden/partial/active files and reject paths that are symlinks/reparse points.
2. Add a ZIP-filtered native **Browse for ZIP** flow. Copy a picked outside ZIP to staging using a unique filename; do not alter the original file.
3. Show file name, size, last-modified time, selected state, refresh, browse, and inspect errors. Do not scan the archive on a blocking UI thread.

### 3. Inspect and classify

1. Add a parser independent of the Modrinth `modrinth.index.json` format; share only proven generic archive helpers.
2. Preflight file signature, entry count, compressed/uncompressed totals, free space, and normalized path uniqueness before extraction.
3. Reject path traversal, absolute/drive/UNC paths, alternate streams, invalid Windows names, reserved manager paths, symlinks/reparse points, and expansion/resource violations. Stream extraction manually into a new staging directory; never call blanket extraction.
4. Classify CurseForge client exports before server packs. A client manifest with remote `files[]` is non-installable in this feature; report the API gate and point to server-pack instructions.
5. Identify Minecraft version/loader/build from explicit archive metadata and validated runtime markers. Require consistent evidence; unknown or conflicting values are unsupported, not guessed.
6. Use the existing Start resolver as a final runtime contract. Support validated Forge 1.12.2 artifacts or modern Forge `win_args.txt`, currently mapped NeoForge `win_args.txt` builds, and the recognized ServerPackCreator Fabric format with exact metadata and its validated runtime path. Keep arbitrary Fabric, Vanilla, and Paper layouts unsupported; a generic `server.jar` cannot disambiguate them. Detect Quilt as unsupported for new imports under current Phase 5 policy while leaving saved Quilt Start behavior unchanged. Do not execute run scripts; only parse existing validated args-file references.
7. Verify required pack payloads are bundled. Use only existing exact, verified official base-runtime installers if a supported dependency is absent. Never fetch missing CurseForge mod files through hidden/undocumented endpoints.
8. Surface the classification and detected values before enabling Configure/Install.

### 4. Install, persist, and retain

1. Reuse the existing job ID, `InstallerState`, progress event, cancellation, input preflight, explicit EULA checkbox, and progress/retry UI patterns.
2. Extract into a unique new server staging folder and apply manager-owned configuration values after pack files. Keep database and server directory untouched until the final validation succeeds.
3. Confirm the existing `resolve_launch_mode` succeeds against the staged tree and the detected database values. Validate Java, port, name, and loader metadata through current preflight.
4. Enter the existing publication decision point, publish the folder and DB row atomically, and add the returned `ServerDto` to the app store. Roll back on DB/filesystem errors. Confirm the saved server appears in the normal list and starts via the existing process manager; do not add a second Start implementation.
5. Persist the automatic-delete preference in the established app settings surface, default false. Delete only the staged ZIP copy after archive validation, final server publication, and DB persistence all succeed. Keep ZIPs on failed/canceled jobs and keep external originals.

### 5. Review and verification

- Independent code review checks remote webview privilege isolation, WebView2 event lifetime/threading, path/filename collisions, redirect/error state handling, ZIP expansion/path safety, loader/version consistency, EULA/manager config ownership, cancel/publication races, rollback, and unchanged Modrinth behavior.
- Embedded-download allowlist tests cover HTTPS `edge.forgecdn.net`, exact/subdomain matching, and non-HTTPS/lookalike rejection. The live redirect and transfer row still require a Windows/WebView2 smoke test.
- When a completed CurseForge transfer fails ZIP validation, classify only a small bounded prefix for obvious HTML error pages, keep the file unpromoted, and show a retry/author SERVER-pack instruction. Do not expose response contents or replace central-directory validation with a byte-signature check.
- Keep the explicit support matrix in the feature spec. The implemented allowlist is validated Forge/NeoForge layouts plus recognized ServerPackCreator Fabric archives. Do not treat the latter as arbitrary Fabric support. Before enabling any additional layout, document its exact markers and matching rules, then use a representative maintained server-pack fixture plus client-export and malformed-archive controls; without these, leave it unsupported. Quilt is detected but not installed under current Phase 5 policy.
- Do not execute archive-provided batch/shell/PowerShell scripts in tests or smoke tests.
- The user authorized feature and regression tests. Final verification: Rust library suite 73/73, focused CurseForge suite 9/9, Cargo check, Rust formatting, and `npm run build` passed. No live CurseForge/WebView2 transfer was exercised; the frontend package has no separate test runner.

## Acceptance checklist

- [x] User resolved the MSRV mismatch and approved the Rust dependencies.
- [x] Remote CurseForge webview is isolated from manager capabilities; external fallback is available.
- [x] Windows/WebView2 downloads stage safely and surface progress, cancel, completion, duplicates, redirects, and failures.
- [x] Other platforms use the external-browser + browse-to-stage path without claiming managed-download parity.
- [x] Next lists completed staged ZIPs and supports refresh plus external browse/copy.
- [x] Archive validation is resource-bounded and distinguishes server packs, client exports, and unsupported ZIPs.
- [x] Version/loader detection is exact for the validated Forge/NeoForge layouts and the narrow ServerPackCreator Fabric allowlist; no scripts are executed.
- [x] ServerPackCreator Fabric imports are documented as a narrow supported exception, and the Create wizard's validation guidance matches that allowlist.
- [x] Supported installs use a new server directory and existing persistence/Start workflows.
- [x] ZIP preservation is default; opt-in deletion occurs only after full successful publication.
- [x] Existing Vanilla, Paper, Fabric, Forge, NeoForge, Quilt saved-server, and Modrinth behavior remains unchanged.
- [x] Independent reviewer passed after the scoped rework loop.
- [x] Rust feature/regression tests, formatting, Cargo check, and frontend build passed; no live browser/download smoke test was run.
