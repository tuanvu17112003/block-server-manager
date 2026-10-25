# ADR-0009: Bounded, batched, virtualized console logs

## Status

Accepted

## Context

The store retained server logs indefinitely and committed a React state update per incoming line. The console then filtered and rendered the full active history as DOM nodes. Modded server startup can emit large bursts, making app memory, update work, and the DOM grow with session duration. Java's startup stall is a separate unresolved issue.

## Decision

Keep at most 10,000 recent log lines per server, batch incoming lines before committing store state, and virtualize console rows so the DOM contains only the visible window plus a small overscan. Do not add a package or change the backend event protocol. Export and search operate on retained history, and the UI communicates when older lines have rolled off.

## Consequences

- Memory and rendered DOM remain bounded during long or noisy sessions.
- The newest lines remain available for search/export; lines older than the retention window are discarded from in-memory history.
- Fixed-height single-line rows enable simple viewport calculations and horizontal scrolling for long messages.
- The Java server process and its startup behavior remain unaffected by this UI change.

