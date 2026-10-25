//! Provider-backed Minecraft version discovery and staged server installation.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::{
    db::DbState,
    error::AppError,
    servers::{self, CreateServerInput, ServerRecord},
    util::paths,
};

const MOJANG_MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const PAPER_PROJECT: &str = "https://fill.papermc.io/v3/projects/paper";
const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const FORGE_PROMOTIONS: &str =
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_CATALOGUE: &str =
    "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const NEOFORGE_METADATA: &str =
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
const USER_AGENT: &str = "mc-server-manager/0.1.0 (https://github.com/)";
const MODRINTH_USER_AGENT: &str = concat!(
    "mc-server-manager/",
    env!("CARGO_PKG_VERSION"),
    " (Modrinth catalog; https://github.com/)"
);
const MAX_HTTP_BODY: usize = 16 * 1024 * 1024;
const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
const MAX_PIPELINE_REDIRECTS: usize = 3;
const MAX_PIPELINE_URL_BYTES: usize = 8192;
const PIPELINE_CURL_BASE_OPTIONS: [&str; 4] = ["--disable", "--fail", "--silent", "--show-error"];
const MAX_MODRINTH_RETRIES: usize = 2;
const MAX_MODRINTH_FILE_ATTEMPTS: usize = 3;
const MODRINTH_FILE_RETRY_DELAYS: [Duration; 2] =
    [Duration::from_millis(250), Duration::from_millis(500)];
const MODRINTH_FILE_PROGRESS_INTERVAL: Duration = Duration::from_secs(2);
const MAX_MODRINTH_FILE_WORKERS: usize = 4;
const MAX_INSTALL_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RECENT_LOG_BYTES: usize = 48 * 1024;
const MAX_PIPELINE_LOADER_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CANCEL_POLL: Duration = Duration::from_millis(200);
const MODPACK_BASE_PROGRESS: ProgressRange = ProgressRange { start: 12, end: 45 };
const MODPACK_FILE_PROGRESS: ProgressRange = ProgressRange { start: 46, end: 76 };
const MODPACK_OVERRIDE_PROGRESS: ProgressRange = ProgressRange { start: 77, end: 88 };
const DISK_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;
const BASE_SERVER_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_MODPACK_REDIRECTS: usize = 3;

#[derive(Debug, Clone, Copy)]
struct ProgressRange {
    start: u8,
    end: u8,
}

impl ProgressRange {
    fn map_installer_progress(self, progress: u8) -> u8 {
        let value = progress.saturating_sub(3).min(91) as u16;
        let span = self.end.saturating_sub(self.start) as u16;
        self.start + ((value * span) / 91) as u8
    }

    fn map_fraction(self, completed: u64, total: u64) -> u8 {
        let span = self.end.saturating_sub(self.start) as u64;
        let offset = if total == 0 {
            span
        } else {
            completed.min(total).saturating_mul(span) / total
        };
        self.start.saturating_add(offset as u8)
    }
}

#[derive(Default)]
struct ModrinthFileProgressState {
    active: HashMap<usize, u64>,
    completed: u64,
    last_reported_bytes: u64,
    last_reported_progress: u8,
    last_emit: Option<Instant>,
}

impl ModrinthFileProgressState {
    fn raw_bytes(&self, total: u64) -> u64 {
        self.active
            .values()
            .fold(self.completed, |sum, bytes| sum.saturating_add(*bytes))
            .min(total)
    }

    fn reported_snapshot(
        &mut self,
        range: ProgressRange,
        total: u64,
        now: Instant,
    ) -> Option<(u64, u8)> {
        let bytes = self.raw_bytes(total).max(self.last_reported_bytes);
        let interval_elapsed = self.last_emit.map_or(true, |last_emit| {
            now.checked_duration_since(last_emit).unwrap_or_default()
                >= MODRINTH_FILE_PROGRESS_INTERVAL
        });
        if !interval_elapsed || bytes <= self.last_reported_bytes {
            return None;
        }
        let progress = range
            .map_fraction(bytes, total)
            .max(self.last_reported_progress);
        self.last_reported_bytes = bytes;
        self.last_reported_progress = progress;
        self.last_emit = Some(now);
        Some((bytes, progress))
    }
}

struct ModrinthFileProgress {
    app: AppHandle,
    job_id: String,
    stage: &'static str,
    range: ProgressRange,
    total: u64,
    state: Mutex<ModrinthFileProgressState>,
}

impl ModrinthFileProgress {
    fn new(
        app: AppHandle,
        job_id: &str,
        stage: &'static str,
        range: ProgressRange,
        total: u64,
    ) -> Self {
        Self {
            app,
            job_id: job_id.to_string(),
            stage,
            range,
            total,
            state: Mutex::new(ModrinthFileProgressState {
                last_reported_progress: range.start,
                last_emit: Some(Instant::now()),
                ..ModrinthFileProgressState::default()
            }),
        }
    }

    fn update_active(&self, file_index: usize, bytes: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.active.insert(file_index, bytes);
            self.emit_if_due(&mut state);
        }
    }

    fn rollback(&self, file_index: usize) {
        if let Ok(mut state) = self.state.lock() {
            state.active.remove(&file_index);
        }
    }

    fn complete(&self, file_index: usize, bytes: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.active.remove(&file_index);
            state.completed = state.completed.saturating_add(bytes);
            self.emit_if_due(&mut state);
        }
    }

    fn emit_if_due(&self, state: &mut ModrinthFileProgressState) {
        if let Some((bytes, progress)) =
            state.reported_snapshot(self.range, self.total, Instant::now())
        {
            let message = format!("Downloaded {bytes} of {} bytes.", self.total);
            emit_progress(
                &self.app,
                &self.job_id,
                progress,
                self.stage,
                &message,
                Some(bytes),
                Some(self.total),
            );
        }
    }
}

struct ModrinthFileScheduler {
    next_index: usize,
    first_failure: Option<AppError>,
}

fn run_bounded_modrinth_file_tasks<F>(
    task_count: usize,
    max_workers: usize,
    execute: F,
) -> Result<(), AppError>
where
    F: Fn(usize, &AtomicBool) -> Result<(), AppError> + Sync,
{
    if task_count == 0 {
        return Ok(());
    }
    let worker_count = task_count.min(max_workers.max(1));
    let scheduler = Mutex::new(ModrinthFileScheduler {
        next_index: 0,
        first_failure: None,
    });
    let stop = AtomicBool::new(false);

    thread::scope(|scope| {
        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let scheduler = &scheduler;
            let stop = &stop;
            let execute = &execute;
            workers.push(scope.spawn(move || loop {
                let task_index = {
                    let mut state = scheduler
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if state.first_failure.is_some() || state.next_index >= task_count {
                        return;
                    }
                    let task_index = state.next_index;
                    state.next_index += 1;
                    task_index
                };

                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    execute(task_index, stop)
                }));
                let failure = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error),
                    Err(_) => Some(AppError::Internal(
                        "Modrinth pack-file worker panicked".into(),
                    )),
                };
                if let Some(error) = failure {
                    let mut state = scheduler
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if state.first_failure.is_none() {
                        state.first_failure = Some(error);
                        stop.store(true, Ordering::Release);
                    }
                    return;
                }
            }));
        }
        for worker in workers {
            if worker.join().is_err() {
                let mut state = scheduler
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if state.first_failure.is_none() {
                    state.first_failure = Some(AppError::Internal(
                        "Modrinth pack-file worker could not be joined".into(),
                    ));
                    stop.store(true, Ordering::Release);
                }
            }
        }
    });

    let state = scheduler
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match state.first_failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftVersion {
    pub id: String,
    pub release_time: String,
    pub version_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderChoice {
    pub loader: String,
    pub version: Option<String>,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub progress: u8,
    pub stage: String,
    pub log: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JobPhase {
    Running,
    Cancelled,
    Publishing,
}

pub(crate) struct JobControl {
    phase: Mutex<JobPhase>,
    cancelled: Arc<AtomicBool>,
}

impl JobControl {
    pub(crate) fn new() -> Self {
        Self {
            phase: Mutex::new(JobPhase::Running),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
            || self.phase
            .lock()
            .map(|phase| *phase == JobPhase::Cancelled)
            .unwrap_or(true)
    }

    pub(crate) fn cancellation_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    pub(crate) fn cancel(&self) -> bool {
        let Ok(mut phase) = self.phase.lock() else {
            return false;
        };
        if *phase != JobPhase::Running {
            return false;
        }
        *phase = JobPhase::Cancelled;
        self.cancelled.store(true, Ordering::Release);
        true
    }

    pub(crate) fn begin_publication(&self) -> Result<(), AppError> {
        let mut phase = self.phase.lock()?;
        match *phase {
            JobPhase::Running => {
                *phase = JobPhase::Publishing;
                Ok(())
            }
            JobPhase::Cancelled => Err(cancelled_error()),
            JobPhase::Publishing => Err(AppError::Conflict(
                "installation is already being published".to_string(),
            )),
        }
    }
}

/// Managed state for cancellable installer jobs. Each job has one cancellation
/// decision point; once publication begins, cancellation can no longer race a
/// partially visible server into existence.
pub struct InstallerState(Mutex<HashMap<String, Arc<JobControl>>>);

impl InstallerState {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    fn register(&self, job_id: &str) -> Result<Arc<JobControl>, AppError> {
        paths::validate_id(job_id)?;
        let mut jobs = self.0.lock()?;
        if jobs.contains_key(job_id) {
            return Err(AppError::Conflict(
                "an install job with this id is already active".into(),
            ));
        }
        let control = Arc::new(JobControl::new());
        jobs.insert(job_id.to_string(), control.clone());
        Ok(control)
    }

    fn finish(&self, job_id: &str, control: &Arc<JobControl>) {
        if let Ok(mut jobs) = self.0.lock() {
            if jobs
                .get(job_id)
                .is_some_and(|current| Arc::ptr_eq(current, control))
            {
                jobs.remove(job_id);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionManifestEntry {
    id: String,
    #[serde(rename = "type")]
    version_type: String,
    #[serde(default)]
    release_time: String,
    url: String,
}

struct InstallLog {
    file: File,
    written: u64,
    recent: String,
}

impl InstallLog {
    fn create(path: &Path) -> Result<Self, AppError> {
        Ok(Self {
            file: File::create(path)?,
            written: 0,
            recent: String::new(),
        })
    }

    fn open_append(path: &Path) -> Result<Self, AppError> {
        let written = fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        Ok(Self {
            file: fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?,
            written,
            recent: String::new(),
        })
    }

    fn append(&mut self, text: &str) {
        let line = format!("{}\n", clean_log_text(text));
        if self.written < MAX_INSTALL_LOG_BYTES {
            let remaining = (MAX_INSTALL_LOG_BYTES - self.written) as usize;
            let bytes = line.as_bytes();
            let count = bytes.len().min(remaining);
            let _ = self.file.write_all(&bytes[..count]);
            let _ = self.file.flush();
            self.written += count as u64;
        }
        self.recent.push_str(&line);
        if self.recent.len() > MAX_RECENT_LOG_BYTES {
            let mut trim_to = self.recent.len() - MAX_RECENT_LOG_BYTES;
            while !self.recent.is_char_boundary(trim_to) {
                trim_to += 1;
            }
            self.recent.drain(..trim_to);
        }
    }

    fn recent(&self) -> String {
        self.recent.clone()
    }
}

#[derive(Clone)]
struct DownloadInfo {
    url: String,
    size: Option<u64>,
    sha1: Option<String>,
    sha256: Option<String>,
}

enum InstallArtifact {
    Jar {
        download: DownloadInfo,
        file_name: &'static str,
        integrity: Integrity,
    },
    Installer {
        download: DownloadInfo,
        file_name: &'static str,
        args: Vec<String>,
        integrity: Integrity,
        warning: Option<String>,
    },
}

#[derive(Clone, Copy)]
enum Integrity {
    Sha1,
    Sha256,
    None,
}

#[derive(Debug, Deserialize)]
struct ModrinthVersionMetadata {
    project_id: String,
    files: Vec<ModrinthVersionFile>,
}

#[derive(Debug, Deserialize)]
struct ModrinthVersionFile {
    filename: String,
    url: String,
    size: u64,
    #[serde(default)]
    primary: bool,
    hashes: ModrinthVersionHashes,
}

#[derive(Debug, Deserialize)]
struct ModrinthVersionHashes {
    sha1: String,
    sha512: String,
}

#[tauri::command]
pub async fn versions_vanilla() -> Result<Vec<MinecraftVersion>, AppError> {
    tauri::async_runtime::spawn_blocking(resolve_vanilla_versions)
        .await
        .map_err(|e| AppError::Internal(format!("version discovery task failed: {e}")))?
}

#[tauri::command]
pub async fn versions_paper() -> Result<Vec<MinecraftVersion>, AppError> {
    tauri::async_runtime::spawn_blocking(resolve_paper_versions)
        .await
        .map_err(|e| AppError::Internal(format!("Paper version discovery task failed: {e}")))?
}

#[tauri::command]
pub async fn loaders_resolve(mc_version: String) -> Result<Vec<LoaderChoice>, AppError> {
    tauri::async_runtime::spawn_blocking(move || resolve_loader_choices(&mc_version, None))
        .await
        .map_err(|e| AppError::Internal(format!("loader resolution task failed: {e}")))?
}

#[tauri::command]
pub async fn server_install(
    app: AppHandle,
    state: State<'_, DbState>,
    jobs: State<'_, InstallerState>,
    input: CreateServerInput,
    job_id: String,
) -> Result<ServerRecord, AppError> {
    validate_install_request(&input, &job_id)?;
    {
        let conn = state.0.lock()?;
        servers::validate_install_preflight(&conn, &input)?;
    }
    let control = jobs.register(&job_id)?;
    let app_data = match crate::util::paths::app_data_dir(&app) {
        Ok(path) => path,
        Err(error) => {
            jobs.finish(&job_id, &control);
            return Err(error);
        }
    };
    let app_for_worker = app.clone();
    let worker_control = control.clone();
    let worker_job_id = job_id.clone();
    let worker_input = input.clone();
    let staging = app_data
        .join("installer-staging")
        .join(uuid::Uuid::new_v4().to_string());
    let worker_staging = staging.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        prepare_install(
            &app_for_worker,
            &worker_job_id,
            &worker_staging,
            &worker_input,
            &worker_control,
        )
    })
    .await;

    let worker = match worker {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            jobs.finish(&job_id, &control);
            return Err(AppError::Internal(format!(
                "server installation task failed: {error}"
            )));
        }
    };
    let result = match worker {
        Ok(()) => {
            if let Err(error) = control.begin_publication() {
                let _ = fs::remove_dir_all(&staging);
                Err(error)
            } else {
                let publish = match state.0.lock() {
                    Ok(conn) => {
                        servers::publish_installed_server(&conn, &app_data, input, &staging)
                    }
                    Err(error) => Err(error.into()),
                };
                match publish {
                    Ok(record) => {
                        emit_progress(
                            &app,
                            &job_id,
                            100,
                            "Complete",
                            "Server installation completed and was saved.",
                            None,
                            None,
                        );
                        Ok(record)
                    }
                    Err(error) => {
                        let _ = fs::remove_dir_all(&staging);
                        Err(error)
                    }
                }
            }
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    };
    jobs.finish(&job_id, &control);
    result
}

#[tauri::command]
pub fn server_install_cancel(
    jobs: State<'_, InstallerState>,
    job_id: String,
) -> Result<bool, AppError> {
    cancel_install_job(&jobs, &job_id)
}

#[tauri::command]
pub async fn modpack_install(
    app: AppHandle,
    state: State<'_, DbState>,
    jobs: State<'_, InstallerState>,
    input: crate::modpacks::install::ModpackInstallInput,
    project_id: String,
    version_id: String,
    job_id: String,
) -> Result<ServerRecord, AppError> {
    let preflight_input =
        validate_modpack_install_request(&input, &project_id, &version_id, &job_id)?;
    {
        let conn = state.0.lock()?;
        servers::validate_install_preflight(&conn, &preflight_input)?;
    }
    let control = jobs.register(&job_id)?;
    let app_data = match crate::util::paths::app_data_dir(&app) {
        Ok(path) => path,
        Err(error) => {
            jobs.finish(&job_id, &control);
            return Err(error);
        }
    };
    let staging = app_data
        .join("installer-staging")
        .join(uuid::Uuid::new_v4().to_string());
    let app_for_worker = app.clone();
    let worker_control = control.clone();
    let worker_staging = staging.clone();
    let worker_input = input;
    let worker_project_id = project_id.clone();
    let worker_version_id = version_id.clone();
    let worker_job_id = job_id.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        prepare_modpack_install(
            &app_for_worker,
            &worker_job_id,
            &worker_staging,
            worker_input,
            &worker_project_id,
            &worker_version_id,
            &worker_control,
        )
    })
    .await;

    let worker = match worker {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            jobs.finish(&job_id, &control);
            return Err(AppError::Internal(format!(
                "Modrinth modpack installation task failed: {error}"
            )));
        }
    };
    let result = match worker {
        Ok(publish_input) => {
            if let Err(error) = control.begin_publication() {
                let _ = fs::remove_dir_all(&staging);
                Err(error)
            } else {
                let publish = match state.0.lock() {
                    Ok(conn) => {
                        servers::publish_installed_server(&conn, &app_data, publish_input, &staging)
                    }
                    Err(error) => Err(error.into()),
                };
                match publish {
                    Ok(record) => {
                        emit_progress(
                            &app,
                            &job_id,
                            100,
                            "Complete",
                            "Modrinth modpack installation completed and was saved.",
                            None,
                            None,
                        );
                        Ok(record)
                    }
                    Err(error) => {
                        let _ = fs::remove_dir_all(&staging);
                        Err(error)
                    }
                }
            }
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    };
    jobs.finish(&job_id, &control);
    result
}

#[tauri::command]
pub async fn curseforge_import_install(
    app: AppHandle,
    state: State<'_, DbState>,
    jobs: State<'_, InstallerState>,
    input: CreateServerInput,
    zip_name: String,
    auto_delete_zip: bool,
    job_id: String,
) -> Result<ServerRecord, AppError> {
    validate_install_request(&input, &job_id)?;
    if !matches!(input.loader.as_str(), "Forge" | "NeoForge" | "Fabric") {
        return Err(AppError::Validation(
            "CurseForge server-pack imports currently support verified Forge, NeoForge, and recognized ServerPackCreator Fabric packs only".into(),
        ));
    }
    if input.loader_version.as_deref().is_none_or(str::is_empty) {
        return Err(AppError::Validation(
            "the imported server pack must include an exact loader build".into(),
        ));
    }
    let app_data = crate::util::paths::app_data_dir(&app)?;
    let source_zip = crate::modpacks::curseforge_import::staged_zip_path(&app_data, &zip_name)?;
    {
        let conn = state.0.lock()?;
        servers::validate_install_preflight(&conn, &input)?;
    }
    let control = jobs.register(&job_id)?;
    let staging = app_data
        .join("installer-staging")
        .join(uuid::Uuid::new_v4().to_string());
    let worker_app = app.clone();
    let worker_control = control.clone();
    let worker_staging = staging.clone();
    let worker_zip = source_zip.clone();
    let worker_input = input.clone();
    let worker_job = job_id.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        prepare_curseforge_install(
            &worker_app,
            &worker_job,
            &worker_staging,
            &worker_zip,
            &worker_input,
            &worker_control,
        )
    })
    .await;

    let worker = match worker {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            jobs.finish(&job_id, &control);
            return Err(AppError::Internal(format!(
                "CurseForge server-pack installation task failed: {error}"
            )));
        }
    };
    let result = match worker {
        Ok(()) => {
            if let Err(error) = control.begin_publication() {
                let _ = fs::remove_dir_all(&staging);
                Err(error)
            } else {
                let publish = match state.0.lock() {
                    Ok(conn) => {
                        servers::publish_installed_server(&conn, &app_data, input, &staging)
                    }
                    Err(error) => Err(error.into()),
                };
                match publish {
                    Ok(record) => {
                        if auto_delete_zip {
                            match crate::modpacks::curseforge_import::remove_staged_zip(
                                &app_data, &zip_name,
                            ) {
                                Ok(()) => {
                                    tracing::info!(name = %zip_name, "removed staged CurseForge ZIP after successful installation")
                                }
                                Err(error) => {
                                    tracing::warn!(name = %zip_name, %error, "could not remove staged CurseForge ZIP after successful installation")
                                }
                            }
                        }
                        emit_progress(
                            &app,
                            &job_id,
                            100,
                            "Complete",
                            "CurseForge server pack was installed and saved.",
                            None,
                            None,
                        );
                        Ok(record)
                    }
                    Err(error) => {
                        let _ = fs::remove_dir_all(&staging);
                        Err(error)
                    }
                }
            }
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            Err(error)
        }
    };
    jobs.finish(&job_id, &control);
    result
}

