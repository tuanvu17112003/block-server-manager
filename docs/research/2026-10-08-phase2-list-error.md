# Phase 2 Server-List Load Error — Research Notes

Research for the scoped backend-002-R3 follow-up.

## Finding

The Tauri server list is an external-system read performed by a React Effect. Its success and failure paths need separate renderable states. If a rejected load leaves the state marked as loading, the user sees “Loading servers…” indefinitely even though the failure toast has already appeared. React documents Effects as the synchronization point for external systems and calls out fetch cancellation/ignoring during cleanup. [React: Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)

## Decision

Keep an explicit load state for the persisted server list. On failure, record the toastable error and render a retry action; retry the same strict `servers_list` IPC. Do not treat a failed list as a confirmed empty database or show mock server records. Browser mode continues to use its local mocks.

## Scope

This is limited to the Tauri startup list load in Phase 2. It adds no dependency or backend command and preserves the existing strict error-propagation rule.
