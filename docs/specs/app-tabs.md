# Spec — Tabs + UI Elements (MVP Desktop)

Source: docs/research/2026-10-08-competitor-ux.md + technical. Persistent header: status dot (grey/green/amber/red) + Start/Stop/Restart + players + version + address:port.

Nav rule (layout-001): 7 per-server tabs only (Overview/Console/Players/Worlds/Backups/Metrics/Settings). Create is a GLOBAL view, not a per-server tab: Sidebar + New Server opens it with a neutral header (no per-server status/actions); TabBar hidden while creating; each entry starts a fresh wizard; Cancel/Back restores prior tab; selecting a saved server in the sidebar exits Create; success selects the new server and lands on Overview/Console.

## 1 Overview
Purpose: landing status + quick actions. Elements: status+uptime, players chip, CPU/RAM mini-bars, version/loader, Start/Stop/Restart/Kill toolbar, Open Folder, Copy IP, 3-line log tail, alert banner (crashed/EULA/port). Empty: Create CTA.

## 2 Create wizard (GLOBAL view, not a per-server tab)
Purpose: 1-click Vanilla/modpack. Steps:
1 Type cards Vanilla / CF Modpack / MR Modpack.
2 Search (modpack): search + source tabs + MC-version + loader filter + sort popular/downloads; cards icon/name/author/downloads/MC; detail pack version dropdown + changelog.
3 Configure: name (unique), pack-version, MC+loader read-only resolved, RAM slider + recommended + free-RAM warn, port auto + conflict, EULA checkbox required + link, Java Auto requirement/status + install progress + Change… override.
4 Install: progress + log expand + Cancel + Retry; auto pre-first-run backup; Done → Console Start pulsing + LAN/port hint + client parity notice. In Tauri first-run, keep the global Create view mounted after the first persisted record is created until the user chooses a navigation action (Done/Go to Console or a saved sidebar server), so the completion state remains visible until then. Vanilla shortcut: MC version + name/RAM/port/EULA.

## 3 Console
Live control + cmd. Log view auto-scroll colored + error highlight + search/filter + Clear/Export .log; cmd input history + Send; Stop/Kill-confirm/Restart; quick chips save-all/say/time/weather; attached state.

## 4 Players
Table avatar/name/UUID/online/OP/white/ban/last/playtime; Search + Filter + Refresh; row Kick-reason/Ban/Unban/OP/Whitelist/Gamemode/Teleport/Heal (confirm, needs running); Add offline via usercache. Disabled when stopped + tooltip. Empty: No one joined yet.

## 5 Worlds
Current card name/size/last/seed + library grid Local+Shared search Upload.zip/Download/Delete-confirm/Duplicate + Activate (stopped + auto-backup prompt) + New empty (seed + level-type). Warn replaces level-name.

## 6 Backups
Table name/created/size/type/note + Backup Now (name + shutdown-during) + Auto toggle + interval + Max kept + Excludes hint + row Restore-confirm (in-place vs reset + overwrite warn)/Download/Delete + progress + retention.

## 7 Metrics
Live CPU%/RAM% vs limit/Players/Uptime/TPS+MSPT (or — needs RCON hint) + graphs 1h-72h + Shift-zoom + Players history + Disk + alert opt-in deferred. Empty when stopped.

## 8 Settings minimal
name, MOTD, max-players, difficulty/gamemode (restart badge), port, RAM slider, online-mode toggle (cracked warns loses OP), Save dirty + Restart banner, Show advanced files link. No separate Versions/Java/Plugins tabs MVP.
Versions as picker not tab; Java backend auto with a per-server path override; properties 7-field subset; mods browser deferred; EULA+RAM mandatory.

Deferred: Files full, Schedules, Roles, DBs, Network, Activity — keep slot extensible.
