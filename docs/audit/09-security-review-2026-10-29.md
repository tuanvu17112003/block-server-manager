# Security review — full application audit (2026-10-29)

Scope: full tracked tree at HEAD (`7ef56af`), focused on the Electron runtime (`electron/`), the
renderer (`src/`), packaging configuration, and dependency/supply-chain status. Method: manual
code review of every security-critical module, benchmarked against the current
[Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), plus
online research into known CVEs/GHSAs for the dependency stack (Electron 45, Vite 5.4, yauzl 3.4,
electron-builder 26.18) and prior public advisories for this exact vulnerability class
(mrpack path traversal). No code was modified during this review.

Companion document: [08-security-audit.md](08-security-audit.md) (secrets/credential scan — PASS,
re-run 2026-10-28). This review covers application security, not secrets hygiene.

---

## 1. Executive summary

**Overall posture: good-to-strong for an Electron desktop app.** The core Electron hardening is
implemented almost completely (sandbox + contextIsolation + no Node integration everywhere, strict
build-time CSP, deny-by-default permissions, per-command IPC sender validation with a fail-closed
origin allowlist, host allowlists with per-hop redirect validation on all provider fetches, a
thoroughly hardened ZIP extractor, OS-encrypted secret storage, and careful process handling). The
renderer contains no `innerHTML`/`eval`-style sinks, and npm audit reports no production dependency
vulnerabilities.

**One high-severity code-level finding was identified** (path traversal via Modrinth pack
manifests — a vulnerability class with public precedent in five other launchers), plus one medium
gap (unvalidated `shell.openExternal` channel that also bypasses the app's own sender gate) and a
set of lower-severity hardening items (Electron fuses, unsigned installer, dev-only Vite
advisories).

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | Path traversal in Modrinth `.mrpack` install (`modrinth.index.json` file paths are not contained) | **High** | Open |
| F2 | `shell:open-external` IPC channel accepts any string and bypasses the trusted-sender gate | **Medium** | Open |
| F3 | Renderer-controllable arbitrary-executable execution via `javaPath` primitives | Medium | By design / harden |
| F4 | Electron fuses (`runAsNode`, `nodeCliInspect`, asar-only load) not enabled | Medium | Open |
| F5 | Windows installer is unsigned (SmartScreen "Unknown publisher") | Low | Documented/accepted |
| F6 | Dev-only advisories in Vite 5.4.21 / esbuild / launch-editor (dev server not shipped) | Low | Dev-time only |
| F7 | CurseForge mod downloads verified by size only (no hash pinning); file names not basename-normalized | Low | Defense-in-depth |
| F8 | `isAppDocumentUrl` uses a string prefix match for the dev-server URL (dev mode only) | Info | Dev-time only |

---

## 2. Application and threat model

- **App**: Block Server Manager v0.2.0 — Electron 45.0.0 (Chromium 156.0.8078.48, Node 24.22.0,
  V8 15.6) + React 18 + TypeScript renderer; main-process services handle all filesystem/process
  work. The former Tauri/Rust runtime is archived (`legacy/`) and not built.
- **Assets at risk**: the user's machine (server processes are spawned and killed, jars and JDKs
  are downloaded and executed), the CurseForge API key, Minecraft server data (worlds/backups).
- **Untrusted inputs**: Modrinth/CurseForge metadata and archives (third-party authored),
  Mojang/Adoptium/loader-provider metadata, CurseForge pages in the embedded staging browser,
  staged user-supplied ZIPs/mrpacks, legacy SQLite database on one-shot import, renderer IPC
  messages (72 commands).
- **Out of scope for exploitation review**: the archived `legacy/` tree (not built/shipped), the
  HTTP backend adapter (`src/backend/http.ts` — browser-only dev path, no Electron surface), and
  the mock backend.

---

## 3. Findings (detail)

### F1 — HIGH: Path traversal via Modrinth pack file paths (arbitrary file write)

**Location**: `electron/services/installer/modrinth.ts:302` (install), `:66-92` (`resolveMrpack`
reads the untrusted index), `:153` (`PROTECTED_OVERRIDE_PATHS` covers overrides only).

`modrinth.index.json` — which lives **inside** the downloaded `.mrpack` and is authored by the
pack publisher — contains a `files[]` array whose `path` field is used directly as the
destination on disk:

