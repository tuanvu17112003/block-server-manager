//! Phase 2 — live `java` process manager (backend-plan §Phase 2).
//!
//! - `start_live_server` refuses while `eula.txt` is not `true` (EULA is NEVER
//!   auto-accepted — enforced here independent of the UI gate) and re-checks
//!   the game port is free at spawn time (it may have been taken since create).
//! - Resolves provider launch files, then spawns the selected Java directly
//!   with the server identity marker in the per-server directory. The Java PID
//!   is recorded in memory (ProcessState) and server.lock.
//! - stdout/stderr lines → `server://log/{id}`; lifecycle → `server://status/{id}`
//!   with `starting → running`, graceful `stopping → stopped`, `crashed`.
//! - `stop_live_server` = stdin `stop` + grace period, then force-kill the
//!   process tree on Windows (with direct-child fallback); `kill_live_server`
//!   terminates immediately. Exits the user did not request (nonzero code)
//!   are reported as `crashed`, never silently as `stopped`.
//! - Stale `server.lock` PIDs are killed on startup (orphans); all live
//!   processes are stopped in `on_before_exit` (lib.rs `stop_all_blocking`).
//!
//! Binding rules: RCON binds `127.0.0.1` only (detached RCON deferred by ADR-0011).
//! No secrets are logged (no command lines with credentials, no passwords).
//! std-only implementation (no new crates): log pumps + the exit poller are
//! plain OS threads; commands return fast and completion arrives via events.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, Manager};

use super::{console, get_server};
use crate::db::DbState;
use crate::error::AppError;
use crate::modpacks::pipeline::{
    launch::{self, RuntimeLaunchMode},
    runtime::{DiagnosticKind, ReadinessSnapshot, ReadinessTracker},
};
use crate::util::{events, paths, ports};

/// Grace period for `stop`/`restart` before falling back to kill.
const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(15);
/// Total budget for stop-all while the window is closing.
const EXIT_STOP_BUDGET: Duration = Duration::from_secs(3);
/// A freshly spawned (`starting`) child that survives this long counts as `running`.
const STARTING_GRACE: Duration = Duration::from_secs(1);
/// Cap for a single log line forwarded to the UI (log backpressure: truncate).
const MAX_LOG_LINE: usize = 4096;
const MAX_FAILURE_EVIDENCE_BYTES: usize = 1024 * 1024;
const MAX_LATEST_LOG_TAIL_BYTES: usize = 512 * 1024;
const MAX_CRASH_REPORT_BYTES: usize = 256 * 1024;
const MAX_CRASH_REPORTS: usize = 2;
const MAX_CRASH_REPORT_SCAN_ENTRIES: usize = 128;

/// One live `java` child. stdout/stderr were handed to the log-pump threads;
/// stdin is kept for `server_stop` (`stop`) and `server_send_command`.
pub struct LiveProcess {
    pub pid: u32,
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    /// Set by stop/kill/restart so the exit poller reports `stopped`, not `crashed`.
    pub stopping: bool,
    pub started_at: Instant,
    pub running_reported: bool,
}

pub type LiveHandle = Arc<Mutex<LiveProcess>>;

/// Managed Tauri state: live children by server id.
pub struct ProcessState(
    pub Mutex<HashMap<String, LiveHandle>>,
    Mutex<HashSet<String>>,
);

impl ProcessState {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()), Mutex::new(HashSet::new()))
    }
}

impl Default for ProcessState {
    fn default() -> Self {
        Self::new()
    }
}

fn emit_status(app: &AppHandle, id: &str, status: &str) {
    let _ = app.emit(
        &events::server_status_event(id),
        serde_json::json!({ "status": status }),
    );
}

fn emit_log(app: &AppHandle, id: &str, line: &str) {
    let _ = app.emit(&events::server_log_event(id), line.to_string());
}

fn emit_readiness(app: &AppHandle, id: &str, snapshot: &ReadinessSnapshot) {
    let _ = app.emit(&format!("server://readiness/{id}"), snapshot);
}

fn emit_prelaunch_failure(
    app: &AppHandle,
    id: &str,
    loader: &str,
    kind: DiagnosticKind,
    message: &str,
) {
    let mut tracker = ReadinessTracker::new(loader.to_string());
    let snapshot = tracker.mark_prelaunch_failure(kind, message);
    emit_readiness(app, id, &snapshot);
}

/// Best-effort DB status write (status events are the source of truth for the UI).
fn set_db_status(app: &AppHandle, id: &str, status: &str) {
    let state = app.state::<DbState>();
    if let Ok(conn) = state.0.lock() {
        let _ = conn.execute(
            "UPDATE servers SET status = ?1 WHERE id = ?2",
            rusqlite::params![status, id],
        );
    };
}

fn set_status(app: &AppHandle, id: &str, status: &str) {
    set_db_status(app, id, status);
    emit_status(app, id, status);
}

fn live_handle(app: &AppHandle, id: &str) -> Result<LiveHandle, AppError> {
    let state = app.state::<ProcessState>();
    let map = state.0.lock()?;
    map.get(id)
        .cloned()
        .ok_or_else(|| AppError::NotFound("server is not running".to_string()))
}

fn is_live(app: &AppHandle, id: &str) -> bool {
    live_handle(app, id).is_ok()
}

/// Keep a same-server start reserved from the initial live check through
/// successful registration. This prevents two callers from spawning before
/// either PID reaches the live-process map.
struct StartReservation<'a> {
    reservations: &'a Mutex<HashSet<String>>,
    id: String,
}

impl Drop for StartReservation<'_> {
    fn drop(&mut self) {
        match self.reservations.lock() {
            Ok(mut reservations) => {
                reservations.remove(&self.id);
            }
            Err(_) => {
                tracing::error!(server = %self.id, "process start reservation lock poisoned while releasing")
            }
        }
    }
}

fn reserve_start<'a>(state: &'a ProcessState, id: &str) -> Result<StartReservation<'a>, AppError> {
    let mut reservations = state
        .1
        .lock()
        .map_err(|_| AppError::Internal("process start reservation lock poisoned".to_string()))?;
    if reservations.contains(id) {
        return Err(AppError::Conflict(
            "server start is already in progress".to_string(),
        ));
    }
    let processes = state
        .0
        .lock()
        .map_err(|_| AppError::Internal("process registry lock poisoned".to_string()))?;
    if processes.contains_key(id) {
        return Err(AppError::Conflict("server is already running".to_string()));
    }
    drop(processes);
    reservations.insert(id.to_string());
    drop(reservations);
    Ok(StartReservation {
        reservations: &state.1,
        id: id.to_string(),
    })
}

/// Run a short server-record update only while the server is fully stopped.
/// The reservation lock stays held through the update so a start cannot race
/// between the state check and the database write.
pub fn with_server_stopped<T>(
    app: &AppHandle,
    id: &str,
    update: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    paths::validate_id(id)?;
    let state = app.state::<ProcessState>();
    let reservations = state
        .1
        .lock()
        .map_err(|_| AppError::Internal("process start reservation lock poisoned".to_string()))?;
    if reservations.contains(id) {
        return Err(AppError::Conflict(
            "Java cannot be changed while the server is starting".to_string(),
        ));
    }
    let processes = state
        .0
        .lock()
        .map_err(|_| AppError::Internal("process registry lock poisoned".to_string()))?;
    if processes.contains_key(id) {
        return Err(AppError::Conflict(
            "stop the server before changing its Java runtime".to_string(),
        ));
    }
    drop(processes);
    update()
}

/// True only when `eula.txt` explicitly opts in (last `eula=` wins;
/// comments/`#` lines ignored). Missing/unreadable file counts as refused.
fn eula_txt_accepted(app_data: &Path, id: &str) -> bool {
    let Ok(dir) = paths::server_dir(app_data, id) else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(dir.join("eula.txt")) else {
        return false;
    };
    let mut accepted = false;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = t.split_once('=') {
            if k.trim().eq_ignore_ascii_case("eula") {
                accepted = v.trim().eq_ignore_ascii_case("true");
            }
        }
    }
    accepted
}

/// Direct JAR or generated Java argument files for a validated server install.
pub(crate) enum LaunchMode {
    Jar {
        file_name: String,
    },
    ArgumentFiles {
        user_jvm_args: String,
        loader_args: String,
    },
}

