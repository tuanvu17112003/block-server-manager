# Specification — Server Versions, Loader Compatibility, and Installation (Phase 4)

## Goal

Replace the Tauri Create wizard's simulated install with provider-backed version discovery, compatible loader resolution, and cancellable server installation. A successful job produces a usable server folder and saved server record. A failed or canceled job produces neither.

## Scope and boundaries

- Platform: Windows x64, using the selected Temurin Java 8/17/21/25 runtime for currently available releases.
- Vanilla catalogue includes official Minecraft manifest entries with `type == release` plus opt-in `snapshot` entries (pre-releases and release candidates are typed `snapshot` by Mojang); `old_alpha` and `old_beta` remain excluded. Snapshots install through the same artifact path and are labelled inline; the picker shows releases by default with a persistent "Show all builds" toggle. See ADR-0007.
- Paper/Fabric/Forge/NeoForge choices cover all provider-published installable builds, gated on artifact completeness rather than advisory flags. Paper lists builds of any `channel` with a complete `server:default` artifact; Fabric lists loaders of any `stable` flag resolvable via the exact endpoint; Forge lists the full official per-MC catalogue (not just `recommended`/`latest` promotions); NeoForge lists all Maven metadata entries under the documented MC mapping. Stable entries sort first and every non-stable entry carries an inline label. See ADR-0007.
- Quilt is not available for new server creation. Preserve the existing process-launch support for already-saved Quilt records.
- Modrinth and CurseForge pack downloads remain Phase 5. Browser mode keeps mock behavior; Tauri must not report the mock pack install as complete.
- No new Rust dependencies in this phase.

## Discovery and compatibility

- `versions_vanilla` returns official release entries from the Mojang manifest by default, and release + snapshot entries when the caller opts in; each entry carries its `versionType` for labelling. `old_alpha`/`old_beta` are never listed.
- `versions_paper` returns Minecraft releases with at least one artifact-complete Paper build of any channel.
- `loaders_resolve(mcVersion)` returns exact available choices for Vanilla, Paper, Fabric, Forge, and NeoForge. Fabric uses compatible metadata of any `stable` flag; Forge uses the full official per-MC catalogue with `recommended`/`latest` entries labelled and all other entries labelled as specific versions; NeoForge uses the documented MC mapping over all metadata entries with betas labelled. Quilt is omitted. Vanilla is listed when Mojang exposes the selected release (or snapshot, when opted in).
- Unsupported versions, unavailable provider metadata, or incompatible combinations are omitted or fail clearly; version numbers are never treated as compatibility proof by themselves. Non-stable entries are never silently substituted: a stale selection is held with an explanatory notice and Install stays blocked until the user picks explicitly.
- Unsupported versions, unavailable provider metadata, or incompatible combinations are omitted or fail clearly; version numbers are never treated as compatibility proof by themselves.
- `server_install` re-resolves and validates the selected provider/version before downloading, so stale UI data cannot force an incompatible artifact.

## Installation behavior

1. Validate the Create input, Java runtime, EULA choice, port, and job ID.
2. Create an isolated per-job staging directory under app data.
3. Resolve exact provider metadata and download/run the installer into staging.
4. Emit `job://progress/{jobId}` events with a progress percentage and plain log text. Show byte progress when size is known; show stage progress for external installers.
5. Capture installer stdout/stderr in the staged `installer.log` and expose recent log text to the UI.
6. Validate the provider's expected server artifact. Vanilla checks Mojang size and SHA-1; Paper checks Fill size and SHA-256; installer-based providers require successful exit and their expected launcher/JAR. Quilt installs are rejected.
7. Generate the minimal server properties and leave EULA false unless the user explicitly accepted it in the Create form.
8. Publish the files and persist the server record only after validation. Keep the new record visible in the existing mounted Create completion flow.
9. On cancellation or any failure, terminate the active installer process, remove staging output, and ensure no server record/folder remains. Keep a sanitized error and installer log for Retry.
10. `server_start` must launch every published provider using the installed provider's validated launch shape. Forge/NeoForge use generated Windows argument files with the selected Java and keep the process manager's EULA, identity, PID, log, stdin, and stop/kill controls. Reject an install if its launch shape is not supported.
11. Orphan recovery must match the exact launch shape saved for that server (JAR filename or provider-specific argument files) plus the per-server JVM identity marker. It must keep failing closed when process inspection is unavailable and must not require a literal `server.jar` argument for valid loader modes.

## UI behavior

- Configure step loads supported Minecraft versions and compatible loaders from typed Tauri commands; unavailable choices cannot be selected.
- Each activation starts with a fresh server type selection. Selecting a saved server in the sidebar exits the global Create view and opens that server.
- Layout adapts to compact and wide windows; cards and form fields reflow before clipping or overlap.
- Install step shows real progress, stage/log output, Cancel, and Retry. Disable duplicate submission while a job is active.
- Cancel invokes the backend cancel command and returns to Configure after cleanup completes.
- Success enables the existing Done/Go to Console completion actions and selects the persisted server.
- Tauri modpack choices remain unavailable until Phase 5. Browser development continues to use its existing mock packs and progress.
- Existing Create name/RAM/port/EULA/Java states and EULA safety behavior remain.

## Acceptance criteria

- [ ] Every Mojang `release` catalogue entry is offered for Vanilla and can install when its official server artifact is available, with size/SHA-1 verification. Snapshot entries are offered behind the "Show all builds" toggle and install through the same verified path; entries without a server artifact fail clearly.
- [ ] Paper exposes builds of any channel with complete server artifacts (labels carry the channel); stable builds sort first. Install verifies size/SHA-256.
- [ ] Fabric, Forge, and NeoForge offer all provider-published installable builds with stability labels (stable first) and install the exact selected build after exact provider verification; Forge validates exact catalogue membership; Quilt creation is unavailable.
- [ ] Every published provider can start and stop through the process manager. Forge/NeoForge use generated Windows argument files; they are not published as usable servers unless a supported launch mode is resolved.
- [ ] Stale-lock recovery verifies the saved provider-specific launch arguments and exact server marker for JAR and argument-file modes; unavailable inspection still fails closed.
- [ ] Quilt is absent from new server loader choices and rejected by `server_install`; previously saved Quilt records retain process validation and Start behavior.
- [ ] Unsupported or incompatible Minecraft/loader pairs are not offered and are rejected if submitted stale.
- [ ] A missing loader build disables/rejects install; the Create payload can never silently substitute Vanilla while another loader remains selected.
- [ ] Progress/log updates are visible; Cancel terminates the job and cleans staging; Retry starts a fresh job.
- [ ] Installer failure or cancellation leaves no persistent server record or partial server directory.
- [ ] EULA defaults false and is true only after the user's explicit acceptance.
- [ ] Java 25 is provisionable and accepted for Minecraft 26.1; the other official releases resolve their Mojang-declared Java requirement.
- [ ] Phase 2 process/EULA behavior, first-run Create persistence, and browser mocks remain intact.
- [ ] No new Rust dependency is introduced.
