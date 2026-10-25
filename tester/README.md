# tester/

Evaluation track for **automated testing framework executed by AI agents** — isolated per user instruction (`Create a new folder named "tester" for this`).

Scope: **Full stack** (Rust backend + React/Vite frontend + Tauri E2E smoke).
Model: **Hybrid evaluation** (MCP tools vs alternatives).
Deliverable: **Report only** — no code, no deps, no config changes.

## Contents

- `ai-agent-testing-evaluation.md` — main report (architecture review + tool comparison + recommendation + sources)
- `README.md` — this index

## Status

- 2026-10-09: Architecture mapping (Explorer) + MCP/alternatives research (Scout) complete. Report synthesized by PQM. No implementation started.
- Live `WORKFLOW_STATE.md` still tracks the parallel Modrinth loader-fix goal (Phase: Implement, not Done). This folder is a parallel evaluation track and does not replace that state.

## How to use

1. Read `ai-agent-testing-evaluation.md` for the full findings.
2. If a prototype is approved later, follow Path 1 → Path 2 → Path 3 order in the report, with explicit user consent before adding any dependency (per standing constraint: no new deps without approval).