fn prepare_curseforge_install(
    app: &AppHandle,
    job_id: &str,
    staging: &Path,
    source_zip: &Path,
    input: &CreateServerInput,
    control: &JobControl,
) -> Result<(), AppError> {
    ensure_not_cancelled(control)?;
    let outer_plan = crate::modpacks::curseforge_import::build_archive_plan(source_zip)?;
    let prepared =
        crate::modpacks::curseforge_import::prepare_server_pack_archive(source_zip, outer_plan)?;
    let plan = &prepared.plan;
    let client_export = crate::modpacks::curseforge_import::is_client_export(&prepared.path, plan);
    if client_export {
        return Err(AppError::Validation(
            "CurseForge client exports cannot be installed directly; select the SERVER pack from Additional Files".into(),
        ));
    }
    let pack = crate::modpacks::curseforge_import::detect_pack_for_install(&prepared.path, plan)
        .map_err(AppError::Validation)?;
    if pack.minecraft_version != input.mc_version
        || pack.loader != input.loader
        || Some(pack.loader_version.as_str()) != input.loader_version.as_deref()
    {
        return Err(AppError::Validation(
            "selected server pack no longer matches the inspected Minecraft version and loader build".into(),
        ));
    }
    verify_import_loader_build(&pack.minecraft_version, &pack.loader, &pack.loader_version)?;
    let runtime_reserve = if pack.server_pack_creator {
        BASE_SERVER_RESERVE_BYTES
    } else {
        0
    };
    let required = plan
        .expanded_bytes
        .checked_add(runtime_reserve)
        .and_then(|bytes| bytes.checked_add(DISK_HEADROOM_BYTES))
        .ok_or_else(|| AppError::Validation("CurseForge disk estimate overflowed".into()))?;
    if let Some(parent) = staging.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(staging).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Conflict("this CurseForge install job already has a staging directory".into())
        } else {
            error.into()
        }
    })?;
    crate::modpacks::install::ensure_safe_staging(staging)?;
    ensure_free_space(staging, required)?;
    emit_progress(
        app,
        job_id,
        5,
        "Preparing",
        "Validating the selected CurseForge SERVER archive.",
        None,
        None,
    );
    if pack.server_pack_creator {
        prepare_install_with_progress(
            app,
            job_id,
            staging,
            input,
            control,
            ProgressRange { start: 5, end: 10 },
            true,
        )?;
    }
    crate::modpacks::curseforge_import::extract_server_pack_zip(
        app,
        job_id,
        &prepared.path,
        plan,
        &pack,
        staging,
        control,
    )?;
    if pack.loader == "Fabric" {
        let java_path = input.java_path.as_deref().ok_or_else(|| {
            AppError::Validation(
                "select or install a compatible Java runtime before installation".into(),
            )
        })?;
        let java = crate::java::validate_java_for_version(java_path, &pack.minecraft_version)?;
        crate::modpacks::install::validate_fabric_mod_java_constraints(staging, java.major)?;
    }
    ensure_not_cancelled(control)?;
    crate::servers::process::resolve_launch_mode(
        staging,
        &pack.loader,
        &pack.minecraft_version,
        Some(&pack.loader_version),
    )?;
    let mut log = InstallLog::open_append(&staging.join("installer.log"))?;
    log.append("Validated CurseForge server-pack import.");
    emit_progress(
        app,
        job_id,
        99,
        "Validated",
        "The server-pack files pass the existing Start-path validation.",
        Some(plan.expanded_bytes),
        Some(plan.expanded_bytes),
    );
    Ok(())
}

pub(crate) fn verify_import_loader_build(
    minecraft_version: &str,
    loader: &str,
    loader_version: &str,
) -> Result<(), AppError> {
    ensure_supported_mc(minecraft_version)?;
    let releases = vanilla_manifest_entries(None)?;
    if !releases
        .iter()
        .any(|entry| entry.id == minecraft_version && entry.version_type == "release")
    {
        return Err(AppError::Validation(format!(
            "Minecraft {minecraft_version} is not an official release"
        )));
    }
    match loader {
        "Forge" => {
            let artifact = loader_version.strip_prefix("specific:").ok_or_else(|| {
                AppError::Validation("Forge import requires an exact Forge build".into())
            })?;
            if !safe_version_segment(artifact)
                || !artifact.starts_with(&format!("{minecraft_version}-"))
            {
                return Err(AppError::Validation(
                    "Forge import contains an invalid build marker".into(),
                ));
            }
            let catalogue = forge_catalogue(None)?;
            let artifacts = forge_catalogue_artifacts(&catalogue, minecraft_version)?;
            if artifacts.iter().any(|candidate| candidate == artifact) {
                Ok(())
            } else {
                Err(AppError::Validation(format!(
                    "Forge build {artifact} is not listed in current official metadata"
                )))
            }
        }
        "NeoForge" => {
            if !safe_version_segment(loader_version)
                || neoforge_prefix(minecraft_version).is_none()
                || !neoforge_versions(minecraft_version, None)?
                    .iter()
                    .any(|candidate| candidate == loader_version)
            {
                Err(AppError::Validation(format!(
                    "NeoForge build {loader_version} is not listed for Minecraft {minecraft_version} in current official metadata"
                )))
            } else {
                Ok(())
            }
        }
        "Fabric" => {
            if !safe_version_segment(loader_version) {
                return Err(AppError::Validation(
                    "ServerPackCreator pack contains an invalid Fabric loader version".into(),
                ));
            }
            let metadata = fetch_json(
                &format!("{FABRIC_META}/versions/loader/{minecraft_version}/{loader_version}"),
                None,
                None,
            )?;
            if fabric_loader_version_matches(&metadata, loader_version) {
                Ok(())
            } else {
                Err(AppError::Validation(
                    "Fabric Meta did not confirm the exact ServerPackCreator loader version".into(),
                ))
            }
        }
        _ => Err(AppError::Validation(
            "CurseForge imports require a verified Forge, NeoForge, or ServerPackCreator Fabric build".into(),
        )),
    }
}

pub(crate) fn emit_curseforge_progress(
    app: &AppHandle,
    job_id: &str,
    progress: u8,
    stage: &str,
    log: &str,
    bytes_downloaded: Option<u64>,
    bytes_total: Option<u64>,
) {
    emit_progress(
        app,
        job_id,
        progress,
        stage,
        log,
        bytes_downloaded,
        bytes_total,
    );
}

#[tauri::command]
pub fn modpack_install_cancel(
    jobs: State<'_, InstallerState>,
    job_id: String,
) -> Result<bool, AppError> {
    cancel_install_job(&jobs, &job_id)
}

fn cancel_install_job(jobs: &InstallerState, job_id: &str) -> Result<bool, AppError> {
    paths::validate_id(job_id)?;
    let jobs = jobs.0.lock()?;
    Ok(jobs.get(job_id).is_some_and(|control| control.cancel()))
}

fn validate_install_request(input: &CreateServerInput, job_id: &str) -> Result<(), AppError> {
    paths::validate_id(job_id)?;
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err(AppError::Validation(
            "server installation is supported on Windows x64 only".to_string(),
        ));
    }
    if input.loader == "Quilt" {
        return Err(AppError::Validation(
            "Quilt is no longer available for new server creation".to_string(),
        ));
    }
    if input.modpack_id.is_some() {
        return Err(AppError::Validation(
            "Tauri modpack installs are unavailable until Phase 5".to_string(),
        ));
    }
    if !matches!(
        input.loader.as_str(),
        "Vanilla" | "Paper" | "Fabric" | "Forge" | "NeoForge"
    ) {
        return Err(AppError::Validation(format!(
            "unknown server loader '{}'",
            input.loader
        )));
    }
    let mc_version = input.mc_version.trim();
    if input.mc_version != mc_version || !safe_mc_version_or_snapshot(mc_version) {
        return Err(AppError::Validation(
            "Minecraft version must be a dot-separated numeric version ID".to_string(),
        ));
    }
    if input.name.trim().is_empty()
        || input.name.trim().len() > 64
        || input
            .name
            .chars()
            .any(|c| c == '\n' || c == '\r' || c == '=')
    {
        return Err(AppError::Validation(
            "server name must be 1–64 characters and must not contain newlines or '='".to_string(),
        ));
    }
    if !(512..=65536).contains(&input.ram_mb) {
        return Err(AppError::Validation(
            "ram must be between 512 and 65536 MB".to_string(),
        ));
    }
    if input
        .java_path
        .as_deref()
        .map_or(true, |path| path.trim().is_empty())
    {
        return Err(AppError::Validation(
            "select or install a compatible Java runtime before installing the server".to_string(),
        ));
    }
    crate::java::validate_java_for_version(
        input.java_path.as_deref().unwrap_or_default(),
        input.mc_version.trim(),
    )?;
    Ok(())
}

fn validate_modpack_install_request(
    input: &crate::modpacks::install::ModpackInstallInput,
    project_id: &str,
    version_id: &str,
    job_id: &str,
) -> Result<CreateServerInput, AppError> {
    paths::validate_id(job_id)?;
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err(AppError::Validation(
            "Modrinth modpack installation is supported on Windows x64 only".to_string(),
        ));
    }
    if !crate::modpacks::install::valid_modrinth_id(project_id)
        || !crate::modpacks::install::valid_modrinth_id(version_id)
    {
        return Err(AppError::Validation(
            "Modrinth project and version IDs must be eight-character IDs".to_string(),
        ));
    }
    if input.minecraft_version.trim() != input.minecraft_version
        || !safe_minecraft_version(&input.minecraft_version)
    {
        return Err(AppError::Validation(
            "Minecraft version must be a dot-separated numeric version ID".to_string(),
        ));
    }
    if input.name.trim().is_empty()
        || input.name.trim().len() > 64
        || input
            .name
            .chars()
            .any(|character| character == '\n' || character == '\r' || character == '=')
    {
        return Err(AppError::Validation(
            "server name must be 1–64 characters and must not contain newlines or '='".to_string(),
        ));
    }
    if !(512..=65536).contains(&input.ram_mb) {
        return Err(AppError::Validation(
            "ram must be between 512 and 65536 MB".to_string(),
        ));
    }
    let loader = match input.loader.as_str() {
        "minecraft" => "Vanilla",
        "fabric" => "Fabric",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => {
            return Err(AppError::Validation(
                "Modrinth pack loader must be minecraft, fabric, forge, or neoforge".to_string(),
            ));
        }
    };
    let java_path = input
        .java_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation(
                "select or install a compatible Java runtime before installing the modpack".into(),
            )
        })?;
    let java = crate::java::validate_java_for_version(java_path, &input.minecraft_version)?;

    Ok(CreateServerInput {
        name: input.name.clone(),
        loader: loader.to_string(),
        mc_version: input.minecraft_version.clone(),
        loader_version: None,
        modpack_id: Some(format!("modrinth:{project_id}:{version_id}")),
        port: input.port,
        ram_mb: input.ram_mb,
        java_path: Some(java.path),
        eula_accepted: Some(input.eula_accepted),
    })
}

fn prepare_modpack_install(
    app: &AppHandle,
    job_id: &str,
    staging: &Path,
    request: crate::modpacks::install::ModpackInstallInput,
    project_id: &str,
    version_id: &str,
    control: &JobControl,
) -> Result<CreateServerInput, AppError> {
    ensure_not_cancelled(control)?;
    let mut server_input =
        validate_modpack_install_request(&request, project_id, version_id, job_id)?;
    fs::create_dir_all(staging.parent().unwrap_or(staging))?;
    fs::create_dir(staging).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Conflict("this install job already has a staging directory".to_string())
        } else {
            error.into()
        }
    })?;
    crate::modpacks::install::ensure_safe_staging(staging)?;
    let archive_path = staging.join("modrinth-pack.mrpack");
    let mut log = InstallLog::create(&staging.join("installer.log"))?;
    log.append("Preparing isolated Modrinth modpack installation.");
    emit_progress(
        app,
        job_id,
        2,
        "Preparing",
        "Preparing isolated Modrinth modpack installation.",
        None,
        None,
    );

    let version_url = format!("https://api.modrinth.com/v2/version/{version_id}");
    let version_json = fetch_modrinth_json_cancellable(&version_url, control)?;
    let version: ModrinthVersionMetadata = serde_json::from_value(version_json)
        .map_err(|_| AppError::Validation("Modrinth returned malformed version metadata".into()))?;
    if version.project_id != project_id {
        return Err(AppError::Validation(
            "the selected Modrinth version does not belong to this project".into(),
        ));
    }
    let mrpack_file = version
        .files
        .iter()
        .filter(|file| file.filename.to_ascii_lowercase().ends_with(".mrpack"))
        .find(|file| file.primary)
        .or_else(|| {
            version
                .files
                .iter()
                .find(|file| file.filename.to_ascii_lowercase().ends_with(".mrpack"))
        })
        .ok_or_else(|| {
            AppError::Validation("the selected Modrinth version has no .mrpack file".into())
        })?;
    if mrpack_file.size == 0
        || mrpack_file.size > crate::modpacks::install::MAX_MRPACK_BYTES
        || !crate::modpacks::install::valid_hash(&mrpack_file.hashes.sha1, 40)
        || !crate::modpacks::install::valid_hash(&mrpack_file.hashes.sha512, 128)
        || !crate::modpacks::install::valid_provider_download_url(&mrpack_file.url)
    {
        return Err(AppError::Validation(
            "Modrinth .mrpack metadata has an invalid size, hash, or download URL".into(),
        ));
    }

    let initial_reserve = mrpack_file
        .size
        .checked_add(BASE_SERVER_RESERVE_BYTES)
        .and_then(|bytes| bytes.checked_add(DISK_HEADROOM_BYTES))
        .ok_or_else(|| AppError::Validation("Modrinth disk estimate overflowed".into()))?;
    ensure_free_space(staging, initial_reserve)?;

    log.append("Downloading the exact selected Modrinth pack version.");
    emit_progress(
        app,
        job_id,
        3,
        "Downloading pack",
        "Downloading the exact selected Modrinth pack version.",
        Some(0),
        Some(mrpack_file.size),
    );
    download_modrinth_file(
        &mrpack_file.url,
        &archive_path,
        mrpack_file.size,
        app,
        job_id,
        control,
        ProgressRange { start: 3, end: 10 },
        0,
        mrpack_file.size,
        "Downloading pack",
        &mut log,
    )?;
    verify_exact_file_size(&archive_path, mrpack_file.size, "Modrinth pack archive")?;
    verify_hash_cancellable(
        &archive_path,
        &mrpack_file.hashes.sha1,
        "SHA1",
        "Modrinth pack archive",
        control,
    )?;
    verify_hash_cancellable(
        &archive_path,
        &mrpack_file.hashes.sha512,
        "SHA512",
        "Modrinth pack archive",
        control,
    )?;

    let plan = crate::modpacks::install::parse_mrpack(
        &archive_path,
        &request.minecraft_version,
        &request.loader,
    )?;
    server_input.loader_version = resolve_modpack_loader_version(&plan, &server_input, control)?;
    let base_reserve = base_server_reserve(&server_input, control)?;
    let required_reserve = plan
        .required_bytes
        .checked_add(plan.override_bytes)
        .and_then(|bytes| bytes.checked_add(base_reserve))
        .and_then(|bytes| bytes.checked_add(DISK_HEADROOM_BYTES))
        .ok_or_else(|| AppError::Validation("Modrinth disk estimate overflowed".into()))?;
    ensure_free_space(staging, required_reserve)?;

    let pack_file_log = format!(
        "Modrinth server files: {} included; {} unsupported skipped.",
        plan.required_files.len(),
        plan.skipped_files
    );
    log.append(&pack_file_log);
    emit_progress(
        app,
        job_id,
        11,
        "Preparing server runtime",
        &pack_file_log,
        None,
        None,
    );
    drop(log);

    prepare_install_with_progress(
        app,
        job_id,
        staging,
        &server_input,
        control,
        MODPACK_BASE_PROGRESS,
        true,
    )?;
    let log = InstallLog::open_append(&staging.join("installer.log"))?;

    let mut required_targets = Vec::with_capacity(plan.required_files.len());
    for file in &plan.required_files {
        ensure_not_cancelled(control)?;
        let target = crate::modpacks::install::safe_target(staging, &file.path)?;
        if let Some(parent) = Path::new(&file.path)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            crate::modpacks::install::ensure_directory_tree(staging, &parent.to_string_lossy())?;
        }
        required_targets.push(target);
    }

    let shared_log = Mutex::new(log);
    let file_progress = ModrinthFileProgress::new(
        app.clone(),
        job_id,
        "Downloading pack files",
        MODPACK_FILE_PROGRESS,
        plan.required_bytes,
    );
    let download_result = run_bounded_modrinth_file_tasks(
        plan.required_files.len(),
        MAX_MODRINTH_FILE_WORKERS,
        |file_index, sibling_stop| {
            let file = &plan.required_files[file_index];
            let target = &required_targets[file_index];
            let mut previous_failure = String::new();
            let part = with_modrinth_file_retries(
                &file.path,
                |attempt_number| {
                    ensure_modrinth_transfer_active(control, Some(sibling_stop))
                        .map_err(ModrinthDownloadFailure::from)?;
                    if attempt_number > 1 {
                        shared_log
                            .lock()
                            .map_err(|_| {
                                AppError::Internal("installer log lock was poisoned".into())
                            })?
                            .append(&format!(
                                "retry {attempt_number}/{MAX_MODRINTH_FILE_ATTEMPTS} for {}: {}",
                                file.path, previous_failure
                            ));
                    }
                    shared_log
                        .lock()
                        .map_err(|_| AppError::Internal("installer log lock was poisoned".into()))?
                        .append(&format!(
                            "Downloading pack file {} (attempt {attempt_number}/{MAX_MODRINTH_FILE_ATTEMPTS}).",
                            file.path
                        ));
                    let part =
                        staging.join(format!("modrinth-download-{}.part", uuid::Uuid::new_v4()));
                    let url = &file.urls[(attempt_number - 1) % file.urls.len()];
                    let attempt: Result<std::path::PathBuf, ModrinthDownloadFailure> = (|| {
                        file_progress.update_active(file_index, 0);
                        let received_size = download_modrinth_required_file(
                            url,
                            &part,
                            file.size,
                            app,
                            job_id,
                            control,
                            sibling_stop,
                            file_index,
                            &file_progress,
                            plan.required_bytes,
                        )?;
                        let undersized = verify_modrinth_required_file_size_and_hashes(
                            received_size,
                            file.size,
                            || {
                                verify_hash_cancellable_with_stop(
                                    &part,
                                    &file.sha1,
                                    "SHA1",
                                    &file.path,
                                    control,
                                    Some(sibling_stop),
                                )
                            },
                            || {
                                verify_hash_cancellable_with_stop(
                                    &part,
                                    &file.sha512,
                                    "SHA512",
                                    &file.path,
                                    control,
                                    Some(sibling_stop),
                                )
                            },
                        )
                        .map_err(|error| {
                            if control.is_cancelled() || sibling_stop.load(Ordering::Acquire) {
                                ModrinthDownloadFailure::terminal(error)
                            } else {
                                ModrinthDownloadFailure::retryable(error)
                            }
                        })?;
                        if undersized {
                            shared_log
                                .lock()
                                .map_err(|_| {
                                    AppError::Internal("installer log lock was poisoned".into())
                                })?
                                .append(&format!(
                                    "Accepted undersized Modrinth file {} ({received_size} of {} bytes) after SHA1 and SHA512 verification.",
                                    file.path, file.size
                                ));
                        }
                        Ok(part.clone())
                    })(
                    );
                    if let Err(error) = &attempt {
                        previous_failure = error.message();
                        file_progress.rollback(file_index);
                        let _ = fs::remove_file(&part);
                    }
                    attempt
                },
                |delay| wait_for_modrinth_file_retry_with_stop(control, sibling_stop, delay),
            )?;

            let placement = (|| -> Result<u64, AppError> {
                ensure_modrinth_transfer_active(control, Some(sibling_stop))?;
                crate::modpacks::install::remove_existing_regular_file(target)?;
                fs::rename(&part, target)?;
                Ok(fs::metadata(target)?.len())
            })();
            match placement {
                Ok(received_size) => {
                    file_progress.complete(file_index, received_size);
                    Ok(())
                }
                Err(error) => {
                    file_progress.rollback(file_index);
                    let _ = fs::remove_file(&part);
                    Err(error)
                }
            }
        },
    );
    let mut log = shared_log
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    download_result?;
    if plan.required_files.is_empty() {
        emit_progress(
            app,
            job_id,
            MODPACK_FILE_PROGRESS.end,
            "Downloading pack files",
            "No server-supported manifest files require downloading.",
            Some(0),
            Some(0),
        );
    } else {
        emit_progress(
            app,
            job_id,
            MODPACK_FILE_PROGRESS.end,
            "Downloading pack files",
            "All included server files passed their size and hash checks.",
            Some(plan.required_bytes),
            Some(plan.required_bytes),
        );
    }

    if server_input.loader == "Fabric" {
        ensure_not_cancelled(control)?;
        log.append("Checking the effective Fabric mod set, including override JARs, before applying overrides.");
        emit_progress(
            app,
            job_id,
            MODPACK_FILE_PROGRESS.end,
            "Checking mod runtime",
            "Checking the effective Fabric mod set before applying server overrides.",
            Some(plan.required_bytes),
            Some(plan.required_bytes),
        );
        let java_path = server_input.java_path.as_deref().ok_or_else(|| {
            AppError::Validation(
                "select or install a compatible Java runtime before installation".into(),
            )
        })?;
        let java = crate::java::validate_java_for_version(java_path, &server_input.mc_version)?;
        crate::modpacks::install::validate_fabric_mod_java_constraints_with_overrides(
            staging,
            java.major,
            &archive_path,
            &plan,
            Some(control),
        )?;
        log.append("The effective Fabric mod set passed the Java compatibility preflight.");
        let dependency_check_complete =
            crate::modpacks::install::validate_fabric_mod_hard_dependencies_with_overrides(
                staging,
                &archive_path,
                &plan,
                Some(control),
            )?;
        if dependency_check_complete {
            log.append("Fabric hard dependency preflight completed.");
        } else {
            log.append("WARNING: Fabric hard dependency preflight was incomplete; some metadata or candidates exceeded the inspection bounds.");
        }
    }

    let mut copied_override_bytes = 0u64;
    for server_layer in [false, true] {
        ensure_not_cancelled(control)?;
        let layer_name = if server_layer {
            "server-overrides"
        } else {
            "overrides"
        };
        let copied = crate::modpacks::install::apply_override_layer(
            &archive_path,
            &plan,
            staging,
            server_layer,
            control,
            copied_override_bytes,
            plan.override_bytes,
            |completed, total| {
                let message = format!("Applied {completed} of {total} override bytes.");
                log.append(&message);
                emit_progress(
                    app,
                    job_id,
                    MODPACK_OVERRIDE_PROGRESS.map_fraction(completed, total),
                    "Applying server overrides",
                    &message,
                    Some(completed),
                    Some(total),
                );
            },
        )?;
        copied_override_bytes = copied_override_bytes
            .checked_add(copied)
            .ok_or_else(|| AppError::Validation("Modrinth override size overflowed".into()))?;
        log.append(&format!("Applied {layer_name} layer."));
    }
    if plan.override_bytes == 0 {
        emit_progress(
            app,
            job_id,
            MODPACK_OVERRIDE_PROGRESS.end,
            "Applying server overrides",
            "This pack has no server overrides.",
            Some(0),
            Some(0),
        );
    }
    drop(log);
    fs::remove_file(&archive_path)?;

    ensure_not_cancelled(control)?;
    log = InstallLog::open_append(&staging.join("installer.log"))?;
    log.append("Revalidating the exact Modrinth runtime before publication.");
    if is_modpack_fabric_exact(&server_input) {
        let loader = server_input.loader_version.as_deref().ok_or_else(|| {
            AppError::Validation("Modrinth Fabric pack is missing its exact loader version".into())
        })?;
        verify_modpack_fabric_build(&server_input.mc_version, loader, control)?;
    } else {
        let choices = resolve_loader_choices(&server_input.mc_version, Some(control))?;
        if !choices.iter().any(|choice| {
            choice.loader == server_input.loader
                && choice.version.as_deref() == server_input.loader_version.as_deref()
        }) {
            return Err(AppError::Validation(
                "the exact Minecraft or loader build is no longer provider-verified".into(),
            ));
        }
    }
    let mut final_dependency_check_complete = true;
    if server_input.loader == "Fabric" {
        let java_path = server_input.java_path.as_deref().ok_or_else(|| {
            AppError::Validation(
                "select or install a compatible Java runtime before installation".into(),
            )
        })?;
        let java = crate::java::validate_java_for_version(java_path, &server_input.mc_version)?;
        crate::modpacks::install::validate_fabric_mod_java_constraints_with_control(
            staging,
            java.major,
            Some(control),
        )?;
        let dependency_check_complete =
            crate::modpacks::install::validate_fabric_mod_hard_dependencies(
                staging,
                &plan.skipped_server_paths,
                Some(control),
            )?;
        final_dependency_check_complete = dependency_check_complete;
        if dependency_check_complete {
            log.append("Final Fabric hard dependency check passed.");
        } else {
            log.append("WARNING: final Fabric hard dependency check was incomplete; some metadata or candidates exceeded the inspection bounds.");
        }
    }
    crate::servers::process::resolve_launch_mode(
        staging,
        &server_input.loader,
        &server_input.mc_version,
        server_input.loader_version.as_deref(),
    )?;
    ensure_not_cancelled(control)?;
    let (final_stage, final_message) = if final_dependency_check_complete {
        (
            "Validated",
            "Modrinth pack files, overrides, and runtime validation passed.",
        )
    } else {
        (
            "Validated with warnings",
            "Modrinth installation completed with warnings: the final Fabric hard dependency scan was incomplete. Check installer warnings before starting.",
        )
    };
    log.append(final_message);
    emit_progress(app, job_id, 94, final_stage, final_message, None, None);
    drop(log);
    Ok(server_input)
}