/// Resolve a provider-specific launch mode from installed files. Generated
/// batch files are parsed only to validate their expected argument file.
pub(crate) fn resolve_launch_mode(
    server_dir: &Path,
    loader: &str,
    mc_version: &str,
    loader_version: Option<&str>,
) -> Result<LaunchMode, AppError> {
    match loader {
        "Vanilla" | "Paper" | "Fabric" => {
            require_nonempty_file(&server_dir.join("server.jar"), "server.jar")?;
            Ok(LaunchMode::Jar {
                file_name: "server.jar".to_string(),
            })
        }
        "Quilt" => {
            require_nonempty_file(
                &server_dir.join("quilt-server-launch.jar"),
                "quilt-server-launch.jar",
            )?;
            require_nonempty_file(&server_dir.join("server.jar"), "server.jar")?;
            require_real_directory(&server_dir.join("server"), "server")?;
            require_nonempty_file(
                &server_dir.join("server").join("server.jar"),
                "server/server.jar",
            )?;
            Ok(LaunchMode::Jar {
                file_name: "server.jar".to_string(),
            })
        }
        "Forge" if mc_version == "1.12.2" => {
            let versioned = forge_build_version(mc_version, loader_version)?;
            let universal = format!("forge-{versioned}-universal.jar");
            let server_jar = format!("minecraft_server.{mc_version}.jar");
            require_nonempty_file(&server_dir.join(&universal), &universal)?;
            require_nonempty_file(&server_dir.join(&server_jar), &server_jar)?;
            Ok(LaunchMode::Jar {
                file_name: universal,
            })
        }
        "Forge" => {
            let versioned = forge_build_version(mc_version, loader_version)?;
            let required = format!("libraries/net/minecraftforge/forge/{versioned}/win_args.txt");
            modern_loader_launch_mode(server_dir, &required, "Forge")
        }
        "NeoForge" => {
            let version = loader_version
                .filter(|version| safe_version_segment(version))
                .ok_or_else(|| AppError::Validation("invalid NeoForge server version".into()))?;
            let prefix = match mc_version {
                "1.20.1" => "47.",
                "1.20.4" => "20.4.",
                "1.20.6" => "20.6.",
                "1.21" => "21.0.",
                _ => {
                    return Err(AppError::Validation(format!(
                        "NeoForge has no supported version mapping for Minecraft {mc_version}"
                    )));
                }
            };
            if !version.starts_with(prefix) {
                return Err(AppError::Validation(format!(
                    "NeoForge {version} does not map to Minecraft {mc_version}"
                )));
            }
            let required = format!("libraries/net/neoforged/neoforge/{version}/win_args.txt");
            modern_loader_launch_mode(server_dir, &required, "NeoForge")
        }
        _ => Err(AppError::Validation(format!(
            "no supported launch mode is available for {loader} on Minecraft {mc_version}"
        ))),
    }
}

fn modern_loader_launch_mode(
    server_dir: &Path,
    required_loader_args: &str,
    loader_name: &str,
) -> Result<LaunchMode, AppError> {
    require_regular_file(&server_dir.join("user_jvm_args.txt"), "user_jvm_args.txt")?;
    let relative = extract_generated_arg_file(server_dir, required_loader_args, loader_name)?;
    require_nonempty_file(&server_dir.join(&relative), &relative)?;
    Ok(LaunchMode::ArgumentFiles {
        user_jvm_args: "user_jvm_args.txt".to_string(),
        loader_args: relative,
    })
}

fn extract_generated_arg_file(
    server_dir: &Path,
    expected_path: &str,
    loader_name: &str,
) -> Result<String, AppError> {
    let run_script = server_dir.join("run.bat");
    require_regular_file(&run_script, "run.bat")?;
    if std::fs::metadata(&run_script)?.len() > 256 * 1024 {
        return Err(AppError::Validation(format!(
            "{loader_name} run.bat exceeds the supported size"
        )));
    }
    let script = std::fs::read_to_string(run_script)
        .map_err(|_| AppError::Validation(format!("{loader_name} run.bat is not valid UTF-8")))?;
    expected_generated_arg_file(&script, expected_path, loader_name)
}

/// Validate a generated Forge/NeoForge script without executing it. Import
/// inspection uses this same parser before writing a server directory.
pub(crate) fn expected_generated_arg_file(
    script: &str,
    expected_path: &str,
    loader_name: &str,
) -> Result<String, AppError> {
    if script.len() > 256 * 1024 {
        return Err(AppError::Validation(format!(
            "{loader_name} run.bat exceeds the supported size"
        )));
    }
    let expected = expected_path.replace('\\', "/");
    let mut found = HashSet::new();
    for token in
        script.split(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | ';' | '&' | '|'))
    {
        let candidate = token.trim_start_matches('@').replace('\\', "/");
        if candidate.to_ascii_lowercase().starts_with("libraries/")
            && candidate.ends_with("/win_args.txt")
            && candidate.eq_ignore_ascii_case(&expected)
        {
            found.insert(candidate);
        }
    }
    if found.len() != 1 {
        return Err(AppError::Validation(format!(
            "{loader_name} run.bat does not reference the expected version-specific Windows argument file"
        )));
    }
    let relative = found.into_iter().next().expect("one checked argument file");
    if !Path::new(&relative)
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return Err(AppError::Validation(format!(
            "{loader_name} argument file path is not relative to the server folder"
        )));
    }
    Ok(relative)
}

pub(crate) fn forge_build_version(
    mc_version: &str,
    loader_version: Option<&str>,
) -> Result<String, AppError> {
    let (label, build) = loader_version
        .and_then(|value| value.split_once(':'))
        .ok_or_else(|| AppError::Validation("invalid Forge promotion selection".into()))?;
    match label {
        "recommended" | "latest" => {
            if !safe_version_segment(build) {
                return Err(AppError::Validation(
                    "invalid Forge promotion selection".into(),
                ));
            }
            Ok(format!("{mc_version}-{build}"))
        }
        "specific" => {
            let prefix = format!("{mc_version}-");
            if !safe_version_segment(build)
                || !build.starts_with(&prefix)
                || build.len() <= prefix.len()
            {
                return Err(AppError::Validation(
                    "invalid Forge promotion selection".into(),
                ));
            }
            Ok(build.to_string())
        }
        _ => Err(AppError::Validation(
            "invalid Forge promotion selection".into(),
        )),
    }
}

fn safe_version_segment(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 96
        && version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+'))
}

fn require_regular_file(path: &Path, display_name: &str) -> Result<(), AppError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        AppError::Validation(format!(
            "required server launch file {display_name} is missing"
        ))
    })?;
    if !metadata.file_type().is_file() {
        return Err(AppError::Validation(format!(
            "required server launch file {display_name} is not a regular file"
        )));
    }
    Ok(())
}

fn require_nonempty_file(path: &Path, display_name: &str) -> Result<(), AppError> {
    require_regular_file(path, display_name)?;
    if std::fs::metadata(path)?.len() == 0 {
        return Err(AppError::Validation(format!(
            "required server launch file {display_name} is empty"
        )));
    }
    Ok(())
}

fn require_real_directory(path: &Path, display_name: &str) -> Result<(), AppError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        AppError::Validation(format!(
            "required server directory {display_name} is missing"
        ))
    })?;
    if is_link_or_reparse_point(&metadata) || !metadata.file_type().is_dir() {
        return Err(AppError::Validation(format!(
            "required server directory {display_name} is a symlink or reparse point"
        )));
    }
    Ok(())
}

