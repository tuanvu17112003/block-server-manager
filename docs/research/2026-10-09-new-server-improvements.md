# Research — New Server Improvements (2026-10-09)

## Context restored

The prior Phase 4 implementation limited Minecraft discovery to seven releases and exposed Vanilla, Paper, Fabric, Quilt, Forge, and NeoForge. The user reports the non-Quilt paths are working and asks to remove Quilt creation while fixing New Server flow state/navigation, responsive sizing, and the version limit. The earlier live Quilt 0.15.1 attempt failed its SHA-256 check; the subsequent sidecar fallback was approved, but live retry was still pending.

The active source of truth before this follow-up was `WORKFLOW_STATE.md`, preserved at `.workflow/archive/2026-10-09_backend-phase4-followup-context.md`. Phase 4 sources remain historical records in `docs/research/2026-10-08-phase4-server-installs.md` and `.workflow/archive/2026-10-08_backend-phase4-server-installs.md`.

## Findings

### Release catalogue and Java

- The Rust installer already fetches Mojang's `version_manifest_v2.json`, selects entries whose manifest `type` is `release`, then intersects those IDs with `SUPPORTED_MC`. Removing that intersection exposes all official release IDs through the existing Vanilla discovery path.
- Installer metadata resolution reads each selected release's `downloads.server` object and verifies its URL, size, and SHA-1 before publication. A version without a valid server artifact must fail clearly rather than publish an incomplete server.
- The current Java resolver already reads each selected version JSON's `javaVersion.majorVersion`. Its app-managed runtime set and local Start allowlist are limited to 8/17/21. The official Minecraft 26.1 release notes state Java 25 is required, so Java 25 must be provisioned and accepted by the local Start path to cover the currently published release catalogue.
- Adoptium's current release page lists a Windows x64 Temurin JDK 25 ZIP, so the existing app-managed ZIP provisioning approach can support Minecraft 26.1 without a platform installer or new dependency.
- Keep the existing release-only meaning of the picker. Snapshot, pre-release, alpha, and beta entries are not part of the requested catalogue expansion.
- Paper's version list is already provider-backed and only includes releases with a STABLE build. Fabric, Forge, and NeoForge choices are resolved from their own metadata; unsupported combinations remain unavailable. NeoForge's current explicit mapping remains the boundary where no provider-specific mapping exists.

### Quilt boundary

- The Tauri Create screen has a Quilt type card; `loaders_resolve` contacts Quilt Meta; `server_install` accepts Quilt and dispatches to the Quilt installer. Those are new-server creation paths and are the removal target.
- Existing persisted Quilt records use a separate process launch branch. Keep that branch so the change does not make an already-saved server unmanageable.
- Quilt in `src/mocks/data.ts` belongs to the modpack browse filter, not the standalone Tauri server type picker. Keep that mock pack catalogue behavior unchanged.

### Navigation and responsive layout

- `Shell.openCreate` sets `creating` but does not establish a fresh Create identity. Create owns its server type state locally. A fresh keyed Create session on each entry makes the default selection deterministic.
- Sidebar server rows currently call only the store's `select` action. While `showCreate` remains true, the normal server view stays hidden. Shell must receive that selection and exit New Server for a saved row, including the first-run completion state after a server exists.
- The app shell has a fixed 240px sidebar. The Create type and configuration grids switch at viewport-based `md` widths even though the sidebar reduces the content width. Add shrinkable flex containers and tune column breakpoints to the available compact-window space so cards/forms stack before they become cramped.
- The Create section is scrollable vertically; preserve scroll access to all fields and actions. Avoid fixed-width children that can extend past the remaining pane.

### User screenshot follow-up

- The user's follow-up screenshot shows the compact-width Overview dashboard still failing: the Status card's Start/Stop/Restart/New action row extends past its card into the adjacent Players card. The Overview summary grid uses viewport-based three columns while the fixed-reservation sidebar reduces the available pane width, and its action row has no wrapping.
- Apply content-driven columns to both Overview card grids and allow Status/Server action rows to wrap. Keep the New Server responsive changes already made; this follow-up expands the same responsive requirement to the dashboard layout.

## Implementation constraints

- Keep user-visible server choices tied to live provider metadata; do not infer loader compatibility from version numbering.
- Preserve the selected Minecraft Java requirement, EULA default/guard, validated staging publication, process lifecycle, and existing browser mocks.
- No new dependencies are needed.
- Do not add or run tests under the active higher-priority instruction; use independent code review and any allowed non-test static checks.

## Sources

- [Mojang official version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json) — release IDs and per-version metadata locations. The raw endpoint was not renderable in the browser research tool; the project already uses it directly.
- [Minecraft Java Edition 26.1 release notes](https://feedback.minecraft.net/hc/en-us/articles/44551668333837-Minecraft-Java-Edition-26-1) — confirms Java 25 requirement and cross-platform server jar availability.
- [Adoptium Temurin releases](https://adoptium.net/temurin/releases/?arch=x64&os=windows&version=25) — current Windows x64 JDK 25 ZIP availability.
- [React: Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state) — component identity/key behavior for resetting local form state.
- [MDN: Responsive Design](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Responsive_Design) and [MDN: Flexbox](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Flexbox) — flexible sizing, content-driven layout, and breakpoint use.
- [Tauri 2 window configuration](https://v2.tauri.app/reference/config/#windowconfig) — native window size settings; the change will adapt content rather than raise the minimum width.
- [Paper downloads service](https://docs.papermc.io/misc/downloads-service/) — provider metadata and build availability.
- Internal call paths: `src/App.tsx::Shell`, `src/components/layout.tsx::Sidebar`, `src/tabs/Create.tsx::Create`, `src-tauri/src/installer/mod.rs`, `src-tauri/src/java/mod.rs`, and `src-tauri/src/servers/process.rs` as mapped through CodeGraph on 2026-10-09.
