# Console Log Performance Findings

Date: 2026-10-09  
Task: `backend-015-console-log-performance`

## Local evidence

- `src/store.tsx` appended each server output event to a per-server array with no retention limit, and scheduled a React state update for every line.
- `src/tabs/ConsoleTab.tsx` filtered the entire active history and rendered one DOM row for every matching line. Search, level changes, and other component renders repeated that work.
- The supplied Task Manager image shows a Java process at roughly 1.6 GB with 0% CPU while the console has stopped advancing. This supports investigating the server startup separately; it does not establish a Java cause for app UI stutter.
- The application is a Tauri + React frontend. Java is a child server process; the console rendering and log-state costs execute in the desktop app's webview.

## Research and decision inputs

- React documents rendering collection elements with `filter()` and `map()`. Its `useMemo` and `memo` guidance helps when repeated calculations or unchanged child props are the bottleneck, but it does not bound an ever-growing list or DOM.
- Tauri documents its event system as message passing to frontend listeners. The current listener calls `appendLog` once for each server output event, so bursts translate directly into React updates.
- A bounded history plus fixed-height viewport virtualization directly bounds retained state and rendered DOM. Short batching reduces update frequency without adding a dependency or changing the Rust process/event API.

## Sources

- [React: Rendering Lists](https://react.dev/learn/rendering-lists)
- [React: useMemo](https://react.dev/reference/react/useMemo)
- [React: memo](https://react.dev/reference/react/memo)
- [Tauri: Calling the Frontend](https://tauri.app/develop/calling-frontend/)

