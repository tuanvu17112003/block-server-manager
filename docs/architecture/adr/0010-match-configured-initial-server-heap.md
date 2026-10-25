# ADR-0010: Match the initial server heap to its configured maximum

## Status

Accepted

## Context

The app launched the user's Fabric server with `-Xmx` equal to configured RAM but omitted `-Xms`. The user's successful `start.bat` uses the same value for both. The app-managed server JAR and mod JARs matched the BAT folder, and Java 17.0.12 matched, so heap initialization was a concrete launch difference. The app-managed server folder does not contain the BAT file.

## Decision

Pass both `-Xms<configured RAM>` and `-Xmx<configured RAM>` for app-managed Java launches. Keep the existing server-directory working directory, Java validation, process identity marker, loader arguments, and pipe-based tracking. Do not execute `start.bat`.

## Consequences

- The JVM commits its configured heap size at startup instead of growing from a smaller initial heap.
- Memory reservation follows each server's RAM setting; an 8 GB server starts with an 8 GB initial heap.
- Launching stays under the app's existing process tracking and does not execute arbitrary batch commands.
- This change matches the user's simplified BAT example; it does not add the older custom Aikar/G1 tuning options.