fn resolve_modpack_loader_version(
    plan: &crate::modpacks::install::ManifestPlan,
    input: &CreateServerInput,
    control: &JobControl,
) -> Result<Option<String>, AppError> {
    let expected_loader = match plan.loader.as_str() {
        "minecraft" => "Vanilla",
        "fabric" => "Fabric",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => return Err(AppError::Validation("unsupported Modrinth loader".into())),
    };
    if input.loader != expected_loader {
        return Err(AppError::Validation(
            "Modrinth pack loader does not match the selected loader".into(),
        ));
    }
    if plan.loader == "fabric" {
        let loader_version = plan.loader_version.as_deref().ok_or_else(|| {
            AppError::Validation("Modrinth Fabric pack is missing its exact loader version".into())
        })?;
        verify_modpack_fabric_build(&input.mc_version, loader_version, control)?;
        return Ok(Some(loader_version.to_string()));
    }
    let choices = resolve_loader_choices(&input.mc_version, Some(control))?;
    let choice = choices
        .iter()
        .find(|choice| {
            if choice.loader != expected_loader {
                return false;
            }
            match (
                plan.loader.as_str(),
                choice.version.as_deref(),
                plan.loader_version.as_deref(),
            ) {
                ("minecraft", None, None) => true,
                ("forge", Some(candidate), Some(selected)) => {
                    candidate.split_once(':').map(|(_, build)| build) == Some(selected)
                }
                (_, Some(candidate), Some(selected)) => candidate == selected,
                _ => false,
            }
        })
        .ok_or_else(|| {
            AppError::Validation(
                "the Modrinth pack's exact loader build is not currently provider-verified".into(),
            )
        })?;
    Ok(choice.version.clone())
}

fn base_server_reserve(input: &CreateServerInput, control: &JobControl) -> Result<u64, AppError> {
    let artifact = resolve_install_artifact(input, control)?;
    let (size, is_installer) = match artifact {
        InstallArtifact::Jar { download, .. } => (download.size, false),
        InstallArtifact::Installer { download, .. } => (download.size, true),
    };
    let estimate = size.unwrap_or(BASE_SERVER_RESERVE_BYTES);
    Ok(if is_installer {
        estimate.max(BASE_SERVER_RESERVE_BYTES)
    } else {
        estimate.max(64 * 1024 * 1024)
    })
}

fn ensure_free_space(path: &Path, required: u64) -> Result<(), AppError> {
    let available = crate::java::free_disk_space(path)?;
    if available < required {
        return Err(AppError::Validation(format!(
            "not enough free disk space for this Modrinth pack (need {required} bytes, have {available})"
        )));
    }
    Ok(())
}

fn verify_exact_file_size(path: &Path, expected: u64, name: &str) -> Result<(), AppError> {
    let actual = fs::metadata(path)?.len();
    if actual != expected {
        return Err(AppError::Validation(format!(
            "size verification failed for {name} (expected {expected} bytes, got {actual})"
        )));
    }
    Ok(())
}

fn verify_modrinth_required_file_size_and_hashes<S1, S512>(
    actual: u64,
    expected: u64,
    verify_sha1: S1,
    verify_sha512: S512,
) -> Result<bool, AppError>
where
    S1: FnOnce() -> Result<(), AppError>,
    S512: FnOnce() -> Result<(), AppError>,
{
    if actual == 0 {
        return Err(AppError::Validation(
            "Modrinth pack file download returned an empty file".into(),
        ));
    }
    if actual > expected {
        return Err(oversized_download_error(expected));
    }
    let undersized = actual < expected;
    verify_sha1()?;
    verify_sha512()?;
    Ok(undersized)
}

fn prepare_install(
    app: &AppHandle,
    job_id: &str,
    staging: &Path,
    input: &CreateServerInput,
    control: &JobControl,
) -> Result<(), AppError> {
    prepare_install_with_progress(
        app,
        job_id,
        staging,
        input,
        control,
        ProgressRange { start: 3, end: 94 },
        false,
    )
}

/// Pipeline adapter for the existing exact-pinned runtime artifact installer.
/// The active handlers continue to call `prepare_install_with_progress` with
/// their existing inputs; this adapter only prepares a pipeline staging tree.
pub(crate) fn prepare_pipeline_runtime_artifact(
    app: &AppHandle,
    job_id: &str,
    staging: &Path,
    loader: &str,
    minecraft_version: &str,
    installer_loader_version: Option<&str>,
    java_path: Option<&Path>,
    artifact_url: &str,
    artifact_size: Option<u64>,
    artifact_sha1: Option<&str>,
    allowed_redirect_hosts: &'static [&'static str],
    control: &JobControl,
) -> Result<(), AppError> {
    paths::validate_id(job_id)?;
    ensure_not_cancelled(control)?;
    if matches!(loader, "Forge" | "NeoForge") && java_path.is_none() {
        return Err(AppError::Validation(
            "a compatible Java runtime is required for the official loader installer".into(),
        ));
    }
    let java_path = java_path
        .map(|path| {
            path.to_str().map(str::to_string).ok_or_else(|| {
                AppError::Validation("selected Java path is not valid Unicode".into())
            })
        })
        .transpose()?;
    let input = CreateServerInput {
        name: "Modpack pipeline staging".into(),
        loader: loader.to_string(),
        mc_version: minecraft_version.to_string(),
        loader_version: installer_loader_version.map(str::to_string),
        modpack_id: None,
        port: None,
        ram_mb: 2048,
        java_path,
        eula_accepted: Some(false),
    };
    let download = DownloadInfo {
        url: artifact_url.to_string(),
        size: artifact_size,
        sha1: artifact_sha1.map(str::to_ascii_lowercase),
        sha256: None,
    };
    let artifact = match loader {
        "Vanilla" => InstallArtifact::Jar {
            download,
            file_name: "server.jar",
            integrity: Integrity::Sha1,
        },
        "Fabric" => InstallArtifact::Jar {
            download,
            file_name: "server.jar",
            integrity: Integrity::None,
        },
        "Forge" => InstallArtifact::Installer {
            download,
            file_name: "forge-installer.jar",
            args: vec![
                "-jar".into(),
                "forge-installer.jar".into(),
                "--installServer".into(),
            ],
            integrity: Integrity::None,
            warning: None,
        },
        "NeoForge" => InstallArtifact::Installer {
            download,
            file_name: "neoforge-installer.jar",
            args: vec![
                "-jar".into(),
                "neoforge-installer.jar".into(),
                "--installServer".into(),
            ],
            integrity: Integrity::None,
            warning: None,
        },
        other => {
            return Err(AppError::Validation(format!(
                "unsupported pipeline loader {other}"
            )))
        }
    };
    prepare_install_with_artifact_limit(
        app,
        job_id,
        staging,
        &input,
        control,
        ProgressRange { start: 0, end: 94 },
        true,
        Some(MAX_PIPELINE_LOADER_ARTIFACT_BYTES),
        Some(artifact),
        Some(allowed_redirect_hosts),
    )
}

fn prepare_install_with_progress(
    app: &AppHandle,
    job_id: &str,
    staging: &Path,
    input: &CreateServerInput,
    control: &JobControl,
    progress: ProgressRange,
    allow_existing_staging: bool,
) -> Result<(), AppError> {
    prepare_install_with_artifact_limit(
        app,
        job_id,
        staging,
        input,
        control,
        progress,
        allow_existing_staging,
        None,
        None,
        None,
    )
}

fn prepare_install_with_artifact_limit(
    app: &AppHandle,
    job_id: &str,
    staging: &Path,
    input: &CreateServerInput,
    control: &JobControl,
    progress: ProgressRange,
    allow_existing_staging: bool,
    maximum_artifact_bytes: Option<u64>,
    pipeline_artifact: Option<InstallArtifact>,
    redirect_hosts: Option<&'static [&'static str]>,
) -> Result<(), AppError> {
    ensure_not_cancelled(control)?;
    fs::create_dir_all(staging.parent().unwrap_or(staging))?;
    if allow_existing_staging {
        if !staging.exists() {
            fs::create_dir(staging)?;
        }
        if !staging.is_dir() {
            return Err(AppError::Validation(
                "installer staging path is not a directory".to_string(),
            ));
        }
        crate::modpacks::install::ensure_safe_staging(staging)?;
    } else {
        fs::create_dir(staging).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::Conflict("this install job already has a staging directory".to_string())
            } else {
                error.into()
            }
        })?;
    }
    let log_path = staging.join("installer.log");
    let mut log = if allow_existing_staging && log_path.exists() {
        InstallLog::open_append(&log_path)?
    } else {
        InstallLog::create(&log_path)?
    };
    log.append("Preparing isolated server installation.");
    emit_progress(
        app,
        job_id,
        progress.map_installer_progress(3),
        "Preparing",
        "Preparing isolated server installation.",
        None,
        None,
    );

    ensure_not_cancelled(control)?;
    log.append("Revalidating current Minecraft and loader metadata.");
    emit_progress(
        app,
        job_id,
        progress.map_installer_progress(8),
        "Resolving compatibility",
        "Revalidating current provider metadata.",
        None,
        None,
    );
    if pipeline_artifact.is_none() {
        if is_modpack_fabric_exact(input) {
            let loader = input.loader_version.as_deref().ok_or_else(|| {
                AppError::Validation(
                    "Modrinth pack is missing its exact Fabric loader version".into(),
                )
            })?;
            verify_modpack_fabric_build(&input.mc_version, loader, control)?;
        } else {
            let choices = resolve_loader_choices(&input.mc_version, Some(control))?;
            let requested_version = input.loader_version.as_deref();
            let selected = choices.iter().find(|choice| {
                choice.loader == input.loader && choice.version.as_deref() == requested_version
            });
            if selected.is_none() {
                return Err(AppError::Validation(format!(
                    "{} is not currently available for Minecraft {}",
                    input.loader, input.mc_version
                )));
            }
        }
    }

    ensure_not_cancelled(control)?;
    let artifact = match pipeline_artifact {
        Some(artifact) => artifact,
        None => resolve_install_artifact(input, control)?,
    };
    let (download, file_name, integrity, warning) = match &artifact {
        InstallArtifact::Jar {
            download,
            file_name,
            integrity,
        } => (download.clone(), *file_name, *integrity, None),
        InstallArtifact::Installer {
            download,
            file_name,
            integrity,
            warning,
            ..
        } => (download.clone(), *file_name, *integrity, warning.clone()),
    };
    let destination = staging.join(file_name);
    if let Some(warning) = warning {
        log.append(&warning);
        emit_progress(
            app,
            job_id,
            progress.map_installer_progress(20),
            "Warning",
            &warning,
            None,
            download.size,
        );
    }
    log.append(&format!("Downloading {}.", file_name));
    emit_progress(
        app,
        job_id,
        progress.map_installer_progress(20),
        "Downloading",
        &format!("Downloading {file_name}."),
        Some(0),
        download.size,
    );
    download_file(
        &download.url,
        &destination,
        download.size,
        maximum_artifact_bytes,
        redirect_hosts,
        app,
        job_id,
        control,
        &mut log,
        progress,
    )?;

    if let Some(size) = download.size {
        let actual = fs::metadata(&destination)?.len();
        if actual != size {
            return Err(AppError::Validation(format!(
                "download size verification failed for {file_name} (expected {size} bytes, got {actual})"
            )));
        }
    }
    match integrity {
        Integrity::Sha1 => verify_hash(&destination, download.sha1.as_deref(), "SHA1", file_name)?,
        Integrity::Sha256 => verify_hash(
            &destination,
            download.sha256.as_deref(),
            "SHA256",
            file_name,
        )?,
        Integrity::None => {}
    }

    match artifact {
        InstallArtifact::Installer { args, .. } => {
            ensure_not_cancelled(control)?;
            log.append("Running the official server installer with the selected Java runtime.");
            emit_progress(
                app,
                job_id,
                progress.map_installer_progress(66),
                "Running installer",
                "Running the official server installer.",
                None,
                None,
            );
            run_installer(
                input.java_path.as_deref().ok_or_else(|| {
                    AppError::Validation("a compatible Java runtime is required".to_string())
                })?,
                &destination,
                &args,
                app,
                job_id,
                control,
                &mut log,
                progress,
            )?;
        }
        InstallArtifact::Jar { file_name, .. } => {
            if file_name != "server.jar" {
                return Err(AppError::Internal("unexpected server artifact name".into()));
            }
            if fs::metadata(&destination)?.len() == 0 {
                return Err(AppError::Validation(
                    "downloaded server JAR is empty".to_string(),
                ));
            }
        }
    }

    crate::servers::process::resolve_launch_mode(
        staging,
        &input.loader,
        &input.mc_version,
        input.loader_version.as_deref(),
    )?;
    ensure_not_cancelled(control)?;
    log.append("Provider artifact validation passed.");
    emit_progress(
        app,
        job_id,
        progress.map_installer_progress(94),
        "Validated",
        "Provider artifact validation passed.",
        None,
        None,
    );
    Ok(())
}

fn resolve_vanilla_versions() -> Result<Vec<MinecraftVersion>, AppError> {
    let entries = vanilla_manifest_entries(None)?;
    Ok(entries
        .into_iter()
        .filter(|entry| is_listable_manifest_type(&entry.version_type))
        .map(|entry| MinecraftVersion {
            id: entry.id,
            release_time: entry.release_time,
            version_type: entry.version_type,
        })
        .collect())
}

fn resolve_paper_versions() -> Result<Vec<MinecraftVersion>, AppError> {
    let official = resolve_vanilla_versions()?;
    let project = fetch_json(&format!("{PAPER_PROJECT}"), None, Some(USER_AGENT))?;
    let listed = project
        .get("versions")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            AppError::Validation("Paper metadata did not contain a version catalogue".to_string())
        })?;
    let mut result = Vec::new();
    for version in official {
        let supported_by_paper = listed.values().any(|group| {
            group
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(&version.id)))
        });
        if !supported_by_paper || paper_builds(&version.id, None)?.is_empty() {
            continue;
        }
        result.push(version);
    }
    Ok(result)
}

fn resolve_loader_choices(
    mc_version: &str,
    control: Option<&JobControl>,
) -> Result<Vec<LoaderChoice>, AppError> {
    ensure_supported_mc(mc_version)?;
    let manifest = vanilla_manifest_entries(control)?;
    if !manifest
        .iter()
        .any(|entry| entry.id == mc_version && is_listable_manifest_type(&entry.version_type))
    {
        return Err(AppError::Validation(format!(
            "Minecraft {mc_version} is not an official release in the Mojang manifest"
        )));
    }

    let mut choices = vec![LoaderChoice {
        loader: "Vanilla".to_string(),
        version: None,
        label: "Vanilla".to_string(),
        stable: None,
    }];

    for build in paper_builds(mc_version, control)? {
        let is_stable = build.channel == "STABLE";
        let label = if is_stable {
            format!("Paper stable build {}", build.id)
        } else if build.channel.is_empty() {
            format!("Paper build {} (non-stable)", build.id)
        } else {
            format!("Paper {} build {}", build.channel, build.id)
        };
        choices.push(LoaderChoice {
            loader: "Paper".to_string(),
            version: Some(build.id.clone()),
            label,
            stable: Some(is_stable),
        });
    }

    let fabric_url = format!("{FABRIC_META}/versions/loader/{mc_version}");
    let mut fabric_entries: Vec<(bool, String)> = Vec::new();
    for item in fetch_json(&fabric_url, control, None)?
        .as_array()
        .into_iter()
        .flatten()
    {
        let loader = item.get("loader").unwrap_or(item);
        let stable = loader.get("stable").and_then(Value::as_bool) == Some(true);
        if let Some(version) = loader.get("version").and_then(Value::as_str) {
            if safe_version_segment(version) {
                fabric_entries.push((stable, version.to_string()));
            }
        }
    }
    fabric_entries.sort_by(|a, b| b.0.cmp(&a.0));
    for (stable, version) in fabric_entries {
        choices.push(LoaderChoice {
            loader: "Fabric".to_string(),
            version: Some(version.clone()),
            label: fabric_choice_label(&version, stable),
            stable: Some(stable),
        });
    }

    let promotions = forge_promotions(control)?;
    let catalogue = forge_catalogue(control)?;
    let catalogue_artifacts = forge_catalogue_artifacts(&catalogue, mc_version)?;
    let mut promoted_builds: Vec<String> = Vec::new();
    for promotion in ["recommended", "latest"] {
        let key = format!("{mc_version}-{promotion}");
        if let Some(version) = promotions.get(&key).and_then(Value::as_str) {
            if safe_version_segment(version) {
                let selected = format!("{promotion}:{version}");
                choices.push(LoaderChoice {
                    loader: "Forge".to_string(),
                    version: Some(selected),
                    label: format!("Forge {promotion} ({version})"),
                    stable: Some(true),
                });
                promoted_builds.push(version.to_string());
            }
        }
    }
    for artifact in catalogue_artifacts {
        let build = forge_build_from_artifact(&artifact, mc_version);
        if promoted_builds.iter().any(|v| v == &build) {
            continue;
        }
        if !safe_version_segment(&build) {
            continue;
        }
        choices.push(LoaderChoice {
            loader: "Forge".to_string(),
            version: Some(format!("specific:{artifact}")),
            label: format!("Forge {build} (specific version)"),
            stable: Some(false),
        });
    }

    for version in neoforge_versions(mc_version, control)? {
        let beta = is_neoforge_beta(&version);
        let label = if beta {
            format!("NeoForge {version} (beta)")
        } else {
            format!("NeoForge {version}")
        };
        choices.push(LoaderChoice {
            loader: "NeoForge".to_string(),
            label,
            version: Some(version),
            stable: Some(!beta),
        });
    }

    Ok(choices)
}