```ts
await downloadFirstAvailable(mrFileCandidates({ downloads: f.downloads, ... }), {
  dest: path.join(o.dir, f.path),   // ← untrusted f.path, no containment check
  allowedHosts: MODRINTH_ALLOWED_HOSTS, signal,
});
```

`path.join()` neither rejects `..` segments, absolute paths (`C:\…`, `/…`), nor normalizes
Windows separators; `downloadFirstAvailable → download()` (`installer/core.ts:205`) then creates
parent directories and writes attacker-controlled bytes (the file body is fetched from a pack
author's own artifact on `cdn.modrinth.com` / GitHub, both on the allowlist) to the computed path.
Consequences:

1. **Arbitrary file write outside the server staging directory** → potential code execution
   (e.g. write into the user's Startup folder, overwrite an autostart script, or plant a DLL for
   a later load).
2. **EULA/config bypass**: the manager-owned `eula.txt` / `server.properties` protection
   (`PROTECTED_OVERRIDE_PATHS`, `modrinth.ts:153`) is applied only to the *archive override*
   layers, not to `index.files` — a pack can ship its own `eula.txt` with `eula=true` and satisfy
   the EULA gate that `server-process.ts` enforces (`start()` checks the file, not who wrote it).

Both affected sources reach this code path: the in-app **Modrinth remote browser**
(`modpack_pipeline_preview → modrinthRemote`) and **local `.mrpack` import** (`localMrpack`).
The pipeline's file-decision review (`pipeline.ts`) surfaces the paths to the user but performs no
technical validation, and a hostile path among hundreds of mod files will not be caught by a human.

**Why this is credible**: this is a proven vulnerability class for mrpack installers. In 2023 the
identical pattern (trusting `files[].path`) produced path-traversal advisories in ATLauncher
([GHSA-7cff-8xv4-mvx6](https://github.com/ATLauncher/ATLauncher/security/advisories/GHSA-7cff-8xv4-mvx6)),
Prism/MultiMC/PolyMC and mrpack-install (see the
[write-up of five affected implementations](https://akarys.me/en/blog/mrpack-vulnerabilities)).
TLS and Modrinth's hash pinning protect transport and the archive identity — they do not constrain
the *author's* manifest contents.

**Contrast with the existing hardening**: the ZIP extraction path (`extractZip`,
`installer/core.ts:353-359, 483-537`) *does* enforce `safeTarget` containment, symlink/reparse
rejection, Win32 reserved names, case-insensitive duplicate detection and byte budgets. The gap is
only in the index-file download path, which bypasses that layer.

**Recommendation (code change required — not applied in this review)**: run every `f.path` through
the same containment as `safeTarget` before download (reject absolute/UNC/drive paths, `..`
segments, backslashes, reserved names), and add `eula.txt`/`server.properties` (and
`msm-install.json`/`install-report.json`) to a protected set enforced for index files as well.

---

### F2 — MEDIUM: `shell:open-external` channel has no scheme validation and skips the sender gate

**Location**: `electron/ipc.ts:144` (handler), `:280-285` (registration without sender check),
`electron/preload.ts:32` (renderer bridge).

Two independent weaknesses on the same channel:

1. **No scheme allowlist**: the handler is `async (a) => { await shell.openExternal(String(a)); }`.
   Any string the renderer passes is handed to the OS shell. Electron's guidance is explicit:
   *"Never pass untrusted content to `shell.openExternal` — it can enable arbitrary command
   execution."* The main window's own `setWindowOpenHandler` (`main.ts:62-65`) does the right thing
   (`/^https?:\/\//i`) — the dedicated channel is inconsistent with it. A compromised or future
   buggy renderer could invoke `openExternal('file:///C:/...')` or a custom protocol handler.
2. **Sender-gate bypass**: `registerIpc` validates the sender frame origin for every `cmd:*`
   channel (`ipc.ts:257-267`, fail-closed `isTrustedSender`) — but the three *dialog* channels
   (`dialog:pick-mrpack`, `dialog:pick-zip`, `shell:open-external`) are registered in a separate
   loop that performs no sender validation. The hardening therefore does not cover this channel.

Today the renderer only passes fixed CurseForge URLs (`src/tauri.ts:832-839`), and the staging
browser window has **no preload** (so remote content cannot reach IPC at all — verified). The risk
is therefore "renderer compromise / future regression", but the fix is one line each:

**Recommendation**: route `shell:open-external` through an https-only check (mirror the
`setWindowOpenHandler` regex or a parsed-URL origin allowlist) and run `isTrustedSender` in the
dialog-channel loop exactly as the `cmd:*` loop does.

---

### F3 — MEDIUM: renderer-supplied paths are executed (Java primitives)

**Locations**: `electron/services/runtime.ts:52-59` (`resolveJava`), `electron/services/java.ts:355-380`
(`inspectJava` spawns the given executable), `:607-626` (`validateJava`); IPC surface:
`java_validate`, `servers_set_java_path`, pipeline `input.javaPath` (`validate-ipc.ts:301-308, 459-462, 505-508`).

The "pin a JDK path" feature means the main process will **execute any renderer-supplied absolute
path** (`java -version` probe at validate time; as the launch executable at start time). By itself
this is the intended feature; combined with a renderer compromise (or with F1/F2 as the initial
 foothold) it is a one-step arbitrary-execution primitive: set `servers_set_java_path { path }` →
`server_start` runs the attacker's binary.

**Recommendation (hardening, not a redesign)**: restrict manual overrides to a `.java`-style
executable check, verify the probe output really parses as a JDK (already done — keep it), and/or
limit overrides to roots the user picked through a native directory dialog. Document the trust
boundary in the spec. (A compromised renderer reaching IPC is already "game over" in most Electron
apps; the goal here is removing the most direct exec primitive.)

---

### F4 — MEDIUM: Electron fuses not enabled

**Location**: `electron-builder.yml` (no `electronFuses` block), no `@electron/fuses` usage anywhere.

The packaged app ships with default fuses. Concretely:

- `runAsNode` stays enabled — `ELECTRON_RUN_AS_NODE=1 <app>.exe script.js` turns the installed app
  into a plain Node interpreter. The repo itself has to fight this env var in every gate runner
  (`scripts/verify.mjs:26`, `scripts/verify-package.mjs:34`, `scripts/verify-installer.mjs:37`,
  `scripts/quitsmoke.mjs:8`), which is direct evidence the fuse is live.
- `nodeCliInspectArguments` stays enabled (remote debugging attach possible).
- `onlyLoadAppFromAsar` / embedded `asarIntegrity` are not enforced (`asar: true` is set, but a
  tampered `app.asar.unpacked`/loose-file layout is still loadable).

**Recommendation**: flip the standard fuse set via `@electron/fuses` or electron-builder's
`electronFuses` config: `runAsNode: false`, `enableNodeCliInspectArguments: false`,
`onlyLoadAppFromAsar: true`, `enableCookieEncryption: true`, `enableNodeOptionsEnvironmentVariable:
false`, plus asar integrity validation. Note the verify scripts can then drop their env cleanup.

---

### F5 — LOW: unsigned NSIS installer

**Location**: `electron-builder.yml` (no signing config), documented in `README.md:53,107`.

The installer is unsigned (SmartScreen "Unknown publisher"), per-user, keeps app data on uninstall.
This is an *accepted, documented* risk for local distribution, but it means any tampered copy of
the installer binary circulating externally is indistinguishable from the official one. **Recommendation**:
obtain a code-signing certificate before any public distribution (already noted in
[docs/packaging.md](../packaging.md)); consider publishing SHA-256 digests alongside release
artifacts in the meantime.

### F6 — LOW: dev-only dependency advisories (Vite 5.4.21, esbuild, launch-editor)

`npm audit` (run 2026-10-29): **0 vulnerabilities in production dependencies**; 3 packages flagged,
all dev-only:

| Advisory | Severity | Note |
|---|---|---|
| [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) + [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw) (launch-editor) | high / moderate | Editor CLI flag injection & Windows `fs.existsSync` bypass; NTLMv2 hash disclosure via UNC paths on Windows dev machines — relevant because development happens on Windows. Requires clicking a dev-overlay editor link. |
| Vite dev-server advisories (path traversal in optimized-deps `.map` handling, `server.fs.deny` bypass on Windows alternate paths, cross-origin script execution via custom middleware) | high/moderate/low | Only the `vite` dev server on `localhost:1420` (`strictPort`, default host); never shipped in the packaged app. |
| esbuild ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) | moderate | Dev-server request forgery; vite 5.4 pins esbuild 0.21.x. |
| postcss-selector-parser (ReDoS) | moderate | Build-time only. |

npm proposes `vite@8.3.5` (semver-major). Interim guidance: run `npm run dev` only on trusted
networks (Vite binds localhost by default; the config does not override `host`), and plan the
Vite major upgrade on its own schedule. No packaged-app impact.

### F7 — LOW: CurseForge artifact integrity relies on transport + size only

**Location**: `electron/services/installer/curseforge.ts:459-461` (`downloadFile` verifies
`meta.fileLength` only), `:334-338` (key-mode server-pack zip: size only).

Modrinth files are hash-pinned (sha1/sha512 from the API — good); Paper and Vanilla are sha256/sha1
pinned; Adoptium JDK zips are size-verified (Adoptium also publishes sha256 checksums in the same
payload — consider using them). CurseForge downloads are protected by TLS and first-party host
allowlisting, plus the per-file ID being content-addressed on their CDN, but there is no local hash
pinning. Additionally `fileName` from CF metadata is joined without `path.basename()` (contrast
`contentFileName` in `content-core.ts:49-54`, which does this correctly for Modrinth content).

### F8 — INFO: dev-server URL compared with a string prefix

**Location**: `electron/main.ts:37-50` (`isAppDocumentUrl`).

`will-navigate` accepts `url.startsWith(VITE_DEV_SERVER_URL)`. A prefix match can be fooled by an
origin that merely *begins with* the dev URL (e.g. `http://localhost:1420.evil.example`). The IPC
gate does this correctly (parsed `URL` origin equality in `ipc.ts:180-213`). Dev-mode only
(`VITE_DEV_SERVER_URL` is unset in production), so this is informational; fix is to parse both URLs
and compare origins, as `isTrustedIpcUrl` already does.

---

## 4. Controls verified as present and effective (positive findings)

**Electron platform hardening** (all windows — production, test, and the CurseForge staging
window): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
(`main.ts:86-93, 311-321, 367-375`; `curseforge-staging.ts:121-125`); deny-all
`setPermissionRequestHandler` (`main.ts:72`); `will-attach-webview` prevented (`main.ts:71`);
`setWindowOpenHandler` denies popups and only forwards http(s) to the OS browser (`main.ts:62-65`);
navigation restricted to the app's own document with external navigations handed to the OS browser
(`main.ts:66-70`); DevTools disabled in packaged builds (`main.ts:73-75, 91`).

**IPC boundary** (strongest area of the codebase):
- All 72 `cmd:*` channels validate the sender frame against a fail-closed origin allowlist
  (parsed-URL comparison, temp-root exception only when unpackaged) — `ipc.ts:180-267`.
- Every command has a hand-written per-argument validator (`validate-ipc.ts`): typed primitives,
  enums, bounded ints, path-safe name patterns (no separators, no `.`/`..`, control chars
  rejected), token patterns for job/backup ids; a contract test keeps the validator set in lockstep
  with the shared command list.
- Server/world/backup/content names are constrained to single path segments; server ids are
  `randomUUID()` (`store.ts:277`); `resolveContainedPath` double-checks prefix containment for
  folder opens (`properties.ts:223-239`).

**Supply chain / downloads**:
- HTTPS-only fetches with per-provider host allowlists and **per-hop redirect validation**
  (`fetchTrusted`, `installer/core.ts:105-163`), applied to every metadata and artifact fetch.
- Hash/size verification for Modrinth pack files (sha1/sha512), Paper (sha256 + mandatory size),
  Vanilla (sha1 + size), content mods (sha1/sha512), and cache re-verification before reuse
  (`verifyCachedFile` / `downloadFirstAvailable`).
- Zip extraction (`extractZip`, `installer/core.ts:446-537`) rejects path escapes, absolute
  entries, symlinks/reparse points, Win32 reserved device names, trailing dot/space segments,
  case-insensitive duplicates, and enforces entry-count/path-length/total-byte budgets.
- CurseForge staging downloads are host-allowlisted, staged as `.part` + atomic rename, and only
  complete basenames inside the staging dir are listable/inspectable (`curseforge-staging.ts:75-116, 27-33, 56-65`).

**Secrets and logging**: CurseForge key stored via Electron `safeStorage` (DPAPI) with a
0600-mode plaintext fallback only when the OS keystore is unavailable; key material never sent to
the renderer (status DTO only — `secrets-core.ts:150-159`); every log line and support-bundle
payload passes through layered redaction (`diagnostics.ts:161-210`); support bundles exclude
worlds/backups/jars and redact paths.

**Process handling**: child processes are always spawned with argument arrays (no shell → no
command injection); console commands are single-line, length-bounded, and written to stdin only
(`server-process.ts:555-562`); orphan reaping kills a PID only after verifying via CIM that the
image is Java **and** carries this server's identity marker — otherwise fail-closed
(`server-process.ts:176-210`); bounded quit budget then tree-kill (`main.ts:124-144`).

**Renderer**: no `innerHTML`/`dangerouslySetInnerHTML`/`eval` anywhere in `src/` (grep-verified);
strict build-time CSP (`script-src 'self'`, `object-src 'none'`, `frame-src 'none'`,
`form-action 'none'`, explicit `connect-src` allowlist) injected only into production builds
(`vite.config.ts:7-37`); CSP + IPC sender checks together mean a renderer XSS would still face the
`cmd:*` origin gate — but see F1–F3 for why renderer compromise must still be treated as serious.

**Embedded remote-content window**: separate session partition, no preload, no IPC, navigation and
window-open allowlists (curseforge.com/forgecdn.net, HTTPS only), download interception deny by
default (`curseforge-staging.ts:118-142`).

**Legacy import**: SQLite opened `readOnly`, server ids validated against a path-safe pattern
before any filesystem copy, table names validated, target never overwritten, idempotent marker
(`legacy-import.ts` header guarantees, `:39-40` and below).

**Dependency status**: Electron 45.0.0 is the newest stable major (released 2026-10-21;
45.1.0 with point-release fixes followed 2026-10-27); yauzl 3.4.0 is past the fix for
CVE-2026-31988 (NTFS timestamp parser off-by-one, fixed after 3.2.0) and npm audit reports no
production vulnerabilities; electron-builder 26.18.0 has no published advisories.

---

## 5. Prioritized remediation roadmap

1. **F1 (High)** — Add pack-path containment to the Modrinth index-file download path
   (reuse/extract the `safeTarget` logic), and extend the manager-owned file protection to
   `index.files`. Add a regression test with a hostile `modrinth.index.json`.
2. **F2 (Medium)** — Validate scheme (https-only) on `shell:open-external`; run the trusted-sender
   check in the dialog-channel registration loop.
3. **F4 (Medium)** — Enable Electron fuses + asar integrity in `electron-builder.yml`.
4. **F3 (Medium)** — Harden the Java-path override trust boundary (extension/output checks,
   dialog-picked roots).
5. **F7 (Low)** — `path.basename()` CurseForge file names; use Adoptium sha256 checksums; pin CF
   hashes where the API provides them.
6. **F5/F6/F8 (Low/Info)** — Code signing before public distribution; Vite 8 upgrade schedule;
   origin-parse `isAppDocumentUrl`.
7. **Ongoing** — Track Electron point releases (45.1.0 already available) and re-run
   `npm audit` in CI; keep the existing `scripts/security-audit.mjs` secrets scan on the same
   cadence.

---

## 6. Research sources

- Electron security checklist (benchmark for §3/§4):
  https://www.electronjs.org/docs/latest/tutorial/security
- Electron 45.0.0 release (Chromium 156.0.8078.48 / Node 24.22.0, 2026-10-21):
  https://www.electronjs.org/blog/ ; release feed: https://releases.electronjs.org/
- mrpack path-traversal precedent: ATLauncher advisory
  https://github.com/ATLauncher/ATLauncher/security/advisories/GHSA-7cff-8xv4-mvx6 ;
  cross-launcher write-up https://akarys.me/en/blog/mrpack-vulnerabilities ;
  official mrpack format https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
- yauzl advisory (CVE-2026-31988 / GHSA-gmq8-994r-jv83, fixed before 3.4.0):
  https://github.com/advisories/GHSA-gmq8-994r-jv83
- Vite/esbuild/launch-editor advisories (dev-only; full list in §F6):
  https://github.com/advisories/GHSA-587h-7wmj-h5pm ,
  https://github.com/advisories/GHSA-r825-w8mm-5pxw ,
  https://github.com/advisories/GHSA-67mh-4wv8-2f99
- electron-builder advisory search (none published for 26.x):
  https://security.snyk.io/package/npm/electron-builder
- Prior internal audit (secrets/history — PASS): [08-security-audit.md](08-security-audit.md)
