use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    db::DbState,
    error::AppError,
    installer::{self, JobControl, JobProgress},
    java,
    modpacks::{
        curseforge_import, install,
        pipeline::{
            download::{self, DownloadProgress},
            loader::{self, LoaderCompletenessEvidence},
            model::{ExactPackPin, FileDecisionAction, ProviderPin},
            plan::{InstallPlan, InstallTarget, LoaderKind, LoaderPin},
            providers::{
                self,
                curseforge::ResolvedCurseForgeServerZip,
                modrinth::ResolvedMrpackInstall,
                snapshot::{snapshot_archive_with_cancel, ArchiveSnapshot},
                PlanContext, ProviderResolutionError,
            },
            report::{encode_json, InstallReport, InstallStatus, INSTALL_REPORT_FILE},
            selection::UserFileChoice,
            transaction::{self, PipelineTransactionError, PreparedPayload},
        },
    },
    servers::{self, CreateServerInput, ServerRecord},
    util::{paths, ports},
};

const MAX_PIPELINE_SESSIONS: usize = 8;
const PIPELINE_SESSION_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_INSTALL_REPORT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct PipelineState(Arc<Mutex<PipelineStateInner>>);

#[derive(Default)]
struct PipelineStateInner {
    local_sources: HashMap<String, SelectedLocalMrpack>,
    previews: HashMap<String, Arc<PendingPreview>>,
    jobs: HashMap<String, Arc<JobControl>>,
}

#[derive(Clone)]
struct SelectedLocalMrpack {
    path: PathBuf,
    file_name: String,
    expires_at: Instant,
}

struct PendingPreview {
    plan: InstallPlan,
    warnings: Vec<String>,
    source_name: String,
    source: PendingSource,
    archive: ArchiveSnapshot,
    expires_at: Instant,
}