fn is_link_or_reparse_point(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Validate, spawn Java, track its PID, pump logs, and watch for exit.
/// Returns the OS PID. Emits starting now; the exit poller promotes to running
/// after STARTING_GRACE or reports crashed if the child exits immediately.
pub fn start_live_server(app: &AppHandle, id: &str) -> Result<u32, AppError> {
    paths::validate_id(id)?;
    let state = app.state::<ProcessState>();
    let _reservation = reserve_start(&state, id)?;
    let app_data = paths::app_data_dir(app)?;

    // DB row must exist (NotFound otherwise).
    let record = {
        let db = app.state::<DbState>();
        let conn = db.0.lock()?;
        get_server(&conn, id)?
    };

    // EULA: NEVER auto-accepted. Both the DB flag (explicit user act) and the
    // on-disk file (what `java` itself enforces) must agree on `true`.
    if !record.eula_accepted || !eula_txt_accepted(&app_data, id) {
        let mut readiness = ReadinessTracker::new(record.loader.clone());
        emit_readiness(
            app,
            id,
            &readiness.mark_eula_pending(
                "the Minecraft EULA has not been accepted; no process was started",
            ),
        );
        return Err(AppError::Validation(
            "the Minecraft EULA has not been accepted (accept it via the EULA checkbox first)"
                .to_string(),
        ));
    }

    // Re-check the game port is actually free right now — it may have been
    // taken after the server row was created.
    let port: u16 = record
        .port
        .try_into()
        .map_err(|_| AppError::Validation("stored game port is out of range".to_string()))?;
    if !ports::is_tcp_free(port) {
        return Err(AppError::Conflict(format!(
            "port {port} is already in use on this machine"
        )));
    }

    let dir = paths::server_dir(&app_data, id)?;
    let launch_mode = resolve_launch_mode(
        &dir,
        &record.loader,
        &record.mc_version,
        record.loader_version.as_deref(),
    )
    .map_err(|error| {
        emit_prelaunch_failure(
            app,
            id,
            &record.loader,
            DiagnosticKind::InvalidLaunch,
            &error.to_string(),
        );
        error
    })?;

    // Use only a verified selected or detected Java executable. Never fall
    // back to an unvalidated PATH command after an explicit override fails.
    let java = crate::java::resolve_server_java(
        &app_data,
        &record.mc_version,
        record.java_path.as_deref(),
    )
    .map_err(|error| {
        let kind = if error.to_string().to_ascii_lowercase().contains("version") {
            DiagnosticKind::JavaVersionMismatch
        } else {
            DiagnosticKind::InvalidLaunch
        };
        emit_prelaunch_failure(app, id, &record.loader, kind, &error.to_string());
        error
    })?;
    let runtime_mode = match &launch_mode {
        LaunchMode::Jar { file_name } => RuntimeLaunchMode::Jar {
            file_name: file_name.clone(),
        },
        LaunchMode::ArgumentFiles {
            user_jvm_args,
            loader_args,
        } => RuntimeLaunchMode::ArgumentFiles {
            user_jvm_args: user_jvm_args.clone(),
            loader_args: loader_args.clone(),
        },
    };
    let launch_config = launch::build_live_launch_config(
        id,
        &app_data,
        &dir,
        &record.loader,
        &record.mc_version,
        record.loader_version.as_deref(),
        &java.path,
        record.ram_mb,
        &runtime_mode,
    )
    .map_err(|error| {
        emit_prelaunch_failure(
            app,
            id,
            &record.loader,
            DiagnosticKind::InvalidLaunch,
            &error.to_string(),
        );
        error
    })?;

    let mut cmd = Command::new(&launch_config.java_path);
    cmd.current_dir(&launch_config.working_directory);
    for argument in &launch_config.argv {
        cmd.arg(argument);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flash per spawned server.
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        AppError::Io(format!(
            "failed to launch Java ({}): {e}. Change or install Java in Settings.",
            launch_config.java_path
        ))
    })?;
    let pid = child.id();

    // Never report success without durable tracking. A failed write can leave
    // a partial file, so remove it and stop/reap the newly spawned child.
    let lock_path = dir.join("server.lock");
    if let Err(err) = std::fs::write(&lock_path, pid.to_string()) {
        let _ = std::fs::remove_file(&lock_path);
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError::Io(format!(
            "failed to write server PID lockfile: {err}"
        )));
    }

    // Reservation prevents a competing start from reaching this point. Still
    // fail closed if the registry is poisoned or an unexpected entry exists.
    let mut processes = match state.0.lock() {
        Ok(processes) => processes,
        Err(_) => {
            let _ = std::fs::remove_file(&lock_path);
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Internal(
                "process registry lock poisoned".to_string(),
            ));
        }
    };
    if processes.contains_key(id) {
        let _ = std::fs::remove_file(&lock_path);
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError::Conflict("server is already running".to_string()));
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    let handle: LiveHandle = Arc::new(Mutex::new(LiveProcess {
        pid,
        child,
        stdin,
        stopping: false,
        started_at: Instant::now(),
        running_reported: false,
    }));
    processes.insert(id.to_string(), Arc::clone(&handle));
    drop(processes);

    let readiness = Arc::new(Mutex::new(ReadinessTracker::new(record.loader.clone())));
    set_status(app, id, "starting");
    if let Ok(tracker) = readiness.lock() {
        emit_readiness(app, id, &tracker.snapshot());
    }

    if let Some(out) = stdout {
        let a = app.clone();
        let sid = id.to_string();
        let tracker = Arc::clone(&readiness);
        std::thread::spawn(move || pump_stream(a, sid, out, tracker));
    }
    if let Some(err) = stderr {
        let a = app.clone();
        let sid = id.to_string();
        let tracker = Arc::clone(&readiness);
        std::thread::spawn(move || pump_stream(a, sid, err, tracker));
    }
    {
        let a = app.clone();
        let sid = id.to_string();
        let h = Arc::clone(&handle);
        let tracker = Arc::clone(&readiness);
        let diagnostic_root = PathBuf::from(launch_config.working_directory.clone());
        std::thread::spawn(move || watch_exit(a, sid, h, tracker, diagnostic_root));
    }

    tracing::info!(server = %id, pid, port, "server process spawned");
    Ok(pid)
}

#[cfg(test)]
fn heap_size_args(ram_mb: i64) -> (String, String) {
    (format!("-Xmx{ram_mb}M"), format!("-Xms{ram_mb}M"))
}

/// Forward every stdout/stderr line to `server://log/{id}` (truncated on overflow).
fn pump_stream(
    app: AppHandle,
    id: String,
    stream: impl std::io::Read + Send + 'static,
    readiness: Arc<Mutex<ReadinessTracker>>,
) {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    loop {
        match read_log_line(&mut reader, &mut buffer) {
            Ok(Some(line)) => {
                emit_log(&app, &id, &line);
                match readiness.lock() {
                    Ok(mut tracker) => {
                        if let Some(snapshot) = tracker.observe_line(&line) {
                            emit_readiness(&app, &id, &snapshot);
                        }
                    }
                    Err(_) => {
                        tracing::error!(server = %id, "readiness tracker lock poisoned while reading logs")
                    }
                }
            }
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(server = %id, error = %error, "server log stream ended after read error");
                break;
            }
        }
    }
}

fn read_log_line(
    reader: &mut impl BufRead,
    buffer: &mut Vec<u8>,
) -> std::io::Result<Option<String>> {
    if buffer.capacity() > MAX_LOG_LINE {
        *buffer = Vec::with_capacity(MAX_LOG_LINE);
    }
    buffer.clear();
    let mut saw_bytes = false;
    let mut found_newline = false;
    loop {
        let consumed = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                break;
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let content_bytes = newline.unwrap_or(available.len());
            let consume_bytes = newline.map_or(available.len(), |index| index + 1);
            let retain_bytes = content_bytes.min(MAX_LOG_LINE.saturating_sub(buffer.len()));
            buffer.extend_from_slice(&available[..retain_bytes]);
            saw_bytes = true;
            found_newline = newline.is_some();
            consume_bytes
        };
        reader.consume(consumed);
        if found_newline {
            break;
        }
    }

    if !saw_bytes {
        return Ok(None);
    }
    if found_newline && buffer.last() == Some(&b'\r') {
        buffer.pop();
    }

    let mut line = String::from_utf8_lossy(buffer).into_owned();
    if line.len() > MAX_LOG_LINE {
        // `String::truncate` requires a UTF-8 boundary, so walk down when the
        // byte limit lands inside a multi-byte character.
        let mut end = MAX_LOG_LINE.min(line.len());
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        line.truncate(end);
    }
    Ok(Some(line))
}

/// Historical files supplement a startup failure report only. This path is
/// read-only and is deliberately separate from live readiness line handling.
fn collect_failure_evidence(
    app: &AppHandle,
    server_id: &str,
    expected_root: &Path,
    tracker: &mut ReadinessTracker,
) -> Result<usize, String> {
    let app_data = paths::app_data_dir(app).map_err(|error| error.to_string())?;
    validate_no_reparse_components(&app_data)?;
    let canonical_app_data = fs::canonicalize(&app_data).map_err(|error| error.to_string())?;
    let requested_root =
        paths::server_dir(&app_data, server_id).map_err(|error| error.to_string())?;
    validate_no_reparse_components(&requested_root)?;
    let canonical_root = fs::canonicalize(&requested_root).map_err(|error| error.to_string())?;
    let bound_root = canonical_app_data.join("servers").join(server_id);
    if canonical_root != bound_root || expected_root != bound_root {
        return Err("diagnostic server root no longer matches its app-data ID binding".into());
    }
    collect_readonly_failure_evidence(&requested_root, tracker)
}

