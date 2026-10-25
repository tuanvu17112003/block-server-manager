# Server Initial Heap Specification

## Goal

Make app-launched servers start with the same initial and maximum heap size selected in the server's RAM setting.

## Requirements

1. For every supported launch mode, pass `-Xms<ramMb>M` and `-Xmx<ramMb>M` before the server main/loader arguments.
2. Keep the existing verified Java executable, server working directory, `-Dtestmultiai.server.id` process marker, EULA validation, and process output tracking.
3. Do not execute `start.bat` or other external shell scripts.
4. Do not add the older Aikar GC tuning flags; the user's latest working command requires only matching `-Xms` and `-Xmx`.

## Acceptance criteria

- An 8,192 MB server receives `-Xms8192M` and `-Xmx8192M`.
- A server with another configured RAM value receives matching initial and maximum values for that size.
- Jar and argument-file launch modes preserve their existing loader arguments and process identity marker.
- Rust formatting/tests/build pass, and the desktop server launch is retested if the Windows app control is available.

