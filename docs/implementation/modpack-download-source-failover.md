# Implementation Guide — Modrinth Download Source Failover (backend-009)

Read first: `../research/2026-10-09-modrinth-download-source-failover.md`, `../specs/modpack-installation.md` §Installation step 7.

## Scope and constraints

- Owned code paths: `src-tauri/src/modpacks/install.rs` manifest URL parsing and `src-tauri/src/installer/mod.rs` required-file attempt selection.
- Keep the existing three-attempt ceiling and four-worker ceiling. Do not increase worst-case per-file network attempts.
- Retain only HTTPS candidate URLs accepted by the current provider allowlist, preserving manifest order. Never follow an unapproved redirect.
- Preserve fresh per-attempt `.part` files, existing size limits, SHA-1 and SHA-512 verification, cancellation, progress rollback, staging cleanup, exact selected pack version, and atomic publication.
- No new dependencies; do not change standalone installs, provider selection, EULA handling, Quilt support, or CurseForge gating.

## Ordered implementation

1. Change `RequiredFile` to carry the trusted URL candidates for the manifest entry. Parse every candidate in order, retain only URLs accepted by `valid_provider_download_url`, and reject an entry with no trusted candidate.
2. During the existing per-file retry sequence, select candidates by attempt number, cycling only when there are fewer candidates than attempts. Continue to use `download_modrinth_required_file` for every candidate so redirect checks and byte caps remain centralized.
3. Verify both manifest hashes after every downloaded body. A mismatch must clean up that attempt's `.part` file and proceed only through the existing bounded retry sequence. Never place or publish a mismatching body.
4. Keep progress rollback, cancellation checks, sibling-stop behavior, and the original final error path intact. If logging the source choice, log only its ordinal, never its full URL.

## Acceptance checklist

- [x] Multiple manifest URLs are retained in their original order only when each URL passes the existing HTTPS host allowlist.
- [x] An entry with no trusted URL is rejected before download.
- [x] Attempts rotate across candidate URLs while remaining within the existing three-attempt cap; one-URL behavior remains bounded as before.
- [x] SHA-1 and SHA-512 must both match before placement; mismatch remains fail-closed after exhaustion.
- [x] Redirect, size-cap, cancellation, progress rollback, and staging/publication safeguards remain unchanged.
- [x] No dependencies or adjacent provider/install behavior changed.