/// Read a bounded latest.log tail and up to two newest crash reports. The
/// caller supplies a root that has already been bound to the server ID; this
/// helper revalidates every component before opening a file.
fn collect_readonly_failure_evidence(
    server_root: &Path,
    tracker: &mut ReadinessTracker,
) -> Result<usize, String> {
    checked_diagnostic_root(server_root)?;
    let mut total_read = 0usize;

    match open_diagnostic_file(server_root, "logs/latest.log") {
        Ok(Some((mut file, size_bytes, _))) => {
            match read_diagnostic_window(
                &mut file,
                size_bytes,
                MAX_LATEST_LOG_TAIL_BYTES.min(MAX_FAILURE_EVIDENCE_BYTES),
                true,
            ) {
                Ok(bytes) => {
                    total_read = total_read.saturating_add(bytes.len());
                    observe_historical_diagnostic_bytes(tracker, "logs/latest.log", &bytes, true);
                }
                Err(_) => {
                    tracker.record_evidence_warning(
                        "logs/latest.log",
                        "The latest log could not be read after handle verification; historical evidence is incomplete.",
                    );
                }
            }
        }
        Ok(None) => {}
        Err(_) => {
            tracker.record_evidence_warning(
                "logs/latest.log",
                "The latest log handle could not be verified; historical evidence is incomplete.",
            );
        }
    }

    let crash_scan = newest_crash_report_paths(server_root);
    if crash_scan.cap_reached {
        tracker.record_evidence_warning(
            "crash-reports/",
            &format!(
                "Crash-report scan reached its {}-entry limit; evidence is incomplete and newer reports may remain uninspected.",
                MAX_CRASH_REPORT_SCAN_ENTRIES
            ),
        );
    } else if crash_scan.incomplete {
        tracker.record_evidence_warning(
            "crash-reports/",
            "Crash-report scan could not inspect every directory entry; historical evidence is incomplete.",
        );
    }
    for relative_path in crash_scan.paths {
        if total_read >= MAX_FAILURE_EVIDENCE_BYTES {
            break;
        }
        let remaining = MAX_FAILURE_EVIDENCE_BYTES - total_read;
        let limit = MAX_CRASH_REPORT_BYTES.min(remaining);
        let opened = open_selected_crash_report(&relative_path, tracker, || {
            open_diagnostic_file(server_root, &relative_path)
        });
        let Ok(Some((mut file, size_bytes, _))) = opened else {
            continue;
        };
        let bytes = match read_diagnostic_window(&mut file, size_bytes, limit, false) {
            Ok(bytes) => bytes,
            Err(_) => {
                tracker.record_evidence_warning(
                    &relative_path,
                    "A crash report could not be read after handle verification; historical evidence is incomplete.",
                );
                continue;
            }
        };
        total_read = total_read.saturating_add(bytes.len());
        observe_historical_diagnostic_bytes(tracker, &relative_path, &bytes, false);
    }

    Ok(total_read)
}

fn checked_diagnostic_root(path: &Path) -> Result<PathBuf, String> {
    validate_no_reparse_components(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_link_or_reparse_point(&metadata) {
        return Err("diagnostic server root is not a regular directory".into());
    }
    fs::canonicalize(path).map_err(|error| error.to_string())
}

fn validate_no_reparse_components(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("diagnostic path is not absolute".into());
    }
    let components = path.components().collect::<Vec<_>>();
    let mut current = PathBuf::new();
    for (index, component) in components.iter().enumerate() {
        match component {
            std::path::Component::ParentDir => {
                return Err("diagnostic path contains a parent component".into())
            }
            std::path::Component::CurDir => continue,
            _ => current.push(component.as_os_str()),
        }
        if !current.is_absolute() {
            continue;
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if is_link_or_reparse_point(&metadata) {
            return Err("diagnostic path contains a symlink or reparse point".into());
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err("diagnostic path has a non-directory parent".into());
        }
    }
    Ok(())
}

fn checked_diagnostic_path(
    server_root: &Path,
    relative_path: &str,
    directory: bool,
) -> Result<Option<PathBuf>, String> {
    crate::modpacks::pipeline::model::validate_safe_relative_path(relative_path)
        .map_err(|error| error.to_string())?;
    let canonical_root = checked_diagnostic_root(server_root)?;
    let mut current = canonical_root.clone();
    let components = relative_path.split('/').collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if is_link_or_reparse_point(&metadata) {
            return Err("diagnostic file path contains a symlink or reparse point".into());
        }
        let final_component = index + 1 == components.len();
        if (!final_component && !metadata.is_dir())
            || (final_component && directory && !metadata.is_dir())
            || (final_component && !directory && !metadata.file_type().is_file())
        {
            return Err("diagnostic path has an unexpected file type".into());
        }
        let canonical = fs::canonicalize(&current).map_err(|error| error.to_string())?;
        if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
            return Err("diagnostic path escapes the bound server root".into());
        }
        current = canonical;
    }
    Ok(Some(current))
}

fn open_diagnostic_file(
    server_root: &Path,
    relative_path: &str,
) -> Result<Option<(File, u64, SystemTime)>, String> {
    let canonical_root = checked_diagnostic_root(server_root)?;
    let Some(path) = checked_diagnostic_path(server_root, relative_path, false)? else {
        return Ok(None);
    };
    let checked_metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !checked_metadata.file_type().is_file() || is_link_or_reparse_point(&checked_metadata) {
        return Err("diagnostic file is not a regular non-reparse file".into());
    }
    let file = open_verified_diagnostic_handle(&path, &canonical_root, checked_metadata.len())?;
    let opened_metadata = file.metadata().map_err(|error| error.to_string())?;
    let modified = opened_metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
    Ok(Some((file, opened_metadata.len(), modified)))
}

/// The file handle's resolved path is checked before its bytes may be read.
/// Path validation alone is insufficient because a parent directory can be
/// replaced after `checked_diagnostic_path` returns.
fn open_verified_diagnostic_handle(
    path: &Path,
    canonical_root: &Path,
    expected_size: u64,
) -> Result<File, String> {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let mut options = OpenOptions::new();
        options.read(true);
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        options.open(path).map_err(|error| error.to_string())?
    };
    #[cfg(target_os = "linux")]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        const LINUX_O_NONBLOCK: i32 = 0o4000;
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(LINUX_O_NONBLOCK);
        options.open(path).map_err(|error| error.to_string())?
    };
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (path, canonical_root, expected_size);
        return Err("opened-file path verification is unsupported on this platform".into());
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        let opened_metadata = file.metadata().map_err(|error| error.to_string())?;
        if !opened_metadata.file_type().is_file()
            || is_link_or_reparse_point(&opened_metadata)
            || opened_metadata.len() != expected_size
        {
            return Err("opened diagnostic handle is not the expected regular file".into());
        }
        let final_path = final_path_from_diagnostic_handle(&file)?;
        if !final_path.starts_with(canonical_root) || final_path != path {
            return Err(
                "opened diagnostic handle resolves outside its validated server path".into(),
            );
        }
        Ok(file)
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetFinalPathNameByHandleW(
        file: *mut std::ffi::c_void,
        path: *mut u16,
        path_capacity: u32,
        flags: u32,
    ) -> u32;
}

#[cfg(windows)]
fn final_path_from_diagnostic_handle(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::io::AsRawHandle;
    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if length == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let length = length as usize;
        if length < buffer.len() {
            buffer.truncate(length);
            let path = String::from_utf16(&buffer).map_err(|error| {
                format!("invalid Windows path returned for diagnostics: {error}")
            })?;
            return Ok(PathBuf::from(path));
        }
        if length >= 32_768 {
            return Err("opened diagnostic handle path exceeds Windows path limits".into());
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(target_os = "linux")]
fn final_path_from_diagnostic_handle(file: &File) -> Result<PathBuf, String> {
    use std::os::unix::io::AsRawFd;
    let descriptor_path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
    fs::canonicalize(descriptor_path).map_err(|error| error.to_string())
}

#[derive(Debug, Default)]
struct CrashReportScan {
    paths: Vec<String>,
    cap_reached: bool,
    incomplete: bool,
}

fn newest_crash_report_paths(server_root: &Path) -> CrashReportScan {
    newest_crash_report_paths_with_opener(server_root, open_diagnostic_file)
}

fn newest_crash_report_paths_with_opener<F>(server_root: &Path, mut open_file: F) -> CrashReportScan
where
    F: FnMut(&Path, &str) -> Result<Option<(File, u64, SystemTime)>, String>,
{
    let directory = match checked_diagnostic_path(server_root, "crash-reports", true) {
        Ok(Some(directory)) => directory,
        Ok(None) => return CrashReportScan::default(),
        Err(_) => {
            return CrashReportScan {
                incomplete: true,
                ..CrashReportScan::default()
            }
        }
    };
    let mut entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => {
            return CrashReportScan {
                incomplete: true,
                ..CrashReportScan::default()
            }
        }
    };
    let mut candidates = Vec::new();
    let mut incomplete = false;
    let mut scanned = 0usize;
    while scanned < MAX_CRASH_REPORT_SCAN_ENTRIES {
        let Some(entry) = entries.next() else {
            break;
        };
        scanned += 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !Path::new(&file_name)
            .extension()
            .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("txt"))
        {
            continue;
        }
        let relative_path = format!("crash-reports/{file_name}");
        match open_file(server_root, &relative_path) {
            Ok(Some((_, size_bytes, modified))) if size_bytes > 0 => {
                candidates.push((modified, relative_path));
            }
            Ok(Some(_)) => {}
            Ok(None) => incomplete = true,
            Err(_) => incomplete = true,
        }
    }
    let cap_reached = match entries.next() {
        Some(Ok(_)) => true,
        Some(Err(_)) => {
            incomplete = true;
            true
        }
        None => false,
    };
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let paths = candidates
        .into_iter()
        .take(MAX_CRASH_REPORTS)
        .map(|(_, path)| path)
        .collect();
    CrashReportScan {
        paths,
        cap_reached,
        incomplete,
    }
}

