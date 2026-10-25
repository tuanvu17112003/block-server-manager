# Research — Phase 5 Modpack Sources

**Accessed:** 2026-10-09  
**Scope:** Roadmap Phase 5, Modrinth-first server modpack discovery and installation, with CurseForge gated on approved API access.

## Recovered project context

`docs/implementation/backend-plan.md` defines Phase 5 as Modrinth v2 search/project/version/download; CurseForge v1 behind a user API key; `.mrpack` and CurseForge manifest extraction; dependency resolution; and a cancellable `modpack_install` job. The Create wizard already has mock Modrinth/CurseForge packs, source/filter/version state, and simulated browser progress. Under Tauri it currently handles only standalone server installation. SQLite already has `servers.modpack_id`; the Rust publisher currently rejects a nonempty modpack ID and writes `None`. Phase 4 has reusable per-job cancellation, progress events, staging, validation, and publish-after-validation behavior.

## Modrinth API and pack format

- Search modpacks through `GET https://api.modrinth.com/v2/search` with the `project_type:modpack` facet. Results include stable project IDs and `total_hits`; page with `offset` and `limit` (maximum 100). Facet arrays express OR within each array and AND between arrays. Search supports relevance, downloads, follows, newest, and updated indexes.
- Public search and read endpoints do not require a token. Every request must send a unique identifying `User-Agent`; the documented limit is 300 requests per minute per IP, with rate-limit response headers. Use bounded backoff for 429 responses and avoid repeated refresh loops.
- Fetch project versions by project ID, then filter by Minecraft version and exact loader metadata. Version metadata includes files, hashes, dependencies, environment, and a changelog. Use IDs rather than mutable slugs for references.
- `.mrpack` format version 1 is a ZIP with UTF-8 `modrinth.index.json` at its root. The top-level dependencies define Minecraft and loader versions. The file list defines remote payloads and paths; verify declared size plus SHA-1 and SHA-512 before placement. Apply shared `overrides/`, then `server-overrides/`; never apply `client-overrides/` to a dedicated server.
- File `env` describes client/server presence and required/optional/unsupported status; it is separate from a project's broader client/server compatibility field. A file URL must be HTTPS. Validate each URL and every redirect hop against an explicit host policy. Reject archive paths that are absolute, drive-qualified, contain traversal, or escape the staging root. The official format page leaves some absent-environment behavior unspecified; Phase 5 v1 will include only explicitly server-required entries and will report skipped optional/client-only entries.

## CurseForge API, access, and terms

- The official Core API uses `https://api.curseforge.com` and the `x-api-key` header. Relevant routes are `GET /v1/mods/search`, `GET /v1/mods/{modId}/files`, `GET /v1/mods/{modId}/files/{fileId}`, `POST /v1/mods/files`, and `GET /v1/mods/{modId}/files/{fileId}/download-url`. Search/files pagination caps pages at 50. Use pinned project/file IDs from the manifest rather than resolving to “latest”.
- CurseForge says third-party developers must apply, accept its API terms, and receive Overwolf approval before receiving a unique key. Its terms describe the key as non-transferable; prohibit sharing it with third parties; prohibit saving/caching API data; prohibit proxy/VPN identity concealment; and restrict use of API material for directly or indirectly competing services. They reserve quotas and possible written licensing; no public fixed request-per-minute limit was found.
- CurseForge's June 10, 2026 announcement says direct CDN downloads will require the key in `x-api-key` beginning July 16, 2026. That date has passed, but no later official enforcement-status confirmation was found. Do not assume a returned download URL can be fetched without the key.
- The terms create a material access and product-use gate for a server manager with modpack browsing. The project's planned BYOK model, local installed files, manifest references, and transient search results need confirmation from CurseForge before enabling this provider. No shared application key should be shipped.
- A CurseForge `.zip` export has `manifest.json` at the root, pinned `{projectID,fileID,required}` references, a Minecraft version/loader declaration, and an `overrides/` subtree. Its referenced mod files are not bundled in the archive. Validate file/project association and loader compatibility. CurseForge support lists Quilt, but the project's current new-server decision excludes Quilt installation; Phase 5 must reject packs requiring unsupported loaders.

## Dependency and implementation fit

- `src-tauri/Cargo.toml` has no direct ZIP or credential-store dependency; the project's declared Rust MSRV is 1.77. The latest `zip` release requires Rust 1.88, so it is not suitable without changing the project MSRV. `zip` 2.4.2 declares Rust 1.73 and exposes ZIP reader/extraction APIs; it is a compatible candidate with only the `deflate` feature enabled.
- `keyring` 3.6.3 declares Rust 1.75 and supports Windows Credential Manager with its `windows-native` feature. It is a compatible candidate for the roadmap's keyring requirement if CurseForge is cleared.
- Both candidates are new direct dependencies and require explicit user consent under project instructions. Do not work around that requirement with ad hoc ZIP parsing or hand-written credential APIs.
- CurseForge terms do not specify a local secret-store design. If approved, the UI should send the key only to the local Rust process for credential-store write/delete; API calls use the header; UI and IPC return only whether a key is configured. Never write it to SQLite, browser storage, logs, command-line arguments, or error text.

## Phase 5 scope decisions and open gates

- Scope is remote provider selection, not local pack-file import, profile-code import, or pack editing; this follows the Phase 5 roadmap's search/project/version/download flow.
- Modrinth v1 installation uses the existing isolated installer job lifecycle. It resolves the pack's exact Minecraft and supported loader versions, downloads the pack manifest and selected files into staging, verifies each file, applies only safe server overrides, and publishes only after the full server is validated.
- Standalone server loader constraints continue to apply: Vanilla, Paper, Fabric, Forge, and NeoForge are supported where the pack metadata maps to a verified install path. Quilt or unknown loaders fail with a clear unsupported message.
- CurseForge integration remains disabled until the user confirms that this application has the required API approval and acceptable terms interpretation, including caching/persistence of installed artifacts and metadata. The API's no-cache clause may require written clarification.
- Dependency additions remain gated on explicit user consent: candidate `zip = 2.4.2` (`default-features = false`, `features = ["deflate"]`) for manifest/override extraction; candidate `keyring = 3.6.3` with `windows-native` for CurseForge BYOK.

## Sources

- [Modrinth API overview](https://docs.modrinth.com/api/)
- [Modrinth search projects](https://docs.modrinth.com/api/operations/searchprojects/)
- [Modrinth project versions](https://docs.modrinth.com/api/operations/getprojectversions/)
- [Modrinth `.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
- [CurseForge Core API reference](https://docs.curseforge.com/rest-api/)
- [CurseForge API key application guidance](https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key)
- [CurseForge third-party API terms](https://support.curseforge.com/support/solutions/articles/9000207405-curseforge-3rd-party-api-terms-and-conditions)
- [CurseForge CDN API-key announcement](https://blog.curseforge.com/introducing-api-key-authentication-for-curseforge-file-downloads/)
- [CurseForge pack export format](https://support.curseforge.com/support/solutions/articles/9000197908-exporting-a-modpack-for-curseforge-project-submission)
- [`zip` 2.4.2 package and API docs](https://docs.rs/crate/zip/2.4.2)
- [`zip` 2.4.2 manifest (Rust 1.73 MSRV)](https://raw.githubusercontent.com/zip-rs/zip2/v2.4.2/Cargo.toml)
- [`keyring` 3.6.3 manifest (Rust 1.75 MSRV)](https://docs.rs/crate/keyring/3.6.3/source/Cargo.toml)
- [`keyring` 3.6.3 platform/store documentation](https://docs.rs/crate/keyring/3.6.3/source/README.md)