enum PendingSource {
    LocalMrpack {
        source_id: String,
    },
    RemoteMrpack {
        project_id: String,
        version_id: String,
        version_json: serde_json::Value,
        loader: LoaderPin,
    },
    CurseForgeServerZip {
        file_name: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMrpackSelection {
    pub source_id: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum PipelineSourceRequest {
    ModrinthRemote {
        project_id: String,
        version_id: String,
        loader: LoaderPin,
        java_path: String,
    },
    LocalMrpack {
        source_id: String,
    },
    CurseForgeServerZip {
        zip_name: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelinePreview {
    pub preview_id: String,
    pub source_name: String,
    pub plan: InstallPlan,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineCreateInput {
    pub name: String,
    pub port: Option<u16>,
    pub ram_mb: i64,
    pub java_path: Option<String>,
    pub eula_accepted: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineInstallChoices {
    #[serde(default)]
    pub files: HashMap<String, UserFileChoice>,
    #[serde(default)]
    pub approved_replacements: HashSet<String>,
    #[serde(default)]
    pub auto_delete_curseforge_zip: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineInstallResult {
    pub status: String,
    pub server: Option<ServerRecord>,
    pub report: InstallReport,
    pub error: Option<String>,
}

impl PipelineState {
    pub fn new() -> Self {
        Self::default()
    }

    fn register_job(&self, job_id: &str) -> Result<Arc<JobControl>, AppError> {
        paths::validate_id(job_id)?;
        let mut inner = self
            .0
            .lock()
            .map_err(|_| AppError::Internal("modpack pipeline state lock poisoned".into()))?;
        reap_expired_sessions(&mut inner);
        if inner.jobs.contains_key(job_id) {
            return Err(AppError::Conflict(
                "an install job with this id is already active".into(),
            ));
        }
        let control = Arc::new(JobControl::new());
        inner.jobs.insert(job_id.to_string(), control.clone());
        Ok(control)
    }

    fn finish_job(&self, job_id: &str, control: &Arc<JobControl>) {
        if let Ok(mut inner) = self.0.lock() {
            if inner
                .jobs
                .get(job_id)
                .is_some_and(|current| Arc::ptr_eq(current, control))
            {
                inner.jobs.remove(job_id);
            }
        }
    }

    fn cancel_job(&self, job_id: &str) -> Result<bool, AppError> {
        paths::validate_id(job_id)?;
        let inner = self
            .0
            .lock()
            .map_err(|_| AppError::Internal("modpack pipeline state lock poisoned".into()))?;
        Ok(inner
            .jobs
            .get(job_id)
            .is_some_and(|control| control.cancel()))
    }
}

#[tauri::command]
pub async fn modpack_pipeline_pick_local_mrpack(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PipelineState>,
) -> Result<Option<LocalMrpackSelection>, AppError> {
    require_main_window(&window)?;
    let picker_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter("Modrinth modpacks", &["mrpack"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| AppError::Internal(format!("Modrinth pack picker failed: {error}")))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected_path = selected.into_path().map_err(|error| {
        AppError::Validation(format!("could not read selected pack path: {error}"))
    })?;
    let metadata = fs::symlink_metadata(&selected_path)
        .map_err(|_| AppError::NotFound("the selected .mrpack file could not be found".into()))?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(AppError::Validation(
            "select a regular .mrpack file, not a folder or link".into(),
        ));
    }
    if metadata.len() == 0 || metadata.len() > install::MAX_MRPACK_BYTES {
        return Err(AppError::Validation(
            ".mrpack size is outside the 2 GiB import limit".into(),
        ));
    }
    if !selected_path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mrpack"))
    {
        return Err(AppError::Validation(
            "select a file with a .mrpack extension".into(),
        ));
    }
    let file_name = selected_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty() && !name.chars().any(char::is_control))
        .ok_or_else(|| AppError::Validation("selected .mrpack filename is invalid".into()))?
        .to_string();
    let source_id = uuid::Uuid::new_v4().to_string();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| AppError::Internal("modpack pipeline state lock poisoned".into()))?;
    reap_expired_sessions(&mut inner);
    if inner.local_sources.len() + inner.previews.len() >= MAX_PIPELINE_SESSIONS {
        return Err(AppError::Conflict(
            "too many modpack reviews are open; close one and try again".into(),
        ));
    }
    inner.local_sources.insert(
        source_id.clone(),
        SelectedLocalMrpack {
            path: selected_path,
            file_name: file_name.clone(),
            expires_at: Instant::now() + PIPELINE_SESSION_TTL,
        },
    );
    Ok(Some(LocalMrpackSelection {
        source_id,
        file_name,
    }))
}

#[tauri::command]
pub async fn modpack_pipeline_preview(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PipelineState>,
    source: PipelineSourceRequest,
    job_id: String,
) -> Result<PipelinePreview, AppError> {
    require_main_window(&window)?;
    let state = state.inner().clone();
    let control = state.register_job(&job_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = prepare_preview(&app, &state, source, &job_id, &control);
        state.finish_job(&job_id, &control);
        result
    })
    .await
    .map_err(|error| AppError::Internal(format!("modpack preview task failed: {error}")))?;
    result
}

fn prepare_preview(
    app: &AppHandle,
    state: &PipelineState,
    source_request: PipelineSourceRequest,
    job_id: &str,
    control: &JobControl,
) -> Result<PipelinePreview, AppError> {
    let app_data = paths::app_data_dir(app)?;
    let preview_id = uuid::Uuid::new_v4().to_string();
    let preview_context = preview_plan_context(&preview_id);
    emit_progress(
        app,
        job_id,
        2,
        "Checking source pack",
        "Resolving the exact pack source.",
        None,
        None,
    );

    let (plan, warnings, source_name, source, archive) = match source_request {
        PipelineSourceRequest::ModrinthRemote {
            project_id,
            version_id,
            loader,
            java_path,
        } => {
            let java = java::validate_java_for_version(&java_path, &loader.minecraft_version)?;
            installer::ensure_not_cancelled(control)?;
            let version_json = providers::modrinth::fetch_remote_version_json_with_control(
                &project_id,
                &version_id,
                control,
            )
            .map_err(provider_error)?;
            installer::ensure_not_cancelled(control)?;
            let preinspection = providers::modrinth::resolve_remote_version_json(
                &project_id,
                &version_id,
                &version_json,
                preview_context,
                loader.clone(),
            )
            .map_err(provider_error)?;
            let source_name = preinspection.archive_download().file_name.clone();
            emit_progress(
                app,
                job_id,
                7,
                "Downloading pack archive",
                &source_name,
                Some(0),
                Some(preinspection.archive_download().size_bytes),
            );
            let downloaded = download_modrinth_archive_temp(
                app,
                job_id,
                preinspection.archive_download(),
                control,
            )?;
            installer::ensure_not_cancelled(control)?;
            let archive = downloaded;
            let resolved = providers::modrinth::finalize_remote_archive_with_cancel(
                &preinspection,
                archive.path(),
                &HashMap::new(),
                || control.is_cancelled(),
            )
            .map_err(provider_error)?;
            let plan = resolved.plan.clone();
            let warnings = resolved.warnings.clone();
            let _canonical_java = java.path;
            (
                plan,
                warnings,
                source_name,
                PendingSource::RemoteMrpack {
                    project_id,
                    version_id,
                    version_json,
                    loader,
                },
                archive,
            )
        }
        PipelineSourceRequest::LocalMrpack { source_id } => {
            let selected = {
                let mut inner = state.0.lock().map_err(|_| {
                    AppError::Internal("modpack pipeline state lock poisoned".into())
                })?;
                reap_expired_sessions(&mut inner);
                inner
                    .local_sources
                    .get(&source_id)
                    .cloned()
                    .ok_or_else(|| {
                        AppError::NotFound(
                            "the selected .mrpack review expired; pick it again".into(),
                        )
                    })?
            };
            let archive =
                snapshot_archive_with_cancel(&selected.path, install::MAX_MRPACK_BYTES, |_| {
                    control.is_cancelled()
                })
                .map_err(provider_error)?;
            installer::ensure_not_cancelled(control)?;
            let resolved = providers::modrinth::resolve_local_mrpack_with_cancel(
                archive.path(),
                preview_context,
                &HashMap::new(),
                || control.is_cancelled(),
            )
            .map_err(provider_error)?;
            (
                resolved.plan,
                resolved.warnings,
                selected.file_name,
                PendingSource::LocalMrpack { source_id },
                archive,
            )
        }
        PipelineSourceRequest::CurseForgeServerZip { zip_name } => {
            let source_path = curseforge_import::staged_zip_path(&app_data, &zip_name)?;
            let archive =
                snapshot_archive_with_cancel(&source_path, install::MAX_MRPACK_BYTES, |_| {
                    control.is_cancelled()
                })
                .map_err(provider_error)?;
            installer::ensure_not_cancelled(control)?;
            let resolved = providers::curseforge::resolve_author_server_zip_from_snapshot(
                &archive,
                &source_path,
                preview_context,
                |_, _| control.is_cancelled(),
            )
            .map_err(provider_error)?;
            (
                resolved.plan,
                resolved.warnings,
                zip_name.clone(),
                PendingSource::CurseForgeServerZip {
                    file_name: zip_name,
                },
                archive,
            )
        }
    };

    installer::ensure_not_cancelled(control)?;
    let preview = PipelinePreview {
        preview_id: preview_id.clone(),
        source_name: source_name.clone(),
        plan: plan.clone(),
        warnings: warnings.clone(),
    };
    let mut inner = state
        .0
        .lock()
        .map_err(|_| AppError::Internal("modpack pipeline state lock poisoned".into()))?;
    reap_expired_sessions(&mut inner);
    if let PendingSource::LocalMrpack { source_id } = &source {
        if !inner.local_sources.contains_key(source_id) {
            return Err(AppError::NotFound(
                "the selected .mrpack review was closed before it finished".into(),
            ));
        }
    }
    if inner.previews.len() >= MAX_PIPELINE_SESSIONS {
        return Err(AppError::Conflict(
            "too many modpack reviews are open; close one and try again".into(),
        ));
    }
    inner.previews.insert(
        preview_id,
        Arc::new(PendingPreview {
            plan,
            warnings,
            source_name,
            source,
            archive,
            expires_at: Instant::now() + PIPELINE_SESSION_TTL,
        }),
    );
    emit_progress(
        app,
        job_id,
        100,
        "Review ready",
        "Optional files and conflicts are ready for review.",
        None,
        None,
    );
    Ok(preview)
}

fn download_modrinth_archive_temp(
    app: &AppHandle,
    job_id: &str,
    archive: &providers::modrinth::ModrinthArchiveDownload,
    control: &JobControl,
) -> Result<ArchiveSnapshot, AppError> {
    let root = std::env::temp_dir().join(format!("modpack-source-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root)?;
    let result = (|| {
        let cancellation = control.cancellation_flag();
        let verified = download::download_modrinth_archive(
            archive,
            &root,
            &cancellation,
            |progress: DownloadProgress| {
                let percent = if progress.expected_bytes == 0 {
                    0
                } else {
                    (progress.bytes_received.saturating_mul(100) / progress.expected_bytes).min(99)
                        as u8
                };
                emit_progress(
                    app,
                    job_id,
                    7 + percent.saturating_mul(25) / 100,
                    "Downloading pack archive",
                    &format!("{}: {} bytes", progress.path, progress.bytes_received),
                    Some(progress.bytes_received),
                    Some(progress.expected_bytes),
                );
            },
        )
        .map_err(download_error)?;
        let path = root.join(verified.path);
        snapshot_archive_with_cancel(&path, install::MAX_MRPACK_BYTES, |_| control.is_cancelled())
            .map_err(provider_error)
    })();
    let _ = fs::remove_dir_all(&root);
    result
}

#[tauri::command]
pub async fn modpack_pipeline_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, PipelineState>,
    preview_id: String,
    input: PipelineCreateInput,
    choices: PipelineInstallChoices,
    job_id: String,
) -> Result<PipelineInstallResult, AppError> {
    require_main_window(&window)?;
    let state = state.inner().clone();
    let control = state.register_job(&job_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<DbState>();
        let result = install_from_preview(
            &app,
            db.inner(),
            &state,
            &preview_id,
            input,
            choices,
            &job_id,
            &control,
        );
        state.finish_job(&job_id, &control);
        result
    })
    .await
    .map_err(|error| AppError::Internal(format!("modpack installation task failed: {error}")))?;
    result
}

fn install_from_preview(
    app: &AppHandle,
    db: &DbState,
    state: &PipelineState,
    preview_id: &str,
    input: PipelineCreateInput,
    choices: PipelineInstallChoices,
    job_id: &str,
    control: &JobControl,
) -> Result<PipelineInstallResult, AppError> {
    paths::validate_id(preview_id)?;
    let pending = {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| AppError::Internal("modpack pipeline state lock poisoned".into()))?;
        reap_expired_sessions(&mut inner);
        inner.previews.remove(preview_id).ok_or_else(|| {
            AppError::NotFound("the modpack review expired; review the source again".into())
        })?
    };

    let installation = install_pending_preview(app, db, &pending, input, choices, job_id, control);
    match installation {
        Ok(result) => {
            if let PendingSource::LocalMrpack { source_id } = &pending.source {
                if let Ok(mut inner) = state.0.lock() {
                    release_local_source(&mut inner, source_id);
                }
            }
            Ok(result)
        }
        Err(error) => {
            let report = read_install_report_from_stage(&app_data_for(app)?, &error.staging_path)
                .unwrap_or_else(|| failed_report(&pending.plan, &error.message, error.cancelled));
            if !error.mutation_started && !control.is_cancelled() {
                if let Ok(mut inner) = state.0.lock() {
                    inner.previews.insert(preview_id.to_string(), pending);
                }
            }
            Ok(PipelineInstallResult {
                status: if error.cancelled {
                    "cancelled"
                } else {
                    "failed"
                }
                .into(),
                server: None,
                report,
                error: Some(error.message),
            })
        }
    }
}

struct InstallFailure {
    message: String,
    staging_path: PathBuf,
    cancelled: bool,
    mutation_started: bool,
}

fn install_pending_preview(
    app: &AppHandle,
    db: &DbState,
    pending: &PendingPreview,
    input: PipelineCreateInput,
    choices: PipelineInstallChoices,
    job_id: &str,
    control: &JobControl,
) -> Result<PipelineInstallResult, InstallFailure> {
    if matches!(pending.plan.loader.kind, super::plan::LoaderKind::Quilt) {
        return Err(install_failure(
            AppError::Validation("Quilt server installs are not supported yet".into()),
            None,
            false,
        ));
    }
    let app_data = app_data_for(app).map_err(|error| install_failure(error, None, false))?;
    let java_path = input
        .java_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| {
            install_failure(
                AppError::Validation(
                    "select a compatible Java executable before installing".into(),
                ),
                None,
                false,
            )
        })?;
    let canonical_java =
        java::validate_java_for_version(java_path, &pending.plan.loader.minecraft_version)
            .map_err(|error| install_failure(error, None, false))?
            .path;
    installer::ensure_not_cancelled(control).map_err(|error| install_failure(error, None, true))?;

    let record = candidate_server_record(
        db,
        &input,
        &pending.plan.loader,
        &pending.plan.source_pin,
        &canonical_java,
    )
    .map_err(|error| install_failure(error, None, false))?;
    let plan_id = uuid::Uuid::new_v4().to_string();
    let context = PlanContext {
        plan_id,
        created_at: chrono::Utc::now().to_rfc3339(),
        target: InstallTarget {
            server_id: record.id.clone(),
            server_name: record.name.clone(),
            directory: format!("servers/{}", record.id),
        },
    };
    let resolved = resolve_pending_source(pending, context, &choices.files, control)
        .map_err(|error| install_failure(error, None, control.is_cancelled()))?;
    resolved
        .plan()
        .validate_ready_to_install()
        .map_err(|error| install_failure(AppError::Validation(error.to_string()), None, false))?;
    let resolved_plan = resolved.plan();
    if resolved_plan.loader != pending.plan.loader
        || resolved_plan.source_pin != pending.plan.source_pin
        || resolved_plan
            .file_decisions
            .iter()
            .any(|decision| decision.action == FileDecisionAction::AwaitingUserChoice)
    {
        return Err(install_failure(
            AppError::Validation(
                "the reviewed provider plan changed; review the source again".into(),
            ),
            None,
            false,
        ));
    }
    let plan = resolved_plan.clone();
    installer::ensure_not_cancelled(control).map_err(|error| install_failure(error, None, true))?;

    let staging = create_pipeline_staging(&app_data, &plan)
        .map_err(|error| install_failure(error, None, false))?;
    emit_progress(
        app,
        job_id,
        3,
        "Preparing exact server runtime",
        "Using the selected Java executable and exact loader pin.",
        None,
        None,
    );
    let loader = loader::prepare_from_plan(
        &plan,
        &staging,
        Some(Path::new(&canonical_java)),
        app,
        job_id,
        control,
    )
    .map_err(|error| {
        let report = failed_report(&plan, &error.to_string(), control.is_cancelled());
        let _ = write_staging_report(&staging, &report);
        install_failure_with_mutation(
            error.to_string(),
            staging.clone(),
            control.is_cancelled(),
            true,
        )
    })?;
    emit_progress(
        app,
        job_id,
        65,
        "Preparing pack files",
        "Verifying downloads and ordered overrides.",
        None,
        None,
    );
    let payload =
        prepare_payload_for_pending(pending, &resolved, &staging, &loader, control, app, job_id)
            .map_err(|error| {
                let mut report = failed_report(&plan, &error.to_string(), control.is_cancelled());
                report.set_loader_evidence(&loader);
                let _ = write_staging_report(&staging, &report);
                install_failure_with_mutation(
                    error.to_string(),
                    staging.clone(),
                    control.is_cancelled(),
                    true,
                )
            })?;
    installer::ensure_not_cancelled(control).map_err(|error| {
        let mut report = failed_report(&plan, &error.to_string(), true);
        report.set_loader_evidence(&loader);
        let _ = write_staging_report(&staging, &report);
        install_failure_with_mutation(error.to_string(), staging.clone(), true, true)
    })?;

    control.begin_publication().map_err(|error| {
        let mut report = failed_report(&plan, &error.to_string(), control.is_cancelled());
        report.set_loader_evidence(&loader);
        let _ = write_staging_report(&staging, &report);
        install_failure_with_mutation(
            error.to_string(),
            staging.clone(),
            control.is_cancelled(),
            true,
        )
    })?;
    emit_progress(
        app,
        job_id,
        92,
        "Publishing server",
        "Committing the server and managed-file ownership atomically.",
        None,
        None,
    );
    let report = transaction::publish_new_staged_install(
        db,
        &app_data,
        &record,
        &plan,
        &payload,
        &loader,
        &staging,
        &choices.approved_replacements,
        &control.cancellation_flag(),
    )
    .map_err(|error| {
        install_failure_with_mutation(
            error.to_string(),
            staging.clone(),
            error == PipelineTransactionError::Cancelled,
            true,
        )
    })?;
    if choices.auto_delete_curseforge_zip {
        if let PendingSource::CurseForgeServerZip { file_name } = &pending.source {
            if let Err(error) = curseforge_import::remove_staged_zip(&app_data, file_name) {
                tracing::warn!(name = %file_name, %error, "could not remove staged CurseForge ZIP after successful installation");
            }
        }
    }
    emit_progress(
        app,
        job_id,
        100,
        "Complete",
        "Server installation and report are published.",
        None,
        None,
    );
    Ok(PipelineInstallResult {
        status: "complete".into(),
        server: Some(record),
        report,
        error: None,
    })
}

enum ResolvedPending {
    Modrinth(ResolvedMrpackInstall),
    CurseForge(ResolvedCurseForgeServerZip),
}

impl ResolvedPending {
    fn plan(&self) -> &InstallPlan {
        match self {
            Self::Modrinth(resolved) => &resolved.plan,
            Self::CurseForge(resolved) => &resolved.plan,
        }
    }
}

fn resolve_pending_source(
    pending: &PendingPreview,
    context: PlanContext,
    choices: &HashMap<String, UserFileChoice>,
    control: &JobControl,
) -> Result<ResolvedPending, AppError> {
    let resolved = match &pending.source {
        PendingSource::LocalMrpack { .. } => ResolvedPending::Modrinth(
            providers::modrinth::resolve_local_mrpack_with_cancel(
                pending.archive.path(),
                context,
                choices,
                || control.is_cancelled(),
            )
            .map_err(provider_error)?,
        ),
        PendingSource::RemoteMrpack {
            project_id,
            version_id,
            version_json,
            loader,
        } => {
            let preinspection = providers::modrinth::resolve_remote_version_json(
                project_id,
                version_id,
                version_json,
                context,
                loader.clone(),
            )
            .map_err(provider_error)?;
            ResolvedPending::Modrinth(
                providers::modrinth::finalize_remote_archive_with_cancel(
                    &preinspection,
                    pending.archive.path(),
                    choices,
                    || control.is_cancelled(),
                )
                .map_err(provider_error)?,
            )
        }
        PendingSource::CurseForgeServerZip { file_name } => {
            let display_path = Path::new(file_name);
            ResolvedPending::CurseForge(
                providers::curseforge::resolve_author_server_zip_from_snapshot(
                    &pending.archive,
                    display_path,
                    context,
                    |_, _| control.is_cancelled(),
                )
                .map_err(provider_error)?,
            )
        }
    };
    if resolved.plan() != &pending.plan && resolved.plan().source_pin != pending.plan.source_pin {
        return Err(AppError::Validation(
            "the source archive no longer matches its reviewed provider pin".into(),
        ));
    }
    Ok(resolved)
}

fn prepare_payload_for_pending(
    pending: &PendingPreview,
    resolved: &ResolvedPending,
    staging: &Path,
    loader: &LoaderCompletenessEvidence,
    control: &JobControl,
    app: &AppHandle,
    job_id: &str,
) -> Result<PreparedPayload, AppError> {
    let cancellation = control.cancellation_flag();
    match (resolved, &pending.source) {
        (ResolvedPending::Modrinth(resolved), _) => {
            transaction::prepare_modrinth_payload_from_snapshot(
                resolved,
                &pending.archive,
                staging,
                loader,
                &cancellation,
                |progress| emit_download_progress(app, job_id, progress),
            )
            .map_err(transaction_error)
        }
        (
            ResolvedPending::CurseForge(resolved),
            PendingSource::CurseForgeServerZip { file_name },
        ) => transaction::prepare_curseforge_payload_from_snapshot(
            resolved,
            &pending.archive,
            Path::new(file_name),
            staging,
            loader,
            &cancellation,
        )
        .map_err(transaction_error),
        _ => Err(AppError::Validation(
            "provider resolution does not match the reviewed source".into(),
        )),
    }
}

fn candidate_server_record(
    db: &DbState,
    input: &PipelineCreateInput,
    loader: &LoaderPin,
    source_pin: &ProviderPin,
    java_path: &str,
) -> Result<ServerRecord, AppError> {
    let name = input.name.trim();
    if name.is_empty()
        || name.len() > 64
        || name
            .chars()
            .any(|character| matches!(character, '\n' | '\r' | '='))
    {
        return Err(AppError::Validation(
            "server name must be 1–64 characters and must not contain newlines or '='".into(),
        ));
    }
    if !(512..=65536).contains(&input.ram_mb) {
        return Err(AppError::Validation(
            "ram must be between 512 and 65536 MB".into(),
        ));
    }
    if !matches!(
        loader.kind,
        LoaderKind::Vanilla | LoaderKind::Fabric | LoaderKind::Forge | LoaderKind::NeoForge
    ) {
        return Err(AppError::Validation(
            "Quilt is a disabled placeholder for new modpack servers".into(),
        ));
    }
    let mc_version = &loader.minecraft_version;
    if !installer::supported_minecraft_version(mc_version) {
        return Err(AppError::Validation(format!(
            "Minecraft version ID '{mc_version}' is invalid"
        )));
    }
    let create_input = CreateServerInput {
        name: name.to_string(),
        loader: loader_kind_name(loader.kind).into(),
        mc_version: mc_version.clone(),
        loader_version: loader.loader_version.clone(),
        modpack_id: Some(persisted_modpack_id(source_pin)),
        port: input.port,
        ram_mb: input.ram_mb,
        java_path: Some(java_path.to_string()),
        eula_accepted: input.eula_accepted,
    };
    let connection =
        db.0.lock()
            .map_err(|_| AppError::Internal("database lock poisoned".into()))?;
    servers::validate_install_preflight(&connection, &create_input)?;
    let port = match input.port.unwrap_or(0) {
        0 => ports::next_free_port(&connection, ports::FIRST_GAME_PORT)?,
        selected => ports::claim_port(&connection, selected)?,
    };
    Ok(ServerRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        loader: loader_kind_name(loader.kind).into(),
        mc_version: mc_version.clone(),
        loader_version: loader.loader_version.clone(),
        modpack_id: Some(persisted_modpack_id(source_pin)),
        port: port as i64,
        ram_mb: input.ram_mb,
        java_path: Some(java_path.to_string()),
        eula_accepted: input.eula_accepted.unwrap_or(false),
        status: "stopped".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn persisted_modpack_id(pin: &ProviderPin) -> String {
    match &pin.exact {
        ExactPackPin::ModrinthRemoteVersion {
            project_id,
            version_id,
            ..
        } => format!("modrinth:{project_id}:{version_id}"),
        ExactPackPin::ModrinthLocalArchive { archive, .. } => {
            format!("modrinth-local:{}", archive.hashes.sha512)
        }
        ExactPackPin::CurseForgeServerArchive { archive, .. } => {
            format!("curseforge-server:{}", archive.hashes.sha512)
        }
    }
}

fn create_pipeline_staging(app_data: &Path, plan: &InstallPlan) -> Result<PathBuf, AppError> {
    let root = app_data.join("installer-staging");
    ensure_regular_directory(&root, "installer staging root")?;
    let stage = root.join(format!("pipeline-{}", plan.plan_id));
    fs::create_dir(&stage).map_err(|error| {
        AppError::Io(format!(
            "could not create isolated pipeline staging: {error}"
        ))
    })?;
    Ok(stage)
}

fn ensure_regular_directory(path: &Path, label: &str) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => Ok(()),
        Ok(_) => Err(AppError::Validation(format!(
            "{label} is not a regular directory"
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn preview_plan_context(preview_id: &str) -> PlanContext {
    let id = format!("preview-{preview_id}");
    PlanContext {
        plan_id: id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        target: InstallTarget {
            server_id: id.clone(),
            server_name: "Pack review".into(),
            directory: format!("servers/{id}"),
        },
    }
}

fn app_data_for(app: &AppHandle) -> Result<PathBuf, AppError> {
    paths::app_data_dir(app)
}

fn read_install_report_from_stage(app_data: &Path, staging: &Path) -> Option<InstallReport> {
    let canonical_app_data = fs::canonicalize(app_data).ok()?;
    let canonical_staging = fs::canonicalize(staging).ok()?;
    if !canonical_staging.starts_with(canonical_app_data.join("installer-staging")) {
        return None;
    }
    let report_path = canonical_staging.join(INSTALL_REPORT_FILE);
    let metadata = fs::symlink_metadata(&report_path).ok()?;
    if !metadata.is_file()
        || is_reparse_point(&metadata)
        || metadata.len() > MAX_INSTALL_REPORT_BYTES
    {
        return None;
    }
    let bytes = fs::read(report_path).ok()?;
    let report: InstallReport = serde_json::from_slice(&bytes).ok()?;
    report.validate().ok()?;
    Some(report)
}

fn write_staging_report(staging: &Path, report: &InstallReport) -> Result<(), AppError> {
    ensure_regular_directory(staging, "pipeline staging")?;
    let bytes = encode_json(report).map_err(AppError::Validation)?;
    if bytes.len() as u64 > MAX_INSTALL_REPORT_BYTES {
        return Err(AppError::Validation(
            "install report exceeds its response size bound".into(),
        ));
    }
    fs::write(staging.join(INSTALL_REPORT_FILE), bytes)?;
    Ok(())
}

fn failed_report(plan: &InstallPlan, message: &str, cancelled: bool) -> InstallReport {
    let mut report = InstallReport::preparing(plan);
    report.status = if cancelled {
        InstallStatus::Cancelled
    } else {
        InstallStatus::Failed
    };
    let bounded = message.chars().take(2048).collect::<String>();
    report.errors.push(bounded.clone());
    report.record_stage("prepareAndPublish", "failed", Some(bounded));
    report
}

fn reap_expired_sessions(inner: &mut PipelineStateInner) {
    let now = Instant::now();
    inner
        .local_sources
        .retain(|_, source| source.expires_at > now);
    inner.previews.retain(|_, preview| preview.expires_at > now);
}

fn emit_download_progress(app: &AppHandle, job_id: &str, progress: DownloadProgress) {
    let percent = if progress.expected_bytes == 0 {
        0
    } else {
        (progress.bytes_received.saturating_mul(100) / progress.expected_bytes).min(99) as u8
    };
    emit_progress(
        app,
        job_id,
        66 + percent.saturating_mul(20) / 100,
        "Downloading pack files",
        &format!("{}: {} bytes", progress.path, progress.bytes_received),
        Some(progress.bytes_received),
        Some(progress.expected_bytes),
    );
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
        log: log
            .chars()
            .filter(|character| !character.is_control())
            .take(2048)
            .collect(),
        bytes_downloaded,
        bytes_total,
    };
    let _ = app.emit(&format!("job://progress/{job_id}"), payload);
}

fn require_main_window(window: &WebviewWindow) -> Result<(), AppError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(AppError::Validation(
            "modpack setup commands are available only to the main window".into(),
        ))
    }
}

fn provider_error(error: ProviderResolutionError) -> AppError {
    match error {
        ProviderResolutionError::Cancelled => {
            AppError::Conflict("modpack installation was cancelled".into())
        }
        other => AppError::Validation(other.to_string()),
    }
}

fn download_error(error: download::DownloadError) -> AppError {
    match error {
        download::DownloadError::Cancelled => {
            AppError::Conflict("modpack installation was cancelled".into())
        }
        other => AppError::Validation(other.to_string()),
    }
}

fn transaction_error(error: PipelineTransactionError) -> AppError {
    match error {
        PipelineTransactionError::Cancelled => {
            AppError::Conflict("modpack installation was cancelled".into())
        }
        PipelineTransactionError::Conflict(message)
        | PipelineTransactionError::Invalid(message)
        | PipelineTransactionError::Failed(message) => AppError::Validation(message),
    }
}

fn install_failure(
    error: AppError,
    staging: Option<PathBuf>,
    mutation_started: bool,
) -> InstallFailure {
    let message = error.to_string();
    InstallFailure {
        cancelled: message.to_ascii_lowercase().contains("cancel"),
        message,
        staging_path: staging.unwrap_or_default(),
        mutation_started,
    }
}

fn install_failure_with_mutation(
    message: String,
    staging_path: PathBuf,
    cancelled: bool,
    mutation_started: bool,
) -> InstallFailure {
    InstallFailure {
        message,
        staging_path,
        cancelled,
        mutation_started,
    }
}

fn loader_kind_name(kind: LoaderKind) -> &'static str {
    match kind {
        LoaderKind::Vanilla => "Vanilla",
        LoaderKind::Fabric => "Fabric",
        LoaderKind::Forge => "Forge",
        LoaderKind::NeoForge => "NeoForge",
        LoaderKind::Quilt => "Quilt",
    }
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
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

#[tauri::command]
pub fn modpack_pipeline_cancel(
    window: WebviewWindow,
    state: State<'_, PipelineState>,
    job_id: String,
) -> Result<bool, AppError> {
    require_main_window(&window)?;
    state.cancel_job(&job_id)
}

#[tauri::command]
pub fn modpack_pipeline_discard_preview(
    window: WebviewWindow,
    state: State<'_, PipelineState>,
    preview_id: String,
) -> Result<bool, AppError> {
    require_main_window(&window)?;
    paths::validate_id(&preview_id)?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| AppError::Internal("modpack pipeline state lock poisoned".into()))?;
    Ok(inner.previews.remove(&preview_id).is_some())
}

#[tauri::command]
pub fn modpack_pipeline_release_local_mrpack(
    window: WebviewWindow,
    state: State<'_, PipelineState>,
    source_id: String,
) -> Result<bool, AppError> {
    require_main_window(&window)?;
    paths::validate_id(&source_id)?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| AppError::Internal("modpack pipeline state lock poisoned".into()))?;
    Ok(release_local_source(&mut inner, &source_id))
}

fn release_local_source(inner: &mut PipelineStateInner, source_id: &str) -> bool {
    let removed_source = inner.local_sources.remove(source_id).is_some();
    let previous_preview_count = inner.previews.len();
    inner
        .previews
        .retain(|_, preview| !pending_preview_uses_local_source(&preview.source, source_id));
    removed_source || inner.previews.len() != previous_preview_count
}

fn pending_preview_uses_local_source(source: &PendingSource, source_id: &str) -> bool {
    matches!(
        source,
        PendingSource::LocalMrpack {
            source_id: preview_source_id
        } if preview_source_id == source_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipeline_source_requests_deserialize_frontend_camel_case_fields() {
        let remote: PipelineSourceRequest = serde_json::from_value(serde_json::json!({
            "kind": "modrinthRemote",
            "projectId": "5FFgwNNP",
            "versionId": "BpTjgzL8",
            "loader": {
                "kind": "fabric",
                "minecraftVersion": "1.21.1",
                "loaderVersion": "0.19.5"
            },
            "javaPath": "C:/Java/bin/java.exe"
        }))
        .unwrap();
        assert!(matches!(
            remote,
            PipelineSourceRequest::ModrinthRemote {
                project_id,
                version_id,
                java_path,
                ..
            } if project_id == "5FFgwNNP"
                && version_id == "BpTjgzL8"
                && java_path == "C:/Java/bin/java.exe"
        ));

        let local: PipelineSourceRequest = serde_json::from_value(serde_json::json!({
            "kind": "localMrpack",
            "sourceId": "f7b6f863-3d71-4a1b-bd7e-31fc0959621e"
        }))
        .unwrap();
        assert!(matches!(
            local,
            PipelineSourceRequest::LocalMrpack { source_id }
                if source_id == "f7b6f863-3d71-4a1b-bd7e-31fc0959621e"
        ));

        let curseforge: PipelineSourceRequest = serde_json::from_value(serde_json::json!({
            "kind": "curseForgeServerZip",
            "zipName": "author-server.zip"
        }))
        .unwrap();
        assert!(matches!(
            curseforge,
            PipelineSourceRequest::CurseForgeServerZip { zip_name }
                if zip_name == "author-server.zip"
        ));
    }

    #[test]
    fn release_local_source_removes_the_picker_token() {
        let mut inner = PipelineStateInner::default();
        inner.local_sources.insert(
            "source-1".into(),
            SelectedLocalMrpack {
                path: PathBuf::from("fixture.mrpack"),
                file_name: "fixture.mrpack".into(),
                expires_at: Instant::now() + Duration::from_secs(60),
            },
        );

        assert!(release_local_source(&mut inner, "source-1"));
        assert!(inner.local_sources.is_empty());
        assert!(!release_local_source(&mut inner, "source-1"));
    }

    #[test]
    fn local_preview_is_bound_to_its_picker_token() {
        let local_source = PendingSource::LocalMrpack {
            source_id: "source-1".into(),
        };
        let remote_source = PendingSource::RemoteMrpack {
            project_id: "project1".into(),
            version_id: "version1".into(),
            version_json: serde_json::json!({}),
            loader: LoaderPin {
                kind: LoaderKind::Fabric,
                minecraft_version: "1.20.1".into(),
                loader_version: Some("0.15.11".into()),
            },
        };

        assert!(pending_preview_uses_local_source(&local_source, "source-1"));
        assert!(!pending_preview_uses_local_source(
            &local_source,
            "source-2"
        ));
        assert!(!pending_preview_uses_local_source(
            &remote_source,
            "source-1"
        ));
    }
}
