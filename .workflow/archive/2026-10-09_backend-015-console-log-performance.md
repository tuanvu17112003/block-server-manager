# Archived WORKFLOW_STATE — backend-015-console-log-performance

Archived: 2026-10-09

## Goal

Keep the server console responsive under large log output and separately report the unresolved Java startup stall accurately.

## Acceptance and result

- Research found unbounded per-server log arrays and full-history filtering/rendering; findings are in `docs/research/2026-10-09-console-log-performance.md`.
- Materialized `docs/architecture/adr/0009-bounded-virtualized-console-logs.md`, `docs/specs/console-log-performance.md`, and `docs/implementation/console-log-performance.md` before implementation.
- Implemented 50 ms log batching, a 10,000-line per-server retention limit, viewport virtualization, retained-history disclosure, and unmount cleanup in `src/store.tsx`, `src/tabs/ConsoleTab.tsx`, and `src/logs.ts`.
- Independent reviewer: PASS.
- `npm run build`: PASS (`tsc` + Vite).
- Windows MCP desktop smoke confirmed live logs and responsive `config` search. Full 10,000-line synthetic burst was not generated.
- Prominence II 4.0.5 all-files startup remained at Necronomicon configuration, did not answer `help`, and did not bind port 25511. Full evidence: `.workflow/artifacts/test-logs/backend-015-console-performance-and-start-test.md`.

## Durable decisions

- Retain at most the latest 10,000 console lines per server, batch events, and render only visible fixed-height rows plus overscan.
- Preserve all selected Modrinth pack manifest entries regardless of environment metadata, per the user's earlier direction.
- Treat the Java server startup stall as separate from app-side React console performance.