fn open_selected_crash_report<F>(
    relative_path: &str,
    tracker: &mut ReadinessTracker,
    open_file: F,
) -> Result<Option<(File, u64, SystemTime)>, String>
where
    F: FnOnce() -> Result<Option<(File, u64, SystemTime)>, String>,
{
    match open_file() {
        Ok(Some(opened)) => Ok(Some(opened)),
        Ok(None) => {
            tracker.record_evidence_warning(
                relative_path,
                "A crash report disappeared after selection; historical evidence is incomplete.",
            );
            Ok(None)
        }
        Err(error) => {
            tracker.record_evidence_warning(
                relative_path,
                "A selected crash report handle could not be verified; historical evidence is incomplete.",
            );
            Err(error)
        }
    }
}

fn read_diagnostic_window(
    file: &mut File,
    file_size: u64,
    maximum_bytes: usize,
    from_end: bool,
) -> std::io::Result<Vec<u8>> {
    let bytes_to_read = file_size.min(maximum_bytes as u64);
    if from_end {
        file.seek(SeekFrom::Start(file_size.saturating_sub(bytes_to_read)))?;
    }
    let mut limited = (&mut *file).take(bytes_to_read);
    let mut bytes = Vec::with_capacity(bytes_to_read as usize);
    limited.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn observe_historical_diagnostic_bytes(
    tracker: &mut ReadinessTracker,
    source: &str,
    bytes: &[u8],
    tail_window: bool,
) {
    let mut start = 0usize;
    if tail_window {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            start = newline + 1;
        }
    }
    for raw_line in bytes[start..].split(|byte| *byte == b'\n') {
        let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if raw_line.len() <= MAX_LOG_LINE {
            let line = String::from_utf8_lossy(raw_line);
            tracker.observe_diagnostic_line(&line, source);
        } else {
            let prefix = String::from_utf8_lossy(&raw_line[..MAX_LOG_LINE]);
            let suffix = String::from_utf8_lossy(&raw_line[raw_line.len() - MAX_LOG_LINE..]);
            tracker.observe_diagnostic_line(&prefix, source);
            tracker.observe_diagnostic_line(&suffix, source);
        }
    }
}

/// Poll the child: promote `starting → running` after the grace period, and
/// finalize (`stopped` vs `crashed`) exactly once when it exits.
fn watch_exit(
    app: AppHandle,
    id: String,
    handle: LiveHandle,
    readiness: Arc<Mutex<ReadinessTracker>>,
    diagnostic_root: PathBuf,
) {
    loop {
        std::thread::sleep(Duration::from_millis(500));
        match readiness.lock() {
            Ok(mut tracker) => {
                if tracker.poll_timeout().is_some() {
                    let _ = collect_failure_evidence(&app, &id, &diagnostic_root, &mut tracker);
                    emit_readiness(&app, &id, &tracker.snapshot());
                }
            }
            Err(_) => {
                tracing::error!(server = %id, "readiness tracker lock poisoned while polling")
            }
        }
        let mut live = match handle.lock() {
            Ok(g) => g,
            Err(_) => break,
        };
        match live.child.try_wait() {
            Ok(Some(status)) => {
                let user_stopped = live.stopping;
                let pid = live.pid;
                drop(live);
                match readiness.lock() {
                    Ok(mut tracker) => {
                        let transition = tracker.finish(user_stopped, status.success());
                        if tracker.snapshot().state
                            == crate::modpacks::pipeline::runtime::ReadinessState::Failed
                        {
                            let _ =
                                collect_failure_evidence(&app, &id, &diagnostic_root, &mut tracker);
                            emit_readiness(&app, &id, &tracker.snapshot());
                        } else if let Some(snapshot) = transition {
                            emit_readiness(&app, &id, &snapshot);
                        }
                    }
                    Err(_) => {
                        tracing::error!(server = %id, "readiness tracker lock poisoned during process exit")
                    }
                }
                finish_exit(&app, &id, &handle, pid, status.success(), user_stopped);
                break;
            }
            Ok(None) => {
                if !live.running_reported && live.started_at.elapsed() >= STARTING_GRACE {
                    live.running_reported = true;
                    drop(live);
                    set_status(&app, &id, "running");
                    tracing::info!(server = %id, "server running");
                }
            }
            Err(_) => {
                // Rare (e.g. transient OS error) — keep polling.
            }
        }
    }
}

/// Single finalizer (idempotent): drop the lockfile + map entry, persist and
/// emit the terminal status. User-requested exits and code 0 → `stopped`;
/// anything else → `crashed` + banner event data (log line + toast on the UI).
fn finish_exit(
    app: &AppHandle,
    id: &str,
    handle: &LiveHandle,
    pid: u32,
    success: bool,
    user_stopped: bool,
) {
    let state = app.state::<ProcessState>();
    // Serialize final status publication with start reservation so an old
    // finalizer cannot publish `stopped` after a newer process has started.
    let _reservations = match state.1.lock() {
        Ok(reservations) => reservations,
        Err(_) => {
            tracing::error!(server = %id, "process start reservation lock poisoned during finalization");
            return;
        }
    };
    let mut map = match state.0.lock() {
        Ok(map) => map,
        Err(_) => {
            tracing::error!(server = %id, "process registry lock poisoned during finalization");
            return;
        }
    };
    if !map
        .get(id)
        .map_or(false, |tracked| Arc::ptr_eq(tracked, handle))
    {
        return;
    }
    if let Ok(app_data) = paths::app_data_dir(app) {
        if let Ok(dir) = paths::server_dir(&app_data, id) {
            remove_pid_lockfile(&dir, pid);
        }
    }
    map.remove(id);
    drop(map);
    let final_status = if user_stopped || success {
        "stopped"
    } else {
        "crashed"
    };
    set_status(app, id, final_status);
    if user_stopped || success {
        tracing::info!(server = %id, status = final_status, "server process exited");
    } else {
        emit_log(
            app,
            id,
            "Launcher: server process exited unexpectedly (crash). Check logs/latest.log for details.",
        );
        tracing::warn!(server = %id, "server process crashed");
    }
}

fn remove_pid_lockfile(server_dir: &Path, pid: u32) {
    let lock_path = server_dir.join("server.lock");
    let is_our_pid = std::fs::read_to_string(&lock_path)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        == Some(pid);
    if is_our_pid {
        let _ = std::fs::remove_file(lock_path);
    }
}

/// Graceful stop: stdin `stop`, `stopping` event now; the exit poller reports
/// `stopped` when the child actually exits. A watchdog kills the child if the
/// grace period expires (including descendants on Windows).
pub fn stop_live_server(app: &AppHandle, id: &str) -> Result<(), AppError> {
    paths::validate_id(id)?;
    let handle = live_handle(app, id)?;
    {
        let mut live = handle
            .lock()
            .map_err(|_| AppError::Internal("process lock poisoned".to_string()))?;
        live.stopping = true;
        if let Some(stdin) = live.stdin.as_mut() {
            let _ = stdin.write_all(b"stop\n");
            let _ = stdin.flush();
        }
    }
    set_status(app, id, "stopping");

    let watchdog_app = app.clone();
    let sid = id.to_string();
    std::thread::spawn(move || {
        let deadline = Instant::now() + GRACEFUL_TIMEOUT;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            // Gone from the map = the exit poller already finalized.
            let gone = watchdog_app
                .state::<ProcessState>()
                .0
                .lock()
                .map(|m| !m.contains_key(&sid))
                .unwrap_or(true);
            if gone {
                break;
            }
            if Instant::now() >= deadline {
                if let Ok(map) = watchdog_app.state::<ProcessState>().0.lock() {
                    if let Some(h) = map.get(&sid) {
                        if let Ok(mut live) = h.lock() {
                            let _ = force_kill_live(&mut live);
                        }
                    }
                }
                break;
            }
        }
    });

    tracing::info!(server = %id, "graceful stop requested");
    Ok(())
}

#[cfg(windows)]
fn taskkill_process_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn force_kill_live(live: &mut LiveProcess) -> Result<(), AppError> {
    #[cfg(windows)]
    if taskkill_process_tree(live.pid) {
        return Ok(());
    }

    live.child
        .kill()
        .map_err(|e| AppError::Io(format!("failed to kill server process: {e}")))
}

