# AI-Agent-Executed Automated Testing — Architecture Review & Hybrid Tool Evaluation

- Date: 2026-10-09
- Scope: Full stack (Rust backend + React/Vite frontend + Tauri E2E smoke) — per user confirmation
- Model: Hybrid evaluation (MCP tools vs alternatives) — per user confirmation
- Deliverable: Report only — no code, no dependency, no config changes
- Workers: Explorer (architecture map) + Scout (MCP/alternatives research), read-only. PQM synthesis.
- Method note: `.codegraph/codegraph.db` exists but no CodeGraph MCP tool was exposed in this session (`list_mcp_resources/templates` empty), so Explorer used Glob+Read fallback per allowed insufficient-result rule. No edits made by workers.

---

## 1. Project architecture review (testability lens)

### 1.1 Frontend — React 18 + Vite 5 + Tailwind 3 + TypeScript 5 strict

- Entry: `index.html` → `src/main.tsx` → `src/App.tsx` (`StoreProvider` + `Shell`): sidebar server list, header lifecycle controls, 7-tab main (`overview/console/players/worlds/backups/metrics/settings`), modal `Create` wizard, `ToastHost`.
- State: `src/store.tsx` React Context (`servers/activeId/logs/cmdHistory/toasts`, actions `start/stop/restart/kill/sendCommand/createServer/setJavaPath/reloadServers`). Dual-mode: browser = `src/mocks/data.ts` in-memory + timers; Tauri = real `invoke()` + `listen()` subscriptions.
- Bridge (sole TS↔Rust boundary): `src/tauri.ts` — `isTauri()`, `invokeOrStub` (mock-tolerant) vs `invokeStrict/invokeRequired` (propagate `AppError`), typed DTOs (`ServerDto/CreateServerInput/JavaDetection/Modrinth*Dtos/JobProgressPayload`), event helpers (`serverLogEvent/serverStatusEvent/jobProgressEvent` + `on*`).
- Build: `vite.config.ts` (fixed port `1420` for Tauri `devUrl`), `tailwind.config.js` + `postcss.config.js`, `tsconfig.json` + `tsconfig.node.json` (strict), `@tauri-apps/api ^2.12.1`.
- Highest-risk UI: `src/tabs/Create.tsx` (1100+ lines) — 4-step wizard, debounced Modrinth search + pagination, exact version/loader/MC triple-gating, Java detect/validate/ensure, cancellable install with `crypto.randomUUID` jobIds and event listeners. Highly async, network-dependent, untested.
- Stubs: `Players/Worlds/Backups/Metrics/Settings/ConsoleTab/Overview` largely mock-backed; backend Phases 6–9 (`backups/players/worlds/metrics/rcon/content`) are `#![allow(dead_code)]` stubs.

### 1.2 Backend — Tauri v2 + Rust (Windows-x64-only)

- Entry: `src-tauri/src/main.rs` → `lib.rs::run()` — Tauri 2 builder + `single-instance` plugin, `setup` ensures app-data dirs + file logging + SQLite migrate + orphan reap, manages `DbState/ProcessState/InstallerState`, `on_window_event` stop-all, 23 commands in `generate_handler!`.
- Persistence: `db/mod.rs` SQLite (`rusqlite` bundled) schema v1 (`servers/backups/worlds/jobs/settings`); `servers/mod.rs` CRUD + port allocation + folder scaffold (`mods/world/logs/backups`, `eula.txt=false`, `server.properties`, `installer.log`); `publish_installed_server` = staging rename → insert with rollback.
- Process manager: `servers/process.rs` (~1294 lines) — spawn selected `java.exe` with server-identity marker, `server.lock` PID tracking, stdout/stderr pumps → `server://log/{id}`, lifecycle → `server://status/{id}`, `stop` = stdin `stop` + 15s grace then kill tree, orphan reaping at boot, EULA + port re-check, no secrets logged.
- Installer (Phase 4): `installer/mod.rs` (~3242 lines) — `versions_vanilla` (Mojang manifest), `versions_paper` (Fill v3 + stable builds), `loaders_resolve` (Vanilla/Paper/Fabric/Forge/NeoForge via 5 provider APIs), `server_install/_cancel` + `modpack_install/_cancel` as cancellable `spawn_blocking` jobs with staging `installer-staging/<uuid>`, hash/size verification (SHA1/SHA256/SHA512), disk preflight (512 MiB headroom + 1 GiB reserve), progress `0–100` via `job://progress/{jobId}`, `JobControl{Running/Cancelled/Publishing}` race guard.
- Modrinth catalog: `modpacks/mod.rs` read-only search/project-versions (facets, 8-char ID validation, HTTPS/hash validation); `modpacks/install.rs` (~925 lines) `.mrpack` parse/extract with limits (`MAX_MRPACK 2 GiB / entries 100k / expanded 20 GiB / index 16 MiB`), reserved-path + zip-slip guards, required-files download + override layers (`overrides` then `server-overrides`).
- Java provisioning (Phase 3): `java/mod.rs` (~1393 lines) — `java_detect/validate/ensure`, Mojang `javaVersion.majorVersion` + offline fallback map, discovery via `JAVA_HOME/PATH/registry/known-locations/app-managed`, `inspect_candidate` via `java -XshowSettings:properties` (64-bit enforced, 5s timeout), Temurin install via Adoptium API + `curl.exe` resume + `certutil` SHA256 + `tar.exe` extract, single-install mutex, progress events. Windows-x64-only (`ensure_windows_x64`).
- Contract: `error.rs` `AppError{Validation/NotFound/Conflict/Io/Db/Internal}` → `{code,message}` toastable; `util/events.rs` channels (`server://log|status|players`, `job://progress`, `metrics://tick`); capabilities `default.json` = `core:default + core:event:default` only (no fs/dialog/shell/http); `tauri.conf.json` (`devUrl localhost:1420`, `frontendDist ../dist`, bundle inactive).

