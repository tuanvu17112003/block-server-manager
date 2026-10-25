# Prominence II 4.0.5 Server Start Test

Date: 2026-10-09  
Task: `backend-013-prominence-4-0-5-start-test`

## Setup

- Used the saved `Prominence 4.0.5 Override Test` server.
- Modrinth pack: Prominence II: Hasturian Era 4.0.5, version ID `iqWrFu7S`, Minecraft 1.20.1, Fabric.
- User had accepted the Minecraft EULA in the app.
- Port: 25639.

## Result

- The app launched Java and Fabric Loader 0.19.3, then marked the server **Crashed**.
- Fabric reported `Incompatible mods found` with missing hard dependencies:
  - `modmenu`, required by Forge Config Screens 8.0.2.
  - `s_lib` >=2.1.0+1.20.1, required by Mutant Skeleton Armor Tweaks 3.1.0+1.20.1, Quests & Teams Fixes 1.0.1+1.20.1, and Unrestricted Enchanting 1.0.0+1.20.1.
- Fabric's suggested fix was to add `modmenu` and `s_lib`; the server process exited unexpectedly.
- No source code or modpack files were changed. The server is stopped after the crash.

This is a startup/dependency issue separate from the fixed root-level override extraction error. The app did not silently add the missing mods.