/// Immediate termination; Windows includes descendants, with a direct-child fallback.
pub fn kill_live_server(app: &AppHandle, id: &str) -> Result<(), AppError> {
    paths::validate_id(id)?;
    let handle = live_handle(app, id)?;
    {
        let mut live = handle
            .lock()
            .map_err(|_| AppError::Internal("process lock poisoned".to_string()))?;
        live.stopping = true;
        force_kill_live(&mut live)?;
    }
    emit_log(app, id, "Launcher: process force-killed by user.");
    tracing::info!(server = %id, "server process killed by user");
    Ok(())
}

/// Write one console line to the live child's stdin and persist it after flush.
/// Fails with `not-found` when the server is stopped or untracked.
pub fn send_to_live_server(app: &AppHandle, id: &str, cmd: &str) -> Result<(), AppError> {
    paths::validate_id(id)?;
    let line = console::validate_command(cmd)?;
    {
        let handle = live_handle(app, id)?;
        let mut live = handle
            .lock()
            .map_err(|_| AppError::Internal("process lock poisoned".to_string()))?;
        match live.stdin.as_mut() {
            Some(stdin) => {
                stdin.write_all(line.as_bytes())?;
                stdin.write_all(b"\n")?;
                stdin.flush()?;
            }
            None => return Err(AppError::NotFound("server is not running".to_string())),
        }
    }

    let state = app.state::<DbState>();
    let mut conn = state.0.lock()?;
    console::record_command(&mut conn, id, line)
}

/// Stop-then-start. When the server is stopped this is a plain (synchronous)
/// start so validation errors propagate to the caller; otherwise the stop is
/// initiated now and a sequencer thread waits for the exit (the stop watchdog
/// kills on timeout) before starting again. Completion arrives via events.
pub fn restart_live_server(app: &AppHandle, id: &str) -> Result<(), AppError> {
    paths::validate_id(id)?;
    if !is_live(app, id) {
        start_live_server(app, id)?;
        return Ok(());
    }
    stop_live_server(app, id)?;
    let a = app.clone();
    let sid = id.to_string();
    std::thread::spawn(move || {
        let deadline = Instant::now() + GRACEFUL_TIMEOUT + Duration::from_secs(2);
        loop {
            let gone = a
                .state::<ProcessState>()
                .0
                .lock()
                .map(|m| !m.contains_key(&sid))
                .unwrap_or(true);
            if gone || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        std::thread::sleep(Duration::from_millis(500));
        if let Err(e) = start_live_server(&a, &sid) {
            // Another start may have won the race — don't clobber its status.
            let taken_over = a
                .state::<ProcessState>()
                .0
                .lock()
                .map(|m| m.contains_key(&sid))
                .unwrap_or(false);
            if taken_over {
                emit_log(
                    &a,
                    &sid,
                    "Launcher: restart superseded by another start request.",
                );
            } else {
                set_status(&a, &sid, "stopped");
                emit_log(&a, &sid, &format!("Launcher: restart failed: {e}"));
            }
        }
    });
    Ok(())
}

/// Best-effort stop-all for window close: stdin `stop` to everyone, a short
/// shared budget, then kill survivors. No events — the UI is going away.
pub fn stop_all_blocking(app: &AppHandle) {
    let handles: Vec<(String, LiveHandle)> = app
        .state::<ProcessState>()
        .0
        .lock()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), Arc::clone(v))).collect())
        .unwrap_or_default();
    if handles.is_empty() {
        return;
    }
    tracing::info!(count = handles.len(), "stopping all servers on exit");
    for (_, h) in &handles {
        if let Ok(mut live) = h.lock() {
            live.stopping = true;
            if let Some(stdin) = live.stdin.as_mut() {
                let _ = stdin.write_all(b"stop\n");
                let _ = stdin.flush();
            }
        }
    }
    let deadline = Instant::now() + EXIT_STOP_BUDGET;
    loop {
        let mut any_alive = false;
        for (_, h) in &handles {
            if let Ok(mut live) = h.lock() {
                match live.child.try_wait() {
                    Ok(Some(_)) => {}
                    _ => {
                        any_alive = true;
                    }
                }
            }
        }
        if !any_alive || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    for (sid, h) in &handles {
        if let Ok(mut live) = h.lock() {
            match live.child.try_wait() {
                Ok(Some(_)) => {}
                _ => {
                    let _ = force_kill_live(&mut live);
                }
            }
        }
        if let Ok(app_data) = paths::app_data_dir(app) {
            if let Ok(dir) = paths::server_dir(&app_data, sid) {
                let _ = std::fs::remove_file(dir.join("server.lock"));
            }
        }
    }
}

/// Startup recovery: kill PIDs left behind by an unclean shutdown (stale
/// `server.lock` files) and normalize every row to `stopped` — nothing is
/// live right after launch.
pub fn reap_orphans(app_data: &Path, conn: &rusqlite::Connection) -> Result<(), AppError> {
    let _ = conn.execute("UPDATE servers SET status = 'stopped'", []);
    let mut stmt = conn.prepare("SELECT id FROM servers")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut ids = Vec::new();
    for r in rows {
        ids.push(r?);
    }
    for id in ids {
        let dir = match paths::server_dir(app_data, &id) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let lock = dir.join("server.lock");
        if !lock.is_file() {
            continue;
        }
        let record = match get_server(conn, &id) {
            Ok(record) => record,
            Err(error) => {
                tracing::info!(server = %id, %error, "could not load saved server launch identity; skipping orphan kill");
                let _ = std::fs::remove_file(&lock);
                continue;
            }
        };
        let launch_mode = resolve_launch_mode(
            &dir,
            &record.loader,
            &record.mc_version,
            record.loader_version.as_deref(),
        );
        if let Err(error) = &launch_mode {
            tracing::info!(server = %id, %error, "saved provider launch shape is unavailable; skipping orphan kill");
        }
        if let Ok(pid_txt) = std::fs::read_to_string(&lock) {
            if let Ok(pid) = pid_txt.trim().parse::<u32>() {
                if pid != 0 {
                    // Never kill blindly: verify the exact Java image, saved
                    // provider launch shape, and per-server marker first.
                    // Mismatch/unavailable inspection skips the kill.
                    if launch_mode
                        .as_ref()
                        .is_ok_and(|mode| orphan_pid_is_java_server(pid, &id, mode))
                    {
                        // CIM verification and taskkill are separate OS calls,
                        // so PID reuse can still race between check and kill.
                        kill_pid(pid); // best-effort: the PID may already be gone.
                        tracing::warn!(server = %id, pid, "killed orphaned server process from stale lockfile");
                    } else {
                        tracing::info!(server = %id, pid, "stale lockfile PID is not our java server (gone or recycled) — skipping kill");
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&lock);
    }
    Ok(())
}

/// Verify the Java image and the saved provider launch identity. Incomplete
/// CIM results fail closed.
#[cfg(windows)]
fn orphan_pid_is_java_server(pid: u32, server_id: &str, launch_mode: &LaunchMode) -> bool {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x08000000; // CREATE_NO_WINDOW
    let script = format!(
        "$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = {pid}'; if ($null -eq $p) {{ exit 3 }}; $p | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let Ok(json) = std::str::from_utf8(&output.stdout) else {
        return false;
    };
    let Ok(process) = serde_json::from_str::<serde_json::Value>(json) else {
        return false;
    };
    let Some(process_id) = process.get("ProcessId").and_then(serde_json::Value::as_u64) else {
        return false;
    };
    if process_id != u64::from(pid) {
        return false;
    }
    let Some(name) = process.get("Name").and_then(serde_json::Value::as_str) else {
        return false;
    };
    if !(name.eq_ignore_ascii_case("java.exe") || name.eq_ignore_ascii_case("javaw.exe")) {
        return false;
    }
    let Some(command_line) = process
        .get("CommandLine")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    has_server_identity(command_line, server_id, launch_mode)
}

/// Verify the Java image and the saved provider launch identity. Incomplete
/// process results fail closed.
#[cfg(not(windows))]
fn orphan_pid_is_java_server(pid: u32, server_id: &str, launch_mode: &LaunchMode) -> bool {
    let comm = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    let Ok(comm) = comm else {
        return false;
    };
    if !comm.status.success() {
        return false;
    }
    let image = String::from_utf8_lossy(&comm.stdout);
    if !(image.trim().eq_ignore_ascii_case("java") || image.trim().eq_ignore_ascii_case("javaw")) {
        return false; // PID gone or recycled by a non-java process.
    }
    let Some(command_line) = process_command_line(pid) else {
        return false;
    };
    has_server_identity(&command_line, server_id, launch_mode)
}

fn has_server_identity(command_line: &str, server_id: &str, launch_mode: &LaunchMode) -> bool {
    let args = command_line
        .split_whitespace()
        .map(|arg| arg.trim_matches('"'))
        .collect::<Vec<_>>();
    let expected_marker = format!("-Dtestmultiai.server.id={server_id}");
    if !args.iter().any(|arg| *arg == expected_marker.as_str()) {
        return false;
    }
    match launch_mode {
        LaunchMode::Jar { file_name } => args
            .windows(2)
            .any(|pair| pair[0] == "-jar" && pair[1].eq_ignore_ascii_case(file_name)),
        LaunchMode::ArgumentFiles {
            user_jvm_args,
            loader_args,
        } => {
            let expected_user = format!("@{user_jvm_args}");
            let expected_loader = format!("@{loader_args}");
            args.iter()
                .any(|arg| arg.eq_ignore_ascii_case(&expected_user))
                && args
                    .iter()
                    .any(|arg| arg.eq_ignore_ascii_case(&expected_loader))
        }
    }
}

#[cfg(not(windows))]
fn process_command_line(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    if let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) {
        if !raw.is_empty() {
            return Some(String::from_utf8_lossy(&raw).replace('\0', " "));
        }
    }

    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "args="])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let args = String::from_utf8_lossy(&output.stdout).into_owned();
    if args.trim().is_empty() {
        None
    } else {
        Some(args)
    }
}

