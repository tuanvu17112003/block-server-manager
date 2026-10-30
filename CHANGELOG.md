# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.3.0] - 2026-10-30

The release that turned the modpack installer from "works on my pack" into something with measured coverage, and
made the project honest about what it can prove.

> Note on versioning: a `v0.2.0` tag already existed at an earlier commit (the first Electron packaging milestone).
> This release is `0.3.0` rather than a rewritten `0.2.0`, because moving a published tag would silently change what
> anyone who already fetched `v0.2.0` believes they have.

### Added

- **Pluggable format adapter layer** with a shape-based registry. Every format now flows through one install path
  instead of a per-provider special case, and each format carries an evidence grade describing how strongly its
  support is proven.
- **Real-artefact E2 harnesses** for Prism/MultiMC and ATLauncher, with checksum verification of the input archives.
- **Conformance gate** (`scripts/conformance-spec.mjs`): parses the design document and fails when the code disagrees
  with it, citing `file:line`.
- **Encoding gate** (`scripts/check-encoding.mjs`): fails on double-encoded UTF-8 in source files — a class of defect
  that compiles cleanly and passes every other test.
- **Deferred-format explanations**: supplying an MCBBS, HMCL, GDLauncher, or Technic archive now reports the format
  and the reason it cannot be installed, instead of a generic "unrecognized modpack" error.
- **12-pack live acceptance matrix** (`electron . --matrixtest`) covering both Modrinth and CurseForge end-to-end with
  verified boots.
- **Portable build**: Block-Server-Manager-x.y.z-Portable.exe, a single self-contained exe that keeps its servers,
  settings and backups in a data folder beside itself — copy the folder to a USB stick and everything comes along.
  Detects an unwritable location at startup and says so, instead of failing later with a permission error.
- **Open-source publishing essentials**: MIT licence, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and
  pull request templates, a Dependabot configuration, and a CI workflow running build, unit tests, spec conformance and
  the encoding guard on every push.
- **Real screenshots in the README**, captured by the project's own UI test rather than staged by hand.
- First-run wizard is now dismissible; App settings is reachable with zero servers.

### Fixed

- CurseForge server packs: loader tag missing on newest files, nested-ZIP server packs, SPC manifests misread as
  client exports, Forge builds resolved from the promotions feed, and multi-tag MC versions picking the wrong loader.
- Legitimately zero-byte config files were rejected as "empty download".
- Extensionless filenames were treated as directories, causing `EEXIST`.
- Modrinth installs now match the four-layer reference: explicit include set, force-included required dependencies,
  and L2+L3 auto-fix before publish.
- **16 files / 65 lines of mojibake** introduced by tooling, including user-facing error strings — repaired, and a gate
  step added so it cannot recur silently.
- App settings was unreachable after deleting every server; the render gate forced the Create wizard with no escape.

### Changed

- A green "Verified format" badge is no longer shown for a plan that installs nothing. Launcher-instance formats that
  carry no server payload are labelled as such rather than being presented as ready to install.

## [0.1.0]

Initial Electron rebuild: server lifecycle, console, players, worlds, backups, content management, metrics, and
Modrinth/CurseForge modpack installation.