### 1.3 Existing test / static gates (exact)

- Frontend `package.json` scripts: `dev` (vite), `build` (`tsc && vite build` — only static gate), `preview`. No `test/lint/typecheck/e2e/format` scripts. No `vitest/jest/playwright/cypress/eslint/prettier` dep or config. No `*.test.*` / `*.spec.*` / `tests/` / `.github/`.
- Rust: inline `#[cfg(test)]` only, runnable via standard `cargo test` (not referenced in any script):
  - `java/mod.rs`: 5 tests (offline fallback, fail-closed unknown, unsupported major, range-unit, start-major map)
  - `servers/mod.rs::publication_tests`: 3 tests (log-handle-close-before-move, rollback-on-DB-fail, properties merge)
  - `servers/process.rs::tests`: 3 tests (JAR/argfile identity, Quilt symlink reject)
  - `modpacks/install.rs`: 7 tests (zip-slip/reserved-path/size-guard class)
  - `installer/mod.rs`: 5 + 7 tests (`modrinth_http_tests` rate-limit/redirect + version/validation)
- Config paths: `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `tailwind.config.js`, `postcss.config.js`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`.

### 1.4 Top testability risks for AI-agent execution

1. **Windows-x64-only backend** — `ensure_windows_x64()` and related gates reject installs/Java on Linux/macOS/ARM. Agents on non-Windows runners can only run pure-function `cargo test`s, never install/start paths. Needs Windows runner + WebView + `curl.exe/tar.exe/certutil.exe/reg.exe`.
2. **Large network artifacts + strict verification** — server JARs, Forge/NeoForge installers, Temurin JDKs (200–400 MB class), `.mrpack` up to 2 GiB / 20 GiB expanded; every byte size+hash checked, disk preflight enforced. E2E is slow/flaky/offline-impossible; provider outages (Mojang/Fill/Fabric/Forge/Adoptium/Modrinth 429) fail closed by design.
3. **Async event-driven completion** — commands return fast; outcome arrives via `job://progress/{jobId}` (0–100 + bytes), `server://log/{id}`, `server://status/{id}` (`starting→running→stopping→stopped/crashed`). Agents must `listen` with timeouts, handle `JobControl::Publishing` cancel race, distinguish `cancelled` vs `failed`.
4. **Filesystem + DB + process side effects** — app-data (`servers/<uuid>/`, `installer-staging/`, `java/temurin-*`, `app.db`, `logs/launcher.log`), SQLite single-`Mutex`, live `java` children with `server.lock`, `stop_all_blocking` on close. Tests need temp-dir isolation + orphan cleanup; parallel agents risk port/DB/name collisions.
5. **Mock/real divergence, zero frontend/E2E harness** — browser uses `mocks/data.ts`; Tauri uses real backend. No component/E2E runner, no MSW/fixture layer. Agent must build harness from scratch (Vitest + mocked `invoke`/`listen`, `cargo test` fixtures, Windows E2E with stub HTTP + tiny fake artifacts).

---

## 2. MCP tools inventory (local + ecosystem)

### 2.1 What exists locally

