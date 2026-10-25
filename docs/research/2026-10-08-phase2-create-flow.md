# Phase 2 First-Server Create Flow — Research Notes

Research for the scoped backend-002-R1 review follow-up.

## Finding

React keeps component state only while the component remains rendered at the same position in the UI tree. Removing `Create` when the first persisted server appears destroys its local `doneId` state before the completion message and “Go to Console” action can be used. [React: Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)

## Decision

Track server-list hydration separately from first-run Create mode. After the persisted list has loaded empty, keep the global Create view mounted through successful record creation. Exit it only on the existing explicit “Go to Console” action (or a user-selected navigation action when a server exists). This preserves the completion message, Start pulse, LAN hint, and client-parity notice without creating a mock server ID in Tauri.

## Scope

This is a narrow correction to the Phase 2 fresh-database Tauri flow. Browser Create navigation and its in-memory mock server remain unchanged. No new dependency or architecture change is required.