struct PaperBuild {
    id: String,
    channel: String,
    download: DownloadInfo,
}

fn paper_channel_priority(channel: &str) -> u8 {
    match channel {
        "STABLE" => 0,
        "BETA" => 1,
        "ALPHA" => 2,
        _ => 3,
    }
}

fn fabric_choice_label(version: &str, stable: bool) -> String {
    if stable {
        format!("Fabric Loader {version}")
    } else {
        format!("Fabric Loader {version} (non-stable)")
    }
}

fn parse_paper_build(build: &Value) -> Option<PaperBuild> {
    let channel = build
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let id = match build.get("id") {
        Some(Value::String(id)) => id.clone(),
        Some(Value::Number(id)) => id.to_string(),
        _ => return None,
    };
    let download = build
        .get("downloads")
        .and_then(|downloads| downloads.get("server:default"))?;
    let url = download.get("url").and_then(Value::as_str)?;
    let size = download.get("size").and_then(Value::as_u64)?;
    let sha256 = download
        .get("checksums")
        .and_then(|checksums| checksums.get("sha256"))
        .and_then(Value::as_str)?;
    if !trusted_https_url(url, &["fill-data.papermc.io"]) || !valid_hash(sha256, 64) {
        return None;
    }
    Some(PaperBuild {
        id,
        channel,
        download: DownloadInfo {
            url: url.to_string(),
            size: Some(size),
            sha1: None,
            sha256: Some(sha256.to_ascii_lowercase()),
        },
    })
}

fn paper_builds(
    mc_version: &str,
    control: Option<&JobControl>,
) -> Result<Vec<PaperBuild>, AppError> {
    let url = format!("{PAPER_PROJECT}/versions/{mc_version}/builds");
    let value = fetch_json(&url, control, Some(USER_AGENT))?;
    parse_paper_builds_value(&value, mc_version)
}

fn parse_paper_builds_value(value: &Value, mc_version: &str) -> Result<Vec<PaperBuild>, AppError> {
    let Some(builds) = value.as_array() else {
        return Err(AppError::Validation(format!(
            "Paper returned invalid build metadata for Minecraft {mc_version}"
        )));
    };
    let mut result = Vec::new();
    for build in builds {
        if let Some(parsed) = parse_paper_build(build) {
            result.push(parsed);
        }
    }
    result.sort_by(|a, b| {
        paper_channel_priority(&a.channel)
            .cmp(&paper_channel_priority(&b.channel))
            .then_with(|| compare_numeric_versions(&b.id, &a.id))
    });
    Ok(result)
}

fn vanilla_manifest_entries(
    control: Option<&JobControl>,
) -> Result<Vec<VersionManifestEntry>, AppError> {
    let value = fetch_json(MOJANG_MANIFEST, control, None)?;
    let entries = value
        .get("versions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::Validation("Mojang metadata did not contain a version catalogue".to_string())
        })?;
    let mut result = Vec::new();
    for entry in entries {
        let Ok(parsed) = serde_json::from_value::<VersionManifestEntry>(entry.clone()) else {
            continue;
        };
        if is_listable_manifest_type(&parsed.version_type)
            && safe_manifest_id(&parsed.id, &parsed.version_type)
        {
            result.push(parsed);
        }
    }
    Ok(result)
}

fn resolve_install_artifact(
    input: &CreateServerInput,
    control: &JobControl,
) -> Result<InstallArtifact, AppError> {
    let mc = input.mc_version.as_str();
    let selected = input.loader_version.as_deref();
    match input.loader.as_str() {
        "Vanilla" => {
            if selected.is_some() {
                return Err(AppError::Validation(
                    "Vanilla does not have a loader version".into(),
                ));
            }
            let entry = vanilla_manifest_entries(Some(control))?
                .into_iter()
                .find(|entry| entry.id == mc && is_listable_manifest_type(&entry.version_type))
                .ok_or_else(|| AppError::Validation(format!("Minecraft {mc} is unavailable")))?;
            if !trusted_https_url(&entry.url, &["piston-meta.mojang.com"]) {
                return Err(AppError::Validation(
                    "Mojang version metadata URL was not trusted".into(),
                ));
            }
            let version_json = fetch_json(&entry.url, Some(control), None)?;
            let server = version_json
                .get("downloads")
                .and_then(|v| v.get("server"))
                .ok_or_else(|| {
                    AppError::Validation("Mojang metadata has no server download".into())
                })?;
            let url = required_str(server, "url", "Mojang server download URL")?;
            let size = server.get("size").and_then(Value::as_u64).ok_or_else(|| {
                AppError::Validation("Mojang server download size is missing".into())
            })?;
            let sha1 = required_str(server, "sha1", "Mojang server SHA-1")?;
            if !trusted_https_url(url, &["piston-data.mojang.com", "launcher.mojang.com"])
                || !valid_hash(sha1, 40)
            {
                return Err(AppError::Validation(
                    "Mojang server artifact metadata is invalid".into(),
                ));
            }
            Ok(InstallArtifact::Jar {
                download: DownloadInfo {
                    url: url.to_string(),
                    size: Some(size),
                    sha1: Some(sha1.to_ascii_lowercase()),
                    sha256: None,
                },
                file_name: "server.jar",
                integrity: Integrity::Sha1,
            })
        }
        "Paper" => {
            let build_id =
                selected.ok_or_else(|| AppError::Validation("select a Paper build".into()))?;
            let build = paper_builds(mc, Some(control))?
                .into_iter()
                .find(|build| build.id == build_id)
                .ok_or_else(|| {
                    AppError::Validation("the selected Paper build is no longer available".into())
                })?;
            Ok(InstallArtifact::Jar {
                download: build.download,
                file_name: "server.jar",
                integrity: Integrity::Sha256,
            })
        }
        "Fabric" => {
            let loader = selected
                .ok_or_else(|| AppError::Validation("select a Fabric loader version".into()))?;
            if is_modpack_fabric_exact(input) {
                verify_modpack_fabric_build(mc, loader, control)?;
            } else {
                validate_fabric_loader(mc, loader, control)?;
            }
            let installer = latest_fabric_installer(control)?;
            let url = format!("{FABRIC_META}/versions/loader/{mc}/{loader}/{installer}/server/jar");
            Ok(InstallArtifact::Jar {
                download: DownloadInfo {
                    url,
                    size: None,
                    sha1: None,
                    sha256: None,
                },
                file_name: "server.jar",
                integrity: Integrity::None,
            })
        }
        "Forge" => {
            let selected =
                selected.ok_or_else(|| AppError::Validation("select a Forge version".into()))?;
            let (promotion, version) = selected.split_once(':').ok_or_else(|| {
                AppError::Validation(
                    "Forge choice must include its recommended/latest/specific label".into(),
                )
            })?;
            if !matches!(promotion, "recommended" | "latest" | "specific")
                || !safe_version_segment(version)
            {
                return Err(AppError::Validation("invalid Forge version choice".into()));
            }
            let catalogue = forge_catalogue(Some(control))?;
            let catalogue_artifacts = forge_catalogue_artifacts(&catalogue, mc)?;
            let artifact_version = if promotion == "specific" {
                if !catalogue_artifacts.iter().any(|a| a == version) {
                    return Err(AppError::Validation(
                        "the selected Forge version is no longer available".into(),
                    ));
                }
                version.to_string()
            } else {
                let promotions = forge_promotions(Some(control))?;
                if promotions
                    .get(&format!("{mc}-{promotion}"))
                    .and_then(Value::as_str)
                    != Some(version)
                {
                    return Err(AppError::Validation(
                        "the selected Forge promotion has changed".into(),
                    ));
                }
                let artifact = resolve_forge_promotion_artifact(mc, version, &catalogue_artifacts)?;
                artifact
            };
            let file_name = format!("forge-{artifact_version}-installer.jar");
            let url = format!("https://maven.minecraftforge.net/net/minecraftforge/forge/{artifact_version}/{file_name}");
            Ok(InstallArtifact::Installer {
                download: DownloadInfo {
                    url,
                    size: None,
                    sha1: None,
                    sha256: None,
                },
                file_name: "forge-installer.jar",
                args: vec![
                    "-jar".into(),
                    "forge-installer.jar".into(),
                    "--installServer".into(),
                ],
                integrity: Integrity::None,
                warning: None,
            })
        }
        "NeoForge" => {
            let version =
                selected.ok_or_else(|| AppError::Validation("select a NeoForge version".into()))?;
            if !neoforge_versions(mc, Some(control))?
                .iter()
                .any(|v| v == version)
            {
                return Err(AppError::Validation(
                    "the selected NeoForge version is no longer compatible".into(),
                ));
            }
            let file_name = format!("neoforge-{version}-installer.jar");
            let url = format!(
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/{version}/{file_name}"
            );
            Ok(InstallArtifact::Installer {
                download: DownloadInfo {
                    url,
                    size: None,
                    sha1: None,
                    sha256: None,
                },
                file_name: "neoforge-installer.jar",
                args: vec![
                    "-jar".into(),
                    "neoforge-installer.jar".into(),
                    "--installServer".into(),
                ],
                integrity: Integrity::None,
                warning: None,
            })
        }
        _ => Err(AppError::Validation(format!(
            "unknown server loader '{}'",
            input.loader
        ))),
    }
}

fn is_modpack_fabric_exact(input: &CreateServerInput) -> bool {
    input.loader == "Fabric"
        && input
            .modpack_id
            .as_deref()
            .is_some_and(|id| id.starts_with("modrinth:") || id == "pipeline:exact-loader")
}

fn verify_modpack_fabric_build(
    mc: &str,
    loader_version: &str,
    control: &JobControl,
) -> Result<(), AppError> {
    ensure_supported_mc(mc)?;
    if !safe_version_segment(loader_version) {
        return Err(AppError::Validation(
            "Modrinth pack contains an invalid Fabric loader version".into(),
        ));
    }
    let releases = vanilla_manifest_entries(Some(control))?;
    if !releases
        .iter()
        .any(|entry| entry.id == mc && entry.version_type == "release")
    {
        return Err(AppError::Validation(format!(
            "Minecraft {mc} is not an official release"
        )));
    }
    let metadata = fetch_json(
        &format!("{FABRIC_META}/versions/loader/{mc}/{loader_version}"),
        Some(control),
        None,
    )?;
    validate_exact_fabric_loader_metadata(&metadata, loader_version)
}

fn fabric_loader_version_matches(metadata: &Value, expected_version: &str) -> bool {
    metadata
        .get("loader")
        .and_then(|loader| loader.get("version"))
        .and_then(Value::as_str)
        == Some(expected_version)
}

fn validate_exact_fabric_loader_metadata(
    metadata: &Value,
    expected_version: &str,
) -> Result<(), AppError> {
    if fabric_loader_version_matches(metadata, expected_version) {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Fabric Meta did not confirm the exact Modrinth pack loader version".into(),
        ))
    }
}

fn validate_fabric_loader(mc: &str, selected: &str, control: &JobControl) -> Result<(), AppError> {
    ensure_supported_mc(mc)?;
    if !safe_version_segment(selected) {
        return Err(AppError::Validation(
            "the selected Fabric loader is no longer available".into(),
        ));
    }
    let metadata = fetch_json(
        &format!("{FABRIC_META}/versions/loader/{mc}/{selected}"),
        Some(control),
        None,
    )?;
    if fabric_loader_version_matches(&metadata, selected) {
        Ok(())
    } else {
        Err(AppError::Validation(
            "the selected Fabric loader is no longer available".into(),
        ))
    }
}

fn latest_fabric_installer(control: &JobControl) -> Result<String, AppError> {
    let versions = fetch_json(
        &format!("{FABRIC_META}/versions/installer"),
        Some(control),
        None,
    )?;
    versions
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("stable").and_then(Value::as_bool) == Some(true))
        })
        .and_then(|item| item.get("version"))
        .and_then(Value::as_str)
        .filter(|version| safe_version_segment(version))
        .map(str::to_string)
        .ok_or_else(|| AppError::Validation("Fabric has no stable installer available".into()))
}

fn forge_promotions(control: Option<&JobControl>) -> Result<Value, AppError> {
    let value = fetch_json(FORGE_PROMOTIONS, control, None)?;
    value
        .get("promos")
        .cloned()
        .ok_or_else(|| AppError::Validation("Forge promotion metadata is malformed".to_string()))
}

fn forge_catalogue(control: Option<&JobControl>) -> Result<Value, AppError> {
    let value = fetch_json(FORGE_CATALOGUE, control, None)?;
    if value.as_object().is_none() {
        return Err(AppError::Validation(
            "Forge catalogue metadata is malformed".to_string(),
        ));
    }
    Ok(value)
}

fn forge_catalogue_artifacts(catalogue: &Value, mc: &str) -> Result<Vec<String>, AppError> {
    let map = catalogue
        .as_object()
        .ok_or_else(|| AppError::Validation("Forge catalogue metadata is malformed".to_string()))?;
    let Some(entries) = map.get(mc) else {
        return Ok(Vec::new());
    };
    let items = entries
        .as_array()
        .ok_or_else(|| AppError::Validation("Forge catalogue metadata is malformed".to_string()))?;
    let mut artifacts = Vec::new();
    for item in items {
        let Some(entry) = item.as_str() else {
            return Err(AppError::Validation(
                "Forge catalogue metadata is malformed".to_string(),
            ));
        };
        if entry.is_empty() || entry.len() > 96 {
            return Err(AppError::Validation(
                "Forge catalogue metadata is malformed".to_string(),
            ));
        }
        let artifact = if entry.starts_with(&format!("{mc}-")) {
            entry.to_string()
        } else {
            format!("{mc}-{entry}")
        };
        if !safe_version_segment(&artifact) {
            continue;
        }
        artifacts.push(artifact);
    }
    artifacts.sort_by(|a, b| compare_numeric_versions(b, a));
    artifacts.dedup();
    Ok(artifacts)
}

fn forge_build_from_artifact(artifact: &str, mc: &str) -> String {
    artifact
        .strip_prefix(&format!("{mc}-"))
        .unwrap_or(artifact)
        .to_string()
}

fn resolve_forge_promotion_artifact(
    mc: &str,
    version: &str,
    catalogue_artifacts: &[String],
) -> Result<String, AppError> {
    let exact = format!("{mc}-{version}");
    if catalogue_artifacts.iter().any(|a| a == &exact) {
        return Ok(exact);
    }
    let mut suffixed: Vec<&String> = catalogue_artifacts
        .iter()
        .filter(|artifact| {
            let build = forge_build_from_artifact(artifact, mc);
            build.starts_with(&format!("{version}-")) || build.starts_with(&format!("{version}+"))
        })
        .collect();
    suffixed.sort();
    suffixed.dedup();
    if suffixed.len() == 1 {
        return Ok(suffixed[0].clone());
    }
    Err(AppError::Validation(
        "the selected Forge promotion is no longer available".into(),
    ))
}

fn neoforge_versions(mc: &str, control: Option<&JobControl>) -> Result<Vec<String>, AppError> {
    let Some(prefix) = neoforge_prefix(mc) else {
        return Ok(Vec::new());
    };
    let xml = fetch_text(NEOFORGE_METADATA, control, None)?;
    let mut versions = Vec::new();
    let mut rest = xml.as_str();
    while let Some(start) = rest.find("<version>") {
        rest = &rest[start + "<version>".len()..];
        let Some(end) = rest.find("</version>") else {
            break;
        };
        let version = rest[..end].trim();
        if version.starts_with(prefix) && safe_version_segment(version) {
            versions.push(version.to_string());
        }
        rest = &rest[end + "</version>".len()..];
    }
    versions.sort_by(|a, b| {
        is_neoforge_beta(a)
            .cmp(&is_neoforge_beta(b))
            .then_with(|| compare_numeric_versions(b, a))
    });
    versions.dedup();
    Ok(versions)
}

fn neoforge_prefix(mc: &str) -> Option<&'static str> {
    match mc {
        // NeoForge kept the Forge-style 47.x line for Minecraft 1.20.1,
        // then adopted its documented MC minor/patch version mapping.
        "1.20.1" => Some("47."),
        "1.20.4" => Some("20.4."),
        "1.20.6" => Some("20.6."),
        "1.21" => Some("21.0."),
        _ => None,
    }
}

fn is_neoforge_beta(version: &str) -> bool {
    version.to_ascii_lowercase().contains("beta")
}

fn ensure_supported_mc(mc: &str) -> Result<(), AppError> {
    if safe_mc_version_or_snapshot(mc) {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Minecraft version must be a dot-separated numeric version ID".to_string(),
        ))
    }
}

// Installer resolution verifies Mojang release metadata before publication.
// This synchronous guard keeps persisted IDs path-safe without a static catalogue.
pub fn supported_minecraft_version(mc: &str) -> bool {
    safe_mc_version_or_snapshot(mc)
}

fn fetch_json(
    url: &str,
    control: Option<&JobControl>,
    user_agent: Option<&str>,
) -> Result<Value, AppError> {
    let text = fetch_text(url, control, user_agent)?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::Validation(format!("provider returned malformed JSON: {e}")))
}

pub(crate) fn fetch_modrinth_json(url: &str) -> Result<Value, AppError> {
    if !url.starts_with("https://api.modrinth.com/v2/")
        || !trusted_https_url(url, &["api.modrinth.com"])
    {
        return Err(AppError::Validation(
            "refusing Modrinth API URL outside the official v2 host".into(),
        ));
    }
    let body = with_modrinth_retries(|| fetch_modrinth_response(url), thread::sleep)?;
    let text = String::from_utf8(body)
        .map_err(|_| AppError::Validation("Modrinth response was not valid UTF-8".into()))?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::Validation(format!("Modrinth returned malformed JSON: {e}")))
}