| Capability | Status |
|---|---|
| `codegraph_explore` (structural index) | Present (`.codegraph/` indexed, mandated by `AGENTS.md` §3). Discovery/fixture aid only, not a test runner. |
| Blender MCP (`execute_blender_code`, screenshots, API/manual search) | Connected but **out-of-scope** — no 3D datablocks in this stack. |
| `list_mcp_resources` / `list_mcp_resource_templates` | Empty this session. No test-runner MCP resources exposed. |
| `WORKFLOW.md` Tester role + §6.2 regression policy | Present — Tester = `Bash (test commands) + read`. Must run new tests + same-module regression + full suite for shared infra. |
| `AGENTS.md` least-privilege + CodeGraph-first | Present — constrains test execution permissions. |
| `src-tauri/capabilities/default.json` | Minimal (`core:default`, `core:event:default`). Any E2E needing fs/dialog/shell/http requires a security decision. |
| `docs/research/` + `sources.md` | 17 notes, none on testing framework — gap this evaluation fills (report lives in `tester/` per user instruction instead of `docs/`). |

Missing: no `.opencode/agents/*.md`, no `opencode.json/jsonc`, no `mcp*.json`, no Tester/Reviewer agent definitions (only 7 design skills), no `vitest.config.ts`, no `playwright.config.ts`, no MCP server configs, no `e2e-tests/`, no CI workflows.

### 2.2 Ecosystem options evaluated (2025–2026)

| Approach | Agent invocation | Pros | Cons | Tauri fit (1-5) |
|---|---|---|---|---|
| **A. Playwright MCP** (`@playwright/mcp`) | MCP tools `browser_navigate/snapshot/click/fill` via a11y tree | Deterministic snapshots, good for exploratory web flows | Token-heavy; upstream now advises CLI+SKILLs over MCP for throughput; browser-only, not Tauri WebView | 2 — fixture validation only |
| **B. Filesystem MCP** (official + Go port) | Scoped `read/write/list/search` with `allowedDirs` | Least-privilege by directory; fixture/log handling without raw `rm -rf` | CVE-2025-53110 (prefix bypass), CVE-2025-53109 (symlink bypass) — must pin patched, canonicalize, deny symlinks | 3 — fixtures, not execution |
| **C. Fetch MCP** | `fetch(url)` → markdown with chunking | Pull Mojang/Paper/docs without raw curl+parse; proxy/UA configurable | SSRF risk (local IPs); prompt-injection via fetched markdown; not an executor | 3 — fixture retrieval |
| **D. GitHub MCP** (official, 32k★) | Repo/issue/PR/Actions via remote or Docker, `--toolsets` scoping | Triage failures, open PRs, trigger/inspect Actions in natural language | Over-broad PAT blast radius; prompt-injection via issue text (May 2025 demo); remote = data leaves host | 3 — CI orchestration |
| **E. Dedicated test-runner MCPs** (`mcp-server-tester`, `@gleanwork/mcp-server-tester`, `mcptest`, `mcpchecker`) | YAML tool-tests / Playwright fixtures / mock MCP servers / trajectory asserts | Purpose-built for agent-behavior testing, LLM-discoverability evals | Immature (★0–35); test MCP servers/agents, not Tauri app logic; LLM-judge cost/flake | 1–2 — premature here |
| **F. `cargo test` + `clippy` + `rustfmt`** | Constrained `bash`: `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt --check` | Zero new deps; canonical Rust unit/integration/doctest; fast, deterministic, CI-ready | Backend only; needs `tests/` + `tempfile` discipline | 5 |
| **G. `vitest` + Testing Library + Playwright direct (+ `mockIPC`)** | `vitest run --no-watch` (never bare `vitest`), `playwright test` vs dev server | Fastest frontend loop; `mockIPC` fakes `invoke()`/events; browser mode reuses asserts | Mocks diverge from Rust reality — needs backend contract tests; browser ≠ WebView quirks | 5 frontend, 4 with mocks |
| **H. Tauri WebDriver E2E** (`tauri-driver` + `@wdio/tauri-service`) | W3C WebDriver vs real app binary; `browser.tauri.execute()/mock()` + log capture | Only path covering real WebView + Rust IPC + capabilities + logs | Heaviest: debug binary build, drivers, display server, two plugins; slower/flakier | 5 — official E2E |
| **I. CI-native (GitHub Actions + `gh`)** | Workflows run full matrix; agent via `gh workflow run/view --log` | Auditable, reproducible; enforces WORKFLOW §6 gates + §6.2 regression | Async (minutes); needs workflow files not yet present | 4 — final gate |
| **J. Agent `bash` with constrained permissions (WORKFLOW Tester)** | Tester role: `bash(test cmds only)+read`, owned-paths, worktree isolation | No new protocol/supply chain; 1:1 with least-privilege + gates; token-efficient vs MCP | Raw bash footgun if unconstrained — needs allowlist + `ask` for edit/bash/webfetch | 5 (process fit) |

