# Archive 2026-10-08 — Minecraft-look reskin (mc-style-001)

Goal: full Minecraft-style revamp, IP-safe. Scope agreed: full look, pure CSS, Press Start 2P headings-only, whole app.

Work:
- Research mc-style-001-R: MC UI signatures, Mojang usage-guideline red lines, OFL font pick (Press Start 2P, Monocraft rejected on optics), skill searches (ux HIT partial, style HITs pixel/dark/scanlines, stack honest no-match), per-area CSS notes. No code.
- Docs: docs/specs/minecraft-style.md (palette/font/recipes/IP/per-area) + docs/README index line.
- Implement: chunky bevel buttons, stone panels/slots, dirt sidebar, java tabs, dark tables, mono console, XP bars, stone modal, MC toasts, edition slots + original NEW! splash tag, non-affiliation footer; fontsource bundling (45 modules). src/** + tailwind.config + package.json (fontsource only).
- Gates: Tester PASS (build, no images, secrets clean); Reviewer FAIL sole item index.html title "Minecraft Server Manager" → PQM trivial fix to "Block Server Manager" (implementer suggestion; user can rename), rebuild 5.2s clean, grep confirms no title-string remains. Remaining "Minecraft" uses descriptive only (EULA links, version labels) - allowed.

Interrupt (same day): git status lag (3718 files/~736k lines, NO_GITIGNORE) → .gitignore added, 16 entries instant. No commits/deletes.

Files: docs/specs/minecraft-style.md, src/** (css/ui/layout/tabs/App/main), tailwind.config.js, package.json, index.html, .gitignore.
Rework: 0.
