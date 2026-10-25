# Server Initial Heap Launch Research

Date: 2026-10-10  
Task: `backend-018-server-initial-heap`

## Local evidence

- The app's Fabric `server.jar` launch sets `-Xmx` from the server's configured RAM, adds its process identity marker, then runs `server.jar nogui` from the managed server directory. It does not set `-Xms` and does not execute `start.bat`.
- The user's successful BAT command sets `-Xms8G -Xmx8G -jar server.jar nogui`.
- The app-managed server JAR and the BAT-folder JAR have the same SHA-256 (`0E4E87619D281F2F31D54A208A2EE5E68395CB3F332450FF2B8F7514249997D2`). All 442 mod JARs in those two folders match byte-for-byte. Their config trees differ in six files; the Necronomicon config is unchanged.
- Both the app-selected Oracle Java 17 launcher and the `java` resolved from PATH are Java 17.0.12 and resolve to the same launcher binary hash.
- The app-managed folder has no `start.bat`; the app intentionally starts a validated Java command directly rather than executing a pack-provided shell script.

## Research

- Oracle documents G1 as the Java 17 default on most platforms, and recommends starting with G1's defaults before custom tuning.
- Oracle documents equal `-Xms`/`-Xmx` as a way to avoid heap resizing. `-XX:+AlwaysPreTouch` moves OS memory backing work into JVM startup, but it is not in the user's latest simplified BAT command.
- The user's latest requested behavior is specifically to set the initial and maximum heap to the configured server RAM; the older Aikar tuning flags are outside this change.

## Sources

- [Oracle Java 17 G1 tuning](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html)
- [Oracle Java 17 `java` command](https://docs.oracle.com/en/java/javase/17/docs/specs/man/java.html)

