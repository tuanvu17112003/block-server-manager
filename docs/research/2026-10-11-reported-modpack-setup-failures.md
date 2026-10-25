# Reported Modpack Setup Failures — Initial Triage

Date: 2026-10-11

## User report

The user reports three symptom groups across CurseForge and Modrinth: a missing-mod error during installation, missing or extra mods after a server is installed and run, and a CurseForge download reported as the wrong format. No exact pack names, version IDs, error text, or installer/server log excerpts were provided at triage time.

## Current code-path findings

- CurseForge downloads are promoted from a temporary file only after both WebView2 and Tauri report completion and `ZipArchive` can read the central directory. A non-ZIP response is rejected; the importer does not publish that file as a server.
- `ZipArchive::new` validates a ZIP from its central directory and supports archives with prepended bytes; a first-byte check must therefore be diagnostic-only and must never replace the archive parser.
- The embedded browser allowlist already accepts HTTPS `curseforge.com` and the true `forgecdn.net` domain tree, including `edge.forgecdn.net`. Unit cases for exact hosts, subdomains, HTTPS-only behavior, and lookalike rejection are present. The live WebView2 redirect/completion path remains unverified.
- CurseForge import requires an author-provided server ZIP (or a specifically recognized ServerPackCreator Fabric archive). The ordinary client export is not a server pack, and arbitrary ZIPs do not become valid by changing their extension.
- Modrinth installation includes `env.server=required` and `optional`, skips `unsupported`, and rejects invalid environment values. A bounded Fabric hard-dependency check can stop publication when a server-included mod requires a dependency omitted or marked unsupported by the selected pack. The app intentionally does not fetch missing `depends` or `recommends` entries outside the selected `.mrpack`.
- The CurseForge and Modrinth preparation/download steps are distinct. They converge at server publication and launch validation, so the reported symptoms do not establish one common root cause.

## Safe diagnostic improvement in scope

For the reported CurseForge wrong-format symptom, keep the current rejection/promotion gate and improve only the error: inspect a small bounded prefix after ZIP parsing fails, identify obvious HTML error pages without logging or displaying their contents, and tell the user to retry through the external browser or select the author-provided SERVER file. A generic message remains for other invalid/truncated files. This does not explain the missing/extra-mod cases, which still require the exact pack/version and logs.

## Triage conclusion

No single implementation defect can be confirmed from the symptom summary. A missing dependency may reflect a pack's own server metadata conflict; a runtime missing/extra-mod report depends on the exact pack version, loader, installed file set, and startup/client log; an invalid CurseForge download may be an error response, incomplete transfer, client archive, or a different selected file. Do not weaken server-side filtering, hash/ZIP validation, or hard-dependency checks without the relevant pack evidence.

## Evidence needed for the next fix

For one failing case from each affected provider, collect:

1. Pack name plus CurseForge file ID or Modrinth project/version ID, and the selected Minecraft/loader versions.
2. The exact installer error and last displayed stage; include the last 30–50 lines of `installer.log` when present.
3. For post-install runtime errors, the first startup error block from `logs/latest.log` plus the client-side missing/extra-mod message.
4. For CurseForge format errors, whether the error occurred in the embedded download, ZIP inspection, or install step; preserve the failed staged file only if the user chooses to share it.

## References

- Supplied OSS review: [`2026-10-11-open-source-solutions-review.md`](2026-10-11-open-source-solutions-review.md)
- Current server-pack and Modrinth policy: [`../specs/server-pack-install-correctness.md`](../specs/server-pack-install-correctness.md)
- CurseForge download follow-up and source register: [`2026-10-10-curseforge-embedded-download-handoff.md`](2026-10-10-curseforge-embedded-download-handoff.md), [`sources.md`](sources.md)
- Rust `zip` reader behavior: [`ZipArchive`](https://docs.rs/zip/latest/zip/read/struct.ZipArchive.html)
