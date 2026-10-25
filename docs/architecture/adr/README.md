# Architecture Decision Records

Numbered ADRs record durable choices that affect system behavior or multiple modules. Each record includes its status, context, decision, and consequences.

- `0009-bounded-virtualized-console-logs.md` — responsive console rendering under sustained server output.
- `0010-match-configured-initial-server-heap.md` — equal initial and maximum heap based on server RAM settings.
- `0011-defer-detached-rcon-until-loopback-binding-is-verified.md` — defer detached RCON while Phase 6 uses tracked stdin and persists per-server command history.
- `0012-curseforge-server-pack-import.md` — isolated manual CurseForge website + staged server-pack ZIP path; Core API remains gated.
- `0013-server-pack-format-and-server-mod-policy.md` — recognized archive layouts and Modrinth server-side file selection; its Java policy is superseded by ADR-0014.
- `0014-modrinth-java-runtime-and-fabric-metadata-preflight.md` — recommended Java selection, Fabric predicate compatibility, early effective-mod preflight, cancellation, and scratch cleanup.
- `0015-block-modrinth-packs-with-missing-server-dependencies.md` — reject publication when active server Fabric mods have definite missing hard dependency IDs.
- `0016-modpack-setup-pipeline-rebuild.md` — one staged, exact-pinned pipeline for CurseForge server ZIPs and Modrinth packs.
- `0017-stable-modpack-archive-fingerprints.md` — calculate both archive digests from one bounded snapshot and inspect that same snapshot.
- `0018-loader-redirect-policy.md` — validate HTTPS and official host allowlists at every new-pipeline loader redirect hop.
- `0019-framework-neutral-http-backend-contract.md` — keep Tauri desktop IPC and add a runtime-configured HTTP/SSE protocol for any compatible backend framework.
