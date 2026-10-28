# Playwright MCP — real-app test brief (Block Server Manager)

Audience: an external AI agent that controls **Playwright MCP** and tests the real desktop app.
This brief is self-contained: follow it exactly, do not guess selectors or data locations.

## 1. What is being tested

- Product: **Block Server Manager 0.2.0** — Electron 45 (Chromium/Chrome 156) + TypeScript + React
  desktop app that installs and manages Minecraft servers (Vanilla/Paper/Fabric/Forge/NeoForge,
  Modrinth/CurseForge modpacks), with console, players, worlds, backups, metrics, content and settings.
- Target: the **packaged Windows build**, not the source/dev renderer:
  `release/win-unpacked/Block Server Manager.exe`
  (created by `npm run pack:dir`; the NSIS installer is `release/Block-Server-Manager-0.2.0-Setup.exe`).
- Test type: black-box UI acceptance through the real preload bridge and real backend (no mocks, no
  jsdom, no headless test flags). The app's `--selftest/--mgmttest/...` modes are **not** a substitute
  for this UI pass.

## 2. How to launch it (isolated profile + CDP)

Playwright MCP attaches to Electron over Chrome DevTools Protocol. Use the helper script — it starts
the packaged app with an isolated `--user-data-dir`, disables the legacy Tauri import for that profile,
waits for CDP, and prints a JSON record:

```powershell
cd H:\TESTMultiAI\20
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run pack:dir                            # rebuild so the package matches the current commit (~2 min)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-test-app.ps1 -Port 9222
```

Record `git rev-parse HEAD` for the report. `npm run pack:dir` rebuilds `dist/` + `dist-electron/` and the
unpacked app; do this once at the start so the tested binary matches the source tree (the helper only
reuses an existing `release/win-unpacked` if present).

Expected output (one JSON line; the app keeps running after the script exits):

```json
{"pid":1234,"port":9222,"exe":"...\\release\\win-unpacked\\Block Server Manager.exe",
 "profileRoot":"C:\\Users\\...\\Temp\\msm-pw-20261029-001622",
 "dataRoot":"...\\msm-pw-...\\profile\\data","cdpUrl":"http://127.0.0.1:9222",
 "browser":"Chrome/156.0.8078.48","startedAt":"..."}
```

Verify CDP before handing control to the browser tools:

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version   # must return Browser + webSocketDebuggerUrl
Invoke-RestMethod http://127.0.0.1:9222/json/list      # must list title "Block Server Manager",
                                                       # url file:///.../resources/app.asar/dist/index.html
```

### Playwright MCP configuration (user does this once on their machine)

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint=http://127.0.0.1:9222"]
    }
  }
}
```

If your MCP client uses the config file form, set `browser.cdpEndpoint` to the same URL. The documented
CDP mode supports Chrome/Chromium started with `--remote-debugging-port`, Edge, **Electron apps**, and
cloud browsers. Start the app **before** starting the MCP server/connecting; then take a snapshot.
If the MCP opens on `about:blank` or a second tab, select the tab titled **Block Server Manager** using
the tab tools. `browser_navigate` is not needed (the page is already loaded); avoid navigating away.

