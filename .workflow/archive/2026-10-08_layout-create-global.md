# Archive 2026-10-08 — Layout: Create global (layout-001)

Goal: Create out of per-server tabs + skill-guided polish, bounded.
Trigger: user screenshot - header showed Survival Vanilla while browsing modpacks; spec already said global, code diverged.

Work:
- Implementer layout-001: TabId/TABS 7 (removed create); App creating/returnTab flow (global CreateHeader, no Header/TabBar in create mode); Create onExit(next) + addServer selects new; Overview onCreate; wizard/EULA untouched. Skill: ui-ux-pro-max nav-hierarchy (global vs contextual nav) via `python .../search.py ... --domain ux` (3 generic hits, principle applied) + html-tailwind stack (0 hits, used ui-styling composition only). No new deps, src/** only.
- Gates: Reviewer PASS (7 tabs, neutral header, EULA intact, src-only; flagged spec 8-tab wording) + Tester PASS (build 44 modules, secrets clean, regression N/A).
- PQM spec touch-up: app-tabs.md nav rule + Create GLOBAL heading; checklist 7+global.

Files: src/types.ts, src/components/layout.tsx, src/App.tsx, src/tabs/Overview.tsx, src/tabs/Create.tsx, docs/specs/app-tabs.md, docs/implementation/checklist.md.
Rework: 0.