fn fetch_modrinth_json_cancellable(url: &str, control: &JobControl) -> Result<Value, AppError> {
    if !url.starts_with("https://api.modrinth.com/v2/")
        || !trusted_https_url(url, &["api.modrinth.com"])
    {
        return Err(AppError::Validation(
            "refusing Modrinth API URL outside the official v2 host".into(),
        ));
    }
    let mut retries = 0usize;
    let body = loop {
        ensure_not_cancelled(control)?;
        let response = fetch_modrinth_response_with_control(url, Some(control))?;
        if response.status == 429 {
            if retries >= MAX_MODRINTH_RETRIES {
                return Err(AppError::Validation(
                    "Modrinth rate limit remained after bounded retries".into(),
                ));
            }
            let delay = modrinth_retry_delay(&response, retries);
            let mut remaining = delay;
            while !remaining.is_zero() {
                ensure_not_cancelled(control)?;
                let interval = remaining.min(CANCEL_POLL);
                thread::sleep(interval);
                remaining = remaining.saturating_sub(interval);
            }
            retries += 1;
            continue;
        }
        if (300..400).contains(&response.status) {
            return Err(AppError::Validation(
                "Modrinth API redirects are refused".into(),
            ));
        }
        if !(200..300).contains(&response.status) {
            return Err(AppError::Validation(format!(
                "Modrinth API returned HTTP {}",
                response.status
            )));
        }
        break response.body;
    };
    let text = String::from_utf8(body)
        .map_err(|_| AppError::Validation("Modrinth response was not valid UTF-8".into()))?;
    serde_json::from_str(&text)
        .map_err(|error| AppError::Validation(format!("Modrinth returned malformed JSON: {error}")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModrinthHttpResponse {
    status: u16,
    ratelimit_remaining: Option<u64>,
    ratelimit_reset: Option<u64>,
    body: Vec<u8>,
}

fn fetch_modrinth_response(url: &str) -> Result<ModrinthHttpResponse, AppError> {
    fetch_modrinth_response_with_control(url, None)
}

fn fetch_modrinth_response_with_control(
    url: &str,
    control: Option<&JobControl>,
) -> Result<ModrinthHttpResponse, AppError> {
    let max_body = MAX_HTTP_BODY.to_string();
    let mut command = Command::new("curl.exe");
    command.args([
        "--disable",
        "--silent",
        "--show-error",
        "--max-time",
        "45",
        "--max-filesize",
        &max_body,
        "--proto",
        "=https",
        "--include",
    ]);
    command
        .args(["--header", &format!("User-Agent: {MODRINTH_USER_AGENT}")])
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("curl stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("curl stderr unavailable".into()))?;
    let out_reader =
        thread::spawn(move || read_limited(stdout, MAX_HTTP_BODY + MAX_HTTP_HEADER_BYTES));
    let err_reader = thread::spawn(move || read_limited(stderr, 8 * 1024));
    let status = loop {
        if control.is_some_and(JobControl::is_cancelled) {
            terminate_child(&mut child);
            let _ = out_reader.join();
            let _ = err_reader.join();
            return Err(cancelled_error());
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(CANCEL_POLL);
    };
    let (stdout, too_large) = out_reader
        .join()
        .map_err(|_| AppError::Internal("curl output reader failed".into()))??;
    let (stderr, _) = err_reader
        .join()
        .map_err(|_| AppError::Internal("curl error reader failed".into()))??;
    if too_large {
        return Err(AppError::Validation(
            "Modrinth response exceeded the bounded header/body limit".into(),
        ));
    }
    if !status.success() {
        let detail = clean_log_text(String::from_utf8_lossy(&stderr).trim());
        return Err(AppError::Validation(if detail.is_empty() {
            format!(
                "Modrinth request failed (curl exit {})",
                status.code().unwrap_or(-1)
            )
        } else {
            format!("Modrinth request failed: {detail}")
        }));
    }
    parse_modrinth_http_response(&stdout)
}

fn parse_modrinth_http_response(raw: &[u8]) -> Result<ModrinthHttpResponse, AppError> {
    let mut block_start = 0;
    loop {
        let relative_end = raw[block_start..]
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .ok_or_else(|| {
                AppError::Validation("Modrinth response headers were incomplete".into())
            })?;
        let header_end = block_start + relative_end;
        let body_start = header_end + 4;
        let header_text = std::str::from_utf8(&raw[block_start..header_end])
            .map_err(|_| AppError::Validation("Modrinth response headers were invalid".into()))?;
        let mut lines = header_text.lines();
        let status_line = lines.next().unwrap_or_default();
        let status = status_line
            .strip_prefix("HTTP/")
            .and_then(|line| line.split_whitespace().next())
            .and_then(|_| status_line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or_else(|| AppError::Validation("Modrinth response status was invalid".into()))?;

        // curl may print an interim response (for example, 100 Continue) or
        // a proxy CONNECT response before the actual API response.
        if raw[body_start..].starts_with(b"HTTP/") {
            block_start = body_start;
            continue;
        }

        let mut ratelimit_remaining = None;
        let mut ratelimit_reset = None;
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let parsed = value.trim().parse::<u64>().ok();
            match name.trim().to_ascii_lowercase().as_str() {
                "x-ratelimit-remaining" => ratelimit_remaining = parsed,
                "x-ratelimit-reset" => ratelimit_reset = parsed,
                _ => {}
            }
        }

        let body = raw[body_start..].to_vec();
        if body.len() > MAX_HTTP_BODY {
            return Err(AppError::Validation(
                "Modrinth response body exceeded the 16 MB limit".into(),
            ));
        }
        return Ok(ModrinthHttpResponse {
            status,
            ratelimit_remaining,
            ratelimit_reset,
            body,
        });
    }
}

fn with_modrinth_retries<F, W>(mut fetch: F, mut wait: W) -> Result<Vec<u8>, AppError>
where
    F: FnMut() -> Result<ModrinthHttpResponse, AppError>,
    W: FnMut(Duration),
{
    let mut retries = 0;
    loop {
        let response = fetch()?;
        if response.status == 429 {
            if retries >= MAX_MODRINTH_RETRIES {
                return Err(AppError::Validation(
                    "Modrinth rate limit remained after bounded retries".into(),
                ));
            }
            wait(modrinth_retry_delay(&response, retries));
            retries += 1;
            continue;
        }
        if (300..400).contains(&response.status) {
            return Err(AppError::Validation(
                "Modrinth API redirects are refused".into(),
            ));
        }
        if !(200..300).contains(&response.status) {
            return Err(AppError::Validation(format!(
                "Modrinth API returned HTTP {}",
                response.status
            )));
        }
        return Ok(response.body);
    }
}

fn modrinth_retry_delay(response: &ModrinthHttpResponse, retry: usize) -> Duration {
    let fallback_ms = 250u64.saturating_mul(1u64 << retry.min(3));
    let reset = response.ratelimit_reset.filter(|seconds| *seconds > 0);
    if response
        .ratelimit_remaining
        .map_or(true, |remaining| remaining == 0)
    {
        if let Some(seconds) = reset {
            return Duration::from_secs(seconds.min(30));
        }
    }
    Duration::from_millis(fallback_ms)
}

#[cfg(test)]
mod modrinth_http_tests {
    use super::*;

    fn response(status: u16, remaining: Option<u64>, reset: Option<u64>) -> ModrinthHttpResponse {
        ModrinthHttpResponse {
            status,
            ratelimit_remaining: remaining,
            ratelimit_reset: reset,
            body: b"{}".to_vec(),
        }
    }

    #[test]
    fn parses_status_rate_headers_and_body() {
        let raw = b"HTTP/2 429 Too Many Requests\r\nx-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 9\r\n\r\nlimited";
        let parsed = parse_modrinth_http_response(raw).unwrap();

        assert_eq!(parsed.status, 429);
        assert_eq!(parsed.ratelimit_remaining, Some(0));
        assert_eq!(parsed.ratelimit_reset, Some(9));
        assert_eq!(parsed.body, b"limited".to_vec());
    }

    #[test]
    fn skips_interim_headers_and_refuses_redirects_without_retrying() {
        let raw = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/2 302 Found\r\nLocation: https://elsewhere.example/\r\n\r\n";
        let parsed = parse_modrinth_http_response(raw).unwrap();
        let mut attempts = 0;
        let error = with_modrinth_retries(
            || {
                attempts += 1;
                Ok(parsed.clone())
            },
            |_| {},
        )
        .unwrap_err();

        assert_eq!(attempts, 1);
        assert!(error.to_string().contains("redirects are refused"));
    }

    #[test]
    fn uses_reset_header_then_returns_success_body() {
        let mut responses = vec![
            response(429, Some(0), Some(7)),
            response(200, Some(2), Some(0)),
        ]
        .into_iter();
        let mut waits = Vec::new();
        let body = with_modrinth_retries(
            || Ok(responses.next().expect("one response per attempt")),
            |delay| waits.push(delay),
        )
        .unwrap();

        assert_eq!(body, b"{}".to_vec());
        assert_eq!(waits, vec![Duration::from_secs(7)]);
    }

    #[test]
    fn bounds_fallback_retries_and_keeps_the_rate_limit_error_visible() {
        let mut attempts = 0;
        let mut waits = Vec::new();
        let error = with_modrinth_retries(
            || {
                attempts += 1;
                Ok(response(429, None, None))
            },
            |delay| waits.push(delay),
        )
        .unwrap_err();

        assert_eq!(attempts, MAX_MODRINTH_RETRIES + 1);
        assert_eq!(
            waits,
            vec![Duration::from_millis(250), Duration::from_millis(500)]
        );
        assert!(error.to_string().contains("rate limit"));
    }
}

fn fetch_text(
    url: &str,
    control: Option<&JobControl>,
    user_agent: Option<&str>,
) -> Result<String, AppError> {
    fetch_text_with_redirect_policy(url, control, user_agent)
}

pub(crate) fn fetch_pipeline_metadata_json(
    url: &str,
    control: &JobControl,
    allowed_hosts: &'static [&'static str],
) -> Result<Value, AppError> {
    let body =
        fetch_pipeline_text_with_redirects(url, control, allowed_hosts, MAX_HTTP_BODY as u64, 45)?;
    serde_json::from_str(&body)
        .map_err(|error| AppError::Validation(format!("provider returned malformed JSON: {error}")))
}

pub(crate) fn fetch_pipeline_metadata_text(
    url: &str,
    control: &JobControl,
    allowed_hosts: &'static [&'static str],
) -> Result<String, AppError> {
    fetch_pipeline_text_with_redirects(url, control, allowed_hosts, MAX_HTTP_BODY as u64, 45)
}

struct PipelineHttpTempDir(std::path::PathBuf);

impl PipelineHttpTempDir {
    fn create() -> Result<Self, AppError> {
        let root = std::env::temp_dir();
        for _ in 0..8 {
            let path = root.join(format!("mc-loader-http-{}", uuid::Uuid::new_v4()));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(AppError::Io(
            "could not create a private loader HTTP response directory".into(),
        ))
    }

    fn body_path(&self) -> std::path::PathBuf {
        self.0.join("response.body")
    }

    fn headers_path(&self) -> std::path::PathBuf {
        self.0.join("response.headers")
    }
}

impl Drop for PipelineHttpTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fetch_pipeline_text_with_redirects(
    url: &str,
    control: &JobControl,
    allowed_hosts: &[&str],
    maximum_body_bytes: u64,
    timeout_seconds: u64,
) -> Result<String, AppError> {
    if !trusted_pipeline_https_url(url, allowed_hosts) {
        return Err(AppError::Validation(
            "loader metadata URL is not HTTPS on its source's approved host".into(),
        ));
    }
    let temporary = PipelineHttpTempDir::create()?;
    let body_path = temporary.body_path();
    let headers_path = temporary.headers_path();
    let mut current = url.to_string();
    let mut redirects = 0usize;
    loop {
        ensure_not_cancelled(control)?;
        let status = run_pipeline_curl_hop(
            &current,
            &body_path,
            &headers_path,
            maximum_body_bytes,
            timeout_seconds,
            control,
            |_| {},
        )?;
        if status == 200 {
            let body_size = fs::metadata(&body_path)?.len();
            if body_size > maximum_body_bytes {
                return Err(AppError::Validation(
                    "loader metadata exceeded its response size limit".into(),
                ));
            }
            let bytes = fs::read(&body_path)?;
            return String::from_utf8(bytes)
                .map_err(|_| AppError::Validation("loader metadata was not valid UTF-8".into()));
        }
        if !is_supported_redirect_status(status) {
            return Err(AppError::Validation(format!(
                "loader metadata request returned HTTP {status}"
            )));
        }
        let location = pipeline_location_header(&headers_path, status)?;
        let target = validate_pipeline_redirect(
            &current,
            &location,
            redirects,
            allowed_hosts,
            "loader metadata",
        )?;
        current = target;
        redirects += 1;
    }
}

fn run_pipeline_curl_hop<F>(
    url: &str,
    body_path: &Path,
    headers_path: &Path,
    maximum_body_bytes: u64,
    timeout_seconds: u64,
    control: &JobControl,
    mut on_progress: F,
) -> Result<u16, AppError>
where
    F: FnMut(u64),
{
    let _ = fs::remove_file(body_path);
    let _ = fs::remove_file(headers_path);
    let max_size = maximum_body_bytes.to_string();
    let timeout = timeout_seconds.to_string();
    let mut command = Command::new(resolve_pipeline_curl_executable()?);
    command.args(PIPELINE_CURL_BASE_OPTIONS);
    command.args([
        "--max-time",
        &timeout,
        "--max-filesize",
        &max_size,
        "--proto",
        "=https",
        "--dump-header",
    ]);
    command
        .arg(headers_path)
        .args(["--output"])
        .arg(body_path)
        .args([
            "--write-out",
            "%{http_code}",
            "--header",
            &format!("User-Agent: {USER_AGENT}"),
        ])
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("curl status output unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("curl stderr unavailable".into()))?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, 64));
    let stderr_reader = thread::spawn(move || read_limited(stderr, 8 * 1024));
    let mut last_progress = Instant::now();
    let status = loop {
        if control.is_cancelled() {
            terminate_child(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let _ = fs::remove_file(body_path);
            let _ = fs::remove_file(headers_path);
            return Err(cancelled_error());
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        let body_size = fs::metadata(body_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let headers_size = fs::metadata(headers_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if body_size > maximum_body_bytes || headers_size > MAX_HTTP_HEADER_BYTES as u64 {
            terminate_child(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let _ = fs::remove_file(body_path);
            let _ = fs::remove_file(headers_path);
            return Err(AppError::Validation(
                "loader HTTP response exceeded its body or header size limit".into(),
            ));
        }
        if last_progress.elapsed() >= Duration::from_millis(700) {
            on_progress(body_size);
            last_progress = Instant::now();
        }
        thread::sleep(CANCEL_POLL);
    };
    let (stdout, stdout_too_large) = stdout_reader
        .join()
        .map_err(|_| AppError::Internal("curl status reader failed".into()))??;
    let (stderr, _) = stderr_reader
        .join()
        .map_err(|_| AppError::Internal("curl error reader failed".into()))??;
    if stdout_too_large {
        return Err(AppError::Validation(
            "curl returned an oversized HTTP status".into(),
        ));
    }
    if !status.success() {
        let detail = clean_log_text(String::from_utf8_lossy(&stderr).trim());
        return Err(AppError::Validation(if detail.is_empty() {
            format!(
                "loader request failed (curl exit {})",
                status.code().unwrap_or(-1)
            )
        } else {
            format!("loader request failed: {detail}")
        }));
    }
    let status_text = String::from_utf8(stdout)
        .map_err(|_| AppError::Validation("curl returned an invalid HTTP status".into()))?;
    let status_code = status_text
        .trim()
        .parse::<u16>()
        .map_err(|_| AppError::Validation("curl returned an invalid HTTP status".into()))?;
    let headers_size = fs::metadata(headers_path)?.len();
    if headers_size == 0 || headers_size > MAX_HTTP_HEADER_BYTES as u64 {
        return Err(AppError::Validation(
            "loader response headers are missing or exceed 64 KiB".into(),
        ));
    }
    let body_size = fs::metadata(body_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if body_size > maximum_body_bytes {
        return Err(AppError::Validation(
            "loader response exceeded its configured body-size limit".into(),
        ));
    }
    Ok(status_code)
}

fn is_supported_redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn pipeline_location_header(headers_path: &Path, expected_status: u16) -> Result<String, AppError> {
    let raw = fs::read(headers_path)?;
    if raw.len() > MAX_HTTP_HEADER_BYTES {
        return Err(AppError::Validation(
            "loader response headers exceed 64 KiB".into(),
        ));
    }
    let headers = String::from_utf8(raw)
        .map_err(|_| AppError::Validation("loader response headers are not valid UTF-8".into()))?;
    parse_pipeline_location_header(&headers, expected_status)
}

fn parse_pipeline_location_header(headers: &str, expected_status: u16) -> Result<String, AppError> {
    let matching = headers
        .split("\r\n\r\n")
        .filter(|block| http_header_status(block) == Some(expected_status))
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err(AppError::Validation(
            "loader redirect response has missing or ambiguous status headers".into(),
        ));
    }
    let locations = matching[0]
        .lines()
        .skip(1)
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("location")
                .then_some(value.trim())
        })
        .collect::<Vec<_>>();
    match locations.as_slice() {
        [location]
            if !location.is_empty()
                && !location.contains(',')
                && !location.chars().any(char::is_control) =>
        {
            Ok((*location).to_string())
        }
        [] => Err(AppError::Validation(
            "loader redirect response is missing its Location header".into(),
        )),
        _ => Err(AppError::Validation(
            "loader redirect response has ambiguous Location headers".into(),
        )),
    }
}

fn http_header_status(block: &str) -> Option<u16> {
    let status_line = block.lines().next()?;
    let mut fields = status_line.split_ascii_whitespace();
    if !fields.next()?.starts_with("HTTP/") {
        return None;
    }
    fields.next()?.parse().ok()
}

fn pipeline_url_host(url: &str) -> Option<&str> {
    let authority = url
        .strip_prefix("https://")?
        .split(['/', '?', '#'])
        .next()?;
    if authority.is_empty() || authority.contains(['@', ':', '\\']) {
        return None;
    }
    Some(authority)
}

fn trusted_pipeline_https_url(url: &str, allowed_hosts: &[&str]) -> bool {
    url.len() <= MAX_PIPELINE_URL_BYTES
        && !url.chars().any(char::is_control)
        && pipeline_url_host(url).is_some_and(|host| {
            allowed_hosts
                .iter()
                .any(|allowed| host.eq_ignore_ascii_case(allowed))
        })
}

fn validate_pipeline_redirect(
    current: &str,
    location: &str,
    redirect_count: usize,
    allowed_hosts: &[&str],
    operation: &str,
) -> Result<String, AppError> {
    if redirect_count >= MAX_PIPELINE_REDIRECTS {
        return Err(AppError::Validation(format!(
            "{operation} exceeded the {MAX_PIPELINE_REDIRECTS}-redirect limit"
        )));
    }
    let target = resolve_pipeline_redirect_target(current, location)?;
    if !trusted_pipeline_https_url(&target, allowed_hosts) {
        let target_host = pipeline_url_host(&target).unwrap_or("invalid host");
        return Err(AppError::Validation(format!(
            "{operation} redirect to unapproved HTTPS host {target_host} was blocked"
        )));
    }
    Ok(target)
}

fn pipeline_curl_executable_path(system_directory: &Path) -> PathBuf {
    system_directory.join("curl.exe")
}

fn validate_pipeline_curl_executable(path: &Path) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        AppError::Validation(format!(
            "trusted system curl.exe is unavailable at '{}': {error}",
            path.display()
        ))
    })?;
    if !metadata.file_type().is_file() || pipeline_is_reparse_point(&metadata) {
        return Err(AppError::Validation(format!(
            "trusted system curl.exe at '{}' is not a regular non-reparse file",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn resolve_pipeline_curl_executable() -> Result<PathBuf, AppError> {
    let system_directory = windows_system_directory()?;
    let executable = pipeline_curl_executable_path(&system_directory);
    validate_pipeline_curl_executable(&executable)?;
    Ok(executable)
}

#[cfg(windows)]
fn windows_system_directory() -> Result<PathBuf, AppError> {
    use std::os::windows::ffi::OsStringExt;

    let mut buffer = vec![0u16; 260];
    loop {
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err(AppError::Validation(format!(
                "could not resolve the Windows system directory for curl.exe: {}",
                std::io::Error::last_os_error()
            )));
        }
        let length = length as usize;
        if length >= buffer.len() {
            if length >= 32_768 {
                return Err(AppError::Validation(
                    "Windows system directory exceeds the supported path limit".into(),
                ));
            }
            buffer.resize(length + 1, 0);
            continue;
        }
        let system_directory = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
        if !system_directory.is_absolute() {
            return Err(AppError::Validation(
                "Windows system directory is not absolute".into(),
            ));
        }
        return Ok(system_directory);
    }
}

#[cfg(not(windows))]
fn resolve_pipeline_curl_executable() -> Result<PathBuf, AppError> {
    Err(AppError::Validation(
        "loader preparation requires curl.exe from the Windows system directory".into(),
    ))
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

fn pipeline_is_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x0400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn resolve_pipeline_redirect_target(current: &str, location: &str) -> Result<String, AppError> {
    let location = location.trim();
    if location.is_empty()
        || location.len() > MAX_PIPELINE_URL_BYTES
        || location
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(AppError::Validation(
            "loader redirect Location is invalid".into(),
        ));
    }
    if location.starts_with("https://") || location.starts_with("//") {
        return Ok(if location.starts_with("//") {
            format!("https:{location}")
        } else {
            location.to_string()
        });
    }
    let before_path = location.split(['/', '?', '#']).next().unwrap_or_default();
    if before_path.contains(':') {
        return Err(AppError::Validation(
            "loader redirect uses an unsupported URL scheme".into(),
        ));
    }
    let authority = pipeline_url_host(current)
        .ok_or_else(|| AppError::Validation("current loader URL is invalid".into()))?;
    let current_tail = current
        .strip_prefix("https://")
        .and_then(|tail| tail.get(authority.len()..))
        .unwrap_or("/");
    let current_path = current_tail
        .split(['?', '#'])
        .next()
        .filter(|path| !path.is_empty())
        .unwrap_or("/");
    let location_without_fragment = location.split('#').next().unwrap_or_default();
    let (location_path, query) = match location_without_fragment.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (location_without_fragment, None),
    };
    let joined = if location_path.is_empty() && query.is_some() {
        current_path.to_string()
    } else if location_path.starts_with('/') {
        location_path.to_string()
    } else {
        let parent = current_path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        format!("{parent}/{location_path}")
    };
    let normalized_path = normalize_pipeline_url_path(&joined)?;
    let query = query.map(|query| format!("?{query}")).unwrap_or_default();
    Ok(format!("https://{authority}{normalized_path}{query}"))
}

fn normalize_pipeline_url_path(path: &str) -> Result<String, AppError> {
    if !path.starts_with('/') || path.contains('\\') {
        return Err(AppError::Validation(
            "loader redirect path is invalid".into(),
        ));
    }
    let mut segments = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            value => segments.push(value),
        }
    }
    Ok(format!("/{}", segments.join("/")))
}

#[cfg(test)]
mod pipeline_loader_redirect_tests {
    use super::*;

    #[test]
    fn loader_redirects_require_https_and_the_operation_host_allowlist() {
        let mojang_metadata = ["piston-meta.mojang.com"];
        assert!(trusted_pipeline_https_url(
            "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
            &mojang_metadata
        ));
        assert!(!trusted_pipeline_https_url(
            "https://piston-data.mojang.com/mc/game/version_manifest_v2.json",
            &mojang_metadata
        ));
        assert!(!trusted_pipeline_https_url(
            "http://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
            &mojang_metadata
        ));
    }

    #[test]
    fn redirect_locations_reject_missing_duplicate_and_non_https_targets() {
        let missing = "HTTP/1.1 302 Found\r\n\r\n";
        assert!(parse_pipeline_location_header(missing, 302)
            .unwrap_err()
            .to_string()
            .contains("missing"));

        let duplicate = "HTTP/1.1 302 Found\r\nLocation: https://files.minecraftforge.net/a\r\nLocation: https://files.minecraftforge.net/b\r\n\r\n";
        assert!(parse_pipeline_location_header(duplicate, 302)
            .unwrap_err()
            .to_string()
            .contains("ambiguous"));

        assert!(resolve_pipeline_redirect_target(
            "https://files.minecraftforge.net/forge/file.jar",
            "http://maven.minecraftforge.net/forge/file.jar"
        )
        .is_err());

        let malformed = "HTTP/1.1 302 Found\r\nLocation: file:///tmp/loader.jar\r\n\r\n";
        let location = parse_pipeline_location_header(malformed, 302).unwrap();
        assert!(validate_pipeline_redirect(
            "https://files.minecraftforge.net/forge/file.jar",
            &location,
            0,
            &["files.minecraftforge.net"],
            "loader artifact",
        )
        .is_err());
    }

    #[test]
    fn relative_loader_redirects_stay_on_the_current_https_host() {
        assert_eq!(
            resolve_pipeline_redirect_target(
                "https://maven.neoforged.net/releases/net/neoforged/file.jar",
                "../other/file.jar"
            )
            .unwrap(),
            "https://maven.neoforged.net/releases/net/other/file.jar"
        );
    }

    #[test]
    fn redirects_accept_only_same_or_source_approved_hosts() {
        let artifact_hosts = ["piston-data.mojang.com", "launcher.mojang.com"];
        assert_eq!(
            validate_pipeline_redirect(
                "https://piston-data.mojang.com/server.jar",
                "https://launcher.mojang.com/server.jar",
                0,
                &artifact_hosts,
                "loader artifact",
            )
            .unwrap(),
            "https://launcher.mojang.com/server.jar"
        );
        assert!(validate_pipeline_redirect(
            "https://piston-data.mojang.com/server.jar",
            "https://cdn.example.invalid/server.jar",
            0,
            &artifact_hosts,
            "loader artifact",
        )
        .is_err());
        assert!(validate_pipeline_redirect(
            "https://piston-data.mojang.com/server.jar",
            "http://launcher.mojang.com/server.jar",
            0,
            &artifact_hosts,
            "loader artifact",
        )
        .is_err());
    }

    #[test]
    fn redirect_chain_allows_three_hops_and_rejects_a_fourth() {
        let allowed_hosts = ["files.minecraftforge.net"];
        let mut current = "https://files.minecraftforge.net/forge/start".to_string();
        let mut redirect_count = 0;
        for location in ["/forge/one", "/forge/two", "/forge/three"] {
            current = validate_pipeline_redirect(
                &current,
                location,
                redirect_count,
                &allowed_hosts,
                "loader metadata",
            )
            .unwrap();
            redirect_count += 1;
        }
        assert_eq!(redirect_count, MAX_PIPELINE_REDIRECTS);
        assert!(validate_pipeline_redirect(
            &current,
            "/forge/four",
            redirect_count,
            &allowed_hosts,
            "loader metadata",
        )
        .unwrap_err()
        .to_string()
        .contains("3-redirect limit"));
    }

    #[test]
    fn pipeline_curl_disables_config_first_and_uses_system_directory_path() {
        assert_eq!(PIPELINE_CURL_BASE_OPTIONS.first(), Some(&"--disable"));
        assert!(!PIPELINE_CURL_BASE_OPTIONS.contains(&"--location"));
        let system_directory = PathBuf::from("system-directory-fixture");
        assert_eq!(
            pipeline_curl_executable_path(&system_directory),
            system_directory.join("curl.exe")
        );
    }

    #[test]
    fn pipeline_curl_executable_requires_a_regular_file() {
        let directory =
            std::env::temp_dir().join(format!("pipeline-curl-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let executable = pipeline_curl_executable_path(&directory);
        assert!(validate_pipeline_curl_executable(&executable).is_err());
        fs::create_dir(&executable).unwrap();
        assert!(validate_pipeline_curl_executable(&executable).is_err());
        fs::remove_dir(&executable).unwrap();
        fs::write(&executable, b"fixture").unwrap();
        assert!(validate_pipeline_curl_executable(&executable).is_ok());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn pipeline_curl_path_uses_get_system_directory_w() {
        let system_directory = windows_system_directory().unwrap();
        let executable = pipeline_curl_executable_path(&system_directory);
        assert!(system_directory.is_absolute());
        assert_eq!(executable.parent(), Some(system_directory.as_path()));
        assert_eq!(
            executable.file_name().and_then(|name| name.to_str()),
            Some("curl.exe")
        );
    }
}

fn fetch_text_with_redirect_policy(
    url: &str,
    control: Option<&JobControl>,
    user_agent: Option<&str>,
) -> Result<String, AppError> {
    if !trusted_https_url(
        url,
        &[
            "piston-meta.mojang.com",
            "piston-data.mojang.com",
            "launcher.mojang.com",
            "fill.papermc.io",
            "fill-data.papermc.io",
            "meta.fabricmc.net",
            "files.minecraftforge.net",
            "maven.minecraftforge.net",
            "maven.neoforged.net",
        ],
    ) {
        return Err(AppError::Validation(
            "refusing metadata URL outside official provider hosts".into(),
        ));
    }
    ensure_not_cancelled_opt(control)?;
    let mut command = Command::new("curl.exe");
    command.args([
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "45",
        "--max-filesize",
        &MAX_HTTP_BODY.to_string(),
        "--proto",
        "=https",
        "--location",
        "--proto-redir",
        "=https",
    ]);
    if let Some(agent) = user_agent {
        command.args(["--header", &format!("User-Agent: {agent}")]);
    } else {
        command.args(["--header", &format!("User-Agent: {USER_AGENT}")]);
    }
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("curl stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("curl stderr unavailable".into()))?;
    let out_reader = thread::spawn(move || read_limited(stdout, MAX_HTTP_BODY));
    let err_reader = thread::spawn(move || read_limited(stderr, 8 * 1024));
    let status = loop {
        if control.is_some_and(JobControl::is_cancelled) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_reader.join();
            let _ = err_reader.join();
            return Err(cancelled_error());
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(CANCEL_POLL);
    };
    let (stdout, too_large) = out_reader
        .join()
        .map_err(|_| AppError::Internal("curl output reader failed".into()))??;
    let (stderr, _) = err_reader
        .join()
        .map_err(|_| AppError::Internal("curl error reader failed".into()))??;
    if too_large {
        return Err(AppError::Validation(
            "provider metadata exceeded the 16 MB response limit".into(),
        ));
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        let detail = clean_log_text(detail.trim());
        return Err(AppError::Validation(if detail.is_empty() {
            format!(
                "provider request failed (curl exit {})",
                status.code().unwrap_or(-1)
            )
        } else {
            format!("provider request failed: {detail}")
        }));
    }
    let response = String::from_utf8(stdout)
        .map_err(|_| AppError::Validation("provider metadata was not valid UTF-8".into()))?;
    Ok(response)
}

fn read_limited<R: Read>(mut reader: R, limit: usize) -> Result<(Vec<u8>, bool), AppError> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut too_large = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.len());
        if count > remaining {
            too_large = true;
        }
        output.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    Ok((output, too_large))
}

fn download_file(
    url: &str,
    destination: &Path,
    expected_size: Option<u64>,
    maximum_size: Option<u64>,
    redirect_hosts: Option<&'static [&'static str]>,
    app: &AppHandle,
    job_id: &str,
    control: &JobControl,
    log: &mut InstallLog,
    progress: ProgressRange,
) -> Result<(), AppError> {
    if let Some(allowed_hosts) = redirect_hosts {
        return download_pipeline_file_with_redirects(
            url,
            destination,
            expected_size,
            maximum_size.ok_or_else(|| {
                AppError::Internal("pipeline artifact is missing its size bound".into())
            })?,
            allowed_hosts,
            app,
            job_id,
            control,
            log,
            progress,
        );
    }
    if !trusted_https_url(
        url,
        &[
            "piston-data.mojang.com",
            "launcher.mojang.com",
            "fill-data.papermc.io",
            "meta.fabricmc.net",
            "maven.minecraftforge.net",
            "maven.neoforged.net",
        ],
    ) {
        return Err(AppError::Validation(
            "refusing download URL outside official provider hosts".into(),
        ));
    }
    ensure_not_cancelled(control)?;
    let part = destination.with_extension("download-part");
    let _ = fs::remove_file(&part);
    let mut command = Command::new("curl.exe");
    if let Some(maximum_size) = maximum_size {
        command.args(["--max-filesize", &maximum_size.to_string()]);
    }
    command.args([
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--max-time",
        "900",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--output",
    ]);
    command
        .arg(&part)
        .args(["--header", &format!("User-Agent: {USER_AGENT}")])
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn()?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("curl stderr unavailable".into()))?;
    let stderr_reader = thread::spawn(move || read_limited(stderr, 8 * 1024));
    let mut last_emit = Instant::now();
    let status = loop {
        if control.is_cancelled() {
            terminate_child(&mut child);
            let _ = stderr_reader.join();
            let _ = fs::remove_file(&part);
            return Err(cancelled_error());
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if last_emit.elapsed() >= Duration::from_millis(700) {
            let downloaded = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let progress = expected_size
                .map(|total| {
                    progress.map_installer_progress(
                        (20 + ((downloaded.min(total) as f64 / total.max(1) as f64) * 42.0) as u8)
                            .min(62),
                    )
                })
                .unwrap_or_else(|| progress.map_installer_progress(38));
            let log_line = expected_size
                .map(|total| format!("Downloaded {downloaded} of {total} bytes."))
                .unwrap_or_else(|| format!("Downloaded {downloaded} bytes."));
            log.append(&log_line);
            emit_progress(
                app,
                job_id,
                progress,
                "Downloading",
                &log_line,
                Some(downloaded),
                expected_size,
            );
            last_emit = Instant::now();
        }
        thread::sleep(CANCEL_POLL);
    };
    let (stderr, _) = stderr_reader
        .join()
        .map_err(|_| AppError::Internal("curl error reader failed".into()))??;
    if !status.success() {
        let _ = fs::remove_file(&part);
        let detail = clean_log_text(String::from_utf8_lossy(&stderr).trim());
        log.append(&format!("Download failed: {detail}"));
        return Err(AppError::Validation(if detail.is_empty() {
            format!(
                "server artifact download failed (curl exit {})",
                status.code().unwrap_or(-1)
            )
        } else {
            format!("server artifact download failed: {detail}")
        }));
    }
    let downloaded = fs::metadata(&part)?.len();
    if downloaded == 0 {
        let _ = fs::remove_file(&part);
        return Err(AppError::Validation(
            "provider returned an empty download".into(),
        ));
    }
    if maximum_size.is_some_and(|maximum| downloaded > maximum) {
        let _ = fs::remove_file(&part);
        return Err(AppError::Validation(
            "server artifact download exceeded the configured size limit".into(),
        ));
    }
    fs::rename(part, destination)?;
    Ok(())
}

fn download_pipeline_file_with_redirects(
    url: &str,
    destination: &Path,
    expected_size: Option<u64>,
    maximum_size: u64,
    allowed_hosts: &[&str],
    app: &AppHandle,
    job_id: &str,
    control: &JobControl,
    log: &mut InstallLog,
    progress: ProgressRange,
) -> Result<(), AppError> {
    if !trusted_pipeline_https_url(url, allowed_hosts) {
        return Err(AppError::Validation(
            "loader artifact URL is not HTTPS on its source's approved host".into(),
        ));
    }
    ensure_not_cancelled(control)?;
    let part = destination.with_extension("download-part");
    let temporary = PipelineHttpTempDir::create()?;
    let headers_path = temporary.headers_path();
    let result = (|| {
        let mut current = url.to_string();
        let mut redirects = 0usize;
        loop {
            ensure_not_cancelled(control)?;
            let mut last_emit = Instant::now();
            let status = run_pipeline_curl_hop(
                &current,
                &part,
                &headers_path,
                maximum_size,
                900,
                control,
                |downloaded| {
                    if last_emit.elapsed() >= Duration::from_millis(700) {
                        let mapped = expected_size
                            .map(|total| {
                                progress.map_installer_progress(
                                    (20 + ((downloaded.min(total) as f64 / total.max(1) as f64)
                                        * 42.0) as u8)
                                        .min(62),
                                )
                            })
                            .unwrap_or_else(|| progress.map_installer_progress(38));
                        let line = expected_size
                            .map(|total| format!("Downloaded {downloaded} of {total} bytes."))
                            .unwrap_or_else(|| format!("Downloaded {downloaded} bytes."));
                        log.append(&line);
                        emit_progress(
                            app,
                            job_id,
                            mapped,
                            "Downloading",
                            &line,
                            Some(downloaded),
                            expected_size,
                        );
                        last_emit = Instant::now();
                    }
                },
            )?;
            if status == 200 {
                let downloaded = fs::metadata(&part)?.len();
                if downloaded == 0 || downloaded > maximum_size {
                    return Err(AppError::Validation(
                        "loader artifact is empty or exceeds the 2 GiB size bound".into(),
                    ));
                }
                if let Some(expected) = expected_size {
                    if downloaded != expected {
                        return Err(AppError::Validation(format!(
                            "loader artifact size mismatch (expected {expected}, received {downloaded})"
                        )));
                    }
                }
                fs::rename(&part, destination)?;
                return Ok(());
            }
            if !is_supported_redirect_status(status) {
                return Err(AppError::Validation(format!(
                    "loader artifact request returned HTTP {status}"
                )));
            }
            let location = pipeline_location_header(&headers_path, status)?;
            let target = validate_pipeline_redirect(
                &current,
                &location,
                redirects,
                allowed_hosts,
                "loader artifact",
            )?;
            current = target;
            redirects += 1;
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

#[derive(Debug)]
enum ModrinthDownloadFailure {
    Retryable(AppError),
    Terminal(AppError),
}

impl ModrinthDownloadFailure {
    fn retryable(error: AppError) -> Self {
        Self::Retryable(error)
    }

    fn terminal(error: AppError) -> Self {
        Self::Terminal(error)
    }

    fn is_retryable(&self) -> bool {
        matches!(self, Self::Retryable(_))
    }

    fn message(&self) -> String {
        match self {
            Self::Retryable(error) | Self::Terminal(error) => error.to_string(),
        }
    }

    fn into_attempt_error(self, path: &str, attempts: usize) -> AppError {
        AppError::Validation(format!(
            "Modrinth pack file {path} failed after {attempts} attempts: {}",
            self.message()
        ))
    }

    fn into_app_error(self) -> AppError {
        match self {
            Self::Retryable(error) | Self::Terminal(error) => error,
        }
    }
}

impl From<AppError> for ModrinthDownloadFailure {
    fn from(error: AppError) -> Self {
        Self::terminal(error)
    }
}

impl From<std::io::Error> for ModrinthDownloadFailure {
    fn from(error: std::io::Error) -> Self {
        Self::retryable(AppError::from(error))
    }
}

impl From<ModrinthDownloadFailure> for AppError {
    fn from(error: ModrinthDownloadFailure) -> Self {
        error.into_app_error()
    }
}

fn with_modrinth_file_retries<T, A, W>(
    path: &str,
    mut attempt: A,
    mut wait: W,
) -> Result<T, AppError>
where
    A: FnMut(usize) -> Result<T, ModrinthDownloadFailure>,
    W: FnMut(Duration) -> Result<(), AppError>,
{
    for attempt_number in 1..=MAX_MODRINTH_FILE_ATTEMPTS {
        match attempt(attempt_number) {
            Ok(value) => return Ok(value),
            Err(error) if error.is_retryable() && attempt_number < MAX_MODRINTH_FILE_ATTEMPTS => {
                wait(MODRINTH_FILE_RETRY_DELAYS[attempt_number - 1])?;
            }
            Err(error) => return Err(error.into_attempt_error(path, attempt_number)),
        }
    }
    unreachable!("Modrinth file retry loop always returns within its fixed attempt limit")
}

fn ensure_modrinth_transfer_active(
    control: &JobControl,
    sibling_stop: Option<&AtomicBool>,
) -> Result<(), AppError> {
    ensure_not_cancelled(control)?;
    if sibling_stop.is_some_and(|stop| stop.load(Ordering::Acquire)) {
        return Err(AppError::Conflict(
            "Modrinth pack-file transfer stopped after another file failed".into(),
        ));
    }
    Ok(())
}

fn wait_for_modrinth_file_retry_with_stop(
    control: &JobControl,
    sibling_stop: &AtomicBool,
    delay: Duration,
) -> Result<(), AppError> {
    let mut remaining = delay;
    while !remaining.is_zero() {
        ensure_modrinth_transfer_active(control, Some(sibling_stop))?;
        let interval = remaining.min(CANCEL_POLL);
        thread::sleep(interval);
        remaining = remaining.saturating_sub(interval);
    }
    ensure_modrinth_transfer_active(control, Some(sibling_stop))
}

fn download_modrinth_file(
    url: &str,
    destination: &Path,
    expected_size: u64,
    app: &AppHandle,
    job_id: &str,
    control: &JobControl,
    progress: ProgressRange,
    completed_before: u64,
    progress_total: u64,
    stage: &str,
    log: &mut InstallLog,
) -> Result<(), ModrinthDownloadFailure> {
    let result = download_modrinth_file_inner(
        url,
        destination,
        expected_size,
        app,
        job_id,
        control,
        progress,
        completed_before,
        progress_total,
        stage,
        None,
        None,
        true,
        Some(log),
    );
    result.map(|_| ())
}

fn download_modrinth_required_file(
    url: &str,
    destination: &Path,
    expected_size: u64,
    app: &AppHandle,
    job_id: &str,
    control: &JobControl,
    sibling_stop: &AtomicBool,
    file_index: usize,
    progress: &ModrinthFileProgress,
    progress_total: u64,
) -> Result<u64, ModrinthDownloadFailure> {
    download_modrinth_file_inner(
        url,
        destination,
        expected_size,
        app,
        job_id,
        control,
        MODPACK_FILE_PROGRESS,
        0,
        progress_total,
        "Downloading pack files",
        Some((progress, file_index)),
        Some(sibling_stop),
        false,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn download_modrinth_file_inner(
    url: &str,
    destination: &Path,
    expected_size: u64,
    app: &AppHandle,
    job_id: &str,
    control: &JobControl,
    progress: ProgressRange,
    completed_before: u64,
    progress_total: u64,
    stage: &str,
    tracked_progress: Option<(&ModrinthFileProgress, usize)>,
    sibling_stop: Option<&AtomicBool>,
    enforce_content_length: bool,
    mut log: Option<&mut InstallLog>,
) -> Result<u64, ModrinthDownloadFailure> {
    if !crate::modpacks::install::valid_provider_download_url(url) {
        return Err(AppError::Validation(
            "refusing Modrinth download URL outside the reviewed HTTPS hosts".into(),
        )
        .into());
    }
    let mut current_url = url.to_string();
    for redirect_index in 0..=MAX_MODPACK_REDIRECTS {
        ensure_modrinth_transfer_active(control, sibling_stop)?;
        if redirect_index > 0 && !crate::modpacks::install::valid_redirect_url(&current_url) {
            return Err(AppError::Validation(
                "Modrinth redirected to an unsupported download host".into(),
            )
            .into());
        }
        let headers_path =
            destination.with_file_name(format!("modrinth-headers-{}.tmp", uuid::Uuid::new_v4()));
        let _ = fs::remove_file(destination);
        let max_size = expected_size.max(1).to_string();
        let mut command = Command::new("curl.exe");
        command.args([
            "--disable",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "30",
            "--speed-limit",
            "1024",
            "--speed-time",
            "60",
            "--max-time",
            "900",
            "--max-filesize",
            &max_size,
            "--proto",
            "=https",
            "--dump-header",
        ]);
        command
            .arg(&headers_path)
            .args(["--output", "-"])
            .args(["--header", &format!("User-Agent: {MODRINTH_USER_AGENT}")])
            .arg(&current_url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut command);
        let body_file = match File::create(destination) {
            Ok(file) => file,
            Err(error) => {
                remove_download_artifacts(destination, &headers_path);
                return Err(error.into());
            }
        };
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                drop(body_file);
                remove_download_artifacts(destination, &headers_path);
                return Err(error.into());
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
            terminate_child(&mut child);
            drop(body_file);
            remove_download_artifacts(destination, &headers_path);
            return Err(AppError::Internal("curl output streams unavailable".into()).into());
        };
        let overflowed = Arc::new(AtomicBool::new(false));
        let overflowed_reader = overflowed.clone();
        let out_reader = thread::spawn(move || {
            stream_download_body(stdout, body_file, expected_size, overflowed_reader)
        });
        let err_reader = thread::spawn(move || read_limited(stderr, 8 * 1024));
        let mut last_emit = Instant::now();
        let mut checked_content_length = false;
        let status = loop {
            if let Err(error) = ensure_modrinth_transfer_active(control, sibling_stop) {
                return Err(abort_modrinth_download(
                    &mut child,
                    out_reader,
                    err_reader,
                    destination,
                    &headers_path,
                    error,
                )
                .into());
            }
            if fs::metadata(&headers_path)
                .is_ok_and(|metadata| metadata.len() > MAX_HTTP_HEADER_BYTES as u64)
            {
                return Err(abort_modrinth_download(
                    &mut child,
                    out_reader,
                    err_reader,
                    destination,
                    &headers_path,
                    AppError::Validation(
                        "Modrinth download response headers exceeded the 64 KiB limit".into(),
                    ),
                )
                .into());
            }
            if !checked_content_length
                && response_status_from_headers(&headers_path)
                    .is_some_and(|status| (200..300).contains(&status))
            {
                if let Some(content_length) = response_content_length_if_complete(&headers_path) {
                    checked_content_length = true;
                    if let Some(error) = content_length_mismatch_error_if_enforced(
                        content_length,
                        expected_size,
                        enforce_content_length,
                    ) {
                        return Err(ModrinthDownloadFailure::retryable(abort_modrinth_download(
                            &mut child,
                            out_reader,
                            err_reader,
                            destination,
                            &headers_path,
                            error,
                        )));
                    }
                }
            }
            if overflowed.load(Ordering::Acquire) {
                return Err(abort_modrinth_download(
                    &mut child,
                    out_reader,
                    err_reader,
                    destination,
                    &headers_path,
                    oversized_download_error(expected_size),
                )
                .into());
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(error) => {
                    return Err(abort_modrinth_download(
                        &mut child,
                        out_reader,
                        err_reader,
                        destination,
                        &headers_path,
                        error.into(),
                    )
                    .into());
                }
            }
            if response_status_from_headers(&headers_path)
                .is_some_and(|status| (200..300).contains(&status))
            {
                let downloaded = fs::metadata(destination)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0)
                    .min(expected_size);
                if let Some((tracked, file_index)) = tracked_progress {
                    tracked.update_active(file_index, downloaded);
                } else if last_emit.elapsed() >= MODRINTH_FILE_PROGRESS_INTERVAL {
                    let completed = completed_before.saturating_add(downloaded);
                    let message = format!("Downloaded {completed} of {progress_total} bytes.");
                    emit_progress(
                        app,
                        job_id,
                        progress.map_fraction(completed, progress_total),
                        stage,
                        &message,
                        Some(completed),
                        Some(progress_total),
                    );
                    last_emit = Instant::now();
                }
            }
            thread::sleep(CANCEL_POLL);
        };
        let body_result = out_reader.join();
        let stderr_result = err_reader.join();
        let body_result = match body_result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(ModrinthDownloadFailure::retryable(AppError::from(error))),
            Err(_) => Err(ModrinthDownloadFailure::terminal(AppError::Internal(
                "curl body reader failed".into(),
            ))),
        };
        let stderr_result = match stderr_result {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(ModrinthDownloadFailure::retryable(error)),
            Err(_) => Err(ModrinthDownloadFailure::terminal(AppError::Internal(
                "curl error reader failed".into(),
            ))),
        };
        if let Err(error) = body_result {
            remove_download_artifacts(destination, &headers_path);
            return Err(error);
        }
        if let Err(error) = stderr_result {
            remove_download_artifacts(destination, &headers_path);
            return Err(error);
        }
        if overflowed.load(Ordering::Acquire) {
            remove_download_artifacts(destination, &headers_path);
            return Err(oversized_download_error(expected_size).into());
        }
        if !status.success() {
            remove_download_artifacts(destination, &headers_path);
            if let Some(log) = log.as_deref_mut() {
                log.append("Modrinth file download failed.");
            }
            return Err(ModrinthDownloadFailure::retryable(AppError::Validation(
                format!(
                    "Modrinth file download failed (curl exit {})",
                    status.code().unwrap_or(-1)
                ),
            )));
        }
        let http_status = match response_status_from_headers(&headers_path) {
            Some(status) => status,
            None => {
                remove_download_artifacts(destination, &headers_path);
                return Err(ModrinthDownloadFailure::retryable(AppError::Validation(
                    "Modrinth download returned an invalid status".into(),
                )));
            }
        };
        if (300..400).contains(&http_status) {
            let location = match response_location(&headers_path) {
                Ok(location) => location,
                Err(error) => {
                    remove_download_artifacts(destination, &headers_path);
                    return Err(error.into());
                }
            };
            remove_download_artifacts(destination, &headers_path);
            if redirect_index >= MAX_MODPACK_REDIRECTS {
                return Err(AppError::Validation(
                    "Modrinth file download exceeded the three-redirect limit".into(),
                )
                .into());
            }
            let location = location
                .ok_or_else(|| {
                    AppError::Validation(
                        "Modrinth redirect did not include a Location header".into(),
                    )
                })
                .map_err(ModrinthDownloadFailure::from)?;
            if !crate::modpacks::install::valid_redirect_url(&location) {
                return Err(AppError::Validation(
                    "Modrinth redirected to a relative or unsupported HTTPS URL".into(),
                )
                .into());
            }
            current_url = location;
            continue;
        }
        let _ = fs::remove_file(&headers_path);
        if !(200..300).contains(&http_status) {
            remove_download_artifacts(destination, &headers_path);
            return Err(ModrinthDownloadFailure::retryable(AppError::Validation(
                format!("Modrinth file download returned HTTP {http_status}"),
            )));
        }
        let metadata = match fs::metadata(destination) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => {
                remove_download_artifacts(destination, &headers_path);
                return Err(AppError::Validation(
                    "Modrinth file download did not create a regular file".into(),
                )
                .into());
            }
        };
        if let Some((tracked, file_index)) = tracked_progress {
            tracked.update_active(file_index, metadata.len().min(expected_size));
        }
        return Ok(metadata.len());
    }
    Err(AppError::Validation("Modrinth file download exceeded the redirect limit".into()).into())
}

fn stream_download_body<R: Read>(
    mut body: R,
    mut destination: File,
    expected_size: u64,
    overflowed: Arc<AtomicBool>,
) -> std::io::Result<()> {
    let mut written = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = body.read(&mut buffer)?;
        if count == 0 {
            return Ok(());
        }
        let remaining = expected_size.saturating_sub(written);
        let allowed = usize::try_from(remaining).unwrap_or(usize::MAX);
        let accepted = count.min(allowed);
        destination.write_all(&buffer[..accepted])?;
        written += accepted as u64;
        if accepted < count {
            overflowed.store(true, Ordering::Release);
            return Ok(());
        }
    }
}

fn abort_modrinth_download(
    child: &mut Child,
    body_reader: std::thread::JoinHandle<std::io::Result<()>>,
    stderr_reader: std::thread::JoinHandle<Result<(Vec<u8>, bool), AppError>>,
    destination: &Path,
    headers: &Path,
    error: AppError,
) -> AppError {
    terminate_child(child);
    let _ = body_reader.join();
    let _ = stderr_reader.join();
    remove_download_artifacts(destination, headers);
    error
}

fn oversized_download_error(expected_size: u64) -> AppError {
    AppError::Validation(format!(
        "Modrinth download exceeded its declared size of {expected_size} bytes"
    ))
}

fn remove_download_artifacts(destination: &Path, headers: &Path) {
    let _ = fs::remove_file(destination);
    let _ = fs::remove_file(headers);
}

fn response_status_from_headers(path: &Path) -> Option<u16> {
    let text = fs::read_to_string(path).ok()?;
    text.lines()
        .filter_map(|line| {
            line.strip_prefix("HTTP/")
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|_| line.split_whitespace().nth(1))
                .and_then(|status| status.parse().ok())
        })
        .last()
}

fn response_content_length_if_complete(path: &Path) -> Option<Option<u64>> {
    let text = fs::read_to_string(path).ok()?;
    if !text.ends_with("\r\n\r\n") && !text.ends_with("\n\n") {
        return None;
    }
    Some(response_content_length_from_headers(&text))
}

fn response_content_length_from_headers(headers: &str) -> Option<u64> {
    let mut in_status_block = false;
    let mut content_length_count = 0usize;
    let mut content_length = None;
    for line in headers.lines() {
        if line.starts_with("HTTP/") {
            in_status_block = true;
            content_length_count = 0;
            content_length = None;
            continue;
        }
        if !in_status_block {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            content_length_count += 1;
            if content_length_count == 1 {
                content_length = value.trim().parse::<u64>().ok();
            } else {
                content_length = None;
            }
        }
    }
    (content_length_count == 1)
        .then_some(content_length)
        .flatten()
}

fn content_length_mismatch_error(actual: u64, expected: u64) -> Option<AppError> {
    (actual != expected).then(|| {
        AppError::Validation(format!(
            "Modrinth Content-Length {actual} does not match expected file size {expected}"
        ))
    })
}

fn content_length_mismatch_error_if_enforced(
    actual: Option<u64>,
    expected: u64,
    enforce: bool,
) -> Option<AppError> {
    if enforce {
        actual.and_then(|actual| content_length_mismatch_error(actual, expected))
    } else {
        None
    }
}

fn response_location(path: &Path) -> Result<Option<String>, AppError> {
    let text = fs::read_to_string(path)
        .map_err(|_| AppError::Validation("Modrinth redirect headers were invalid".into()))?;
    let mut status_block = false;
    let mut location = None;
    for line in text.lines() {
        if line.starts_with("HTTP/") {
            status_block = true;
            location = None;
            continue;
        }
        if status_block {
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("location") {
                    if location.is_some() {
                        return Err(AppError::Validation(
                            "Modrinth redirect returned multiple Location headers".into(),
                        ));
                    }
                    location = Some(value.trim().to_string());
                }
            }
        }
    }
    Ok(location)
}

#[cfg(test)]
mod modrinth_download_reliability_tests {
    use super::*;

    #[test]
    fn content_length_uses_only_one_value_from_the_final_response_block() {
        let headers = concat!(
            "HTTP/1.1 302 Found\r\n",
            "Content-Length: 0\r\n",
            "\r\n",
            "HTTP/2 200 OK\r\n",
            "content-length: 42\r\n",
            "\r\n",
        );

        assert_eq!(response_content_length_from_headers(headers), Some(42));
    }

    #[test]
    fn content_length_ignores_missing_ambiguous_or_malformed_values() {
        assert_eq!(
            response_content_length_from_headers("HTTP/2 200 OK\r\n\r\n"),
            None
        );
        assert_eq!(
            response_content_length_from_headers(
                "HTTP/2 200 OK\r\nContent-Length: 42\r\ncontent-length: 42\r\n\r\n"
            ),
            None
        );
        assert_eq!(
            response_content_length_from_headers("HTTP/2 200 OK\r\nContent-Length: 42, 42\r\n\r\n"),
            None
        );
    }

    #[test]
    fn content_length_mismatch_is_detected_without_replacing_exact_size_checks() {
        let mismatch = content_length_mismatch_error(53_997, 57_672).unwrap();
        assert!(mismatch.to_string().contains("53997"));
        assert!(mismatch.to_string().contains("57672"));
        assert!(content_length_mismatch_error(57_672, 57_672).is_none());
    }

    #[test]
    fn required_file_validation_ignores_content_length_mismatch() {
        assert!(content_length_mismatch_error_if_enforced(Some(53_997), 57_672, false).is_none());
        assert!(content_length_mismatch_error_if_enforced(Some(53_997), 57_672, true).is_some());
    }

    #[test]
    fn undersized_required_file_is_accepted_only_after_hash_verification() {
        let mut sha1_verified = false;
        let mut sha512_verified = false;
        let accepted = verify_modrinth_required_file_size_and_hashes(
            53_997,
            57_672,
            || {
                sha1_verified = true;
                Ok(())
            },
            || {
                sha512_verified = true;
                Ok(())
            },
        )
        .unwrap();

        assert!(accepted);
        assert!(sha1_verified);
        assert!(sha512_verified);
    }

    #[test]
    fn undersized_required_file_propagates_manifest_hash_failure() {
        let mut sha1_verified = false;
        let error = verify_modrinth_required_file_size_and_hashes(
            53_997,
            57_672,
            || {
                sha1_verified = true;
                Ok(())
            },
            || Err(AppError::Validation("SHA512 verification failed".into())),
        )
        .unwrap_err();

        assert!(sha1_verified);
        assert!(error.to_string().contains("SHA512 verification failed"));
    }

    #[test]
    fn empty_and_oversized_required_files_are_rejected_before_hashing() {
        let hash_verification_ran = std::cell::Cell::new(false);
        let empty = verify_modrinth_required_file_size_and_hashes(
            0,
            57_672,
            || {
                hash_verification_ran.set(true);
                Ok(())
            },
            || {
                hash_verification_ran.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(empty.to_string().contains("empty file"));

        let oversized = verify_modrinth_required_file_size_and_hashes(
            57_673,
            57_672,
            || {
                hash_verification_ran.set(true);
                Ok(())
            },
            || {
                hash_verification_ran.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(oversized.to_string().contains("exceeded its declared size"));
        assert!(!hash_verification_ran.get());
    }

    #[test]
    fn required_file_workers_are_bounded_and_stop_after_the_first_failure() {
        use std::sync::{atomic::AtomicUsize, Barrier};

        let active = AtomicUsize::new(0);
        let peak_active = AtomicUsize::new(0);
        let started = AtomicUsize::new(0);
        let barrier = Barrier::new(MAX_MODRINTH_FILE_WORKERS);
        let error =
            run_bounded_modrinth_file_tasks(64, MAX_MODRINTH_FILE_WORKERS, |task_index, stop| {
                let concurrent = active.fetch_add(1, Ordering::AcqRel) + 1;
                peak_active.fetch_max(concurrent, Ordering::AcqRel);
                started.fetch_add(1, Ordering::AcqRel);
                barrier.wait();

                if task_index == 0 {
                    active.fetch_sub(1, Ordering::AcqRel);
                    Err(AppError::Validation("first required file failed".into()))
                } else {
                    while !stop.load(Ordering::Acquire) {
                        thread::yield_now();
                    }
                    active.fetch_sub(1, Ordering::AcqRel);
                    Err(AppError::Conflict("sibling transfer stopped".into()))
                }
            })
            .unwrap_err();

        assert_eq!(
            peak_active.load(Ordering::Acquire),
            MAX_MODRINTH_FILE_WORKERS
        );
        assert_eq!(started.load(Ordering::Acquire), MAX_MODRINTH_FILE_WORKERS);
        assert_eq!(active.load(Ordering::Acquire), 0);
        assert!(error.to_string().contains("first required file failed"));
    }

    #[test]
    fn failed_attempt_progress_rolls_back_without_decreasing_reported_bytes() {
        let range = ProgressRange { start: 0, end: 100 };
        let start = Instant::now();
        let mut state = ModrinthFileProgressState::default();
        state.active.insert(0, 80);

        let first = state
            .reported_snapshot(range, 100, start + MODRINTH_FILE_PROGRESS_INTERVAL)
            .unwrap();
        assert_eq!(first, (80, 80));

        state.active.remove(&0);
        assert_eq!(state.raw_bytes(100), 0);
        state.active.insert(0, 30);
        assert_eq!(state.raw_bytes(100), 30);
        assert!(state
            .reported_snapshot(range, 100, start + Duration::from_secs(4))
            .is_none());
        assert_eq!(state.last_reported_bytes, 80);

        state.active.remove(&0);
        state.completed = 30;
        state.active.insert(1, 25);
        assert_eq!(state.raw_bytes(100), 55);
    }

    #[test]
    fn retries_a_required_file_and_uses_bounded_backoff() {
        let mut attempts = 0;
        let mut waits = Vec::new();
        let value = with_modrinth_file_retries(
            "mods/required.jar",
            |attempt_number| {
                attempts += 1;
                assert_eq!(attempt_number, attempts);
                if attempt_number == 1 {
                    Err(ModrinthDownloadFailure::retryable(AppError::Validation(
                        "SHA512 verification failed".into(),
                    )))
                } else {
                    Ok("verified")
                }
            },
            |delay| {
                waits.push(delay);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(value, "verified");
        assert_eq!(attempts, 2);
        assert_eq!(waits, vec![Duration::from_millis(250)]);
    }

    #[test]
    fn does_not_retry_terminal_download_policy_failures() {
        let mut attempts = 0;
        let mut waits = Vec::new();
        let error = with_modrinth_file_retries(
            "mods/required.jar",
            |_| {
                attempts += 1;
                Err::<(), ModrinthDownloadFailure>(ModrinthDownloadFailure::terminal(
                    AppError::Validation("redirect target is not allowlisted".into()),
                ))
            },
            |delay| {
                waits.push(delay);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(attempts, 1);
        assert!(waits.is_empty());
        assert!(error.to_string().contains("after 1 attempts"));
        assert!(error
            .to_string()
            .contains("redirect target is not allowlisted"));
    }

    #[test]
    fn exhausted_file_retries_report_the_attempt_count_and_original_failure() {
        let mut attempts = 0;
        let mut waits = Vec::new();
        let error = with_modrinth_file_retries(
            "mods/required.jar",
            |_| {
                attempts += 1;
                Err::<(), ModrinthDownloadFailure>(ModrinthDownloadFailure::retryable(
                    AppError::Validation("SHA1 verification failed".into()),
                ))
            },
            |delay| {
                waits.push(delay);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(attempts, MAX_MODRINTH_FILE_ATTEMPTS);
        assert_eq!(
            waits,
            vec![Duration::from_millis(250), Duration::from_millis(500)]
        );
        assert!(error.to_string().contains("after 3 attempts"));
        assert!(error.to_string().contains("SHA1 verification failed"));
    }
}

fn verify_hash(
    path: &Path,
    expected: Option<&str>,
    algorithm: &str,
    artifact_name: &str,
) -> Result<(), AppError> {
    let expected = expected.ok_or_else(|| {
        AppError::Validation(format!(
            "provider did not supply the expected {algorithm} hash"
        ))
    })?;
    validate_expected_hash(expected, algorithm)?;
    let path_string = path.to_string_lossy().to_string();
    let output = hidden_output("certutil.exe", &["-hashfile", &path_string, algorithm])?;
    if !output.status.success() {
        return Err(AppError::Validation(format!(
            "{algorithm} verification failed"
        )));
    }
    verify_hash_value(
        expected,
        &certutil_hash(&output.stdout, expected.len(), algorithm)?,
        algorithm,
        artifact_name,
    )
}

fn verify_hash_cancellable(
    path: &Path,
    expected: &str,
    algorithm: &str,
    artifact_name: &str,
    control: &JobControl,
) -> Result<(), AppError> {
    verify_hash_cancellable_with_stop(path, expected, algorithm, artifact_name, control, None)
}

fn verify_hash_cancellable_with_stop(
    path: &Path,
    expected: &str,
    algorithm: &str,
    artifact_name: &str,
    control: &JobControl,
    sibling_stop: Option<&AtomicBool>,
) -> Result<(), AppError> {
    validate_expected_hash(expected, algorithm)?;
    ensure_modrinth_transfer_active(control, sibling_stop)?;
    let path_string = path.to_string_lossy().to_string();
    let mut command = Command::new("certutil.exe");
    command
        .args(["-hashfile", &path_string, algorithm])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("hash verifier stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("hash verifier stderr unavailable".into()))?;
    let out_reader = thread::spawn(move || read_limited(stdout, 16 * 1024));
    let err_reader = thread::spawn(move || read_limited(stderr, 8 * 1024));
    let status = loop {
        if let Err(error) = ensure_modrinth_transfer_active(control, sibling_stop) {
            terminate_child(&mut child);
            let _ = out_reader.join();
            let _ = err_reader.join();
            return Err(error);
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(CANCEL_POLL);
    };
    let (stdout, _) = out_reader
        .join()
        .map_err(|_| AppError::Internal("hash verifier output reader failed".into()))??;
    let _ = err_reader
        .join()
        .map_err(|_| AppError::Internal("hash verifier error reader failed".into()))??;
    if !status.success() {
        return Err(AppError::Validation(format!(
            "{algorithm} verification failed"
        )));
    }
    verify_hash_value(
        expected,
        &certutil_hash(&stdout, expected.len(), algorithm)?,
        algorithm,
        artifact_name,
    )
}

fn validate_expected_hash(expected: &str, algorithm: &str) -> Result<(), AppError> {
    let length = match algorithm {
        "SHA1" => 40,
        "SHA256" => 64,
        "SHA512" => 128,
        _ => {
            return Err(AppError::Validation(format!(
                "unsupported {algorithm} hash algorithm"
            )))
        }
    };
    if !valid_hash(expected, length) {
        return Err(AppError::Validation(format!(
            "provider supplied an invalid {algorithm} hash"
        )));
    }
    Ok(())
}

fn certutil_hash(output: &[u8], length: usize, algorithm: &str) -> Result<String, AppError> {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .find(|line| valid_hash(line, length))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| AppError::Validation(format!("{algorithm} verifier returned no hash")))
}

fn verify_hash_value(
    expected: &str,
    actual: &str,
    algorithm: &str,
    artifact_name: &str,
) -> Result<(), AppError> {
    if actual != expected.to_ascii_lowercase() {
        return Err(AppError::Validation(format!(
            "{artifact_name} {algorithm} mismatch"
        )));
    }
    Ok(())
}

fn run_installer(
    java_path: &str,
    installer: &Path,
    args: &[String],
    app: &AppHandle,
    job_id: &str,
    control: &JobControl,
    log: &mut InstallLog,
    progress: ProgressRange,
) -> Result<(), AppError> {
    ensure_not_cancelled(control)?;
    let installer_name = installer
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Validation("installer file name is invalid".into()))?;
    let mut command = Command::new(java_path);
    command.current_dir(installer.parent().unwrap_or_else(|| Path::new(".")));
    command.arg("-jar");
    command.arg(installer_name);
    for arg in args.iter().skip(2) {
        command.arg(arg);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("installer stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("installer stderr unavailable".into()))?;
    let shared_log = Arc::new(Mutex::new(InstallLog {
        file: log.file.try_clone()?,
        written: log.written,
        recent: log.recent.clone(),
    }));
    let out_log = shared_log.clone();
    let err_log = shared_log.clone();
    let out_reader = thread::spawn(move || pump_log(stdout, out_log));
    let err_reader = thread::spawn(move || pump_log(stderr, err_log));
    let mut last_emit = Instant::now();
    let status = loop {
        if control.is_cancelled() {
            terminate_child(&mut child);
            let _ = out_reader.join();
            let _ = err_reader.join();
            return Err(cancelled_error());
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if last_emit.elapsed() >= Duration::from_millis(800) {
            let recent = shared_log.lock().map(|l| l.recent()).unwrap_or_default();
            let line = recent
                .lines()
                .last()
                .unwrap_or("Installer is running.")
                .to_string();
            emit_progress(
                app,
                job_id,
                progress.map_installer_progress(72),
                "Running installer",
                &line,
                None,
                None,
            );
            last_emit = Instant::now();
        }
        thread::sleep(CANCEL_POLL);
    };
    let _ = out_reader.join();
    let _ = err_reader.join();
    if let Ok(captured) = shared_log.lock() {
        log.recent = captured.recent.clone();
        log.written = captured.written;
    }
    if !status.success() {
        let recent_text = log.recent();
        let recent = recent_text.lines().rev().take(12).collect::<Vec<_>>();
        return Err(AppError::Validation(format!(
            "server installer exited with code {}{}",
            status.code().unwrap_or(-1),
            if recent.is_empty() {
                String::new()
            } else {
                format!(
                    ": {}",
                    recent.into_iter().rev().collect::<Vec<_>>().join(" | ")
                )
            }
        )));
    }
    Ok(())
}

fn pump_log<R: Read>(mut reader: R, target: Arc<Mutex<InstallLog>>) {
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let text = String::from_utf8_lossy(&buffer[..count]);
                for line in text.lines() {
                    if let Ok(mut log) = target.lock() {
                        log.append(line);
                    }
                }
            }
        }
    }
}

fn emit_progress(
    app: &AppHandle,
    job_id: &str,
    progress: u8,
    stage: &str,
    log: &str,
    bytes_downloaded: Option<u64>,
    bytes_total: Option<u64>,
) {
    let payload = JobProgress {
        progress,
        stage: stage.to_string(),
        log: clean_log_text(log),
        bytes_downloaded,
        bytes_total,
    };
    let _ = app.emit(&format!("job://progress/{job_id}"), payload);
}

fn clean_log_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(2048)
        .collect::<String>()
        .trim()
        .to_string()
}

pub(crate) fn ensure_not_cancelled(control: &JobControl) -> Result<(), AppError> {
    if control.is_cancelled() {
        Err(cancelled_error())
    } else {
        Ok(())
    }
}

fn ensure_not_cancelled_opt(control: Option<&JobControl>) -> Result<(), AppError> {
    if control.is_some_and(JobControl::is_cancelled) {
        Err(cancelled_error())
    } else {
        Ok(())
    }
}

fn cancelled_error() -> AppError {
    AppError::Conflict("server installation was cancelled".to_string())
}

fn trusted_https_url(url: &str, hosts: &[&str]) -> bool {
    let Some(host) = url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
    else {
        return false;
    };
    hosts
        .iter()
        .any(|trusted| host.eq_ignore_ascii_case(trusted))
}

fn safe_version_segment(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 96
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
}

fn safe_minecraft_version(version: &str) -> bool {
    version.len() <= 96
        && version.split('.').count() >= 2
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn is_listable_manifest_type(version_type: &str) -> bool {
    version_type == "release" || version_type == "snapshot"
}

fn safe_manifest_id(id: &str, version_type: &str) -> bool {
    if version_type == "release" {
        safe_minecraft_version(id)
    } else if version_type == "snapshot" {
        safe_mc_version_or_snapshot(id)
    } else {
        false
    }
}

fn safe_mc_version_or_snapshot(version: &str) -> bool {
    if safe_minecraft_version(version) {
        return true;
    }
    safe_version_segment(version) && version.chars().any(|c| c.is_ascii_alphanumeric())
}

fn valid_hash(value: &str, length: usize) -> bool {
    value.len() == length && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn required_str<'a>(value: &'a Value, key: &str, description: &str) -> Result<&'a str, AppError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation(format!("{description} is missing")))
}

fn compare_numeric_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts = left.split(['.', '-', '+']).collect::<Vec<_>>();
    let right_parts = right.split(['.', '-', '+']).collect::<Vec<_>>();
    for (a, b) in left_parts.iter().zip(right_parts.iter()) {
        let order = match (a.parse::<u64>(), b.parse::<u64>()) {
            (Ok(a), Ok(b)) => a.cmp(&b),
            _ => a.cmp(b),
        };
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    left_parts.len().cmp(&right_parts.len())
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn hidden_output(program: &str, args: &[&str]) -> Result<std::process::Output, AppError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    Ok(command.output()?)
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod modpack_install_safety_tests {
    use super::*;

    #[test]
    fn cancellation_releases_job_id_for_retry_and_publication_is_final() {
        let jobs = InstallerState::new();
        let first = jobs.register("retry-job-1").unwrap();
        assert!(first.cancel());
        assert!(ensure_not_cancelled(&first).is_err());
        jobs.finish("retry-job-1", &first);

        let retry = jobs.register("retry-job-1").unwrap();
        assert!(!retry.is_cancelled());
        retry.begin_publication().unwrap();
        assert!(!retry.cancel());
        jobs.finish("retry-job-1", &retry);
    }

    #[test]
    fn rejects_file_size_and_hash_mismatches() {
        let path = std::env::temp_dir().join(format!(
            "mc-server-manager-modpack-size-{}.bin",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, b"payload").unwrap();
        assert!(verify_exact_file_size(&path, 8, "test payload").is_err());
        let _ = fs::remove_file(path);

        let expected = "a".repeat(40);
        let actual = "b".repeat(40);
        assert!(verify_hash_value(&expected, &actual, "SHA1", "test payload").is_err());
    }

    #[test]
    fn caps_streamed_body_when_a_chunk_crosses_the_declared_size() {
        let root = std::env::temp_dir().join(format!(
            "mc-server-manager-modpack-limit-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let part = root.join("payload.part");
        let headers = root.join("headers.tmp");
        fs::write(&headers, b"response headers").unwrap();
        let overflowed = Arc::new(AtomicBool::new(false));

        stream_download_body(
            std::io::Cursor::new(b"12345".to_vec()),
            File::create(&part).unwrap(),
            3,
            overflowed.clone(),
        )
        .unwrap();

        assert!(overflowed.load(Ordering::Acquire));
        assert!(fs::metadata(&part).unwrap().len() <= 3);
        assert_eq!(fs::read(&part).unwrap(), b"123");
        remove_download_artifacts(&part, &headers);
        assert!(!part.exists());
        assert!(!headers.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exact_fabric_match_passes_when_not_stable() {
        let metadata = serde_json::json!({
            "loader": { "version": "0.15.11", "stable": false },
        });
        assert!(validate_exact_fabric_loader_metadata(&metadata, "0.15.11").is_ok());
    }

    #[test]
    fn exact_fabric_mismatch_fails() {
        let metadata = serde_json::json!({
            "loader": { "version": "0.15.10", "stable": true },
        });
        assert!(validate_exact_fabric_loader_metadata(&metadata, "0.15.11").is_err());
    }

    #[test]
    fn exact_fabric_missing_version_fails() {
        let missing = serde_json::json!({ "loader": {} });
        assert!(validate_exact_fabric_loader_metadata(&missing, "0.15.11").is_err());
        let empty = serde_json::json!({});
        assert!(validate_exact_fabric_loader_metadata(&empty, "0.15.11").is_err());
    }

    fn modpack_fabric_input() -> CreateServerInput {
        CreateServerInput {
            name: "pack".to_string(),
            loader: "Fabric".to_string(),
            mc_version: "1.20.1".to_string(),
            loader_version: Some("0.15.11".to_string()),
            modpack_id: Some("modrinth:abcd1234:efgh5678".to_string()),
            port: None,
            ram_mb: 2048,
            java_path: None,
            eula_accepted: None,
        }
    }

    #[test]
    fn modpack_fabric_exact_routes_to_exact_check_only() {
        let mut modpack = modpack_fabric_input();
        assert!(is_modpack_fabric_exact(&modpack));
        modpack.loader_version = None;
        assert!(is_modpack_fabric_exact(&modpack));

        let mut standalone = modpack_fabric_input();
        standalone.modpack_id = None;
        assert!(!is_modpack_fabric_exact(&standalone));

        let mut non_fabric = modpack_fabric_input();
        non_fabric.loader = "Forge".to_string();
        assert!(!is_modpack_fabric_exact(&non_fabric));
    }

    fn paper_build_json(id: serde_json::Value, channel: &str, complete: bool) -> Value {
        let mut download = serde_json::json!({
            "url": "https://fill-data.papermc.io/v1/test.jar",
            "size": 12345u64,
            "checksums": { "sha256": "a".repeat(64) },
        });
        if !complete {
            download.as_object_mut().unwrap().remove("size");
        }
        serde_json::json!({
            "id": id,
            "channel": channel,
            "downloads": { "server:default": download },
        })
    }

    #[test]
    fn paper_beta_and_alpha_artifact_complete_accepted() {
        let stable = paper_build_json(serde_json::json!(100), "STABLE", true).clone();
        let beta = paper_build_json(serde_json::json!(101), "BETA", true).clone();
        let alpha = paper_build_json(serde_json::json!(102), "ALPHA", true).clone();
        for value in [&stable, &beta, &alpha] {
            let parsed = parse_paper_build(value).expect("artifact-complete build accepted");
            assert!(safe_version_segment(&parsed.id) || !parsed.id.is_empty());
        }
        assert_eq!(parse_paper_build(&stable).unwrap().channel, "STABLE");
        assert_eq!(parse_paper_build(&beta).unwrap().channel, "BETA");
        assert_eq!(parse_paper_build(&alpha).unwrap().channel, "ALPHA");
    }

    #[test]
    fn paper_incomplete_builds_skipped() {
        let missing_size = paper_build_json(serde_json::json!(200), "BETA", false);
        assert!(parse_paper_build(&missing_size).is_none());

        let mut no_url = paper_build_json(serde_json::json!(201), "STABLE", true);
        no_url["downloads"]["server:default"]
            .as_object_mut()
            .unwrap()
            .insert(
                "url".to_string(),
                serde_json::json!("https://evil.example.com/server.jar"),
            );
        assert!(parse_paper_build(&no_url).is_none());

        let mut bad_hash = paper_build_json(serde_json::json!(202), "ALPHA", true);
        bad_hash["downloads"]["server:default"]["checksums"]["sha256"] =
            serde_json::json!("not-a-hash");
        assert!(parse_paper_build(&bad_hash).is_none());

        let missing_downloads = serde_json::json!({ "id": 203, "channel": "STABLE" });
        assert!(parse_paper_build(&missing_downloads).is_none());
    }

    #[test]
    fn paper_non_array_envelope_rejected() {
        let envelope = serde_json::json!({ "ok": false, "error": "version_not_found" });
        let error = match parse_paper_builds_value(&envelope, "1.20.1") {
            Ok(_) => panic!("non-array Paper envelope must fail closed"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("invalid build metadata"));

        let ok_array = serde_json::json!([
            paper_build_json(serde_json::json!(100), "STABLE", true),
            paper_build_json(serde_json::json!(101), "BETA", true),
        ]);
        let builds = parse_paper_builds_value(&ok_array, "1.20.1").unwrap();
        assert_eq!(builds.len(), 2);
        assert_eq!(builds[0].channel, "STABLE");
        assert_eq!(builds[1].channel, "BETA");
    }

    #[test]
    fn fabric_loader_match_ignores_stable_flag() {
        let stable_false = serde_json::json!({
            "loader": { "version": "0.16.14", "stable": false },
        });
        assert!(fabric_loader_version_matches(&stable_false, "0.16.14"));
        assert!(validate_exact_fabric_loader_metadata(&stable_false, "0.16.14").is_ok());

        let wrong = serde_json::json!({
            "loader": { "version": "0.16.13", "stable": false },
        });
        assert!(!fabric_loader_version_matches(&wrong, "0.16.14"));
        assert!(validate_exact_fabric_loader_metadata(&wrong, "0.16.14").is_err());
    }

    #[test]
    fn fabric_non_stable_label_suffix() {
        assert_eq!(
            fabric_choice_label("0.16.14", true),
            "Fabric Loader 0.16.14"
        );
        assert_eq!(
            fabric_choice_label("0.19.4", false),
            "Fabric Loader 0.19.4 (non-stable)"
        );
    }

    #[test]
    fn forge_catalogue_membership() {
        let catalogue = serde_json::json!({
            "1.20.1": ["47.2.0", "1.20.1-47.1.0", "1.20.1-47.0.0-prerelease"],
            "1.12.2": ["14.23.5.2854-mc172"],
        });
        let entries = forge_catalogue_artifacts(&catalogue, "1.20.1").unwrap();
        assert!(entries.contains(&"1.20.1-47.2.0".to_string()));
        assert!(entries.contains(&"1.20.1-47.1.0".to_string()));
        assert!(entries.contains(&"1.20.1-47.0.0-prerelease".to_string()));
        assert!(!entries.contains(&"1.20.1-99.9.9".to_string()));

        let ancient = forge_catalogue_artifacts(&catalogue, "1.12.2").unwrap();
        assert!(ancient.contains(&"1.12.2-14.23.5.2854-mc172".to_string()));

        let missing = forge_catalogue_artifacts(&catalogue, "9.9.9").unwrap();
        assert!(missing.is_empty());

        assert_eq!(
            forge_build_from_artifact("1.20.1-47.1.0", "1.20.1"),
            "47.1.0"
        );
        assert_eq!(
            forge_build_from_artifact("1.12.2-14.23.5.2854-mc172", "1.12.2"),
            "14.23.5.2854-mc172"
        );
    }

    #[test]
    fn forge_catalogue_malformed_fails_closed() {
        let not_object = serde_json::json!(["1.20.1-47.2.0"]);
        assert!(forge_catalogue_artifacts(&not_object, "1.20.1").is_err());

        let bad_entries = serde_json::json!({ "1.20.1": "not-an-array" });
        assert!(forge_catalogue_artifacts(&bad_entries, "1.20.1").is_err());

        let non_string = serde_json::json!({ "1.20.1": [123] });
        assert!(forge_catalogue_artifacts(&non_string, "1.20.1").is_err());
    }

    #[test]
    fn forge_promotion_suffix_tolerant_single_match() {
        let catalogue = vec!["1.12.2-14.23.5.2854-mc172".to_string()];
        let resolved =
            resolve_forge_promotion_artifact("1.12.2", "14.23.5.2854", &catalogue).unwrap();
        assert_eq!(resolved, "1.12.2-14.23.5.2854-mc172");

        let exact = vec![
            "1.20.1-47.2.0".to_string(),
            "1.20.1-47.2.0-extra".to_string(),
        ];
        assert_eq!(
            resolve_forge_promotion_artifact("1.20.1", "47.2.0", &exact).unwrap(),
            "1.20.1-47.2.0"
        );

        let ambiguous = vec![
            "1.12.2-14.23.5.2854-mc172".to_string(),
            "1.12.2-14.23.5.2854-mc172-2".to_string(),
        ];
        assert!(resolve_forge_promotion_artifact("1.12.2", "14.23.5.2854", &ambiguous).is_err());

        let missing: Vec<String> = vec![];
        assert!(resolve_forge_promotion_artifact("1.12.2", "14.23.5.2859", &missing).is_err());
    }

    #[test]
    fn loader_ordering_and_labels_stable_first() {
        assert!(paper_channel_priority("STABLE") < paper_channel_priority("BETA"));
        assert!(paper_channel_priority("BETA") < paper_channel_priority("ALPHA"));
        assert!(paper_channel_priority("") > paper_channel_priority("ALPHA"));

        let mut channels = vec!["ALPHA", "", "BETA", "STABLE"];
        channels.sort_by_key(|channel| paper_channel_priority(channel));
        assert_eq!(channels, vec!["STABLE", "BETA", "ALPHA", ""]);

        assert_eq!(
            fabric_choice_label("0.16.14", true),
            "Fabric Loader 0.16.14"
        );
        assert!(fabric_choice_label("0.16.14", false).contains("(non-stable)"));

        let mut fabric: Vec<(bool, String)> = vec![
            (false, "0.15.11".to_string()),
            (true, "0.16.14".to_string()),
        ];
        fabric.sort_by(|a, b| b.0.cmp(&a.0));
        assert!(fabric[0].0);

        assert!(!is_neoforge_beta("21.0.3"));
        assert!(is_neoforge_beta("21.0.0-beta"));
    }

    #[test]
    fn neoforge_beta_labelled() {
        assert!(is_neoforge_beta("21.0.0-beta"));
        assert!(is_neoforge_beta("26.1.0.5-BETA"));
        assert!(!is_neoforge_beta("21.0.3"));
        assert!(!is_neoforge_beta("47.2.0"));
    }

    #[test]
    fn snapshot_types_listable_old_excluded() {
        assert!(is_listable_manifest_type("release"));
        assert!(is_listable_manifest_type("snapshot"));
        assert!(!is_listable_manifest_type("old_beta"));
        assert!(!is_listable_manifest_type("old_alpha"));
        assert!(!is_listable_manifest_type(""));

        assert!(safe_manifest_id("1.20.4", "release"));
        assert!(!safe_manifest_id("25w14a", "release"));
        assert!(safe_manifest_id("25w14a", "snapshot"));
        assert!(safe_manifest_id("1.21.5-rc2", "snapshot"));
        assert!(!safe_manifest_id("b1.7.3", "old_beta"));
        assert!(!safe_manifest_id("", "snapshot"));
        assert!(!safe_manifest_id("..", "snapshot"));

        assert!(safe_mc_version_or_snapshot("1.20.1"));
        assert!(safe_mc_version_or_snapshot("25w14a"));
        assert!(!safe_mc_version_or_snapshot(".."));
        assert!(!safe_mc_version_or_snapshot(""));
        assert!(!safe_mc_version_or_snapshot("a/b"));
    }
}
