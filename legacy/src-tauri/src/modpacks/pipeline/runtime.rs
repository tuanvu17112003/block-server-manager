use std::time::{Duration, Instant};

use serde::Serialize;

const MAX_DIAGNOSTICS: usize = 32;
const MAX_EXCERPT_BYTES: usize = 512;
const MAX_MOD_ID_BYTES: usize = 96;
pub(crate) const READINESS_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReadinessState {
    Starting,
    AwaitingEula,
    Ready,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DiagnosticKind {
    MissingDependency,
    CorruptJar,
    ClientOnlyLeakage,
    JavaVersionMismatch,
    MixinConflict,
    InvalidLaunch,
    MissingLibrary,
    EvidenceIncomplete,
    EulaPending,
    ReadinessTimeout,
    StartupExited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartupDiagnostic {
    pub kind: DiagnosticKind,
    pub message: String,
    pub excerpt: String,
    pub mod_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadinessSnapshot {
    pub state: ReadinessState,
    pub loader_initialized: bool,
    pub minecraft_done: bool,
    pub elapsed_seconds: u64,
    pub diagnostics: Vec<StartupDiagnostic>,
}

pub(crate) struct ReadinessTracker {
    loader: String,
    started_at: Instant,
    timeout: Duration,
    loader_initialized: bool,
    minecraft_done: bool,
    state: ReadinessState,
    diagnostics: Vec<StartupDiagnostic>,
}

impl ReadinessTracker {
    pub(crate) fn new(loader: impl Into<String>) -> Self {
        Self::with_timeout(loader, READINESS_TIMEOUT)
    }

    fn with_timeout(loader: impl Into<String>, timeout: Duration) -> Self {
        Self {
            loader: loader.into(),
            started_at: Instant::now(),
            timeout,
            loader_initialized: false,
            minecraft_done: false,
            state: ReadinessState::Starting,
            diagnostics: Vec::new(),
        }
    }

    pub(crate) fn snapshot(&self) -> ReadinessSnapshot {
        ReadinessSnapshot {
            state: self.state,
            loader_initialized: self.loader_initialized,
            minecraft_done: self.minecraft_done,
            elapsed_seconds: self.started_at.elapsed().as_secs(),
            diagnostics: self.diagnostics.clone(),
        }
    }

    pub(crate) fn mark_eula_pending(&mut self, excerpt: &str) -> ReadinessSnapshot {
        self.state = ReadinessState::AwaitingEula;
        self.push_diagnostic(
            DiagnosticKind::EulaPending,
            "Minecraft requires explicit EULA acceptance before startup can continue.",
            excerpt,
            Vec::new(),
        );
        self.snapshot()
    }

    pub(crate) fn mark_prelaunch_failure(
        &mut self,
        kind: DiagnosticKind,
        message: &str,
    ) -> ReadinessSnapshot {
        self.state = ReadinessState::Failed;
        self.push_diagnostic(kind, message, message, Vec::new());
        self.snapshot()
    }

    /// Incorporate one already bounded stdout/stderr line. Returns a snapshot
    /// only when readiness or diagnostic state changed.
    pub(crate) fn observe_line(&mut self, line: &str) -> Option<ReadinessSnapshot> {
        let previous_state = self.state;
        let previous_loader = self.loader_initialized;
        let previous_done = self.minecraft_done;
        let previous_diagnostics = self.diagnostics.len();
        let lower = line.to_ascii_lowercase();

        for diagnostic in classify_diagnostics(line, &lower) {
            self.push_diagnostic(
                diagnostic.kind,
                &diagnostic.message,
                line,
                diagnostic.mod_ids,
            );
        }

        if is_eula_prompt(&lower) {
            self.state = ReadinessState::AwaitingEula;
            self.push_diagnostic(
                DiagnosticKind::EulaPending,
                "Minecraft is waiting for explicit EULA acceptance.",
                line,
                Vec::new(),
            );
        } else {
            self.loader_initialized |= loader_initialization_seen(&self.loader, &lower);
            self.minecraft_done |= is_minecraft_done(&lower);
            if self.loader_initialized
                && self.minecraft_done
                && !matches!(
                    self.state,
                    ReadinessState::AwaitingEula | ReadinessState::Failed | ReadinessState::Stopped
                )
            {
                self.state = ReadinessState::Ready;
            }
        }

        (previous_state != self.state
            || previous_loader != self.loader_initialized
            || previous_done != self.minecraft_done
            || previous_diagnostics != self.diagnostics.len())
        .then(|| self.snapshot())
    }

    /// Add matches from a bounded historical log excerpt without touching
    /// loader initialization, the Done marker, or the readiness state.
    pub(crate) fn observe_diagnostic_line(&mut self, line: &str, source: &str) -> bool {
        let previous_len = self.diagnostics.len();
        let lower = line.to_ascii_lowercase();
        for diagnostic in classify_diagnostics(line, &lower) {
            self.push_classified_diagnostic(diagnostic, Some(source));
        }
        self.diagnostics.len() != previous_len
    }

    /// Record a bounded notice about missing historical evidence without
    /// changing readiness state or any loader initialization markers.
    pub(crate) fn record_evidence_warning(&mut self, source: &str, message: &str) -> bool {
        let previous_len = self.diagnostics.len();
        self.push_diagnostic_record(StartupDiagnostic {
            kind: DiagnosticKind::EvidenceIncomplete,
            message: truncate_utf8(message, MAX_EXCERPT_BYTES),
            excerpt: bounded_excerpt(message),
            mod_ids: Vec::new(),
            source: Some(truncate_utf8(source, 256)),
        });
        self.diagnostics.len() != previous_len
    }

    pub(crate) fn poll_timeout(&mut self) -> Option<ReadinessSnapshot> {
        if self.state != ReadinessState::Starting || self.started_at.elapsed() < self.timeout {
            return None;
        }
        self.state = ReadinessState::Failed;
        self.push_diagnostic(
            DiagnosticKind::ReadinessTimeout,
            "The server did not complete loader initialization and Minecraft startup in time.",
            "",
            Vec::new(),
        );
        Some(self.snapshot())
    }

    pub(crate) fn finish(
        &mut self,
        user_stopped: bool,
        success: bool,
    ) -> Option<ReadinessSnapshot> {
        if self.state == ReadinessState::AwaitingEula {
            return None;
        }
        let previous = self.state;
        if user_stopped || (success && self.state == ReadinessState::Ready) {
            self.state = ReadinessState::Stopped;
        } else if !success || self.state != ReadinessState::Ready {
            self.state = ReadinessState::Failed;
            self.push_diagnostic(
                DiagnosticKind::StartupExited,
                "The server process exited before readiness was confirmed.",
                "",
                Vec::new(),
            );
        }
        (previous != self.state).then(|| self.snapshot())
    }

    fn push_diagnostic(
        &mut self,
        kind: DiagnosticKind,
        message: &str,
        excerpt: &str,
        mod_ids: Vec<String>,
    ) {
        let mut ids = mod_ids.into_iter().take(2).collect::<Vec<_>>();
        for id in &mut ids {
            *id = truncate_utf8(id, MAX_MOD_ID_BYTES);
        }
        let message = if kind == DiagnosticKind::MixinConflict && !ids.is_empty() {
            format!("Mixin conflict involving {}", ids.join(" and "))
        } else {
            truncate_utf8(message, MAX_EXCERPT_BYTES)
        };
        let diagnostic = StartupDiagnostic {
            kind,
            message,
            excerpt: bounded_excerpt(excerpt),
            mod_ids: ids,
            source: None,
        };
        self.push_diagnostic_record(diagnostic);
    }

    fn push_classified_diagnostic(
        &mut self,
        mut diagnostic: StartupDiagnostic,
        source: Option<&str>,
    ) {
        if diagnostic.kind == DiagnosticKind::MixinConflict && !diagnostic.mod_ids.is_empty() {
            diagnostic.message = format!(
                "Mixin conflict involving {}",
                diagnostic.mod_ids.join(" and ")
            );
        }
        diagnostic.source = source.map(|value| truncate_utf8(value, 256));
        self.push_diagnostic_record(diagnostic);
    }

    fn push_diagnostic_record(&mut self, diagnostic: StartupDiagnostic) {
        if self.diagnostics.iter().any(|existing| {
            existing.kind == diagnostic.kind
                && existing.mod_ids == diagnostic.mod_ids
                && existing.source == diagnostic.source
        }) {
            return;
        }
        if self.diagnostics.len() == MAX_DIAGNOSTICS {
            self.diagnostics.remove(0);
        }
        self.diagnostics.push(diagnostic);
    }
}

fn classify_diagnostics(line: &str, lower: &str) -> Vec<StartupDiagnostic> {
    let mut found = Vec::new();
    let mut add = |kind, message: &str, mod_ids| {
        found.push(StartupDiagnostic {
            kind,
            message: message.into(),
            excerpt: bounded_excerpt(line),
            mod_ids,
            source: None,
        });
    };

    if (lower.contains("missing") && lower.contains("dependenc"))
        || (lower.contains("depends on")
            && (lower.contains("missing") || lower.contains("not installed")))
        || lower.contains("missing or unsupported mandatory dependencies")
        || lower.contains("incompatible mods found")
        || (lower.contains("requires") && lower.contains("which is missing"))
    {
        add(
            DiagnosticKind::MissingDependency,
            "The loader reports incompatible mods or a missing required dependency.",
            Vec::new(),
        );
    }
    if lower.contains("invalid or corrupt jarfile")
        || lower.contains("zip end header")
        || lower.contains("zipexception")
        || lower.contains("zip file is empty")
    {
        add(
            DiagnosticKind::CorruptJar,
            "A server or library JAR could not be read as a valid ZIP archive.",
            Vec::new(),
        );
    }
    if (lower.contains("invalid dist") && lower.contains("dedicated_server"))
        || lower.contains("client-only mod")
        || lower.contains("client only class")
        || lower.contains("environment type client")
    {
        add(
            DiagnosticKind::ClientOnlyLeakage,
            "A client-only class or mod was loaded by the dedicated server.",
            Vec::new(),
        );
    }
    if lower.contains("unsupportedclassversionerror")
        || lower.contains("has been compiled by a more recent version")
        || lower.contains("class file version")
    {
        add(
            DiagnosticKind::JavaVersionMismatch,
            "The selected Java runtime is incompatible with a class required by this server.",
            Vec::new(),
        );
    }
    if lower.contains("mixin")
        && (lower.contains("conflict")
            || lower.contains("failed to apply")
            || lower.contains("apply failed"))
    {
        let ids = extract_mixin_mod_ids(lower);
        let message = if ids.len() >= 2 {
            "Two mods reported a Mixin conflict."
        } else {
            "A Mixin failed to apply; the conflicting mod may need inspection."
        };
        add(DiagnosticKind::MixinConflict, message, ids);
    }
    if lower.contains("could not open argument file")
        || lower.contains("unrecognized option")
        || lower.contains("could not find or load main class")
        || lower.contains("invalid java argument")
    {
        add(
            DiagnosticKind::InvalidLaunch,
            "Java rejected the generated launch arguments or a referenced argument file.",
            Vec::new(),
        );
    }
    if lower.contains("classnotfoundexception") || lower.contains("noclassdeffounderror") {
        add(
            DiagnosticKind::MissingLibrary,
            "Java could not load a required class; a server or library JAR may be missing.",
            Vec::new(),
        );
    }
    found
}

fn extract_mixin_mod_ids(lower: &str) -> Vec<String> {
    let markers = [
        "from mod ",
        "conflicting mod ",
        "conflicts with mod ",
        "between mods ",
        "modid: ",
    ];
    let mut ids = Vec::new();
    for marker in markers {
        let mut remaining = lower;
        while let Some(index) = remaining.find(marker) {
            remaining = &remaining[index + marker.len()..];
            let token = remaining
                .trim_start_matches(|character: char| !character.is_ascii_alphanumeric())
                .split(|character: char| {
                    !(character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
                })
                .next()
                .unwrap_or_default()
                .trim_matches('.');
            if !token.is_empty() && !ids.iter().any(|id: &String| id == token) {
                ids.push(token.to_string());
                if ids.len() == 2 {
                    return ids;
                }
            }
        }
    }
    if ids.len() < 2 {
        if let Some((_, remainder)) = lower.split_once("between mods ") {
            for token in remainder
                .split(|character: char| {
                    !(character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
                })
                .filter(|token| !token.is_empty())
            {
                if matches!(token, "and" | "or") {
                    continue;
                }
                if !ids.iter().any(|id| id == token) {
                    ids.push(token.to_string());
                    if ids.len() == 2 {
                        break;
                    }
                }
            }
        }
    }
    ids
}

fn is_eula_prompt(lower: &str) -> bool {
    (lower.contains("agree to the eula") || lower.contains("accept the eula"))
        || (lower.contains("eula.txt") && lower.contains("true"))
}

fn loader_initialization_seen(loader: &str, lower: &str) -> bool {
    match loader.to_ascii_lowercase().as_str() {
        "fabric" => {
            (lower.contains("loading minecraft") && lower.contains("fabric loader"))
                || lower.contains("fabric loader initialized")
        }
        "forge" => {
            lower.contains("forge mod loading")
                || (lower.contains("forge") && lower.contains("loading mods"))
                || (lower.contains("modlauncher") && lower.contains("forge"))
        }
        "neoforge" => {
            lower.contains("neoforge mod loading")
                || (lower.contains("neoforge") && lower.contains("loading mods"))
                || (lower.contains("modlauncher") && lower.contains("neoforge"))
        }
        "quilt" => {
            (lower.contains("loading minecraft") && lower.contains("quilt loader"))
                || lower.contains("quilt loader initialized")
        }
        _ => {
            lower.contains("starting minecraft server version")
                || lower.contains("starting minecraft server on")
        }
    }
}

fn is_minecraft_done(lower: &str) -> bool {
    lower.contains("done (") && lower.contains(")!")
}

fn bounded_excerpt(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    truncate_utf8(&sanitized, MAX_EXCERPT_BYTES)
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_loader_initialization_and_minecraft_done() {
        let mut tracker = ReadinessTracker::new("Fabric");
        tracker.observe_line("[main/INFO]: Done (3.21s)! For help, type \"help\"");
        assert_eq!(tracker.snapshot().state, ReadinessState::Starting);
        tracker.observe_line("[main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11");
        assert_eq!(tracker.snapshot().state, ReadinessState::Ready);

        let mut forge = ReadinessTracker::new("Forge");
        forge.observe_line("Forge mod loading, version 47.2.0");
        assert_eq!(forge.snapshot().state, ReadinessState::Starting);
        forge.observe_line("Done (4.08s)! For help, type \"help\"");
        assert_eq!(forge.snapshot().state, ReadinessState::Ready);
    }

    #[test]
    fn eula_prompt_is_awaiting_eula_and_is_never_marked_ready() {
        let mut tracker = ReadinessTracker::new("Vanilla");
        let snapshot = tracker
            .observe_line("You need to agree to the EULA in order to run the server.")
            .unwrap();
        assert_eq!(snapshot.state, ReadinessState::AwaitingEula);
        tracker.observe_line("Starting Minecraft server version 1.20.1");
        tracker.observe_line("Done (1.0s)! For help");
        assert_eq!(tracker.snapshot().state, ReadinessState::AwaitingEula);
        assert_eq!(
            tracker.snapshot().diagnostics[0].kind,
            DiagnosticKind::EulaPending
        );
    }

    #[test]
    fn startup_diagnostics_are_bounded_and_name_mixin_mods_when_available() {
        let mut tracker = ReadinessTracker::new("Fabric");
        tracker.observe_line("Missing mandatory dependency example_dep");
        tracker.observe_line(
            "Mixin conflict between mods alpha_mod and beta_mod while applying mixin config",
        );
        tracker.observe_line("java.lang.UnsupportedClassVersionError: class file version 65.0");
        tracker.observe_line("java.util.zip.ZipException: zip END header not found");
        tracker.observe_line(
            "Attempted to load class net/minecraft/client/Minecraft for invalid dist DEDICATED_SERVER",
        );
        tracker.observe_line("Could not open argument file: win_args.txt");
        let snapshot = tracker.snapshot();
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|item| item.kind == DiagnosticKind::MissingDependency));
        let mixin = snapshot
            .diagnostics
            .iter()
            .find(|item| item.kind == DiagnosticKind::MixinConflict)
            .unwrap();
        assert_eq!(mixin.mod_ids, vec!["alpha_mod", "beta_mod"]);
        assert!(mixin.message.contains("alpha_mod") && mixin.message.contains("beta_mod"));
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|item| item.kind == DiagnosticKind::JavaVersionMismatch));
        for expected in [
            DiagnosticKind::CorruptJar,
            DiagnosticKind::ClientOnlyLeakage,
            DiagnosticKind::InvalidLaunch,
        ] {
            assert!(snapshot
                .diagnostics
                .iter()
                .any(|item| item.kind == expected));
        }
        assert!(tracker.observe_line(&"x".repeat(4096)).is_none());
        assert!(tracker.snapshot().diagnostics.len() <= MAX_DIAGNOSTICS);
        assert!(tracker
            .snapshot()
            .diagnostics
            .iter()
            .all(|item| item.excerpt.len() <= MAX_EXCERPT_BYTES));
    }

    #[test]
    fn fabric_dependency_and_missing_class_signatures_are_classified() {
        let mut incompatible = ReadinessTracker::new("Fabric");
        incompatible.observe_line("Incompatible mods found!");
        assert!(incompatible
            .snapshot()
            .diagnostics
            .iter()
            .any(|item| item.kind == DiagnosticKind::MissingDependency));

        let mut required_mod = ReadinessTracker::new("Fabric");
        required_mod.observe_line(
            "Mod 'samplemod' requires version 2 of mod 'helperlib', which is missing.",
        );
        let dependency_snapshot = required_mod.snapshot();
        let dependency = dependency_snapshot
            .diagnostics
            .iter()
            .find(|item| item.kind == DiagnosticKind::MissingDependency)
            .unwrap();
        assert!(dependency.excerpt.contains("which is missing"));

        for signature in [
            "java.lang.ClassNotFoundException: com.example.RequiredClass",
            "java.lang.NoClassDefFoundError: com/example/LibraryClass",
        ] {
            let mut missing_class = ReadinessTracker::new("Fabric");
            missing_class.observe_line(signature);
            assert!(missing_class
                .snapshot()
                .diagnostics
                .iter()
                .any(|item| item.kind == DiagnosticKind::MissingLibrary));
        }

        assert!(required_mod
            .snapshot()
            .diagnostics
            .iter()
            .all(|item| item.message.len() <= MAX_EXCERPT_BYTES));
    }

    #[test]
    fn historical_diagnostics_do_not_advance_readiness_and_keep_source() {
        let mut tracker = ReadinessTracker::new("Fabric");
        assert!(!tracker.observe_diagnostic_line(
            "Loading Minecraft 1.20.1 with Fabric Loader 0.15.11",
            "logs/latest.log"
        ));
        assert!(!tracker.observe_diagnostic_line("Done (2.0s)! For help", "logs/latest.log"));
        assert!(tracker.observe_diagnostic_line(
            "Incompatible mods found!",
            "crash-reports/crash-fixture.txt"
        ));

        let snapshot = tracker.snapshot();
        assert_eq!(snapshot.state, ReadinessState::Starting);
        assert!(!snapshot.loader_initialized);
        assert!(!snapshot.minecraft_done);
        let diagnostic = snapshot.diagnostics.first().unwrap();
        assert_eq!(
            diagnostic.source.as_deref(),
            Some("crash-reports/crash-fixture.txt")
        );
    }

    #[test]
    fn readiness_timeout_fails_once_and_prelaunch_errors_are_audit_only() {
        let mut tracker = ReadinessTracker::with_timeout("NeoForge", Duration::ZERO);
        assert_eq!(
            tracker.poll_timeout().unwrap().state,
            ReadinessState::Failed
        );
        assert!(tracker.poll_timeout().is_none());
        let snapshot = tracker.mark_prelaunch_failure(
            DiagnosticKind::InvalidLaunch,
            "invalid generated library argument path",
        );
        assert_eq!(snapshot.state, ReadinessState::Failed);
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|item| item.kind == DiagnosticKind::InvalidLaunch));
    }
}
