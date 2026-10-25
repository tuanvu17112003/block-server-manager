# Specification — New Server Flow and Version Availability

## Goal

Remove Quilt from new server installation and make New Server navigation, selection state, responsive layout, and Minecraft release availability reliable.

## Scope

- Native Tauri New Server flow, its shared app shell/sidebar, provider version discovery, installer validation, and Java runtime support.
- Vanilla version choices include every Minecraft release currently listed by Mojang's official version manifest (`type == release`). Snapshots and prerelease/alpha/beta entries remain excluded.
- Paper, Fabric, Forge, and NeoForge choices remain limited to provider-verified compatible releases/builds. Paper offers STABLE builds only.
- Quilt is removed from the new server type picker, loader discovery, install request validation, and new server install dispatch.
- Previously saved Quilt server records remain manageable and startable through the existing process-launch validation path.
- Browser mock behavior and modpack browsing filters are not standalone server installation providers and stay unchanged.

## Behavior

### New Server state and navigation

1. Every activation of New Server creates a fresh wizard session with no stale server type or form selection from an earlier session.
2. Choosing a server type updates the selected type and Configure view immediately. Version and loader data must match that selection.
3. Clicking any saved server in the sidebar while New Server is open selects that server and exits the wizard to the prior per-server tab. This remains available after first-run installation has added a server.
4. Back and Done actions keep their existing semantics; the first-run wizard may remain visible until an explicit navigation action is selected.

### Responsive layout

- The sidebar and main content may shrink with the window while preserving visible navigation and a usable content pane.
- New Server type cards and Configure fields, plus Overview summary/detail cards, reduce their column count based on available content width before cards become too narrow.
- Overview Status and Server action rows wrap when they do not fit within their cards.
- Inputs, labels, buttons, and progress/log regions fit within the pane or remain reachable by the existing scroll behavior. No content is clipped or overlaps an adjacent region.

### Minecraft releases and Java

- The Vanilla picker is sourced from all Mojang manifest release IDs instead of a seven-item constant.
- Vanilla installation resolves the exact version JSON and requires a valid `downloads.server` artifact before download/publication.
- Loader choices are resolved from their official providers for the selected release; absent combinations are not shown and stale requests are rejected.
- The Java detector reads Mojang's required major. Temurin runtime support includes 8, 17, 21, and 25 for currently available releases, including Minecraft 26.1.
- Start must validate compatible Java offline using the local version-to-minimum mapping, including Java 25 for 26.1. Versions outside the known local mapping or runtime set fail with a clear message.

## Safety and compatibility

- Do not auto-accept the Minecraft EULA.
- Preserve installer staging, artifact verification, publish-after-validation, and failure cleanup.
- Do not remove the persisted Quilt process-launch branch or constrain historical server record loader strings.
- Do not add Rust dependencies.

## Acceptance criteria

- [ ] No Quilt option appears in Tauri's standalone server type or live compatible loader choices; server_install rejects Quilt if invoked directly.
- [ ] Saved Quilt servers keep their existing start/manage path.
- [ ] A new wizard session resets the server type and the selected type is reflected in Configure.
- [ ] Selecting an existing sidebar row while creating exits the Create view and opens the selected server.
- [ ] Compact and wide layouts keep sidebar, Overview cards/actions, and New Server content usable without clipping/overlap.
- [ ] Vanilla lists every Mojang manifest release; Paper and modded loader choices remain provider compatible.
- [ ] Current official Minecraft releases, including 26.1, can resolve and provision their declared supported Java major.
- [ ] Browser mocks, EULA, and process/publication safety behavior are preserved.
