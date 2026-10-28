# Packaging — Windows NSIS installer

The app ships as a per-user Windows NSIS installer built with **electron-builder** from the same
Electron + TypeScript + React source tree. Packaging is unsigned (no code-signing certificate) and has
**no auto-update**; it is an offline installer for the current version.

## Commands

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run pack:dir            # build + unpacked app under release/win-unpacked/
npm run pack:verify         # run the packaged app's --selftest + --mgmttest
npm run pack:win            # build + NSIS installer under release/
npm run pack:verify:installer  # silent install into a temp dir, run the installed app, silent uninstall
```

`npm run pack:win` runs `npm run build` first (electron tsc → `dist-electron/`, renderer tsc → Vite →
`dist/`), then electron-builder packages:
- `dist/**/*` (renderer HTML/JS/CSS/fonts)
- `dist-electron/**/*` (main process, preload, installer runtime data copied by the build)
- production `node_modules` (`yauzl` only; React/Vite/fonts are build-time dependencies)

The configuration lives in [`electron-builder.yml`](../electron-builder.yml): appId
`com.blockserver.manager`, product name **Block Server Manager**, per-user install
(`perMachine: false`), assisted installer (`oneClick: false`) that lets the user choose the folder,
desktop + Start-menu shortcuts, no admin requirement other than the standard per-user install path.
Icons in `build/` are the app's own icons carried over from the archived Tauri tree
(`legacy/src-tauri/icons`).

## Artifacts

| Path | What |
|---|---|
| `release/Block-Server-Manager-<version>-Setup.exe` | NSIS installer (~116 MB, Electron runtime included) |
| `release/Block-Server-Manager-<version>-Setup.exe.blockmap` | block map (unused without auto-update) |
| `release/win-unpacked/Block Server Manager.exe` | unpacked build for local smoke tests |
| `release/builder-debug.yml`, `builder-effective-config.yaml` | effective packaging config |

`release/` is build output and is **git-ignored**; installers are distributed separately, not committed.

## Verification (what actually gets proven)

1. `npm run pack:verify` runs the unpacked executable with:
   - `--selftest` → `SELFTEST PASS` (store/IPC/commands against an isolated temp data root),
   - `--mgmttest` → `MGMTTEST PASS` (management services against a temp root),
   and asserts `resources/app.asar` exists.
2. `npm run pack:verify:installer` drives the real installer end-to-end:
   - runs `<Setup>.exe /S /D=<temp folder>` and waits for the installed executable,
   - runs the **installed** app with `--selftest` and `--mgmttest`,
   - checks `resources/app.asar` inside the install folder,
   - runs the uninstaller `/S` and waits for the install folder's executable to disappear.

Last verified: installer 116.0 MB, install/uninstall silent PASS, installed app self-tests PASS.

## Install / uninstall behavior

- Install mode is **per-user** (`%LOCALAPPDATA%\Programs\Block Server Manager` by default; the assisted
  installer lets the user pick another folder).
- App data lives in `%APPDATA%\Block Server Manager\data` (packaged `userData/data`): servers, worlds,
  backups, settings and the encrypted CurseForge key. **Uninstall does not delete app data**
  (`deleteAppDataOnUninstall: false`), so reinstalling keeps servers; remove the app-data folder manually
  for a clean slate.
- The legacy Tauri data importer still runs on first launch if the old `%APPDATA%\com.blockserver.manager\app.db`
  exists and the new store is empty.

## Security / SmartScreen

- The installer and app executable are **unsigned**: Windows SmartScreen shows "Unknown publisher" for
  the downloaded installer; choose "More info → Run anyway" or sign the build with an EV/OV certificate
  before public distribution.
- No auto-updater is configured (`publish: null`); updates are manual installer runs. App data survives
  upgrades.
- The packaged app keeps the same runtime hardening as the dev build: sandbox + contextIsolation,
  narrow preload bridge, CSP in the built renderer, sender-frame checks, IPC arg validation, navigation
  allowlists, deny-all permissions and disabled DevTools in packaged builds.

## Troubleshooting

- **`pack:verify` fails with "packaged app not found"** — run `npm run pack:dir` first; the script looks
  for `release/win-unpacked/Block Server Manager.exe`.
- **Antivirus/SmartScreen blocks the setup** — expected for unsigned builds; allow it locally or sign.
- **Installer exits without installing in silent mode** — ensure `/D=<absolute path>` is the **last**
  argument and unquoted (NSIS consumes the rest of the line); the verify script does this correctly.
- **Old dev data is used after install** — packaged builds use `%APPDATA%\Block Server Manager\data`;
  copy the dev `.app-data` contents only if you intend to migrate manually (the legacy Tauri importer is
  separate).
