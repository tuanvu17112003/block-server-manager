# Research — immutable source material

- `2026-10-18-framework-neutral-backend.md` — current Tauri IPC boundary and research for Fetch/CORS, SSE, OpenAPI, runtime configuration, and framework-neutral deployment.
- `2026-10-13-modrinth-preview-ipc-casing.md` — isolated reproduction proving remote Modrinth preview failed because Serde struct-variant fields did not match the TypeScript camelCase IPC payload; includes the generic-toast masking cause.
- `2026-10-12-tauri-mcp-bridge.md` — Tauri MCP Bridge 0.13.1/Tauri 2.12.2 compatibility, loopback-only debug exposure, isolated app-data smoke testing, and read-only boundaries.
- `2026-10-12-phase6-diagnostic-handle-containment.md` — Phase 6 review findings for opened-handle containment, bounded scan disclosure, and disappearance during crash-report enumeration.
- `2026-10-11-archive-fingerprint-consistency.md` — official Windows CNG guidance for calculating SHA-1 and SHA-512 from one bounded archive snapshot.
- `2026-10-11-loader-redirect-security.md` — curl redirect behavior and the new loader-pipeline per-hop host policy.
- `2026-10-11-open-source-solutions-review.md` — review of OSS alternatives and their fit against this app's product, licensing, and install-safety constraints.
- `2026-10-11-reported-modpack-setup-failures.md` — current code-path triage and the exact provider/log evidence needed to identify the runtime causes.
- `2026-10-11-modpack-overhaul-design-review.md` — full handoff review, candidate adoption fit, and keyless/loader decisions for the rebuild.
- `2026-10-10-server-pack-formats-and-modrinth-startup.md` — current CurseForge archive shapes and Modrinth startup-log diagnosis.
- `2026-10-10-modrinth-runtime-and-fabric-metadata.md` — Modrinth installation screenshots, BetterEnd `fabric.mod.json` compatibility, and Fabric Java predicate semantics.
- `2026-10-10-modrinth-missing-hard-dependencies.md` — exact server log evidence, skipped dependency files, and Fabric Loader hard-dependency resolution behavior.

- `2026-10-10-curseforge-server-pack-import.md` — official server-pack UX, WebView2 download lifecycle, client-export distinction, and safe import design.
- `2026-10-10-curseforge-webview2-bridge-follow-up.md` — approved Windows COM interface binding and post-implementation safety findings.
- `2026-10-09-modrinth-all-pack-files.md` — user-directed server installation of every file in a selected Modrinth pack.
- `2026-10-09-console-log-performance.md` — unbounded console log storage/rendering evidence and official React/Tauri references.
- `2026-10-10-server-initial-heap.md` — app/BAT launch comparison and Java heap research.
- `2026-10-10-console-backend-phase6.md` — backend console process/log surfaces, Windows tailing research, and unresolved RCON security constraints.

- `2026-10-09-modpack-sources.md` — Modrinth/CurseForge API, pack-format, terms, and dependency research for Phase 5.
- `2026-10-09-modrinth-install-details.md` — Modrinth per-hop download validation, ZIP safety, staging disk checks, and manifest semantics.
- `2026-10-09-curl-stream-size-limit.md` — system curl version behavior and application-level in-progress size enforcement.
- `2026-10-09-modrinth-download-reliability-rework.md` — repeated Content-Length discrepancy, hash-authenticated size reconciliation, and bounded concurrent downloads.

- `2026-10-08-desktop-stack.md` — Explorer-stack: Tauri vs Electron vs .NET vs Wails + recommendation.
- `2026-10-08-competitor-ux.md` — Explorer-ux: 6 products surveyed + 8-tab synthesis + create-flow.
- `2026-10-08-minecraft-technical.md` — Explorer-mc: APIs, Java map, properties subset, risks.
- `2026-10-08-phase2-process-safety.md` — Phase 2 review rework: PID identity, Windows tree termination, process reservation, and real Tauri records.
- `2026-10-08-phase2-create-flow.md` — React state lifecycle and first-server Create completion behavior.
- `2026-10-08-phase2-list-error.md` — React external-list load failure state and retry behavior.
- `2026-10-08-phase3-java-provisioning.md` — Temurin assets, Mojang Java metadata, Windows discovery, checksums, disk-space checks, and best-effort resume.
- `2026-10-08-phase4-server-installs.md` — official provider metadata, loader compatibility, installer CLI behavior, integrity, cancellation, and safe publication.
- `2026-10-08-tauri-cli-setup.md` — official Tauri CLI installation guidance and the project’s existing npm/Vite wiring.
- `2026-10-09-post-validation-access-denied.md` — screenshot/code-path evidence and a Windows filesystem probe for the access-denied install failure.
- `2026-10-09-quilt-installer-checksum.md` — Quilt Meta’s stale 0.15.1 hash compared with the official Maven artifact and sidecars.
- `2026-10-09-new-server-improvements.md` — all-release discovery, Java 25, Quilt removal, New Server navigation, and responsive layout research.
- `2026-10-09-rustfmt-gate.md` — scope and verification plan for the formatting-only Rust check follow-up.
- `sources.md` — consolidated URLs.
- `2026-10-18-curseforge-cancel-aware-copy.md` — Rust I/O guidance and the install-time nested ZIP cancellation gap.
