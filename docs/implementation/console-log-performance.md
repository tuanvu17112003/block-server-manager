# Implementation Guide: Console Log Performance

## Owned paths

- `src/store.tsx` — queue and batch server log lines; enforce the per-server retention limit and clear queued entries when clearing a server history.
- `src/tabs/ConsoleTab.tsx` — fixed-height viewport virtualization, maintain scrolling and filtering, export retained logs, and disclose rolled-off history.
- `src/logs.ts` — shared retention and row geometry constants/helpers if useful; avoid new dependencies.

## Constraints

- Preserve log event order and all existing commands and server lifecycle behavior.
- Do not change Rust process output or Tauri event channels.
- Keep the implementation dependency-free.
- Keep auto-scroll and manual-scroll behavior intact.
- Do not claim this resolves Java startup hangs.

## Verification checklist

- [x] `npm run build` succeeds.
- [x] Reviewer confirms a large log history renders only viewport rows plus overscan and retained history is capped at 10,000 lines.
- [x] Reviewer confirms burst ordering, per-server cap, and queued clear behavior.
- [ ] Full UI interaction pass for level filtering, clear, export, and auto-scroll is not included in the live smoke; search and live output were exercised.
- [x] Launch the desktop app and inspect the console UI.

Live evidence and limits: `.workflow/artifacts/test-logs/backend-015-console-performance-and-start-test.md`.
