# Implementation Guide — New Server Improvements

Read first: [`../specs/new-server-improvements.md`](../specs/new-server-improvements.md), [`../specs/server-installs.md`](../specs/server-installs.md), [`../specs/java-provisioning.md`](../specs/java-provisioning.md), [`../research/2026-10-09-new-server-improvements.md`](../research/2026-10-09-new-server-improvements.md), and [`../architecture/adr/0005-dynamic-releases-and-quilt-removal.md`](../architecture/adr/0005-dynamic-releases-and-quilt-removal.md).

## Ordered steps and owned paths

1. **Wizard identity and sidebar routing** — `src/App.tsx`, `src/components/layout.tsx`: assign a new Create key/session on each open; route saved-server row selection through Shell so it selects the server and exits New Server. Preserve the empty-database first-run behavior and existing completion actions.
2. **Responsive shell and content** — `src/App.tsx`, `src/components/layout.tsx`, `src/tabs/Create.tsx`, `src/tabs/Overview.tsx`, `src/index.css`: allow flex children to shrink; adapt sidebar sizing and Create/Overview card columns to available width; wrap Overview action rows; retain scroll access.
3. **Release and Java support** — `src-tauri/src/installer/mod.rs`, `src-tauri/src/java/mod.rs`, narrowly required `src-tauri/src/servers/mod.rs`, and `src/tauri.ts`: remove the seven-version intersection; keep release-only and provider compatibility filtering; permit the current Java 25 runtime and offline Start mapping for 26.1; remove Quilt from discovery and install dispatch.
4. **Quilt compatibility boundary** — retain `src-tauri/src/servers/process.rs` Quilt launch support for previously persisted records. Keep mock modpack filtering unchanged.
5. **Documentation sync** — update server install/Java specs and mark the old Quilt checksum implementation note as historical/superseded.

## Implementation checklist

- [ ] New entry remounts/resets local wizard state deterministically.
- [ ] Saved-server selection exits Create from both regular and first-run completion views.
- [ ] At narrow window widths, sidebar and main content remain shrinkable; type cards, forms, and Overview card grids reflow to fit the remaining pane.
- [ ] Overview Status and Server buttons wrap within their cards and never spill over neighboring cards.
- [ ] Vanilla discovery returns all Mojang `release` entries; loader providers filter by actual availability.
- [ ] Installation still resolves and validates each exact server artifact before publication.
- [ ] Java 25 is installable and accepted for a 26.1 server; existing Java 8/17/21 behavior remains.
- [ ] Quilt cannot be selected/resolved/installed for a new server; saved Quilt launch remains intact.
- [ ] EULA, process, cancellation, and publication safety remain unchanged.
- [ ] Reviewer checks all requested behaviors and confirms docs match the implementation.
- [ ] Do not add or run tests unless the user explicitly asks for testing/verification.
