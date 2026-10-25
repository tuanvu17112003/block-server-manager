# Console Log Performance Specification

## Goal

Keep the desktop interface responsive while a server emits large or sustained volumes of output, while preserving live logs, search, level filtering, auto-scroll, clear, and export.

## Requirements

1. Buffer incoming server log events briefly and commit them together; preserve event order and never drop a line except through the retention limit.
2. Retain at most 10,000 newest lines for each server. New output evicts the oldest entries; clearing removes retained entries and pending entries for that server.
3. Search, level filtering, and export operate on the retained history.
4. Render only visible rows and a small overscan. Use stable line IDs, fixed row height, and horizontal scrolling for long log lines.
5. Keep auto-scroll at the newest output when enabled. When disabled, incoming output must not force the user back to the bottom.
6. When history reaches its limit, make clear that older lines have rolled off and export contains retained history only.
7. Do not change server process management, Java launch behavior, or the Tauri event contract.

## Acceptance criteria

- A burst of log events is committed in batched store updates and appears in order.
- Histories never exceed 10,000 entries per server, including after queued lines flush.
- A large history results in a bounded number of rendered row elements based on viewport height, not history length.
- Existing clear, export, search, level filter, and auto-scroll interactions still work.
- Frontend type-check/build passes and the desktop app can be launched for a console smoke test.
- The UI performance change is not described as a fix for an independently stalled Java process.

