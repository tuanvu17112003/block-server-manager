# Architecture

- `overview.md` — system map (Electron desktop, renderer, services, data).
- `adr/` — numbered decisions. Start with 0001 (record ADRs) + 0002 (historical Tauri stack) and
  0020 (Electron is the sole shipped desktop runtime).
- `adr/0003-java-runtime-provisioning.md` — app-local Temurin ZIP provisioning on Windows without machine-wide installer changes.
- `adr/0004-server-installation-jobs.md` — isolated, cancellable install jobs that publish files and persist records after validation.
- `adr/0005-dynamic-releases-and-quilt-removal.md` — dynamic official release discovery, current Java runtime scope, and the retired Quilt creation boundary.
- `adr/0008-install-all-modrinth-pack-files.md` — user-directed installation of every selected pack manifest entry regardless of environment flags.
- `adr/0009-bounded-virtualized-console-logs.md` — batched log state, bounded retained history, and viewport-only console rows.
- `adr/0010-match-configured-initial-server-heap.md` — match initial and maximum heap to each server's configured RAM.
- `adr/0016-modpack-setup-pipeline-rebuild.md` — replace duplicate modpack setup paths with one staged, exact-pinned pipeline in the current app.
- `adr/0017-stable-modpack-archive-fingerprints.md` — bind provider fingerprints and archive inspection to the same temporary snapshot.
- `adr/0018-loader-redirect-policy.md` — validate new-pipeline loader metadata and artifact redirects at every hop.
- `adr/0019-framework-neutral-http-backend-contract.md` — optional HTTP/SSE backend for browser deployments.
- `adr/0020-electron-sole-runtime.md` — Electron as the only shipped desktop runtime; mock data opt-in; Tauri tree dormant.