Hybrid patterns observed: MCP for discovery/fixtures + direct runner for execution; mock → real ladder (`mockIPC` unit → browser-mode → embedded WebDriver → CI matrix); Tester as independent gatekeeper (different context from Implementer, max 3 reworks).

---

## 3. Recommendation — hybrid, least-privilege-first (no new MCP for execution)

### Path 1 — Immediate: direct runners + constrained Tester (no new MCP)

- Stack: `cargo test/clippy/fmt --check` + `vitest run` + `@tauri-apps/api/mocks` (`mockIPC`/`clearMocks`) + `codegraph_explore` for impact surface.
- Why: zero trust-boundary expansion; fits current `default.json`; maps to WORKFLOW Tester/§6.2 and existing rustfmt-gate research; fixes the `no test script / no tests/` gap with `test:run`-style scripts. Token-efficient vs MCP (no schema/a11y overhead). Agent invocation is allowlisted bash, reviewable in logs.
- Prereqs (future prototype, NOT done here): `vitest + @testing-library/react + jsdom`, `src/test/setup.ts` with mocked bindings, `tests/` in `src-tauri` with `tempfile`, smoke subset in `AGENTS.md`.
- Requires explicit user consent before adding any dev-dependency (standing constraint).

### Path 2 — Next: real-app E2E via WebdriverIO embedded (still no generic MCP)

- Stack: `@wdio/tauri-service` (embedded provider) + `tauri-plugin-wdio[-webdriver]` + browser-mode fast loop + GitHub Actions (`xvfb`, EdgeDriver sync, `tauri-driver --locked` fallback).
- Why: only option covering WebView + IPC + capabilities + backend logs. Officially maintained, cross-platform (macOS only via embedded). Keeps MCP attack surface at zero while proving `core:event` flows. CI template exists.
- Prereqs (future): `e2e-tests/` + `appBinaryPath`, two plugins, `wdio` scaffold, CI workflow. Reserve for pre-merge/smoke, not per-edit (heavy/slower).

### Path 3 — Later/opt-in: scoped MCP aides for orchestration, not execution

- Stack: Filesystem MCP (read-only, pinned, single `allowedDir`) + Fetch MCP (egress-allowlisted) + GitHub MCP (`--toolsets context,actions`, read-only PAT) layered **on top of** Paths 1–2.
- Why: agent stages fixtures, fetches provider docs, triggers/inspects CI without widening local exec. Toolsets + scoping enforce least-privilege; audit trail satisfies NSA/RedHat logging guidance.
- Guardrails (mandatory if adopted): version-pin, loopback-only, path canonicalization + symlink denial (post-CVE-2025-53109/53110), human approval for write/merge/push, treat all tool descriptions/fetched markdown as untrusted (tool-poisoning), egress allowlist, truncate outputs.
- Explicitly avoid for now: Playwright MCP as E2E replacement (browser-only, token-heavy) and test-runner MCPs (`mcptest`/`mcp-server-tester`/`mcpchecker` — no MCP surface to test yet).

### Non-recommendations

- Blender MCP: irrelevant to this stack.
- Exposing app as MCP server + `mcptest`-class suites: premature.
- Playwright MCP as Tauri E2E: wrong layer (needs WebDriver bridge for real app).

---

## 4. AI-agent execution model (how agents would run it)

- Roles per `WORKFLOW.md`: Implementer writes code; independent Tester (different context) runs Path 1 (+ Path 2 at gates) per §6.2 regression policy (new tests + same-module suite + full suite for shared infra); Reviewer checks correctness/maintainability/security + docs consistency; Linter runs `tsc`/`clippy`/`fmt --check`; PQM blocks `Done` on FAIL with scoped Rework Package (max 3 attempts, then escalate).
- Least-privilege: Tester gets `bash(test cmds only)+read`, explicit owned-paths per handoff, `git worktree`/branch isolation for parallel work; `push`/install-deps/new-capabilities require human approval (§4.1 risk triggers). Never grant full edit+bash+network by default.
- Inner loop (fast): `codegraph_explore` → impact surface → scoped `vitest run <file>` / `cargo test <filter>` → same-module regression.
- Outer loop (gate): full `vitest run` + `cargo test` + `clippy` + `fmt --check` + `tsc` (+ WebDriver smoke at merge) → CI workflow if present.
- Windows constraint: full install/start E2E requires Windows x64 runner with WebView + system tools; Linux/macOS agents limited to pure-function tests unless `ensure_windows_x64` gates are refactored behind test hooks (architectural decision, not made here).