### Stop and clean up

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-test-app.ps1 -Stop -Port 9222
# JSON: {"stopped":true,"pid":...,"profileRoot":"...","orphanJava":0}
Remove-Item -Recurse -Force "<profileRoot>"   # optional (test data only)
```

Always run the stop command at the end (and after a fatal failure). It kills the app process tree and
reports any orphan `java.exe` whose command line belongs to that profile. Closing the app window also
triggers the app's bounded graceful stop (5 s) + tree kill.

## 3. Hard rules (do not violate)

1. **Never launch the app without `--user-data-dir` from the helper.** The dev build would write to the
   developer's `.app-data`; the helper guarantees a throwaway `%TEMP%\msm-pw-*\profile\data` root.
2. **Never use the developer's real data**: no `H:\TESTMultiAI\20\.app-data`, no
   `%APPDATA%\com.blockserver.manager`, no user servers/worlds/backups. The helper points the legacy
   importer at an empty folder (`MSM_LEGACY_ROOT`) for exactly this reason.
3. **No secrets in the report/repo**: do not paste API keys or the contents of `curseforge-key.*`.
   CurseForge key testing requires a **real user key typed manually by the user** in
   `App settings → CurseForge API key`; if no key is available, mark those cases SKIPPED (key-gated UI
   can still be tested: it must show "API key needed" and never expose search controls).
4. Do not modify files in the repository, do not `git commit`, do not run `npm run verify` as a
   replacement for UI testing, and do not install/uninstall Windows services or system Java.
5. One app instance per profile/port. Do not run the installer or another copy against the same
   profile. Native Windows dialogs (file/folder pickers) **cannot be automated through CDP** — see §8.
6. Report what you actually observe. A pass requires evidence screenshots/annotations, not assumptions.

## 4. UI map and stable selectors

Prefer the accessibility tree from `browser_snapshot` and match visible text case-insensitively (the MC
skin uppercases some headings via CSS; the DOM text is normal case). Useful anchors:

| Area | Stable text / selector |
|---|---|
| Sidebar | `Search servers…`, `+ New Server`, `⚙ App settings`, server rows (`name`, `0/20 · version`) |
| Header | server name, status dot, `▶ Start`, `⏹ Stop`, `↻ Restart`, `Kill`, address:port copy chip |
| Tabs | `Overview`, `Console`, `Content`, `Players`, `Worlds`, `Backups`, `Metrics`, `Settings` |
| App settings (global) | header `App settings` + `Global preferences`; cards `CurseForge API key`, `Downloads & storage`, `CurseForge download retention`, `Diagnostics`; buttons `Save key`, `Choose folder…`, `Open download folder`, `Create support bundle`, `← Back` |
| Server Settings | card `Server settings (7-field MVP subset)`; fields `Server name`, `MOTD`, `Max players`, `Port`, `Difficulty (restart badge)`, `Gamemode (restart badge)`, RAM slider, `online-mode`; `Save`; card `EULA + environment`; card `Danger zone` → `Delete server` (confirm dialog) |
| Create wizard | header `Create Server`; stepper `Type`, `Browse`, `Configure`, `Install`; edition cards `Vanilla`, `Paper`, `Fabric`, `Forge`, `NeoForge`, `Modrinth modpacks`, `CurseForge server pack`; configure fields + `Minecraft EULA` checkbox; install report `Installation report` |
| Dialogs | `role="dialog"` with title text; buttons like `Delete server`, `Activate`, `Restore`, `Cancel`, `Confirm` |
| Toasts | bottom-right, `role="status"`/`role="alert"`, e.g. `Settings saved`, `Copied …` |

Inputs are usually labelled by wrapping `<label>` text; version/loader/RAM/port selects appear after
the catalogue loads (wait for `Configure` options, not just the first render). Modals trap focus,
Escape closes, and focus returns to the trigger — use that for accessibility checks.

## 5. Data / state assertions

- UI assertions are primary. Secondary cross-checks (allowed):
  - **Backend through the real preload bridge** (if your MCP exposes an evaluate tool):
    `window.electronAPI.invoke('servers_list')`, `('worlds_list',{id})`, `('backups_list',{id})`,
    `('players_list',{id})`, `('metrics_get',{id,hours:1})`, `('storage_get')`,
    `('curseforge_key_status')`. These return the same payloads the renderer sees; never call
    privileged Node APIs.
  - **Filesystem** (read-only): `dataRoot\app-data.json`, `dataRoot\servers\<id>\`, `dataRoot\backups\`,
    `dataRoot\logs\launcher.log`. Use the `dataRoot` from the helper's JSON. This proves persistence
    independently of the UI.
- Never edit `app-data.json` by hand; create state through the UI.

## 6. Test cases

Priorities: **P0 = must pass**, **P1 = should pass**, **P2 = optional/time-boxed**. Record each result as
PASS/FAIL/SKIPPED with evidence file names. Time budget: full P0+P1 ≈ 45–60 min on a machine with
network and no Java preinstalled; first Vanilla install downloads Java 21 (~350 MB) and the server jar.

### Suite A — launch, shell, global settings (P0, no server required, ~5 min)
| ID | Steps | Expected |
|---|---|---|
| A1 | Connect Playwright MCP, take snapshot | Real app window: title `Block Server Manager`, sidebar, no "Backend bridge unavailable", no `Loading servers` stuck |
| A2 | Observe first screen with a fresh profile | Create Server wizard opens automatically (`Create Server`, `Type`); the header Back is disabled or a no-op because there are no servers yet (it must not leave a blank shell) |
| A3 | Click `⚙ App settings` in the sidebar | Header `App settings` + `Global preferences`; cards `CurseForge API key`, `Downloads & storage`, `CurseForge download retention`, `Diagnostics`; **no** server settings fields here |
| A4 | Click `← Back` | Returns to the previous server view/Create; no crash; active sidebar entry sane |
| A5 | In App settings, click `Create support bundle` | Toast `Support bundle created (...)`; a `.zip` path appears (`<dataRoot>\diagnostics\support-*.zip`). Do not open it in the repo |
| A6 | Check `CurseForge API key` status without a key | `Status: No key configured.`, hint mentions keyless routes; Save/Clear disabled as appropriate; no key value displayed |
| A7 | Open `Downloads & storage` | Shows effective download folder (`<dataRoot>\cache` by default, badge `app default`), `Choose folder…`, `Reset to default`, `Open download folder`, app data folder. Do **not** confirm the native folder picker; press Escape/Cancel if clicked, and mark the picker interaction SKIPPED |

### Suite B — create + run a Vanilla server (P0, network required, ~8–15 min)
| ID | Steps | Expected |
|---|---|---|
| B1 | From Create, click `Vanilla` edition card | Configure step appears with `Server name (unique)`, version/loader selectors, Java section and the `I accept the Minecraft EULA.` checkbox |
| B2 | Wait for the version select to populate; choose a current release (e.g. `1.21.1`) | Options load from Mojang; no perpetual spinner; errors (offline/proxy) show a retry affordance (`Retry`) |
| B3 | Fill server name (unique, e.g. `pw-vanilla-<time>`), RAM, port (leave default or a free port); do **not** check the EULA yet | Values accepted; the primary Install button is disabled or the UI otherwise requires EULA consent before install |
| B4 | Check `I accept the Minecraft EULA.`, click the primary Install button (label varies, e.g. `Install`/`Install server`) | Progress + stages (`preparing`, `installing loader`, `verify boot`); on success the report shows no errors and a server is created/opened. First run may download Java + server.jar |
| B5 | Observe the shell after creation | Sidebar lists the server; header shows it; `Overview` clickable; Start enabled (EULA accepted) |
| B6 | Click `▶ Start`; wait for status `running` and boot log line containing `Done (` in Console/Overview tail | Server reaches running; no crash; controls switch to Stop/Restart/Kill |
| B7 | Open `Console`; send `list` | Command echoed; a "players online" style list reply (may be empty); history row added; no stack trace |
| B8 | Open server `Settings`; change only `MOTD` to `pw-motd`; click Save while the server is running | Toast `Settings saved…`; **server must remain running** (header still Running; no stopping/stop toast). This is the regression check for save-while-running |
| B9 | Reload nothing; open `Overview` | MOTD/settings reflect `pw-motd` (file-authoritative); restart badge shown only if a restart-requiring field changed |
| B10 | Back in Console, `⏹ Stop`; wait for status `stopped` | Status stopped; last log shows shutdown; server process gone (optional: no `java.exe` with the server id marker) |

### Suite C — persistence and quit safety (P0, ~5 min)
| ID | Steps | Expected |
|---|---|---|
| C1 | Stop the app via the helper `-Stop`, relaunch with a **new** helper run using the same `-ProfileRoot` | Server record still exists (stopped), settings/MOTD persist (`dataRoot\app-data.json` + `servers\<id>\server.properties`); no duplicate server |
| C2 | Start the server again; wait `running`; then close the app window gracefully: `(Get-Process -Id <helper pid>).CloseMainWindow()` (WM_CLOSE → app quit path). Wait up to 15 s, then run the helper `-Stop` to confirm `orphanJava: 0` | Window closes; app process exits (helper stop reports `stopped:true`, `orphanJava: 0`); no `java.exe` bound to that profile. A force-kill (`taskkill /F`) is **not** a valid test of the quit path |
| C3 | Relaunch with the same profile | Server shows `stopped` (not `running`/`crashed`), no stale "starting"; Console history remains; log file exists |
| C4 | Delete the test server via server `Settings → Danger zone → Delete server` (confirm) | Sidebar row disappears; `dataRoot\servers\<id>` removed; app falls back to Create/another server without stale activeId |

### Suite D — management tabs on the test server (P1, ~10–15 min)
| ID | Steps | Expected |
|---|---|---|
| D1 | `Worlds` tab | Active world row (`world`) with size/last modified/seed; `+ New empty`, `Duplicate`, `Export ZIP…`, `Import ZIP…` actions present; world changes disabled while running with tooltip |
| D2 | Duplicate the world (stopped); give a name in the modal | New world row appears (dimension folders copied); toast mentions dimensions included; no crash |
| D3 | Activate the duplicate | Confirmation titled `Activate “<name>”?` with button `Backup + Activate`; active world switches; auto-backup row appears in Backups |
| D4 | Delete a non-active world | Confirm titled `Delete “<name>”?` with button `Delete`; row disappears; a `World-delete` row appears in `Backups` (safety archive) |
| D5 | `Backups` tab → `Backup Now` (name, leave `Stop the server during the backup` off), while stopped | Progress/job updates; row appears with kind `Manual`; local timestamp; `Restore…`, `Export…`, `Delete` available |
| D6 | Restore that backup: row `Restore…` → keep `in-place` → `Restore (confirm)` | Confirm explains overwrite; restore completes; toast says the pre-restore safety backup is in the table; server still startable |
| D7 | `Players` tab | Empty state `No one has joined yet.` (or seeded roster if a player joined via console `whitelist add`); offline actions visible; running-only actions disabled with tooltip while stopped |
| D8 | `Metrics` tab (stopped) | Empty-when-stopped state, disk card present, range selector 1h/6h/24h/72h; no "undefined"/dead RCON promise controls |
| D9 | `Content` tab (Vanilla) | Explains Vanilla has no mods/plugins; no mock content; empty/no-crash states |
| D10 | Switch between the test server and any second server (create a second Vanilla if needed) | Per-server tab data changes correctly; no stale active server name/rows; no "Loading servers" full-screen flash during settings saves |

### Suite E — native-dialog paths (P2, manual-assisted; CDP cannot drive Windows dialogs)
Do **not** leave the app stuck on an OS dialog. Verify the UI gating and cancel behavior only:
- Worlds `Export ZIP…` / `Import ZIP…` while running must be disabled/gated with a tooltip.
- App settings `Choose folder…` and `Open download folder` may be clicked; if a native dialog opens,
  cancel it via Escape/keyboard and close any leftover dialog; record SKIPPED for the dialog interaction.
- World/backup download/export and Java custom-path picker: same rule.
Report which cases were skipped and why.

### Suite F — modpack installs (P2, network-heavy; time-box 20 min)
Only if time remains and the user agrees to network downloads:
1. Create → `Modrinth modpacks` → search `cobbleverse` → open a version → `Review & Install`/preview →
   install. Expected: preview report with file decisions, progress, verified boot, created server,
   `Done (` on start. This downloads ~150 files; do not retry on flaky network more than once.
2. CurseForge: with a user-provided real key, App settings → paste key → Create → CurseForge →
   search a small modpack → preview/install. Without a key, verify only the key-gated UI and that
   search controls are hidden.
If skipped, write `SKIPPED (time/network/key)` and do not claim pass.

### Suite G — accessibility / renderer health (P0, ~3 min, can be interleaved)
| ID | Steps | Expected |
|---|---|---|
| G1 | After every suite, inspect collected console messages | No uncaught exceptions / `TypeError` / React error boundary; warnings acceptable but record them |
| G2 | Open a confirm dialog; press Tab repeatedly, Escape | Focus stays in the dialog, Escape closes, focus returns to the trigger; no focus escape to background |
| G3 | Zoom/resize the window if your MCP supports it (or check responsive layout at default 1280×800) | No overlapping controls; tabs and header usable; no horizontal overflow in App settings/server settings |
| G4 | Check toast announcements | Toasts have `role=status`/`alert`; errors include a readable message (e.g. port conflict, duplicate name) |

## 7. Evidence and report format

Write everything under `H:\TESTMultiAI\20\artifacts\playwright-mcp\<timestamp>\`:
- `report.md` — table of every ID: PASS/FAIL/SKIPPED, steps actually taken, observed result, evidence file.
- `screenshots/NN-<case>.png` — one per case (full-page or window screenshot).
- `console-errors.json` — any renderer console errors/warnings with timestamps.
- `state.json` — optional backend snapshots (`servers_list`, `worlds_list`, `backups_list`,
  `players_list`, `metrics_get`, `storage_get`) — no secrets.
- `env.txt` — app exe path, `head -c` of `git rev-parse HEAD`, Windows version, profileRoot, CDP URL.

Bug report template (in `report.md` or as a separate section):
```
TITLE / SEVERITY (P0-P3) / CASE ID
STEPS: numbered, exact labels clicked
EXPECTED:
ACTUAL (verbatim error text/toast):
EVIDENCE: screenshot(s), console log, backend state
REPRODUCIBLE: always / sometimes (n/m) / once
NOTES: profileRoot, server id, build SHA
```

## 8. Known limitations you must account for

- **Native Windows dialogs** (Open/Save/folder pickers) are outside the CDP renderer; use cancel/Escape
  and mark interaction cases SKIPPED. Never block waiting for them.
- **Network/Java**: first Vanilla install downloads Temurin Java and the server jar; Modrinth/CurseForge
  can rate-limit or be slow. A failed download is a legitimate FAIL only after one clean retry; capture
  the error text. Offline = mark network-dependent cases SKIPPED.
- **No real modpack / CurseForge key** = those cases SKIPPED, not PASS.
- The app supports exactly one instance per profile; don't launch twice. Use a fresh `-ProfileRoot` or
  stop first.
- The packaged app is **unsigned**; Windows SmartScreen may warn if you launch the installer. This
  brief uses `win-unpacked`, so no installer/SmartScreen is needed.
- The app's dev/global `.app-data` and the archived `legacy/` tree are out of scope. Do not test the NSIS
  installer UI here (install/uninstall is verified separately by `npm run pack:verify:installer`).
- Playwright MCP attached over CDP sees the renderer only; do not attempt to inspect Electron main-process
  internals or use `browser_navigate` to load arbitrary URLs (it would navigate the app window away).

## 9. Pass criteria

- **PASS overall** only if: all P0 cases PASS; P1 has no P0-class failure and no unexplained crash;
  zero uncaught renderer exceptions; every PASS has a screenshot; the app is stopped and
  `orphanJava: 0`; no secrets or real user data were touched or written into the report.
- **FAIL overall** for any P0 failure, a backend/bridge error screen, a data-loss/duplicate-server
  behavior, a server left running after the app exits, or a crash of the renderer.
- If blocked before B1 (e.g. CDP cannot attach), report `BLOCKED` with the exact command/output and stop;
  do not test against the developer's real data as a workaround.