/// Best-effort kill of an arbitrary PID (orphan reaping only).
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = cmd.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        checked_diagnostic_root, collect_readonly_failure_evidence, has_server_identity,
        heap_size_args, newest_crash_report_paths_with_opener, open_diagnostic_file,
        open_selected_crash_report, open_verified_diagnostic_handle, read_diagnostic_window,
        read_log_line, resolve_launch_mode, DiagnosticKind, LaunchMode, ReadinessTracker,
        MAX_CRASH_REPORT_BYTES, MAX_CRASH_REPORT_SCAN_ENTRIES, MAX_FAILURE_EVIDENCE_BYTES,
        MAX_LATEST_LOG_TAIL_BYTES, MAX_LOG_LINE,
    };
    #[cfg(windows)]
    use std::process::{Command, Stdio};
    use std::{
        fs,
        io::BufReader,
        path::{Path, PathBuf},
        time::Duration,
    };

    const SERVER_ID: &str = "7f8c3921-1b7c-4923-a9c4-4bf9e741b7cd";
    const MARKER: &str = "-Dtestmultiai.server.id=7f8c3921-1b7c-4923-a9c4-4bf9e741b7cd";

    #[test]
    fn initial_and_maximum_heap_match_configured_server_ram() {
        assert_eq!(
            heap_size_args(8192),
            ("-Xmx8192M".to_string(), "-Xms8192M".to_string())
        );
        assert_eq!(
            heap_size_args(4096),
            ("-Xmx4096M".to_string(), "-Xms4096M".to_string())
        );
    }

    #[test]
    fn invalid_utf8_line_is_replaced_and_later_lines_are_read() {
        let input = b"before\nNew Bl\xE5haj common setup\nafter\n";
        let mut reader = BufReader::new(input.as_slice());
        let mut buffer = Vec::new();

        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("before")
        );
        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("New Bl\u{FFFD}haj common setup")
        );
        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("after")
        );
        assert_eq!(read_log_line(&mut reader, &mut buffer).unwrap(), None);
    }

    #[test]
    fn log_reader_preserves_crlf_blank_and_unterminated_eof_lines() {
        let mut reader = BufReader::new(b"first\r\n\r\nfinal".as_slice());
        let mut buffer = Vec::new();

        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("")
        );
        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("final")
        );
        assert_eq!(read_log_line(&mut reader, &mut buffer).unwrap(), None);
    }

    #[test]
    fn log_reader_truncates_at_a_safe_utf8_boundary() {
        let mut input = vec![b'a'; MAX_LOG_LINE - 1];
        input.extend_from_slice("é\nfollowing\n".as_bytes());
        let mut reader = BufReader::new(input.as_slice());
        let mut buffer = Vec::new();

        let line = read_log_line(&mut reader, &mut buffer)
            .unwrap()
            .expect("oversized line");
        assert_eq!(line.len(), MAX_LOG_LINE - 1);
        assert_eq!(line, "a".repeat(MAX_LOG_LINE - 1));
        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("following")
        );
    }

    #[test]
    fn bounded_log_reader_discards_large_line_and_recovers_after_malformed_bytes() {
        let mut input = vec![b'a'; MAX_LOG_LINE * 128];
        input.extend_from_slice(b"\r\n");
        input.extend_from_slice(b"\xE5h malformed-but-readable\r\nvalid-after\n");
        let mut reader = BufReader::with_capacity(8192, input.as_slice());
        let mut buffer = Vec::with_capacity(MAX_LOG_LINE * 4);

        let oversized = read_log_line(&mut reader, &mut buffer)
            .unwrap()
            .expect("oversized line");
        assert_eq!(oversized, "a".repeat(MAX_LOG_LINE));
        assert!(buffer.len() <= MAX_LOG_LINE);
        assert!(buffer.capacity() <= MAX_LOG_LINE);
        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("\u{fffd}h malformed-but-readable")
        );
        assert_eq!(
            read_log_line(&mut reader, &mut buffer).unwrap().as_deref(),
            Some("valid-after")
        );
        assert_eq!(read_log_line(&mut reader, &mut buffer).unwrap(), None);
    }

    #[test]
    fn historical_failure_evidence_is_bounded_and_does_not_advance_readiness() {
        let root = test_path("failure-evidence");
        let logs = root.join("logs");
        let crash_reports = root.join("crash-reports");
        fs::create_dir_all(&logs).unwrap();
        fs::create_dir_all(&crash_reports).unwrap();

        let mut latest = vec![b'x'; MAX_FAILURE_EVIDENCE_BYTES * 2];
        latest.extend_from_slice(
            b"\nLoading Minecraft 1.20.1 with Fabric Loader 0.15.11\nDone (old run)!\njava.lang.ClassNotFoundException: com.example.MissingLibrary\n",
        );
        fs::write(logs.join("latest.log"), latest).unwrap();

        let mut old_report = b"java.lang.UnsupportedClassVersionError: old report\n".to_vec();
        old_report.resize(MAX_CRASH_REPORT_BYTES + 1024, b'x');
        fs::write(crash_reports.join("crash-old.txt"), old_report).unwrap();
        std::thread::sleep(Duration::from_millis(40));
        let mut newer_report = b"Invalid or corrupt jarfile library.jar\n".to_vec();
        newer_report.resize(MAX_CRASH_REPORT_BYTES + 1024, b'x');
        fs::write(crash_reports.join("crash-newer.txt"), newer_report).unwrap();
        std::thread::sleep(Duration::from_millis(40));
        let mut newest_report = b"Incompatible mods found!\n".to_vec();
        newest_report.resize(MAX_CRASH_REPORT_BYTES + 1024, b'x');
        fs::write(crash_reports.join("crash-newest.txt"), newest_report).unwrap();

        let mut tracker = ReadinessTracker::new("Fabric");
        assert!(checked_diagnostic_root(&root).is_ok());
        let (mut latest_file, latest_size, _) = open_diagnostic_file(&root, "logs/latest.log")
            .unwrap()
            .unwrap();
        assert_eq!(
            read_diagnostic_window(
                &mut latest_file,
                latest_size,
                MAX_LATEST_LOG_TAIL_BYTES,
                true
            )
            .unwrap()
            .len(),
            MAX_LATEST_LOG_TAIL_BYTES
        );
        let total_read = collect_readonly_failure_evidence(&root, &mut tracker).unwrap();
        let snapshot = tracker.snapshot();
        assert_eq!(total_read, MAX_FAILURE_EVIDENCE_BYTES);
        assert_eq!(
            snapshot.state,
            crate::modpacks::pipeline::runtime::ReadinessState::Starting
        );
        assert!(!snapshot.loader_initialized);
        assert!(!snapshot.minecraft_done);
        assert!(snapshot.diagnostics.iter().any(|item| {
            item.kind == DiagnosticKind::MissingLibrary
                && item.source.as_deref() == Some("logs/latest.log")
        }));
        assert!(snapshot.diagnostics.iter().any(|item| {
            item.kind == DiagnosticKind::CorruptJar
                && item.source.as_deref() == Some("crash-reports/crash-newer.txt")
        }));
        assert!(snapshot.diagnostics.iter().any(|item| {
            item.kind == DiagnosticKind::MissingDependency
                && item.source.as_deref() == Some("crash-reports/crash-newest.txt")
        }));
        assert!(!snapshot
            .diagnostics
            .iter()
            .any(|item| item.source.as_deref() == Some("crash-reports/crash-old.txt")));
        assert!(snapshot
            .diagnostics
            .iter()
            .all(|item| item.excerpt.len() <= 512 && item.message.len() <= 512));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn historical_failure_evidence_rejects_reparse_directory_components() {
        let root = test_path("unsafe-failure-evidence");
        let outside = test_path("unsafe-failure-evidence-outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            outside.join("latest.log"),
            b"java.lang.NoClassDefFoundError: must-not-be-read\n",
        )
        .unwrap();
        let logs_link = root.join("logs");
        if !create_directory_link(&logs_link, &outside) {
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
            return;
        }

        let mut tracker = ReadinessTracker::new("Fabric");
        assert_eq!(
            collect_readonly_failure_evidence(&root, &mut tracker).unwrap(),
            0
        );
        let snapshot = tracker.snapshot();
        assert_eq!(
            snapshot.state,
            crate::modpacks::pipeline::runtime::ReadinessState::Starting
        );
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|item| item.kind == DiagnosticKind::EvidenceIncomplete));
        assert!(!snapshot
            .diagnostics
            .iter()
            .any(|item| item.kind == DiagnosticKind::MissingLibrary));

        remove_directory_link(&logs_link);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn diagnostic_handle_path_is_rechecked_after_parent_junction_replacement() {
        let root = test_path("diagnostic-handle-root");
        let outside = test_path("diagnostic-handle-outside");
        let logs = root.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let original_log = logs.join("latest.log");
        fs::write(&original_log, b"inside").unwrap();
        let expected_root = fs::canonicalize(&root).unwrap();
        let stale_checked_path = fs::canonicalize(&original_log).unwrap();
        fs::remove_file(&original_log).unwrap();
        fs::remove_dir(&logs).unwrap();
        let outside_log = outside.join("latest.log");
        fs::write(&outside_log, b"extern").unwrap();

        let outside_path = fs::canonicalize(&outside_log).unwrap();
        let direct = open_verified_diagnostic_handle(&outside_path, &expected_root, 6);
        assert!(direct
            .unwrap_err()
            .contains("opened diagnostic handle resolves outside"));

        if !create_directory_link(&logs, &outside) {
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
            return;
        }

        let result = open_verified_diagnostic_handle(&stale_checked_path, &expected_root, 6);
        assert!(result
            .unwrap_err()
            .contains("opened diagnostic handle resolves outside"));

        remove_directory_link(&logs);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn crash_report_scan_cap_is_disclosed_in_startup_diagnostics() {
        let root = test_path("diagnostic-scan-cap");
        let crash_reports = root.join("crash-reports");
        fs::create_dir_all(&crash_reports).unwrap();
        for index in 0..=MAX_CRASH_REPORT_SCAN_ENTRIES {
            fs::write(crash_reports.join(format!("crash-{index:03}.txt")), b"").unwrap();
        }

        let mut tracker = ReadinessTracker::new("Fabric");
        assert_eq!(
            collect_readonly_failure_evidence(&root, &mut tracker).unwrap(),
            0
        );
        let snapshot = tracker.snapshot();
        let warning = snapshot
            .diagnostics
            .iter()
            .find(|item| item.kind == DiagnosticKind::EvidenceIncomplete)
            .expect("report cap should produce an evidence warning");
        assert!(warning.message.contains("128-entry limit"));
        assert_eq!(warning.source.as_deref(), Some("crash-reports/"));
        assert_eq!(
            snapshot.state,
            crate::modpacks::pipeline::runtime::ReadinessState::Starting
        );
        assert!(!snapshot.loader_initialized && !snapshot.minecraft_done);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn crash_report_disappearing_during_enumeration_marks_scan_incomplete() {
        let root = test_path("diagnostic-scan-disappearing");
        let crash_reports = root.join("crash-reports");
        fs::create_dir_all(&crash_reports).unwrap();
        fs::write(crash_reports.join("crash-disappears.txt"), b"fixture").unwrap();

        let scan = newest_crash_report_paths_with_opener(&root, |_, _| Ok(None));
        assert!(scan.incomplete);
        assert!(scan.paths.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn selected_crash_report_disappearing_before_read_marks_evidence_incomplete() {
        let mut tracker = ReadinessTracker::new("Fabric");
        let relative_path = "crash-reports/crash-disappears.txt";
        let opened = open_selected_crash_report(relative_path, &mut tracker, || Ok(None));
        assert!(matches!(opened, Ok(None)));

        let snapshot = tracker.snapshot();
        assert_eq!(
            snapshot.state,
            crate::modpacks::pipeline::runtime::ReadinessState::Starting
        );
        let warning = snapshot
            .diagnostics
            .iter()
            .find(|item| item.kind == DiagnosticKind::EvidenceIncomplete)
            .unwrap();
        assert_eq!(warning.source.as_deref(), Some(relative_path));
        assert!(warning.message.contains("disappeared after selection"));
    }

    #[test]
    fn orphan_identity_matches_exact_direct_jar_and_marker() {
        let mode = LaunchMode::Jar {
            file_name: "forge-1.12.2-14.23.5.2864-universal.jar".to_string(),
        };
        let command_line = format!(
            "java.exe -Xmx4096M {MARKER} -jar forge-1.12.2-14.23.5.2864-universal.jar nogui"
        );
        assert!(has_server_identity(&command_line, SERVER_ID, &mode));

        let wrong_path = format!("java.exe {MARKER} -jar server.jar nogui");
        assert!(!has_server_identity(&wrong_path, SERVER_ID, &mode));

        let wrong_marker = "java.exe -Dtestmultiai.server.id=another-server -jar forge-1.12.2-14.23.5.2864-universal.jar nogui";
        assert!(!has_server_identity(wrong_marker, SERVER_ID, &mode));
    }

    #[test]
    fn orphan_identity_matches_both_exact_argument_files_and_marker() {
        let mode = LaunchMode::ArgumentFiles {
            user_jvm_args: "user_jvm_args.txt".to_string(),
            loader_args: "libraries/net/neoforged/neoforge/20.4.237/win_args.txt".to_string(),
        };
        let command_line = format!(
            "java.exe @user_jvm_args.txt -Xmx4096M {MARKER} @libraries/net/neoforged/neoforge/20.4.237/win_args.txt nogui"
        );
        assert!(has_server_identity(&command_line, SERVER_ID, &mode));

        let wrong_user_args = format!(
            "java.exe @other_user_jvm_args.txt {MARKER} @libraries/net/neoforged/neoforge/20.4.237/win_args.txt nogui"
        );
        assert!(!has_server_identity(&wrong_user_args, SERVER_ID, &mode));

        let wrong_loader_args = format!(
            "java.exe @user_jvm_args.txt {MARKER} @libraries/net/neoforged/neoforge/20.4.238/win_args.txt nogui"
        );
        assert!(!has_server_identity(&wrong_loader_args, SERVER_ID, &mode));

        let wrong_marker = "java.exe @user_jvm_args.txt -Dtestmultiai.server.id=another-server @libraries/net/neoforged/neoforge/20.4.237/win_args.txt nogui";
        assert!(!has_server_identity(wrong_marker, SERVER_ID, &mode));
    }

    #[test]
    fn quilt_start_rejects_a_linked_nested_server_directory() {
        let root = test_path("quilt-start");
        let outside = test_path("quilt-outside");
        let server_dir = root.join("server");
        fs::create_dir_all(&root).expect("create server directory");
        fs::create_dir_all(&outside).expect("create outside directory");
        fs::write(root.join("quilt-server-launch.jar"), b"launcher").expect("write launcher");
        fs::write(root.join("server.jar"), b"launcher copy").expect("write launch JAR");
        fs::write(outside.join("server.jar"), b"outside server").expect("write outside JAR");

        if !create_directory_link(&server_dir, &outside) {
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
            return;
        }

        match resolve_launch_mode(&root, "Quilt", "1.20.4", None) {
            Err(error) => assert!(error.to_string().contains("symlink or reparse point")),
            Ok(_) => panic!("Start must reject a linked Quilt server directory"),
        }
        remove_directory_link(&server_dir);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mc-server-manager-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[cfg(unix)]
    fn create_directory_link(link: &Path, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn create_directory_link(link: &Path, target: &Path) -> bool {
        Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(not(any(unix, windows)))]
    fn create_directory_link(_link: &Path, _target: &Path) -> bool {
        false
    }

    #[cfg(unix)]
    fn remove_directory_link(link: &Path) {
        let _ = fs::remove_file(link);
    }

    #[cfg(windows)]
    fn remove_directory_link(link: &Path) {
        let _ = fs::remove_dir(link);
    }

    #[cfg(not(any(unix, windows)))]
    fn remove_directory_link(_link: &Path) {}
}