---

## 5. Acceptance mapping

- [x] Architecture reviewed (full stack, bridge, existing gates, top 5 risks).
- [x] MCP tools inventoried (local empty + ecosystem A–E with fit/risk).
- [x] Alternatives evaluated (F–J with Tauri fit).
- [x] Hybrid recommendation given (Path 1 → 2 → 3, with non-recommendations).
- [x] Report-only constraint honored — no files outside `tester/`, no code/config/dep changes.
- [ ] Prototype / plan / checklist — explicitly out of scope per `Report only`. If requested later, materialize under `docs/` per WORKFLOW §3.3 + `tester/` tracking, with dep consent.

## 6. Risks & open questions (for any future prototype)

1. Target OS for agents: Windows x64 runner available, or must tests pass on Linux (requires refactoring `ensure_windows_x64` gates)?
2. Live-network policy: allowed (Mojang/Modrinth/Adoptium) or stubbed/recorded (no cassette infra exists)?
3. Artifact budget: real JARs/JDKs (hundreds of MB) or tiny fake servers + mocked `fetch_*`?
4. Home for framework: `tester/` (current eval track) vs new `tests/`/`e2e/` + `.github/workflows/`?
5. Frontend harness: Vitest + Testing Library + mocked `@tauri-apps/api` and/or WebDriver (`tauri-driver`) E2E?
6. Packaging scope: `bundle.active=false` — is installer/packaging testing in scope, or only `dev`/`build` + `cargo test`?

---

## 7. Sources

MCP / ecosystem:
- https://modelcontextprotocol.io/docs/2025-11-25/getting-started/intro
- https://www.contextstudios.ai/blog/mcp-ecosystem-in-2026-what-the-v127-release-actually-tells-us
- https://www.npmjs.com/package/@playwright/mcp / https://github.com/microsoft/playwright-mcp
- https://www.thoughtworks.com/en-us/insights/blog/generative-ai/model-context-protocol-mcp-impact-2025
- https://github.com/modelcontextprotocol/servers/tree/main/src/fetch
- https://pkg.go.dev/github.com/ad/mcp-filesystem
- https://github.com/github/github-mcp-server (+ README, toolsets, OAuth/PAT)
- https://github.com/steviec/mcp-server-tester / https://github.com/gleanwork/mcp-server-tester / https://github.com/josephgec/mcptest / https://github.com/mcpchecker/mcpchecker

Runners / Tauri testing:
- https://doc.rust-lang.org/cargo/commands/cargo-test.html / https://doc.rust-lang.org/nightly/cargo/guide/tests.html
- https://internals.rust-lang.org/t/check-only-clippy-fmt-for-ci-cd/24197
- https://vitest.dev/config/browser/playwright / https://vitest.dev/blog/vitest-4 / https://vitest.dev/guide/learn/writing-tests-with-ai / https://github.com/vitest-dev/vitest/blob/main/AGENTS.md
- https://waggertron.github.io/tech-learning/posts/2026-07-07-react-vitest-testing-library-playwright
- https://www.endurancesoftwares.com/blog/react-testing-vitest-testing-library-playwright-2026
- https://v2.tauri.app/develop/tests/ / https://v2.tauri.app/develop/tests/mocking/ / https://v2.tauri.app/reference/javascript/api/namespacemocks / https://github.com/tauri-apps/tauri/blob/dev/packages/api/src/mocks.ts
- https://v2.tauri.app/develop/tests/webdriver/ (+ manual-setup, example/selenium, CI docs)

Security / controls:
- https://www.nsa.gov/Portals/75/documents/Cybersecurity/CSI_MCP_SECURITY.pdf
- https://techcommunity.microsoft.com/blog/microsoft-security-blog/the-state-of-mcp-security-in-2026/4531327
- https://www.redhat.com/en/blog/mcp-security-current-situation / https://www.redhat.com/en/blog/model-context-protocol-mcp-understanding-security-risks-and-controls / https://www.redhat.com/en/blog/mcp-security-logging-and-runtime-security-measures
- https://www.ietf.org/archive/id/draft-mohiuddin-mcp-security-considerations-00.html

Local evidence: `package.json`, `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`, `src/store.tsx`, `src/tauri.ts`, `src/tabs/Create.tsx`, `src/mocks/data.ts`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/src/error.rs`, `src-tauri/src/{db,servers,java,installer,modpacks}/**`, `docs/architecture/overview.md`, `docs/specs/*`, `docs/implementation/backend-plan.md`, `docs/architecture/adr/0002–0006`.
