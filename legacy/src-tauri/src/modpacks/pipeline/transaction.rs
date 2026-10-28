use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use crate::{
    db::DbState,
    error::AppError,
    java,
    modpacks::{
        curseforge_import, install,
        pipeline::{
            download::{self, DownloadError, DownloadProgress, VerifiedDownload},
            loader::LoaderCompletenessEvidence,
            model::{ContentHashes, FileDecisionAction, ProviderSource},
            plan::{InstallPlan, LoaderKind},
            providers::{
                curseforge::ResolvedCurseForgeServerZip,
                modrinth::ResolvedMrpackInstall,
                snapshot::{snapshot_archive_with_cancel, ArchiveSnapshot},
                PlanContext, ProviderResolutionError,
            },
            report::{
                encode_json, validate_relative_report_path, FileOutcome, FileReportEntry,
                InstallReport, InstallStatus, ManagedFileRecord, ManagedFilesManifest,
                INSTALL_PLAN_FILE, INSTALL_REPORT_FILE, LAUNCH_CONFIG_FILE, MANAGED_FILES_FILE,
                MAX_LAUNCH_CONFIG_BYTES, MAX_MANAGED_FILES_MANIFEST_BYTES,
            },
        },
    },
    servers::{self, ServerRecord},
    util::{paths, ports},
};

const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const TRANSACTION_HEADROOM_BYTES: u64 = 32 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 128 * 1024;
const MAX_STAGE_FILES: usize = 100_000;
const MAX_STAGE_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const BACKUP_MARKER: &str = ".pipeline-backup.json";
const BACKUP_ROOT: &str = "backups/modpack-installs";
const MAX_SUCCESSFUL_BACKUPS: usize = 2;
const MANAGER_OWNED_PROPERTIES: &[&str] = &[
    "server-port",
    "motd",
    "max-players",
    "online-mode",
    "difficulty",
    "gamemode",
    "level-name",
    "enable-rcon",
    "enable-status",
];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PipelineTransactionError {
    #[error("install transaction is invalid: {0}")]
    Invalid(String),
    #[error("install conflicts with existing server files: {0}")]
    Conflict(String),
    #[error("install transaction was cancelled")]
    Cancelled,
    #[error("install transaction failed: {0}")]
    Failed(String),
}

impl From<AppError> for PipelineTransactionError {
    fn from(error: AppError) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<std::io::Error> for PipelineTransactionError {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<zip::result::ZipError> for PipelineTransactionError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::Invalid(format!("archive operation failed: {error}"))
    }
}

impl From<rusqlite::Error> for PipelineTransactionError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<DownloadError> for PipelineTransactionError {
    fn from(error: DownloadError) -> Self {
        match error {
            DownloadError::Invalid(message) => Self::Invalid(message),
            DownloadError::Cancelled => Self::Cancelled,
            DownloadError::Failed(message) => Self::Failed(message),
            DownloadError::FileFailed { path, attempted_sources, expected_size_bytes, expected_hashes, observed_size_bytes, observed_hashes, message } => {
                Self::Failed(format!(
                    "download failed for {path}; attempted sources: {}; expected {expected_size_bytes} bytes/SHA-1 {}/SHA-512 {}; observed {:?} bytes/{:?}: {message}",
                    attempted_sources.join(", "),
                    expected_hashes.sha1,
                    expected_hashes.sha512,
                    observed_size_bytes,
                    observed_hashes,
                ))
            }
        }
    }
}

impl From<ProviderResolutionError> for PipelineTransactionError {
    fn from(error: ProviderResolutionError) -> Self {
        match error {
            ProviderResolutionError::Cancelled => Self::Cancelled,
            ProviderResolutionError::Malformed(message)
            | ProviderResolutionError::Unsupported(message)
            | ProviderResolutionError::Io(message) => Self::Invalid(message),
            ProviderResolutionError::InsufficientSpace {
                required_bytes,
                available_bytes,
            } => Self::Invalid(format!(
                "not enough temporary space (need {required_bytes}, have {available_bytes})"
            )),
            ProviderResolutionError::InvalidModel(error) => Self::Invalid(error.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadFileOrigin {
    ModrinthDownload,
    SharedOverride,
    ServerOverride,
    CurseForgeArchive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedPayloadFile {
    pub path: String,
    pub size_bytes: u64,
    pub hashes: ContentHashes,
    pub source_host: Option<String>,
    pub origin: PayloadFileOrigin,
}

/// Evidence produced from an active provider resolution and source archive.
/// It is passed in memory to publication; the JSON plan is never reloaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedPayload {
    pub plan_id: String,
    pub source: ProviderSource,
    pub selected_file_paths: Vec<String>,
    pub override_file_paths: Vec<String>,
    pub files: Vec<StagedPayloadFile>,
    pub verified_downloads: Vec<VerifiedDownload>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicationFault {
    AfterFirstMutation,
    BeforeDatabaseCommit,
}

#[derive(Debug, Clone)]
struct RegistryFile {
    canonical_root: String,
    path_key: String,
    relative_path: String,
    size_bytes: u64,
    hashes: ContentHashes,
    plan_id: String,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct StageFile {
    relative_path: String,
    staged_path: PathBuf,
    size_bytes: u64,
    hashes: ContentHashes,
    source_host: Option<String>,
    payload_origin: Option<PayloadFileOrigin>,
    managed: bool,
}

#[derive(Debug, Clone)]
struct FileOperation {
    relative_path: String,
    staged_source: Option<PathBuf>,
    staged_size: Option<u64>,
    staged_hashes: Option<ContentHashes>,
    target: PathBuf,
    backup: Option<PathBuf>,
    expected_existing_size: Option<u64>,
    expected_existing_hashes: Option<ContentHashes>,
    is_manager_artifact: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JournalBackupLocation {
    ServerTree,
    StagingManagerArtifact,
}

#[derive(Debug, Clone)]
struct JournalEntry {
    target: PathBuf,
    staged_source: Option<PathBuf>,
    backup: Option<PathBuf>,
    backup_location: Option<JournalBackupLocation>,
    backup_expected_size: Option<u64>,
    backup_expected_hashes: Option<ContentHashes>,
    target_had_original: bool,
    target_has_new_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupManifest {
    schema_version: u32,
    kind: String,
    backup_id: String,
    server_id: String,
    plan_id: String,
    created_at: String,
    files: Vec<BackupFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupFile {
    relative_path: String,
    size_bytes: u64,
    hashes: ContentHashes,
}

#[derive(Debug, Default)]
struct PublicationJournal {
    entries: Vec<JournalEntry>,
    created_directories: Vec<PathBuf>,
    created_files: Vec<PathBuf>,
    backup_root: Option<PathBuf>,
    canonical_root: PathBuf,
    target_root: PathBuf,
    staging_root: PathBuf,
}

/// Download the exact Modrinth file decisions and then apply shared overrides
/// followed by server overrides. The caller must have prepared the pinned loader
/// in the same staging directory first.
pub fn prepare_modrinth_payload<F>(
    resolved: &ResolvedMrpackInstall,
    archive_path: &Path,
    staging: &Path,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
    on_progress: F,
) -> Result<PreparedPayload, PipelineTransactionError>
where
    F: Fn(DownloadProgress) + Sync,
{
    let mut report = InstallReport::preparing(&resolved.plan);
    if loader.complete {
        report.set_loader_evidence(loader);
    }
    let snapshot = modrinth_archive_fingerprint(&resolved.plan).and_then(|fingerprint| {
        snapshot_archive_with_cancel(archive_path, fingerprint.size_bytes, |_| {
            cancelled.load(Ordering::Acquire)
        })
        .map_err(PipelineTransactionError::from)
    });
    let result = match snapshot {
        Ok(snapshot) => prepare_modrinth_payload_inner(
            resolved,
            &snapshot,
            staging,
            loader,
            cancelled,
            on_progress,
            &mut report,
        ),
        Err(error) => Err(error),
    };
    if let Err(error) = &result {
        record_modrinth_preparation_failure(&mut report, resolved, error);
        persist_preparation_failure(
            &resolved.plan,
            staging,
            &mut report,
            "prepareModrinth",
            error,
        );
    }
    result
}

/// Prepares a Modrinth payload from the exact protected archive snapshot that
/// was reviewed by the provider-selection stage.
pub fn prepare_modrinth_payload_from_snapshot<F>(
    resolved: &ResolvedMrpackInstall,
    snapshot: &ArchiveSnapshot,
    staging: &Path,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
    on_progress: F,
) -> Result<PreparedPayload, PipelineTransactionError>
where
    F: Fn(DownloadProgress) + Sync,
{
    let mut report = InstallReport::preparing(&resolved.plan);
    if loader.complete {
        report.set_loader_evidence(loader);
    }
    let result = prepare_modrinth_payload_inner(
        resolved,
        snapshot,
        staging,
        loader,
        cancelled,
        on_progress,
        &mut report,
    );
    if let Err(error) = &result {
        record_modrinth_preparation_failure(&mut report, resolved, error);
        persist_preparation_failure(
            &resolved.plan,
            staging,
            &mut report,
            "prepareModrinth",
            error,
        );
    }
    result
}

fn prepare_modrinth_payload_inner<F>(
    resolved: &ResolvedMrpackInstall,
    snapshot: &ArchiveSnapshot,
    staging: &Path,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
    on_progress: F,
    report: &mut InstallReport,
) -> Result<PreparedPayload, PipelineTransactionError>
where
    F: Fn(DownloadProgress) + Sync,
{
    validate_loader_evidence(&resolved.plan, loader)?;
    let expected_archive = modrinth_archive_fingerprint(&resolved.plan)?;
    verify_snapshot_fingerprint(snapshot, expected_archive, "Modrinth")?;
    let downloaded =
        match download::download_modrinth_files(resolved, staging, cancelled, on_progress) {
            Ok(downloaded) => downloaded,
            Err(error) => {
                record_download_failure(report, &error);
                return Err(error.into());
            }
        };
    for item in &downloaded {
        report.files.push(FileReportEntry {
            path: item.path.clone(),
            outcome: FileOutcome::Verified,
            size_bytes: Some(item.size_bytes),
            hashes: Some(item.hashes.clone()),
            source_host: Some(item.source_host.clone()),
            detail: Some("provider-declared size, SHA-1, and SHA-512 verified".into()),
        });
    }
    check_cancelled(cancelled)?;
    let override_evidence = extract_mrpack_overrides(snapshot, staging, loader, cancelled)?;
    let override_paths = override_evidence
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    check_cancelled(cancelled)?;
    let mut payload_paths = downloaded
        .iter()
        .map(|file| file.path.clone())
        .collect::<BTreeSet<_>>();
    payload_paths.extend(override_paths.iter().cloned());
    let mut files = collect_staged_payload_files(staging, &payload_paths, cancelled)?;
    let source_hosts = downloaded
        .iter()
        .map(|file| Ok((path_key(&file.path)?, file.source_host.clone())))
        .collect::<Result<HashMap<_, _>, PipelineTransactionError>>()?;
    let override_origins = override_evidence
        .iter()
        .map(|(path, origin)| Ok((path_key(path)?, *origin)))
        .collect::<Result<HashMap<_, _>, PipelineTransactionError>>()?;
    for file in &mut files {
        let key = path_key(&file.path)?;
        if let Some(origin) = override_origins.get(&key) {
            file.origin = *origin;
            file.source_host = None;
        } else {
            file.origin = PayloadFileOrigin::ModrinthDownload;
            file.source_host = source_hosts.get(&key).cloned();
        }
    }
    Ok(PreparedPayload {
        plan_id: resolved.plan.plan_id.clone(),
        source: ProviderSource::Modrinth,
        selected_file_paths: downloaded.iter().map(|file| file.path.clone()).collect(),
        override_file_paths: override_paths,
        files,
        verified_downloads: downloaded,
        warnings: resolved.warnings.clone(),
    })
}

/// Re-resolve a local CurseForge author ZIP before extraction so the provider
/// pin and server-side file inventory come from the source archive, not JSON.
pub fn prepare_curseforge_payload(
    resolved: &ResolvedCurseForgeServerZip,
    archive_path: &Path,
    staging: &Path,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
) -> Result<PreparedPayload, PipelineTransactionError> {
    let mut report = InstallReport::preparing(&resolved.plan);
    if loader.complete {
        report.set_loader_evidence(loader);
    }
    let expected_archive = curseforge_archive_fingerprint(&resolved.plan)?;
    let snapshot = snapshot_archive_with_cancel(archive_path, expected_archive.size_bytes, |_| {
        cancelled.load(Ordering::Acquire)
    });
    let result = match snapshot {
        Ok(snapshot) => prepare_curseforge_payload_inner(
            resolved,
            &snapshot,
            archive_path,
            staging,
            loader,
            cancelled,
        ),
        Err(error) => Err(error.into()),
    };
    if let Err(error) = &result {
        record_curseforge_preparation_failure(&mut report, resolved, error);
        persist_preparation_failure(
            &resolved.plan,
            staging,
            &mut report,
            "prepareCurseForge",
            error,
        );
    }
    result
}

/// Extracts an author-provided CurseForge archive from the exact protected
/// snapshot reviewed by the provider-selection stage. `display_path` is used
/// only to rederive the original listed filename in the source pin.
pub fn prepare_curseforge_payload_from_snapshot(
    resolved: &ResolvedCurseForgeServerZip,
    snapshot: &ArchiveSnapshot,
    display_path: &Path,
    staging: &Path,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
) -> Result<PreparedPayload, PipelineTransactionError> {
    let mut report = InstallReport::preparing(&resolved.plan);
    if loader.complete {
        report.set_loader_evidence(loader);
    }
    let result = prepare_curseforge_payload_inner(
        resolved,
        snapshot,
        display_path,
        staging,
        loader,
        cancelled,
    );
    if let Err(error) = &result {
        record_curseforge_preparation_failure(&mut report, resolved, error);
        persist_preparation_failure(
            &resolved.plan,
            staging,
            &mut report,
            "prepareCurseForge",
            error,
        );
    }
    result
}

fn prepare_curseforge_payload_inner(
    resolved: &ResolvedCurseForgeServerZip,
    snapshot: &ArchiveSnapshot,
    display_path: &Path,
    staging: &Path,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
) -> Result<PreparedPayload, PipelineTransactionError> {
    validate_loader_evidence(&resolved.plan, loader)?;
    check_cancelled(cancelled)?;
    let expected_archive = curseforge_archive_fingerprint(&resolved.plan)?;
    verify_snapshot_fingerprint(snapshot, expected_archive, "CurseForge")?;
    let context = PlanContext {
        plan_id: resolved.plan.plan_id.clone(),
        created_at: resolved.plan.created_at.clone(),
        target: resolved.plan.target.clone(),
    };
    let fresh =
        crate::modpacks::pipeline::providers::curseforge::resolve_author_server_zip_from_snapshot(
            snapshot,
            display_path,
            context,
            |_, _| cancelled.load(Ordering::Acquire),
        )?;
    if fresh.plan != resolved.plan
        || fresh.included_files != resolved.included_files
        || fresh.server_pack_creator != resolved.server_pack_creator
    {
        return Err(PipelineTransactionError::Invalid(
            "CurseForge archive no longer matches its active provider resolution".into(),
        ));
    }
    check_cancelled(cancelled)?;
    let outer = curseforge_import::build_archive_plan(snapshot.path())?;
    let prepared =
        curseforge_import::prepare_server_pack_archive_with_cancel(snapshot.path(), outer, |_| {
            cancelled.load(Ordering::Acquire)
        })
        .map_err(|error| match error {
            curseforge_import::PreparedArchiveError::App(error) => error.into(),
            curseforge_import::PreparedArchiveError::Cancelled => {
                PipelineTransactionError::Cancelled
            }
        })?;
    check_cancelled(cancelled)?;
    let classification =
        crate::modpacks::pipeline::classify::classify_curseforge_server_zip(&prepared.path);
    match classification {
        crate::modpacks::pipeline::classify::CurseForgeArchiveClassification::ServerPack {
            minecraft_version,
            loader: loader_name,
            loader_version,
            ..
        } if minecraft_version == resolved.plan.loader.minecraft_version
            && loader_name == loader_kind_name(resolved.plan.loader.kind)
            && loader_version
                == resolved
                    .plan
                    .loader
                    .loader_version
                    .as_deref()
                    .unwrap_or_default() => {}
        _ => {
            return Err(PipelineTransactionError::Invalid(
                "CurseForge server archive classification changed before extraction".into(),
            ))
        }
    }

    let selected = included_paths(&resolved.plan)?;
    if selected != resolved.included_files.iter().cloned().collect() {
        return Err(PipelineTransactionError::Invalid(
            "CurseForge included-file list differs from its server-side plan".into(),
        ));
    }
    let mut files =
        extract_curseforge_payload_files(&prepared.path, staging, &selected, loader, cancelled)?;
    for file in &mut files {
        file.source_host = Some("author-provided CurseForge server ZIP".into());
    }
    Ok(PreparedPayload {
        plan_id: resolved.plan.plan_id.clone(),
        source: ProviderSource::CurseForge,
        selected_file_paths: selected.iter().cloned().collect(),
        override_file_paths: Vec::new(),
        files,
        verified_downloads: Vec::new(),
        warnings: resolved.warnings.clone(),
    })
}

fn record_download_failure(report: &mut InstallReport, error: &DownloadError) {
    let DownloadError::FileFailed {
        path,
        attempted_sources,
        expected_size_bytes,
        expected_hashes,
        observed_size_bytes,
        observed_hashes,
        message,
    } = error
    else {
        return;
    };
    let detail = bounded_report_text(&format!(
        "expected {} bytes, SHA-1 {}, SHA-512 {}; observed {:?} bytes, hashes {:?}; attempted sources [{}]; {}",
        expected_size_bytes,
        expected_hashes.sha1,
        expected_hashes.sha512,
        observed_size_bytes,
        observed_hashes,
        attempted_sources.join(", "),
        message
    ));
    report.files.push(FileReportEntry {
        path: path.clone(),
        outcome: FileOutcome::Failed,
        size_bytes: *observed_size_bytes,
        hashes: observed_hashes.clone(),
        source_host: None,
        detail: Some(detail),
    });
}

fn record_modrinth_preparation_failure(
    report: &mut InstallReport,
    resolved: &ResolvedMrpackInstall,
    error: &PipelineTransactionError,
) {
    if report
        .files
        .iter()
        .any(|file| file.outcome == FileOutcome::Failed)
    {
        return;
    }
    for file in resolved.file_downloads.iter().take(32) {
        if report
            .files
            .iter()
            .any(|entry| entry.path == file.path && entry.outcome == FileOutcome::Verified)
        {
            continue;
        }
        report.files.push(FileReportEntry {
            path: file.path.clone(),
            outcome: FileOutcome::Failed,
            size_bytes: None,
            hashes: None,
            source_host: None,
            detail: Some(bounded_report_text(&format!(
                "expected {} bytes, SHA-1 {}, SHA-512 {}; candidate sources [{}]; transfer or staging did not complete: {}",
                file.size_bytes,
                file.hashes.sha1,
                file.hashes.sha512,
                file.urls.iter().take(8).map(|url| bounded_report_text(url)).collect::<Vec<_>>().join(", "),
                error
            ))),
        });
    }
    if resolved.file_downloads.len() > 32 {
        report.warnings.push(format!(
            "{} additional file diagnostics omitted",
            resolved.file_downloads.len() - 32
        ));
    }
}

fn record_curseforge_preparation_failure(
    report: &mut InstallReport,
    resolved: &ResolvedCurseForgeServerZip,
    error: &PipelineTransactionError,
) {
    use crate::modpacks::pipeline::model::ExactPackPin;
    let archive_evidence = match &resolved.plan.source_pin.exact {
        ExactPackPin::CurseForgeServerArchive { archive, .. } => format!(
            "calculated archive fingerprint only (not an authenticity claim): {} bytes, SHA-1 {}, SHA-512 {}",
            archive.size_bytes, archive.hashes.sha1, archive.hashes.sha512
        ),
        _ => "archive fingerprint unavailable".into(),
    };
    for path in resolved.included_files.iter().take(32) {
        report.files.push(FileReportEntry {
            path: path.clone(),
            outcome: FileOutcome::Failed,
            size_bytes: None,
            hashes: None,
            source_host: Some("author-provided local server ZIP".into()),
            detail: Some(bounded_report_text(&format!(
                "{archive_evidence}; extraction did not complete: {error}"
            ))),
        });
    }
    if resolved.included_files.len() > 32 {
        report.warnings.push(format!(
            "{} additional file diagnostics omitted",
            resolved.included_files.len() - 32
        ));
    }
}

fn persist_preparation_failure(
    plan: &InstallPlan,
    staging: &Path,
    report: &mut InstallReport,
    stage: &str,
    error: &PipelineTransactionError,
) {
    report.status = if *error == PipelineTransactionError::Cancelled {
        InstallStatus::Cancelled
    } else {
        InstallStatus::Failed
    };
    let detail = bounded_report_text(&error.to_string());
    report.errors.push(detail.clone());
    report.record_stage(stage, "failed", Some(detail));
    if safe_preparation_report_root(staging) {
        let _ = write_stage_json(staging, INSTALL_PLAN_FILE, plan);
        let _ = write_stage_json(staging, INSTALL_REPORT_FILE, report);
    }
}

fn safe_preparation_report_root(staging: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(staging) else {
        return false;
    };
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return false;
    }
    let Some(parent) = staging.parent() else {
        return false;
    };
    if parent
        .file_name()
        .is_none_or(|name| name != "installer-staging")
    {
        return false;
    }
    let Ok(parent_metadata) = fs::symlink_metadata(parent) else {
        return false;
    };
    if !parent_metadata.is_dir() || is_reparse_point(&parent_metadata) {
        return false;
    }
    let Ok(canonical_staging) = fs::canonicalize(staging) else {
        return false;
    };
    let Ok(canonical_parent) = fs::canonicalize(parent) else {
        return false;
    };
    canonical_staging.parent() == Some(canonical_parent.as_path())
}

fn bounded_report_text(value: &str) -> String {
    const MAX_CHARS: usize = 2048;
    if value.chars().count() <= MAX_CHARS {
        return value.to_string();
    }
    let mut output = value.chars().take(MAX_CHARS - 1).collect::<String>();
    output.push('…');
    output
}

fn validate_loader_evidence(
    plan: &InstallPlan,
    evidence: &LoaderCompletenessEvidence,
) -> Result<(), PipelineTransactionError> {
    plan.validate_ready_to_install()
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    if !evidence.complete
        || evidence.plan != *plan
        || evidence.coordinate.provider_pin != plan.loader
    {
        return Err(PipelineTransactionError::Invalid(
            "loader completeness evidence does not belong to this finalized plan".into(),
        ));
    }
    Ok(())
}

fn modrinth_archive_fingerprint(
    plan: &InstallPlan,
) -> Result<&crate::modpacks::pipeline::model::ArchiveFingerprint, PipelineTransactionError> {
    let expected = match &plan.source_pin.exact {
        crate::modpacks::pipeline::model::ExactPackPin::ModrinthLocalArchive {
            archive, ..
        }
        | crate::modpacks::pipeline::model::ExactPackPin::ModrinthRemoteVersion {
            archive, ..
        } => archive,
        _ => {
            return Err(PipelineTransactionError::Invalid(
                "mrpack archive does not match its source pin variant".into(),
            ))
        }
    };
    Ok(expected)
}

fn curseforge_archive_fingerprint(
    plan: &InstallPlan,
) -> Result<&crate::modpacks::pipeline::model::ArchiveFingerprint, PipelineTransactionError> {
    let expected = match &plan.source_pin.exact {
        crate::modpacks::pipeline::model::ExactPackPin::CurseForgeServerArchive {
            archive, ..
        } => archive,
        _ => {
            return Err(PipelineTransactionError::Invalid(
                "CurseForge plan has an incompatible source pin".into(),
            ))
        }
    };
    Ok(expected)
}

fn verify_snapshot_fingerprint(
    snapshot: &ArchiveSnapshot,
    expected: &crate::modpacks::pipeline::model::ArchiveFingerprint,
    provider: &str,
) -> Result<(), PipelineTransactionError> {
    let actual = snapshot.fingerprint();
    if actual.size_bytes != expected.size_bytes || !hashes_equal(&actual.hashes, &expected.hashes) {
        return Err(PipelineTransactionError::Invalid(format!(
            "{provider} archive snapshot fingerprint differs from the resolved source pin"
        )));
    }
    Ok(())
}

fn included_paths(plan: &InstallPlan) -> Result<BTreeSet<String>, PipelineTransactionError> {
    plan.validate_ready_to_install()
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    let mut included = BTreeSet::new();
    for decision in &plan.file_decisions {
        if decision.action == FileDecisionAction::Include {
            install::validate_relative_path(&decision.path, false)
                .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
            included.insert(decision.path.clone());
        }
    }
    Ok(included)
}

fn extract_mrpack_overrides(
    snapshot: &ArchiveSnapshot,
    staging: &Path,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
) -> Result<Vec<(String, PayloadFileOrigin)>, PipelineTransactionError> {
    let archive_path = snapshot.path();
    let metadata = fs::symlink_metadata(archive_path)?;
    if !metadata.file_type().is_file()
        || is_reparse_point(&metadata)
        || metadata.len() > MAX_ARCHIVE_BYTES
    {
        return Err(PipelineTransactionError::Invalid(
            "mrpack override source is not a regular bounded archive".into(),
        ));
    }
    install::ensure_safe_staging(staging)?;
    let mut archive = ZipArchive::new(File::open(archive_path)?).map_err(|_| {
        PipelineTransactionError::Invalid("mrpack archive is not a readable ZIP".into())
    })?;
    if archive.len() == 0 || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(PipelineTransactionError::Invalid(
            "mrpack archive entry count is outside the supported bound".into(),
        ));
    }
    let loader_paths = loader
        .required_files
        .iter()
        .map(|file| file.relative_path.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut seen = HashMap::<String, (String, String)>::new();
    let mut members = Vec::new();
    let mut total_expanded = 0u64;
    for index in 0..archive.len() {
        check_cancelled(cancelled)?;
        let entry = archive.by_index(index)?;
        if entry.is_symlink() {
            return Err(PipelineTransactionError::Invalid(
                "mrpack archive contains a symbolic-link entry".into(),
            ));
        }
        let name = entry.name().to_string();
        let is_dir = entry.is_dir();
        let relative = install::validate_relative_path(&name, is_dir)
            .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
        total_expanded = total_expanded
            .checked_add(entry.size())
            .filter(|sum| *sum <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| {
                PipelineTransactionError::Invalid("mrpack expanded size exceeds 20 GiB".into())
            })?;
        if !is_dir && entry.size() > MAX_ENTRY_BYTES {
            return Err(PipelineTransactionError::Invalid(format!(
                "mrpack entry {relative} exceeds the per-file size bound"
            )));
        }
        let Some((layer, payload_path)) = override_member(&relative)? else {
            continue;
        };
        if is_dir || payload_path.is_empty() {
            continue;
        }
        reject_protected_pack_path(&payload_path)?;
        if loader_paths.contains(&payload_path.to_ascii_lowercase()) {
            return Err(PipelineTransactionError::Invalid(format!(
                "mrpack override would replace a required loader file: {payload_path}"
            )));
        }
        let key = payload_path.to_ascii_lowercase();
        if let Some((previous_layer, previous_path)) = seen.get(&key) {
            if previous_path != &payload_path || previous_layer == &layer {
                return Err(PipelineTransactionError::Invalid(format!(
                    "mrpack overrides contain duplicate or case-aliased path {payload_path}"
                )));
            }
        }
        seen.insert(key, (layer.clone(), payload_path.clone()));
        members.push(ArchiveMember {
            index,
            path: payload_path,
            layer,
            size: entry.size(),
        });
    }
    if members.is_empty() {
        return Ok(Vec::new());
    }
    let required_space = members
        .iter()
        .try_fold(TRANSACTION_HEADROOM_BYTES, |sum, entry| {
            sum.checked_add(entry.size)
                .filter(|value| {
                    *value <= MAX_EXPANDED_BYTES.saturating_add(TRANSACTION_HEADROOM_BYTES)
                })
                .ok_or_else(|| {
                    PipelineTransactionError::Invalid("override space estimate overflowed".into())
                })
        })?;
    let available = java::free_disk_space(staging).map_err(|error| {
        PipelineTransactionError::Failed(format!(
            "could not preflight override staging space: {error}"
        ))
    })?;
    if available < required_space {
        return Err(PipelineTransactionError::Invalid(format!(
            "not enough staging space for overrides (need {required_space} bytes, have {available})"
        )));
    }
    drop(archive);
    let mut applied = BTreeMap::new();
    for layer in ["overrides", "server-overrides"] {
        for member in members.iter().filter(|member| member.layer == layer) {
            check_cancelled(cancelled)?;
            let destination = install::safe_target(staging, &member.path)?;
            if let Some(parent) = Path::new(&member.path)
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
            {
                install::ensure_directory_tree(staging, &parent.to_string_lossy())?;
            }
            if fs::symlink_metadata(&destination).is_ok() {
                install::remove_existing_regular_file(&destination)?;
            }
            let archive_file = File::open(archive_path)?;
            let mut member_archive = ZipArchive::new(archive_file)?;
            let mut entry = member_archive.by_index(member.index)?;
            if entry.is_symlink() || entry.is_dir() || entry.size() != member.size {
                return Err(PipelineTransactionError::Invalid(format!(
                    "mrpack override {} changed before extraction",
                    member.path
                )));
            }
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)?;
            let mut copied = 0u64;
            let mut buffer = [0u8; COPY_BUFFER_BYTES];
            loop {
                check_cancelled(cancelled)?;
                let read = entry.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                copied = copied
                    .checked_add(read as u64)
                    .filter(|size| *size <= member.size)
                    .ok_or_else(|| {
                        PipelineTransactionError::Invalid(format!(
                            "override {} exceeded its declared size",
                            member.path
                        ))
                    })?;
                output.write_all(&buffer[..read])?;
            }
            output.flush()?;
            output.sync_all()?;
            drop(output);
            if copied != member.size {
                let _ = fs::remove_file(&destination);
                return Err(PipelineTransactionError::Invalid(format!(
                    "override {} size did not match its ZIP metadata",
                    member.path
                )));
            }
            let origin = match layer {
                "overrides" => PayloadFileOrigin::SharedOverride,
                "server-overrides" => PayloadFileOrigin::ServerOverride,
                _ => {
                    return Err(PipelineTransactionError::Invalid(
                        "unexpected mrpack override layer".into(),
                    ))
                }
            };
            applied.insert(member.path.clone(), origin);
        }
    }
    Ok(applied.into_iter().collect())
}

#[derive(Debug, Clone)]
struct ArchiveMember {
    index: usize,
    path: String,
    layer: String,
    size: u64,
}

fn override_member(path: &str) -> Result<Option<(String, String)>, PipelineTransactionError> {
    let (root, remainder) = path.split_once('/').unwrap_or((path, ""));
    let layer = match root.to_ascii_lowercase().as_str() {
        "overrides" if root == "overrides" => "overrides",
        "server-overrides" if root == "server-overrides" => "server-overrides",
        "client-overrides" if root == "client-overrides" => return Ok(None),
        "overrides" | "server-overrides" | "client-overrides" => {
            return Err(PipelineTransactionError::Invalid(
                "mrpack override folder names must use their canonical spelling".into(),
            ))
        }
        _ => return Ok(None),
    };
    if remainder.is_empty() {
        return Ok(Some((layer.into(), String::new())));
    }
    let safe = install::validate_relative_path(remainder, false)
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    Ok(Some((layer.into(), safe)))
}

fn extract_curseforge_payload_files(
    archive_path: &Path,
    staging: &Path,
    selected: &BTreeSet<String>,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
) -> Result<Vec<StagedPayloadFile>, PipelineTransactionError> {
    install::ensure_safe_staging(staging)?;
    let archive_meta = fs::symlink_metadata(archive_path)?;
    if !archive_meta.file_type().is_file()
        || is_reparse_point(&archive_meta)
        || archive_meta.len() > MAX_ARCHIVE_BYTES
    {
        return Err(PipelineTransactionError::Invalid(
            "CurseForge source ZIP is not a regular bounded file".into(),
        ));
    }
    let mut archive = ZipArchive::new(File::open(archive_path)?).map_err(|_| {
        PipelineTransactionError::Invalid("CurseForge source is not a readable ZIP".into())
    })?;
    if archive.len() == 0 || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(PipelineTransactionError::Invalid(
            "CurseForge ZIP entry count is outside the supported bound".into(),
        ));
    }
    let loader_paths = loader
        .required_files
        .iter()
        .map(|item| item.relative_path.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut chosen = Vec::with_capacity(selected.len());
    let mut total = 0u64;
    for logical_path in selected {
        check_cancelled(cancelled)?;
        install::validate_relative_path(logical_path, false)
            .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
        if loader_paths.contains(&logical_path.to_ascii_lowercase()) {
            return Err(PipelineTransactionError::Invalid(format!(
                "CurseForge payload conflicts with a required loader file: {logical_path}"
            )));
        }
        let mut matches = Vec::new();
        for index in 0..archive.len() {
            let entry = archive.by_index(index)?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name();
            if name == logical_path
                || name
                    .strip_suffix(logical_path)
                    .is_some_and(|prefix| prefix.ends_with('/'))
            {
                matches.push((index, entry.size(), entry.is_symlink()));
            }
        }
        let [(index, size, false)] = matches.as_slice() else {
            return Err(PipelineTransactionError::Invalid(format!(
                "CurseForge archive does not contain one unambiguous regular entry for {logical_path}"
            )));
        };
        if *size > MAX_ENTRY_BYTES {
            return Err(PipelineTransactionError::Invalid(format!(
                "CurseForge entry {logical_path} exceeds the per-file bound"
            )));
        }
        total = total
            .checked_add(*size)
            .filter(|value| *value <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| {
                PipelineTransactionError::Invalid(
                    "CurseForge expanded file set exceeds 20 GiB".into(),
                )
            })?;
        chosen.push((*index, logical_path.clone(), *size));
    }
    let required = total
        .checked_add(TRANSACTION_HEADROOM_BYTES)
        .ok_or_else(|| {
            PipelineTransactionError::Invalid("CurseForge space estimate overflowed".into())
        })?;
    let available = java::free_disk_space(staging).map_err(|error| {
        PipelineTransactionError::Failed(format!(
            "could not preflight CurseForge extraction space: {error}"
        ))
    })?;
    if available < required {
        return Err(PipelineTransactionError::Invalid(format!("not enough staging space for CurseForge archive (need {required} bytes, have {available})")));
    }

    let mut output = Vec::with_capacity(chosen.len());
    for (index, path, expected_size) in chosen {
        check_cancelled(cancelled)?;
        reject_protected_pack_path(&path)?;
        let destination = install::safe_target(staging, &path)?;
        if let Some(parent) = Path::new(&path)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            install::ensure_directory_tree(staging, &parent.to_string_lossy())?;
        }
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(PipelineTransactionError::Conflict(format!(
                "CurseForge payload conflicts with staged content at {path}"
            )));
        }
        let mut entry = archive.by_index(index)?;
        if entry.is_symlink() || entry.is_dir() || entry.size() != expected_size {
            return Err(PipelineTransactionError::Invalid(format!(
                "CurseForge entry {path} changed before extraction"
            )));
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        let mut copied = 0u64;
        let mut buffer = [0u8; COPY_BUFFER_BYTES];
        loop {
            check_cancelled(cancelled)?;
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(read as u64)
                .filter(|size| *size <= expected_size)
                .ok_or_else(|| {
                    PipelineTransactionError::Invalid(format!(
                        "CurseForge entry {path} exceeded its ZIP size"
                    ))
                })?;
            file.write_all(&buffer[..read])?;
        }
        file.flush()?;
        file.sync_all()?;
        drop(file);
        if copied != expected_size {
            let _ = fs::remove_file(&destination);
            return Err(PipelineTransactionError::Invalid(format!(
                "CurseForge entry {path} size changed during extraction"
            )));
        }
        let (size_bytes, hashes) =
            download::hash_regular_file(&destination, cancelled, &AtomicBool::new(false))?;
        output.push(StagedPayloadFile {
            path,
            size_bytes,
            hashes,
            source_host: None,
            origin: PayloadFileOrigin::CurseForgeArchive,
        });
    }
    Ok(output)
}

fn collect_staged_payload_files(
    staging: &Path,
    paths: &BTreeSet<String>,
    cancelled: &AtomicBool,
) -> Result<Vec<StagedPayloadFile>, PipelineTransactionError> {
    let mut files = Vec::with_capacity(paths.len());
    for relative in paths {
        check_cancelled(cancelled)?;
        reject_protected_pack_path(relative)?;
        let path = install::safe_target(staging, relative)?;
        let (size_bytes, hashes) =
            download::hash_regular_file(&path, cancelled, &AtomicBool::new(false))?;
        files.push(StagedPayloadFile {
            path: relative.clone(),
            size_bytes,
            hashes,
            source_host: None,
            origin: PayloadFileOrigin::ModrinthDownload,
        });
    }
    Ok(files)
}

fn reject_protected_pack_path(path: &str) -> Result<(), PipelineTransactionError> {
    let key = path.to_ascii_lowercase();
    let first = key.split('/').next().unwrap_or_default();
    let protected = matches!(first, "world" | "logs" | "backups")
        || matches!(
            key.as_str(),
            "eula.txt"
                | "user_jvm_args.txt"
                | "install-plan.json"
                | "install-report.json"
                | "managed-files.json"
                | "launch-config.json"
                | "installer.log"
        );
    if protected {
        return Err(PipelineTransactionError::Invalid(format!(
            "pack payload targets protected server data: {path}"
        )));
    }
    Ok(())
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

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), PipelineTransactionError> {
    if cancelled.load(Ordering::Acquire) {
        Err(PipelineTransactionError::Cancelled)
    } else {
        Ok(())
    }
}

/// Commit a completed same-volume staging directory and its managed-file
/// ownership rows as one rollback-capable publication operation.
pub fn publish_staged_install(
    db: &DbState,
    app_data: &Path,
    plan: &InstallPlan,
    payload: &PreparedPayload,
    loader: &LoaderCompletenessEvidence,
    staging: &Path,
    approved_replacements: &HashSet<String>,
    cancelled: &AtomicBool,
) -> Result<InstallReport, PipelineTransactionError> {
    let mut connection =
        db.0.lock()
            .map_err(|error| PipelineTransactionError::Failed(error.to_string()))?;
    publish_staged_install_with_fault(
        &mut connection,
        app_data,
        plan,
        payload,
        loader,
        staging,
        approved_replacements,
        cancelled,
        None,
    )
}

/// Publishes a newly allocated server with the same managed-file transaction
/// used by update flows. The candidate record is inserted only inside the
/// immediate database transaction, after the new target has passed path and
/// ownership preflight; failed publication rolls back the row and scaffold.
pub fn publish_new_staged_install(
    db: &DbState,
    app_data: &Path,
    server: &ServerRecord,
    plan: &InstallPlan,
    payload: &PreparedPayload,
    loader: &LoaderCompletenessEvidence,
    staging: &Path,
    approved_replacements: &HashSet<String>,
    cancelled: &AtomicBool,
) -> Result<InstallReport, PipelineTransactionError> {
    let mut connection =
        db.0.lock()
            .map_err(|error| PipelineTransactionError::Failed(error.to_string()))?;
    publish_staged_install_with_candidate(
        &mut connection,
        app_data,
        plan,
        payload,
        loader,
        staging,
        approved_replacements,
        cancelled,
        Some(server),
        None,
    )
}

fn publish_staged_install_with_fault(
    connection: &mut Connection,
    app_data: &Path,
    plan: &InstallPlan,
    payload: &PreparedPayload,
    loader: &LoaderCompletenessEvidence,
    staging: &Path,
    approved_replacements: &HashSet<String>,
    cancelled: &AtomicBool,
    fault: Option<PublicationFault>,
) -> Result<InstallReport, PipelineTransactionError> {
    publish_staged_install_with_candidate(
        connection,
        app_data,
        plan,
        payload,
        loader,
        staging,
        approved_replacements,
        cancelled,
        None,
        fault,
    )
}

fn publish_staged_install_with_candidate(
    connection: &mut Connection,
    app_data: &Path,
    plan: &InstallPlan,
    payload: &PreparedPayload,
    loader: &LoaderCompletenessEvidence,
    staging: &Path,
    approved_replacements: &HashSet<String>,
    cancelled: &AtomicBool,
    new_server: Option<&ServerRecord>,
    fault: Option<PublicationFault>,
) -> Result<InstallReport, PipelineTransactionError> {
    let mut report = InstallReport::preparing(plan);
    let new_target_created = AtomicBool::new(false);
    let result = publish_once(
        connection,
        app_data,
        plan,
        payload,
        loader,
        staging,
        approved_replacements,
        cancelled,
        new_server,
        &new_target_created,
        fault,
        &mut report,
    );
    match result {
        Ok(()) => Ok(report),
        Err(error) => {
            if new_target_created.load(Ordering::Acquire) {
                if let Some(server) = new_server {
                    cleanup_new_server_scaffold(app_data, server);
                }
            }
            report.status = if error == PipelineTransactionError::Cancelled {
                InstallStatus::Cancelled
            } else {
                InstallStatus::Failed
            };
            report.errors.push(error.to_string());
            report.record_stage("validateAndPublish", "failed", Some(error.to_string()));
            let _ = write_stage_json(staging, INSTALL_REPORT_FILE, &report);
            Err(error)
        }
    }
}

fn publish_once(
    connection: &mut Connection,
    app_data: &Path,
    plan: &InstallPlan,
    payload: &PreparedPayload,
    loader: &LoaderCompletenessEvidence,
    staging: &Path,
    approved_replacements: &HashSet<String>,
    cancelled: &AtomicBool,
    new_server: Option<&ServerRecord>,
    new_target_created: &AtomicBool,
    fault: Option<PublicationFault>,
    report: &mut InstallReport,
) -> Result<(), PipelineTransactionError> {
    plan.validate_ready_to_install()
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    validate_loader_evidence(plan, loader)?;
    validate_payload_evidence(plan, payload)?;
    check_cancelled(cancelled)?;
    for decision in plan
        .file_decisions
        .iter()
        .filter(|decision| decision.action != FileDecisionAction::Include)
    {
        report.files.push(FileReportEntry {
            path: decision.path.clone(),
            outcome: FileOutcome::Skipped,
            size_bytes: None,
            hashes: None,
            source_host: None,
            detail: Some(format!(
                "action={:?}, reason={:?}",
                decision.action, decision.reason
            )),
        });
    }
    for download in &payload.verified_downloads {
        let replaced_by_override = payload
            .override_file_paths
            .iter()
            .any(|path| path == &download.path);
        report.files.push(FileReportEntry {
            path: download.path.clone(),
            outcome: FileOutcome::Verified,
            size_bytes: Some(download.expected_size_bytes),
            hashes: Some(download.expected_hashes.clone()),
            source_host: Some(download.source_host.clone()),
            detail: Some(if replaced_by_override {
                "provider file verified, then intentionally superseded by a declared archive override".into()
            } else {
                "provider-declared size, SHA-1, and SHA-512 verified".into()
            }),
        });
    }
    let canonical_root = validate_install_roots(app_data, plan, staging, new_server.is_some())?;
    let canonical_staging = fs::canonicalize(staging)?;
    let staging = canonical_staging.as_path();
    report.record_stage("validate", "complete", None);
    let target_root = server_directory(&canonical_root, &plan.target.server_id);
    let backup_id = format!("install-{}", uuid::Uuid::new_v4());
    let mut transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(server) = new_server {
        validate_new_server_candidate(&transaction, server, plan)?;
        insert_server_record(&transaction, server)?;
        scaffold_new_server_target(&canonical_root, &target_root, server, new_target_created)?;
    }
    let server = servers::get_server(&transaction, &plan.target.server_id)
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    validate_database_target(&server, plan)?;

    let old_registry = load_registry(&transaction, plan, &canonical_root)?;
    let old_manifest = load_and_validate_manifest(plan, &target_root, &canonical_root)?;
    compare_registry_and_manifest(&old_registry, old_manifest.as_ref(), &canonical_root, plan)?;
    let old_file_state =
        inspect_registered_target_files(plan, &canonical_root, &old_registry, cancelled)?;
    let stage_files = collect_stage_files(staging, payload, loader, cancelled)?;
    let stage_by_key = stage_files
        .into_iter()
        .map(|file| Ok((path_key(&file.relative_path)?, file)))
        .collect::<Result<BTreeMap<_, _>, PipelineTransactionError>>()?;

    let old_by_key = old_registry
        .iter()
        .map(|file| (file.path_key.clone(), file))
        .collect::<HashMap<_, _>>();
    let mut approval_keys = HashSet::with_capacity(approved_replacements.len());
    for path in approved_replacements {
        let key = path_key(path)?;
        if is_protected_path(path) {
            return Err(PipelineTransactionError::Invalid(format!(
                "replacement approval cannot target protected path {path}"
            )));
        }
        approval_keys.insert(key);
    }

    let mut new_managed_records = Vec::new();
    let mut planned_operations = Vec::new();
    let mut backup_files = Vec::<BackupFile>::new();
    let mut known_conflicts = HashSet::new();

    for (key, stage_file) in &stage_by_key {
        if stage_file
            .relative_path
            .eq_ignore_ascii_case("server.properties")
            || stage_file
                .relative_path
                .eq_ignore_ascii_case("user_jvm_args.txt")
        {
            continue;
        }
        let target = if stage_file.payload_origin.is_none() {
            safe_loader_runtime_target(&target_root, &stage_file.relative_path, loader)?
        } else {
            safe_server_target(&target_root, &stage_file.relative_path, false)?
        };
        let existing = inspect_existing_file(&target)?;
        let old = old_by_key.get(key).copied();
        let unchanged_managed = match (existing.as_ref(), old) {
            (Some(actual), Some(owned)) => {
                actual.size_bytes == owned.size_bytes && hashes_equal(&actual.hashes, &owned.hashes)
            }
            _ => false,
        };
        if existing.is_some() && !unchanged_managed {
            known_conflicts.insert(key.clone());
            if !approval_keys.contains(key) {
                return Err(PipelineTransactionError::Conflict(format!(
                    "{} already exists as an untracked or user-modified file; approve replacement after backup to continue",
                    stage_file.relative_path
                )));
            }
        }
        let backup = existing
            .as_ref()
            .map(|_| backup_path(&target_root, &backup_id, &stage_file.relative_path));
        if let Some(actual) = existing.as_ref() {
            backup_files.push(BackupFile {
                relative_path: stage_file.relative_path.clone(),
                size_bytes: actual.size_bytes,
                hashes: actual.hashes.clone(),
            });
        }
        planned_operations.push(FileOperation {
            relative_path: stage_file.relative_path.clone(),
            staged_source: Some(stage_file.staged_path.clone()),
            staged_size: Some(stage_file.size_bytes),
            staged_hashes: Some(stage_file.hashes.clone()),
            target,
            backup,
            expected_existing_size: existing.as_ref().map(|file| file.size_bytes),
            expected_existing_hashes: existing.as_ref().map(|file| file.hashes.clone()),
            is_manager_artifact: false,
        });
        new_managed_records.push(ManagedFileRecord {
            path: stage_file.relative_path.clone(),
            size_bytes: stage_file.size_bytes,
            hashes: stage_file.hashes.clone(),
            plan_id: plan.plan_id.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        });
        report.files.push(FileReportEntry {
            path: stage_file.relative_path.clone(),
            outcome: FileOutcome::Installed,
            size_bytes: Some(stage_file.size_bytes),
            hashes: Some(stage_file.hashes.clone()),
            source_host: stage_file.source_host.clone(),
            detail: Some(match stage_file.payload_origin {
                Some(PayloadFileOrigin::SharedOverride) => {
                    "installed from the shared overrides/ archive layer".into()
                }
                Some(PayloadFileOrigin::ServerOverride) => {
                    "installed from the server-overrides/ archive layer".into()
                }
                Some(PayloadFileOrigin::ModrinthDownload) => {
                    "installed from the provider-verified download".into()
                }
                Some(PayloadFileOrigin::CurseForgeArchive) => {
                    "installed from the author-provided server ZIP".into()
                }
                None => "installed from the prepared loader runtime".into(),
            }),
        });
    }

    for (key, old) in &old_by_key {
        if stage_by_key.contains_key(key) {
            continue;
        }
        let state = old_file_state.get(key);
        let Some(state) = state else { continue };
        if !state.exists {
            continue;
        }
        if !state.matches_installed {
            known_conflicts.insert(key.clone());
            if !approval_keys.contains(key) {
                report.files.push(FileReportEntry {
                    path: old.relative_path.clone(),
                    outcome: FileOutcome::PreservedUserFile,
                    size_bytes: Some(state.size_bytes),
                    hashes: Some(state.hashes.clone()),
                    source_host: None,
                    detail: Some("stale managed file was edited locally; retained and released from pipeline ownership".into()),
                });
                continue;
            }
        }
        let target = safe_owned_target(&target_root, &old.relative_path)?;
        let backup = backup_path(&target_root, &backup_id, &old.relative_path);
        backup_files.push(BackupFile {
            relative_path: old.relative_path.clone(),
            size_bytes: state.size_bytes,
            hashes: state.hashes.clone(),
        });
        planned_operations.push(FileOperation {
            relative_path: old.relative_path.clone(),
            staged_source: None,
            staged_size: None,
            staged_hashes: None,
            target,
            backup: Some(backup),
            expected_existing_size: Some(state.size_bytes),
            expected_existing_hashes: Some(state.hashes.clone()),
            is_manager_artifact: false,
        });
        report.files.push(FileReportEntry {
            path: old.relative_path.clone(),
            outcome: FileOutcome::RemovedAsStale,
            size_bytes: Some(state.size_bytes),
            hashes: Some(state.hashes.clone()),
            source_host: None,
            detail: None,
        });
    }

    if let Some(user_jvm) = stage_by_key.get("user_jvm_args.txt") {
        let target = target_root.join("user_jvm_args.txt");
        match inspect_existing_file(&target)? {
            Some(existing) => {
                report.files.push(FileReportEntry {
                    path: "user_jvm_args.txt".into(),
                    outcome: FileOutcome::PreservedUserFile,
                    size_bytes: Some(existing.size_bytes),
                    hashes: Some(existing.hashes),
                    source_host: None,
                    detail: Some("existing user JVM arguments were preserved".into()),
                });
            }
            None => planned_operations.push(FileOperation {
                relative_path: "user_jvm_args.txt".into(),
                staged_source: Some(user_jvm.staged_path.clone()),
                staged_size: Some(user_jvm.size_bytes),
                staged_hashes: Some(user_jvm.hashes.clone()),
                target,
                backup: None,
                expected_existing_size: None,
                expected_existing_hashes: None,
                is_manager_artifact: false,
            }),
        }
    }

    {
        let properties = stage_by_key.get("server.properties");
        let target = target_root.join("server.properties");
        let existing = inspect_existing_file(&target)?;
        if properties.is_some() || existing.is_some() {
            let merged = merge_server_properties(
                existing.as_ref().map(|_| target.as_path()),
                properties.map(|item| item.staged_path.as_path()),
                &server,
            )?;
            let merged_stage = staging.join(format!(
                ".pipeline-server-properties-{}.tmp",
                uuid::Uuid::new_v4()
            ));
            write_new_file(&merged_stage, &merged)?;
            let (size, hashes) =
                download::hash_regular_file(&merged_stage, cancelled, &AtomicBool::new(false))?;
            let backup = existing
                .as_ref()
                .map(|_| backup_path(&target_root, &backup_id, "server.properties"));
            if let Some(existing) = existing.as_ref() {
                backup_files.push(BackupFile {
                    relative_path: "server.properties".into(),
                    size_bytes: existing.size_bytes,
                    hashes: existing.hashes.clone(),
                });
            }
            planned_operations.push(FileOperation {
                relative_path: "server.properties".into(),
                staged_source: Some(merged_stage),
                staged_size: Some(size),
                staged_hashes: Some(hashes.clone()),
                target,
                backup,
                expected_existing_size: existing.as_ref().map(|file| file.size_bytes),
                expected_existing_hashes: existing.as_ref().map(|file| file.hashes.clone()),
                is_manager_artifact: false,
            });
            report.files.push(FileReportEntry {
                path: "server.properties".into(),
                outcome: FileOutcome::Installed,
                size_bytes: Some(size),
                hashes: Some(hashes),
                source_host: None,
                detail: Some("manager-owned keys merged while preserving user keys".into()),
            });
        }
    }

    let extra_approvals = approval_keys
        .difference(&known_conflicts)
        .cloned()
        .collect::<Vec<_>>();
    if !extra_approvals.is_empty() {
        return Err(PipelineTransactionError::Invalid(
            "replacement approval includes paths that do not have an active conflict".into(),
        ));
    }

    let mut manifest = ManagedFilesManifest::new(&plan.target.server_id, &canonical_root);
    new_managed_records.sort_by(|left, right| {
        path_key(&left.path)
            .unwrap_or_default()
            .cmp(&path_key(&right.path).unwrap_or_default())
    });
    manifest.files = new_managed_records.clone();
    manifest
        .validate()
        .map_err(PipelineTransactionError::Invalid)?;
    report.status = InstallStatus::Complete;
    report.set_loader_evidence(loader);
    report.warnings.extend(payload.warnings.clone());
    report.record_stage("download", "complete", None);
    report.record_stage("stageAndMerge", "complete", None);
    report.record_stage("validateAndPublish", "complete", None);
    write_stage_json(staging, INSTALL_PLAN_FILE, plan)?;
    write_stage_json(staging, INSTALL_REPORT_FILE, report)?;
    write_stage_json(staging, MANAGED_FILES_FILE, &manifest)?;
    let launch_config = crate::modpacks::pipeline::launch::build_staged_launch_config(
        plan,
        loader,
        staging,
        &canonical_root,
        &target_root,
        server.ram_mb,
    )
    .map_err(PipelineTransactionError::Invalid)?;
    write_stage_json(staging, LAUNCH_CONFIG_FILE, &launch_config)?;

    let manager_operations = manager_artifact_operations(staging, &target_root)?;
    planned_operations.extend(manager_operations);
    planned_operations.sort_by_key(|operation| operation.is_manager_artifact);
    validate_all_targets_still_bound(&canonical_root, &target_root, staging, plan)?;
    check_cancelled(cancelled)?;

    let backup_root = if backup_files.is_empty() {
        None
    } else {
        Some(target_root.join(BACKUP_ROOT).join(&backup_id))
    };
    let mut journal = PublicationJournal::new(&canonical_root, &target_root, staging);
    if let Some(backup_root) = &backup_root {
        journal.backup_root = Some(backup_root.clone());
    }
    let transaction_result = apply_publication_operations(
        &mut transaction,
        &canonical_root,
        &target_root,
        staging,
        plan,
        &planned_operations,
        &backup_files,
        backup_root.as_deref(),
        &mut journal,
        cancelled,
        fault,
    );
    if let Err(error) = transaction_result {
        journal.rollback(report);
        return Err(error);
    }
    validate_all_targets_still_bound(&canonical_root, &target_root, staging, plan).map_err(
        |error| {
            journal.rollback(report);
            error
        },
    )?;
    if let Err(error) =
        replace_registry_rows(&transaction, plan, &canonical_root, &new_managed_records)
    {
        journal.rollback(report);
        return Err(error);
    }
    if fault == Some(PublicationFault::BeforeDatabaseCommit) {
        journal.rollback(report);
        return Err(PipelineTransactionError::Failed(
            "injected failure before the managed-file database commit".into(),
        ));
    }
    check_cancelled(cancelled).map_err(|error| {
        journal.rollback(report);
        error
    })?;
    validate_all_targets_still_bound(&canonical_root, &target_root, staging, plan).map_err(
        |error| {
            journal.rollback(report);
            error
        },
    )?;
    if let Err(error) = transaction.commit() {
        journal.rollback(report);
        return Err(PipelineTransactionError::Failed(format!(
            "managed-file database commit failed: {error}"
        )));
    }
    journal.disarm();
    report.record_stage("validateAndPublish", "complete", None);
    prune_successful_backups(
        &canonical_root,
        &target_root,
        &plan.target.server_id,
        MAX_SUCCESSFUL_BACKUPS,
    );
    if let Err(error) = cleanup_completed_staging(staging, app_data, plan) {
        tracing::warn!(%error, "could not remove completed modpack staging directory");
    }
    Ok(())
}

fn validate_install_roots(
    app_data: &Path,
    plan: &InstallPlan,
    staging: &Path,
    allow_missing_target: bool,
) -> Result<PathBuf, PipelineTransactionError> {
    let app_meta = fs::symlink_metadata(app_data)?;
    if !app_meta.is_dir() || is_reparse_point(&app_meta) {
        return Err(PipelineTransactionError::Invalid(
            "app-data root is not a regular directory".into(),
        ));
    }
    let canonical_root = fs::canonicalize(app_data)?;
    let staging_root = canonical_root.join("installer-staging");
    let staging_root_meta = fs::symlink_metadata(&staging_root)?;
    if !staging_root_meta.is_dir() || is_reparse_point(&staging_root_meta) {
        return Err(PipelineTransactionError::Invalid(
            "app installer-staging root is not a regular directory".into(),
        ));
    }
    let canonical_staging_root = fs::canonicalize(&staging_root)?;
    let staging_meta = fs::symlink_metadata(staging)?;
    if !staging_meta.is_dir() || is_reparse_point(&staging_meta) {
        return Err(PipelineTransactionError::Invalid(
            "install staging is not a regular directory".into(),
        ));
    }
    let canonical_staging = fs::canonicalize(staging)?;
    if canonical_staging == canonical_staging_root
        || !canonical_staging.starts_with(&canonical_staging_root)
    {
        return Err(PipelineTransactionError::Invalid(
            "install staging must be an isolated app installer-staging child".into(),
        ));
    }
    let target_root = server_directory(&canonical_root, &plan.target.server_id);
    let servers_root = canonical_root.join("servers");
    match fs::symlink_metadata(&servers_root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => {}
        Ok(_) => {
            return Err(PipelineTransactionError::Invalid(
                "app-data servers root is not a regular directory".into(),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing_target => {}
        Err(error) => return Err(error.into()),
    }
    match fs::symlink_metadata(&target_root) {
        Ok(metadata) if allow_missing_target => {
            let _ = metadata;
            return Err(PipelineTransactionError::Conflict(
                "new server target directory already exists".into(),
            ));
        }
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => {
            let canonical_target = fs::canonicalize(&target_root)?;
            if canonical_target != target_root || !canonical_target.starts_with(&servers_root) {
                return Err(PipelineTransactionError::Invalid(
                    "selected server directory resolves outside app-data servers".into(),
                ));
            }
        }
        Ok(_) => {
            return Err(PipelineTransactionError::Invalid(
                "selected server directory is not a regular directory".into(),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing_target => {}
        Err(error) => return Err(error.into()),
    }
    validate_windows_path_length(&canonical_staging, "install staging")?;
    validate_windows_path_length(&target_root, "server target")?;
    Ok(canonical_root)
}

fn validate_new_server_candidate(
    connection: &Connection,
    server: &ServerRecord,
    plan: &InstallPlan,
) -> Result<(), PipelineTransactionError> {
    if server.id != plan.target.server_id
        || server.name != plan.target.server_name
        || server.mc_version != plan.loader.minecraft_version
        || server.loader != loader_kind_name(plan.loader.kind)
        || !loader_versions_match(
            server.loader_version.as_deref(),
            plan.loader.loader_version.as_deref(),
            plan.loader.kind,
            &plan.loader.minecraft_version,
        )
        || server.status != "stopped"
        || server.port <= 0
        || server.port > u16::MAX as i64
    {
        return Err(PipelineTransactionError::Invalid(
            "new server candidate does not match the finalized provider plan".into(),
        ));
    }
    paths::validate_id(&server.id)
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    let id_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM servers WHERE id = ?1",
        params![server.id],
        |row| row.get(0),
    )?;
    if id_count != 0 {
        return Err(PipelineTransactionError::Conflict(
            "allocated server ID is already in use".into(),
        ));
    }
    let name_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM servers WHERE name = ?1",
        params![server.name],
        |row| row.get(0),
    )?;
    if name_count != 0 {
        return Err(PipelineTransactionError::Conflict(format!(
            "a server named '{}' already exists",
            server.name
        )));
    }
    ports::claim_port(connection, server.port as u16)
        .map_err(|error| PipelineTransactionError::Conflict(error.to_string()))?;
    Ok(())
}

fn insert_server_record(
    connection: &Connection,
    server: &ServerRecord,
) -> Result<(), PipelineTransactionError> {
    connection.execute(
        "INSERT INTO servers (id, name, loader, mc_version, loader_version, modpack_id, \
         port, ram_mb, java_path, eula_accepted, status, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            server.id,
            server.name,
            server.loader,
            server.mc_version,
            server.loader_version,
            server.modpack_id,
            server.port,
            server.ram_mb,
            server.java_path,
            if server.eula_accepted { 1 } else { 0 },
            server.status,
            server.created_at,
        ],
    )?;
    Ok(())
}

fn scaffold_new_server_target(
    canonical_root: &Path,
    target_root: &Path,
    server: &ServerRecord,
    new_target_created: &AtomicBool,
) -> Result<(), PipelineTransactionError> {
    let servers_root = canonical_root.join("servers");
    match fs::symlink_metadata(&servers_root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&servers_root)?;
        }
        _ => {
            return Err(PipelineTransactionError::Invalid(
                "app-data servers root changed before new-server publication".into(),
            ))
        }
    }
    match fs::symlink_metadata(target_root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(PipelineTransactionError::Conflict(
                "new server target appeared before publication".into(),
            ))
        }
        Err(error) => return Err(error.into()),
    }
    fs::create_dir(target_root)?;
    new_target_created.store(true, Ordering::Release);
    for directory in ["mods", "world", "logs", "backups"] {
        let path = target_root.join(directory);
        ensure_new_scaffold_directory(target_root, &path)?;
    }
    let eula = format!(
        "# By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (https://www.minecraft.net/en-us/eula).\n\
         # NEVER auto-accepted by the launcher — set to true only via the explicit EULA checkbox.\n\
         eula={}\n",
        if server.eula_accepted { "true" } else { "false" }
    );
    write_new_file(&target_root.join("eula.txt"), eula.as_bytes())?;
    let properties = initial_server_properties(server);
    write_new_file(
        &target_root.join("server.properties"),
        properties.as_bytes(),
    )?;
    Ok(())
}

fn ensure_new_scaffold_directory(
    root: &Path,
    directory: &Path,
) -> Result<(), PipelineTransactionError> {
    let relative = directory.strip_prefix(root).map_err(|_| {
        PipelineTransactionError::Invalid("new server scaffold escaped its target root".into())
    })?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    ensure_safe_parent_chain(root, &relative)?;
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => Ok(()),
        Ok(_) => Err(PipelineTransactionError::Invalid(
            "new server scaffold directory is not regular".into(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(directory)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn initial_server_properties(server: &ServerRecord) -> String {
    [
        ("server-port", server.port.to_string()),
        ("motd", server.name.clone()),
        ("max-players", "20".into()),
        ("online-mode", "true".into()),
        ("difficulty", "normal".into()),
        ("gamemode", "survival".into()),
        ("level-name", "world".into()),
        ("enable-rcon", "false".into()),
        ("enable-status", "true".into()),
    ]
    .into_iter()
    .map(|(key, value)| format!("{key}={value}\n"))
    .collect()
}

fn cleanup_new_server_scaffold(app_data: &Path, server: &ServerRecord) {
    let Ok(canonical_root) = fs::canonicalize(app_data) else {
        return;
    };
    let target_root = server_directory(&canonical_root, &server.id);
    if !target_root.starts_with(canonical_root.join("servers"))
        || validate_rollback_root(&canonical_root).is_err()
    {
        return;
    }
    let eula_path = target_root.join("eula.txt");
    let expected_eula = format!(
        "# By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (https://www.minecraft.net/en-us/eula).\n\
         # NEVER auto-accepted by the launcher — set to true only via the explicit EULA checkbox.\n\
         eula={}\n",
        if server.eula_accepted { "true" } else { "false" }
    );
    remove_if_exact_regular_file(&canonical_root, &eula_path, expected_eula.as_bytes());
    remove_if_exact_regular_file(
        &canonical_root,
        &target_root.join("server.properties"),
        initial_server_properties(server).as_bytes(),
    );
    for directory in ["mods", "world", "logs", "backups"] {
        remove_empty_directory(&canonical_root, &target_root.join(directory));
    }
    remove_empty_directory(&canonical_root, &target_root);
    remove_empty_directory(&canonical_root, &canonical_root.join("servers"));
}

fn remove_if_exact_regular_file(root: &Path, path: &Path, expected: &[u8]) {
    if validate_rollback_path(root, path, Some(false), false).is_err() {
        return;
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if !metadata.is_file() || is_reparse_point(&metadata) || metadata.len() != expected.len() as u64
    {
        return;
    }
    if fs::read(path).is_ok_and(|actual| actual == expected) {
        let _ = fs::remove_file(path);
    }
}

fn remove_empty_directory(root: &Path, path: &Path) {
    if validate_rollback_path(root, path, Some(true), false).is_err() {
        return;
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.is_dir() && !is_reparse_point(&metadata) {
            let _ = fs::remove_dir(path);
        }
    }
}

fn validate_windows_path_length(path: &Path, label: &str) -> Result<(), PipelineTransactionError> {
    if path.as_os_str().to_string_lossy().encode_utf16().count() >= 240 {
        return Err(PipelineTransactionError::Invalid(format!(
            "{label} path exceeds the supported 239 UTF-16 code-unit limit"
        )));
    }
    Ok(())
}

fn validate_database_target(
    server: &ServerRecord,
    plan: &InstallPlan,
) -> Result<(), PipelineTransactionError> {
    if server.id != plan.target.server_id
        || server.name != plan.target.server_name
        || server.mc_version != plan.loader.minecraft_version
        || server.loader != loader_kind_name(plan.loader.kind)
        || !loader_versions_match(
            server.loader_version.as_deref(),
            plan.loader.loader_version.as_deref(),
            plan.loader.kind,
            &plan.loader.minecraft_version,
        )
    {
        return Err(PipelineTransactionError::Conflict(
            "install plan target or loader no longer matches the selected server database row"
                .into(),
        ));
    }
    Ok(())
}

fn loader_versions_match(
    stored: Option<&str>,
    planned: Option<&str>,
    kind: LoaderKind,
    minecraft_version: &str,
) -> bool {
    match (stored, planned) {
        (None, None) => true,
        (Some(stored), Some(planned)) if stored == planned => true,
        (Some(stored), Some(planned)) if kind == LoaderKind::Forge => {
            forge_runtime_version(stored, minecraft_version)
                == forge_runtime_version(planned, minecraft_version)
        }
        _ => false,
    }
}

fn forge_runtime_version<'a>(value: &'a str, minecraft_version: &str) -> &'a str {
    let coordinate = value
        .split_once(':')
        .map(|(_, build)| build)
        .unwrap_or(value);
    let prefix = format!("{minecraft_version}-");
    coordinate.strip_prefix(&prefix).unwrap_or(coordinate)
}

fn server_directory(canonical_root: &Path, server_id: &str) -> PathBuf {
    canonical_root.join("servers").join(server_id)
}

fn validate_payload_evidence(
    plan: &InstallPlan,
    payload: &PreparedPayload,
) -> Result<(), PipelineTransactionError> {
    if payload.plan_id != plan.plan_id || payload.source != plan.source_pin.source {
        return Err(PipelineTransactionError::Invalid(
            "staged payload evidence does not belong to this source plan".into(),
        ));
    }
    let included = included_paths(plan)?;
    let selected = payload
        .selected_file_paths
        .iter()
        .map(|path| path_key(path))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let included_keys = included
        .iter()
        .map(|path| path_key(path))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if selected != included_keys {
        return Err(PipelineTransactionError::Invalid(
            "staged source-file set differs from the resolved Include decisions".into(),
        ));
    }
    let payload_paths = payload
        .files
        .iter()
        .map(|file| {
            install::validate_relative_path(&file.path, false)
                .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
            file.hashes
                .validate()
                .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
            if file.size_bytes > MAX_STAGE_FILE_BYTES {
                return Err(PipelineTransactionError::Invalid(format!(
                    "staged payload file {} exceeds its size bound",
                    file.path
                )));
            }
            path_key(&file.path)
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let mut declared_paths = selected;
    for path in &payload.override_file_paths {
        reject_protected_pack_path(path)?;
        declared_paths.insert(path_key(path)?);
    }
    if payload_paths != declared_paths {
        return Err(PipelineTransactionError::Invalid(
            "staged payload evidence differs from selected files and overrides".into(),
        ));
    }
    let override_origins = payload
        .files
        .iter()
        .filter(|file| {
            matches!(
                file.origin,
                PayloadFileOrigin::SharedOverride | PayloadFileOrigin::ServerOverride
            )
        })
        .map(|file| Ok((path_key(&file.path)?, file.origin)))
        .collect::<Result<HashMap<_, _>, PipelineTransactionError>>()?;
    let declared_overrides = payload
        .override_file_paths
        .iter()
        .map(|path| path_key(path))
        .collect::<Result<HashSet<_>, _>>()?;
    if override_origins.keys().cloned().collect::<HashSet<_>>() != declared_overrides {
        return Err(PipelineTransactionError::Invalid(
            "per-file override provenance differs from the declared override paths".into(),
        ));
    }
    let mut download_by_key = HashMap::with_capacity(payload.verified_downloads.len());
    for download in &payload.verified_downloads {
        let key = path_key(&download.path)?;
        download
            .expected_hashes
            .validate()
            .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
        download
            .hashes
            .validate()
            .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
        if download.source_host.trim().is_empty()
            || download.expected_size_bytes != download.size_bytes
            || !hashes_equal(&download.expected_hashes, &download.hashes)
            || download.size_bytes > MAX_STAGE_FILE_BYTES
            || download_by_key.insert(key, download).is_some()
        {
            return Err(PipelineTransactionError::Invalid(
                "verified download evidence is incomplete, duplicated, or mismatched".into(),
            ));
        }
    }
    match payload.source {
        ProviderSource::Modrinth => {
            if download_by_key.keys().cloned().collect::<BTreeSet<_>>() != included_keys {
                return Err(PipelineTransactionError::Invalid(
                    "verified Modrinth download paths differ from the included file decisions"
                        .into(),
                ));
            }
            for file in &payload.files {
                let key = path_key(&file.path)?;
                let is_override = declared_overrides.contains(&key);
                let download = download_by_key.get(&key);
                match (is_override, file.origin, download) {
                    (
                        true,
                        PayloadFileOrigin::SharedOverride | PayloadFileOrigin::ServerOverride,
                        Some(_),
                    )
                    | (
                        true,
                        PayloadFileOrigin::SharedOverride | PayloadFileOrigin::ServerOverride,
                        None,
                    )
                    | (false, PayloadFileOrigin::ModrinthDownload, Some(_)) => {}
                    _ => {
                        return Err(PipelineTransactionError::Invalid(format!(
                        "payload origin for {} conflicts with its provider and override decisions",
                        file.path
                    )))
                    }
                }
                if !is_override {
                    let expected = download.ok_or_else(|| {
                        PipelineTransactionError::Invalid(format!(
                            "missing provider integrity evidence for {}",
                            file.path
                        ))
                    })?;
                    if expected.expected_size_bytes != file.size_bytes
                        || !hashes_equal(&expected.expected_hashes, &file.hashes)
                    {
                        return Err(PipelineTransactionError::Invalid(format!(
                            "staged Modrinth file {} differs from its provider-declared size or hashes",
                            file.path
                        )));
                    }
                    if file.source_host.as_deref() != Some(expected.source_host.as_str()) {
                        return Err(PipelineTransactionError::Invalid(format!(
                            "staged Modrinth file {} lost its verified source host",
                            file.path
                        )));
                    }
                } else if file.source_host.is_some() {
                    return Err(PipelineTransactionError::Invalid(format!(
                        "archive override {} must retain archive provenance instead of a download host",
                        file.path
                    )));
                }
            }
        }
        ProviderSource::CurseForge => {
            if !download_by_key.is_empty()
                || !declared_overrides.is_empty()
                || payload
                    .files
                    .iter()
                    .any(|file| file.origin != PayloadFileOrigin::CurseForgeArchive)
            {
                return Err(PipelineTransactionError::Invalid(
                    "CurseForge payload contains Modrinth download or override provenance".into(),
                ));
            }
        }
    }
    Ok(())
}

fn collect_stage_files(
    staging: &Path,
    payload: &PreparedPayload,
    loader: &LoaderCompletenessEvidence,
    cancelled: &AtomicBool,
) -> Result<Vec<StageFile>, PipelineTransactionError> {
    install::ensure_safe_staging(staging)?;
    let payload_by_key = payload
        .files
        .iter()
        .map(|file| Ok((path_key(&file.path)?, file)))
        .collect::<Result<HashMap<_, _>, PipelineTransactionError>>()?;
    let loader_by_key = loader
        .required_files
        .iter()
        .map(|file| Ok((path_key(&file.relative_path)?, file)))
        .collect::<Result<HashMap<_, _>, PipelineTransactionError>>()?;
    let verified_downloads = payload
        .verified_downloads
        .iter()
        .map(|file| Ok((path_key(&file.path)?, file)))
        .collect::<Result<HashMap<_, _>, PipelineTransactionError>>()?;
    for key in payload_by_key.keys() {
        if loader_by_key.contains_key(key) && key != "server.properties" {
            return Err(PipelineTransactionError::Invalid(format!(
                "pack payload collides with exact loader runtime path {key}"
            )));
        }
    }
    let allowed = payload_by_key
        .keys()
        .chain(loader_by_key.keys())
        .cloned()
        .collect::<HashSet<_>>();
    let mut output = Vec::new();
    let mut stack = vec![(staging.to_path_buf(), String::new())];
    let mut observed = HashSet::new();
    let mut total = 0u64;
    while let Some((directory, relative_parent)) = stack.pop() {
        check_cancelled(cancelled)?;
        let entries = fs::read_dir(&directory)?;
        for entry in entries {
            check_cancelled(cancelled)?;
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if is_reparse_point(&metadata) {
                return Err(PipelineTransactionError::Invalid(format!(
                    "staging contains a reparse point: {}",
                    entry.path().display()
                )));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if relative_parent.is_empty() {
                name
            } else {
                format!("{relative_parent}/{name}")
            };
            if metadata.is_dir() {
                if is_protected_directory(&relative) {
                    return Err(PipelineTransactionError::Invalid(format!(
                        "staging contains protected pack data at {relative}"
                    )));
                }
                stack.push((entry.path(), relative));
                continue;
            }
            if !metadata.is_file() {
                return Err(PipelineTransactionError::Invalid(format!(
                    "staging contains a non-file entry: {relative}"
                )));
            }
            if is_internal_staging_file(&relative) {
                continue;
            }
            if is_protected_path(&relative)
                && !is_server_property_path(&relative)
                && !is_user_jvm_path(&relative)
            {
                return Err(PipelineTransactionError::Invalid(format!(
                    "staging contains protected file data: {relative}"
                )));
            }
            let normalized = install::validate_relative_path(&relative, false)
                .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
            let key = path_key(&normalized)?;
            if !allowed.contains(&key) {
                return Err(PipelineTransactionError::Invalid(format!(
                    "staging contains an unaccounted file: {relative}"
                )));
            }
            if !observed.insert(key.clone()) {
                return Err(PipelineTransactionError::Invalid(format!(
                    "staging contains a case-insensitive path alias: {relative}"
                )));
            }
            if metadata.len() > MAX_STAGE_FILE_BYTES {
                return Err(PipelineTransactionError::Invalid(format!(
                    "staged file {relative} exceeds the 4 GiB bound"
                )));
            }
            total = total
                .checked_add(metadata.len())
                .filter(|size| *size <= MAX_EXPANDED_BYTES)
                .ok_or_else(|| {
                    PipelineTransactionError::Invalid(
                        "staging content exceeds the 20 GiB bound".into(),
                    )
                })?;
            validate_windows_path_length(&entry.path(), "staged file")?;
            let (size_bytes, hashes) =
                download::hash_regular_file(&entry.path(), cancelled, &AtomicBool::new(false))?;
            if let Some(expected) = payload_by_key.get(&key) {
                if !is_server_property_path(&relative)
                    && (size_bytes != expected.size_bytes
                        || !hashes_equal(&hashes, &expected.hashes))
                {
                    return Err(PipelineTransactionError::Invalid(format!(
                        "staged payload file {relative} changed after verification"
                    )));
                }
                if expected.origin == PayloadFileOrigin::ModrinthDownload {
                    let provider = verified_downloads.get(&key).ok_or_else(|| {
                        PipelineTransactionError::Invalid(format!(
                            "missing verified download record for {relative}"
                        ))
                    })?;
                    if size_bytes != provider.expected_size_bytes
                        || !hashes_equal(&hashes, &provider.expected_hashes)
                    {
                        return Err(PipelineTransactionError::Invalid(format!(
                            "staged downloaded file {relative} no longer matches its provider-declared integrity metadata"
                        )));
                    }
                }
            }
            if let Some(expected) = loader_by_key.get(&key) {
                if size_bytes != expected.size_bytes || !hashes_equal(&hashes, &expected.hashes) {
                    return Err(PipelineTransactionError::Invalid(format!(
                        "loader file {relative} changed after size/hash completeness verification"
                    )));
                }
            }
            output.push(StageFile {
                relative_path: normalized,
                staged_path: entry.path(),
                size_bytes,
                hashes,
                source_host: payload_by_key
                    .get(&key)
                    .and_then(|file| file.source_host.clone()),
                payload_origin: payload_by_key.get(&key).map(|file| file.origin),
                managed: !is_server_property_path(&relative) && !is_user_jvm_path(&relative),
            });
        }
    }
    for key in allowed {
        if !observed.contains(&key) {
            return Err(PipelineTransactionError::Invalid(format!(
                "staging is missing a resolved payload or loader file ({key})"
            )));
        }
    }
    if output.len() > MAX_STAGE_FILES {
        return Err(PipelineTransactionError::Invalid(
            "staging has too many files".into(),
        ));
    }
    output.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(output)
}

#[derive(Debug, Clone)]
struct ExistingFile {
    size_bytes: u64,
    hashes: ContentHashes,
}

#[derive(Debug, Clone)]
struct ExistingOwnedState {
    exists: bool,
    matches_installed: bool,
    size_bytes: u64,
    hashes: ContentHashes,
}

fn load_registry(
    tx: &Transaction<'_>,
    plan: &InstallPlan,
    canonical_root: &Path,
) -> Result<Vec<RegistryFile>, PipelineTransactionError> {
    let mut statement = tx.prepare(
        "SELECT canonical_root, path_key, relative_path, installed_size, installed_sha1, installed_sha512, plan_id, updated_at FROM managed_server_files WHERE server_id = ?1 ORDER BY path_key",
    )?;
    let rows = statement.query_map(params![plan.target.server_id.as_str()], |row| {
        let installed_size: u64 = row.get(3)?;
        Ok(RegistryFile {
            canonical_root: row.get(0)?,
            path_key: row.get(1)?,
            relative_path: row.get(2)?,
            size_bytes: installed_size,
            hashes: ContentHashes {
                sha1: row.get(4)?,
                sha512: row.get(5)?,
            },
            plan_id: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;
    let mut records = Vec::new();
    for row in rows {
        let record = row?;
        if record.canonical_root != canonical_root.to_string_lossy()
            || record.size_bytes > MAX_STAGE_FILE_BYTES
            || record.plan_id.trim().is_empty()
            || record.updated_at.trim().is_empty()
            || path_key(&record.relative_path)? != record.path_key
            || is_protected_path(&record.relative_path)
        {
            return Err(PipelineTransactionError::Invalid(
                "managed-file registry contains a foreign root, unsafe path, or malformed record"
                    .into(),
            ));
        }
        record
            .hashes
            .validate()
            .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
        records.push(record);
    }
    Ok(records)
}

fn load_and_validate_manifest(
    plan: &InstallPlan,
    target_root: &Path,
    canonical_root: &Path,
) -> Result<Option<ManagedFilesManifest>, PipelineTransactionError> {
    let path = target_root.join(MANAGED_FILES_FILE);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata)
            if !metadata.file_type().is_file()
                || is_reparse_point(&metadata)
                || metadata.len() > MAX_MANAGED_FILES_MANIFEST_BYTES as u64 =>
        {
            Err(PipelineTransactionError::Invalid(
                "existing managed-file manifest is not a regular bounded file".into(),
            ))
        }
        Ok(_) => {
            let bytes = fs::read(&path)?;
            let manifest: ManagedFilesManifest =
                serde_json::from_slice(&bytes).map_err(|error| {
                    PipelineTransactionError::Invalid(format!(
                        "existing managed-file manifest is malformed: {error}"
                    ))
                })?;
            manifest
                .validate()
                .map_err(PipelineTransactionError::Invalid)?;
            if manifest.server_id != plan.target.server_id
                || manifest.canonical_app_data_dir != canonical_root.to_string_lossy()
            {
                return Err(PipelineTransactionError::Invalid(
                    "managed-file manifest is bound to a different server or app-data root".into(),
                ));
            }
            Ok(Some(manifest))
        }
    }
}

fn compare_registry_and_manifest(
    registry: &[RegistryFile],
    manifest: Option<&ManagedFilesManifest>,
    canonical_root: &Path,
    plan: &InstallPlan,
) -> Result<(), PipelineTransactionError> {
    if registry.is_empty() && manifest.is_none() {
        return Ok(());
    }
    let manifest = manifest.ok_or_else(|| {
        PipelineTransactionError::Invalid(
            "managed-file database rows exist without their audit manifest; cleanup is blocked"
                .into(),
        )
    })?;
    if manifest.canonical_app_data_dir != canonical_root.to_string_lossy()
        || manifest.server_id != plan.target.server_id
        || manifest.files.len() != registry.len()
    {
        return Err(PipelineTransactionError::Invalid(
            "managed-file manifest and ownership registry disagree; cleanup is blocked".into(),
        ));
    }
    let manifest_by_key = manifest
        .files
        .iter()
        .map(|file| Ok((path_key(&file.path)?, file)))
        .collect::<Result<HashMap<_, _>, PipelineTransactionError>>()?;
    for row in registry {
        let Some(file) = manifest_by_key.get(&row.path_key) else {
            return Err(PipelineTransactionError::Invalid(
                "managed-file manifest omits a database-owned path; cleanup is blocked".into(),
            ));
        };
        if file.path != row.relative_path
            || file.size_bytes != row.size_bytes
            || file.plan_id != row.plan_id
            || file.updated_at != row.updated_at
            || !hashes_equal(&file.hashes, &row.hashes)
        {
            return Err(PipelineTransactionError::Invalid(format!(
                "managed-file manifest differs from the database for {}; cleanup is blocked",
                row.relative_path
            )));
        }
    }
    Ok(())
}

fn inspect_registered_target_files(
    plan: &InstallPlan,
    canonical_root: &Path,
    registry: &[RegistryFile],
    cancelled: &AtomicBool,
) -> Result<HashMap<String, ExistingOwnedState>, PipelineTransactionError> {
    let root = server_directory(canonical_root, &plan.target.server_id);
    let mut states = HashMap::with_capacity(registry.len());
    for record in registry {
        check_cancelled(cancelled)?;
        let path = safe_owned_target(&root, &record.relative_path)?;
        let actual = inspect_existing_file(&path)?;
        let state = match actual {
            Some(actual) => ExistingOwnedState {
                exists: true,
                matches_installed: actual.size_bytes == record.size_bytes
                    && hashes_equal(&actual.hashes, &record.hashes),
                size_bytes: actual.size_bytes,
                hashes: actual.hashes,
            },
            None => ExistingOwnedState {
                exists: false,
                matches_installed: false,
                size_bytes: 0,
                hashes: ContentHashes {
                    sha1: "0".repeat(40),
                    sha512: "0".repeat(128),
                },
            },
        };
        states.insert(record.path_key.clone(), state);
    }
    Ok(states)
}

fn inspect_existing_file(path: &Path) -> Result<Option<ExistingFile>, PipelineTransactionError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata) if !metadata.file_type().is_file() || is_reparse_point(&metadata) => {
            Err(PipelineTransactionError::Invalid(format!(
                "existing server target is not a regular non-reparse file: {}",
                path.display()
            )))
        }
        Ok(_) => {
            let (size_bytes, hashes) = download::hash_regular_file(
                path,
                &AtomicBool::new(false),
                &AtomicBool::new(false),
            )?;
            Ok(Some(ExistingFile { size_bytes, hashes }))
        }
    }
}

fn replace_registry_rows(
    tx: &Transaction<'_>,
    plan: &InstallPlan,
    canonical_root: &Path,
    records: &[ManagedFileRecord],
) -> Result<(), PipelineTransactionError> {
    tx.execute(
        "DELETE FROM managed_server_files WHERE server_id = ?1",
        params![plan.target.server_id],
    )?;
    let canonical = canonical_root.to_string_lossy().into_owned();
    for record in records {
        let installed_size = i64::try_from(record.size_bytes).map_err(|_| {
            PipelineTransactionError::Invalid(
                "managed file size exceeds SQLite integer bounds".into(),
            )
        })?;
        tx.execute(
            "INSERT INTO managed_server_files (server_id, canonical_root, path_key, relative_path, installed_size, installed_sha1, installed_sha512, plan_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                plan.target.server_id.as_str(),
                canonical.as_str(),
                path_key(&record.path)?,
                record.path.as_str(),
                installed_size,
                record.hashes.sha1.as_str(),
                record.hashes.sha512.as_str(),
                record.plan_id.as_str(),
                record.updated_at.as_str(),
            ],
        )?;
    }
    Ok(())
}

fn path_key(path: &str) -> Result<String, PipelineTransactionError> {
    validate_relative_report_path(path).map_err(PipelineTransactionError::Invalid)
}

fn hashes_equal(left: &ContentHashes, right: &ContentHashes) -> bool {
    left.sha1.eq_ignore_ascii_case(&right.sha1) && left.sha512.eq_ignore_ascii_case(&right.sha512)
}

fn safe_server_target(
    root: &Path,
    relative: &str,
    allow_manager_artifact: bool,
) -> Result<PathBuf, PipelineTransactionError> {
    let relative = install::validate_relative_path(relative, false)
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    let is_manager = matches!(
        relative.to_ascii_lowercase().as_str(),
        "install-plan.json" | "install-report.json" | "managed-files.json" | "launch-config.json"
    );
    let target = if is_manager || (allow_manager_artifact && is_user_jvm_path(&relative)) {
        root.join(&relative)
    } else {
        install::safe_target(root, &relative)?
    };
    ensure_safe_parent_chain(root, &relative)?;
    validate_windows_path_length(&target, "server file")?;
    Ok(target)
}

fn safe_loader_runtime_target(
    root: &Path,
    relative: &str,
    loader: &LoaderCompletenessEvidence,
) -> Result<PathBuf, PipelineTransactionError> {
    let key = path_key(relative)?;
    let is_required_loader_file = loader
        .required_files
        .iter()
        .any(|file| path_key(&file.relative_path).is_ok_and(|required| required == key));
    if !is_required_loader_file {
        return Err(PipelineTransactionError::Invalid(format!(
            "reserved server path {relative} is not part of the exact loader completeness evidence"
        )));
    }
    let relative = install::validate_relative_path(relative, false)
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    ensure_safe_parent_chain(root, &relative)?;
    let target = root.join(relative);
    validate_windows_path_length(&target, "loader runtime file")?;
    Ok(target)
}

fn safe_owned_target(root: &Path, relative: &str) -> Result<PathBuf, PipelineTransactionError> {
    let relative = install::validate_relative_path(relative, false)
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    ensure_safe_parent_chain(root, &relative)?;
    let target = root.join(relative);
    validate_windows_path_length(&target, "managed server file")?;
    Ok(target)
}

fn ensure_safe_parent_chain(root: &Path, relative: &str) -> Result<(), PipelineTransactionError> {
    let root_meta = fs::symlink_metadata(root)?;
    if !root_meta.is_dir() || is_reparse_point(&root_meta) {
        return Err(PipelineTransactionError::Invalid(
            "server root changed or became a reparse point".into(),
        ));
    }
    let mut current = root.to_path_buf();
    let components = relative.split('/').collect::<Vec<_>>();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => {}
            Ok(_) => {
                return Err(PipelineTransactionError::Invalid(format!(
                    "server path contains a non-directory or reparse point: {}",
                    current.display()
                )))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn ensure_path_under_staging(staging: &Path, path: &Path) -> Result<(), PipelineTransactionError> {
    let canonical_staging = fs::canonicalize(staging)?;
    let parent = path
        .parent()
        .ok_or_else(|| PipelineTransactionError::Invalid("staging path has no parent".into()))?;
    let canonical_parent = fs::canonicalize(parent)?;
    if !canonical_parent.starts_with(&canonical_staging) || path == staging {
        return Err(PipelineTransactionError::Invalid(
            "transaction rollback path escaped isolated staging".into(),
        ));
    }
    let stage_metadata = fs::symlink_metadata(staging)?;
    if !stage_metadata.is_dir() || is_reparse_point(&stage_metadata) {
        return Err(PipelineTransactionError::Invalid(
            "staging root changed before a file operation".into(),
        ));
    }
    let relative = path.strip_prefix(staging).map_err(|_| {
        PipelineTransactionError::Invalid("staging path is not a child of its root".into())
    })?;
    let mut current = staging.to_path_buf();
    for component in relative
        .components()
        .take(relative.components().count().saturating_sub(1))
    {
        let std::path::Component::Normal(component) = component else {
            return Err(PipelineTransactionError::Invalid(
                "staging path contains a non-normal component".into(),
            ));
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current)?;
        if !metadata.is_dir() || is_reparse_point(&metadata) {
            return Err(PipelineTransactionError::Invalid(
                "staging parent changed to a reparse point".into(),
            ));
        }
    }
    Ok(())
}

fn is_server_property_path(path: &str) -> bool {
    path.eq_ignore_ascii_case("server.properties")
}

fn is_user_jvm_path(path: &str) -> bool {
    path.eq_ignore_ascii_case("user_jvm_args.txt")
}

fn is_protected_directory(path: &str) -> bool {
    matches!(
        path.split('/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "world" | "logs" | "backups"
    )
}

fn is_internal_staging_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "installer.log"
            | "forge-installer.jar"
            | "neoforge-installer.jar"
            | "install-plan.json"
            | "install-report.json"
            | "managed-files.json"
            | "launch-config.json"
    ) || lower
        .split('/')
        .any(|component| component.starts_with(".pipeline-"))
}

fn is_protected_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    is_protected_directory(path)
        || matches!(
            lower.as_str(),
            "eula.txt"
                | "user_jvm_args.txt"
                | "server.properties"
                | "install-plan.json"
                | "install-report.json"
                | "managed-files.json"
                | "launch-config.json"
                | "installer.log"
        )
}

fn backup_path(target_root: &Path, backup_id: &str, relative: &str) -> PathBuf {
    target_root.join(BACKUP_ROOT).join(backup_id).join(relative)
}

fn write_stage_json<T: serde::Serialize>(
    staging: &Path,
    file_name: &str,
    value: &T,
) -> Result<(), PipelineTransactionError> {
    let bytes = encode_json(value).map_err(PipelineTransactionError::Failed)?;
    if file_name == MANAGED_FILES_FILE && bytes.len() > MAX_MANAGED_FILES_MANIFEST_BYTES {
        return Err(PipelineTransactionError::Invalid(format!(
            "managed-file manifest exceeds the {MAX_MANAGED_FILES_MANIFEST_BYTES} byte limit"
        )));
    }
    if file_name == LAUNCH_CONFIG_FILE && bytes.len() > MAX_LAUNCH_CONFIG_BYTES {
        return Err(PipelineTransactionError::Invalid(format!(
            "launch configuration exceeds the {MAX_LAUNCH_CONFIG_BYTES} byte limit"
        )));
    }
    write_stage_file(staging, file_name, &bytes)
}

fn write_stage_file(
    staging: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<(), PipelineTransactionError> {
    let metadata = fs::symlink_metadata(staging)?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(PipelineTransactionError::Invalid(
            "staging root is not a regular directory".into(),
        ));
    }
    let target = staging.join(file_name);
    if let Ok(existing) = fs::symlink_metadata(&target) {
        if !existing.file_type().is_file() || is_reparse_point(&existing) {
            return Err(PipelineTransactionError::Invalid(format!(
                "staged manager artifact is not a regular file: {file_name}"
            )));
        }
        fs::remove_file(&target)?;
    }
    let temporary = staging.join(format!(".pipeline-json-{}.tmp", uuid::Uuid::new_v4()));
    write_new_file(&temporary, bytes)?;
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(PipelineTransactionError::Failed(format!(
            "could not write staged {file_name}: {error}"
        )));
    }
    Ok(())
}

fn manager_artifact_operations(
    staging: &Path,
    target_root: &Path,
) -> Result<Vec<FileOperation>, PipelineTransactionError> {
    let mut operations = Vec::new();
    for name in [
        INSTALL_PLAN_FILE,
        INSTALL_REPORT_FILE,
        MANAGED_FILES_FILE,
        LAUNCH_CONFIG_FILE,
    ] {
        let staged_source = staging.join(name);
        let metadata = fs::symlink_metadata(&staged_source)?;
        if !metadata.file_type().is_file()
            || is_reparse_point(&metadata)
            || (name == MANAGED_FILES_FILE
                && metadata.len() > MAX_MANAGED_FILES_MANIFEST_BYTES as u64)
            || (name == LAUNCH_CONFIG_FILE && metadata.len() > MAX_LAUNCH_CONFIG_BYTES as u64)
        {
            return Err(PipelineTransactionError::Invalid(format!(
                "staged manager artifact {name} is unsafe or exceeds its size limit"
            )));
        }
        let (size, hashes) = download::hash_regular_file(
            &staged_source,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        )?;
        let target = target_root.join(name);
        let existing = inspect_existing_file(&target)?;
        let rollback_copy = existing
            .as_ref()
            .map(|_| staging.join(format!(".pipeline-rollback-{}.bak", uuid::Uuid::new_v4())));
        operations.push(FileOperation {
            relative_path: name.into(),
            staged_source: Some(staged_source),
            staged_size: Some(size),
            staged_hashes: Some(hashes),
            target,
            backup: rollback_copy,
            expected_existing_size: existing.as_ref().map(|file| file.size_bytes),
            expected_existing_hashes: existing.map(|file| file.hashes),
            is_manager_artifact: true,
        });
    }
    Ok(operations)
}

fn apply_publication_operations(
    _tx: &mut Transaction<'_>,
    canonical_root: &Path,
    target_root: &Path,
    staging: &Path,
    plan: &InstallPlan,
    operations: &[FileOperation],
    backup_files: &[BackupFile],
    backup_root: Option<&Path>,
    journal: &mut PublicationJournal,
    cancelled: &AtomicBool,
    fault: Option<PublicationFault>,
) -> Result<(), PipelineTransactionError> {
    if let Some(root) = backup_root {
        ensure_bound_directory(
            target_root,
            BACKUP_ROOT,
            canonical_root,
            staging,
            plan,
            journal,
            cancelled,
        )?;
        let relative_root = root.strip_prefix(target_root).map_err(|_| {
            PipelineTransactionError::Invalid("backup root escaped the server directory".into())
        })?;
        let relative_root = relative_to_slashes(relative_root)?;
        ensure_bound_directory(
            target_root,
            &relative_root,
            canonical_root,
            staging,
            plan,
            journal,
            cancelled,
        )?;
    }
    let mut completed_operations = 0usize;
    for operation in operations {
        check_cancelled(cancelled)?;
        validate_all_targets_still_bound(canonical_root, target_root, staging, plan)?;
        let relative_target = operation.target.strip_prefix(target_root).map_err(|_| {
            PipelineTransactionError::Invalid(
                "publication target escaped the selected server".into(),
            )
        })?;
        let relative_target = relative_to_slashes(relative_target)?;
        ensure_safe_parent_chain(target_root, &relative_target)?;
        if let Some(parent) = Path::new(&relative_target)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            let parent = relative_to_slashes(parent)?;
            ensure_bound_directory(
                target_root,
                &parent,
                canonical_root,
                staging,
                plan,
                journal,
                cancelled,
            )?;
        }
        if let Some(source) = operation.staged_source.as_ref() {
            ensure_path_under_staging(staging, source)?;
            verify_staged_file(
                source,
                operation.staged_size,
                operation.staged_hashes.as_ref(),
            )?;
        }
        let existing = inspect_existing_file(&operation.target)?;
        match (
            &existing,
            operation.expected_existing_size,
            operation.expected_existing_hashes.as_ref(),
        ) {
            (None, None, None) => {}
            (Some(actual), Some(expected_size), Some(expected_hashes))
                if actual.size_bytes == expected_size
                    && hashes_equal(&actual.hashes, expected_hashes) => {}
            (None, Some(_), Some(_)) if operation.staged_source.is_none() => continue,
            _ => {
                return Err(PipelineTransactionError::Conflict(format!(
                    "{} changed after publication preflight",
                    operation.relative_path
                )))
            }
        }
        if existing.is_some() && operation.backup.is_none() {
            return Err(PipelineTransactionError::Conflict(format!(
                "{} appeared after publication preflight",
                operation.relative_path
            )));
        }
        let backup_location = match operation.backup.as_deref() {
            None => None,
            Some(backup) if operation.is_manager_artifact => {
                validate_staging_manager_backup_path(staging, backup, true)
                    .map_err(PipelineTransactionError::Invalid)?;
                Some(JournalBackupLocation::StagingManagerArtifact)
            }
            Some(backup) if backup.starts_with(target_root) => {
                Some(JournalBackupLocation::ServerTree)
            }
            Some(_) => {
                return Err(PipelineTransactionError::Invalid(
                    "transaction backup is outside the server backup root and staging manager-artifact zone".into(),
                ))
            }
        };
        let index = journal.entries.len();
        journal.entries.push(JournalEntry {
            target: operation.target.clone(),
            staged_source: operation.staged_source.clone(),
            backup: operation.backup.clone(),
            backup_location,
            backup_expected_size: operation.expected_existing_size,
            backup_expected_hashes: operation.expected_existing_hashes.clone(),
            target_had_original: false,
            target_has_new_file: false,
        });
        if let (Some(actual), Some(backup)) = (existing.as_ref(), operation.backup.as_ref()) {
            match backup_location {
                Some(JournalBackupLocation::ServerTree) => {
                    let relative = relative_to_slashes(backup.strip_prefix(target_root).unwrap())?;
                    ensure_safe_parent_chain(target_root, &relative)?;
                    if let Some(parent) = Path::new(&relative)
                        .parent()
                        .filter(|path| !path.as_os_str().is_empty())
                    {
                        let parent = relative_to_slashes(parent)?;
                        ensure_bound_directory(
                            target_root,
                            &parent,
                            canonical_root,
                            staging,
                            plan,
                            journal,
                            cancelled,
                        )?;
                    }
                }
                Some(JournalBackupLocation::StagingManagerArtifact) => {
                    validate_staging_manager_backup_path(staging, backup, true)
                        .map_err(PipelineTransactionError::Invalid)?;
                    ensure_path_under_staging(staging, backup)?;
                }
                None => {
                    return Err(PipelineTransactionError::Invalid(
                        "transaction backup location evidence is missing".into(),
                    ))
                }
            }
            validate_all_targets_still_bound(canonical_root, target_root, staging, plan)?;
            let current = inspect_existing_file(&operation.target)?.ok_or_else(|| {
                PipelineTransactionError::Conflict(format!(
                    "{} disappeared before backup",
                    operation.relative_path
                ))
            })?;
            if current.size_bytes != actual.size_bytes
                || !hashes_equal(&current.hashes, &actual.hashes)
            {
                return Err(PipelineTransactionError::Conflict(format!(
                    "{} changed before backup",
                    operation.relative_path
                )));
            }
            if let Some(parent) = backup.parent() {
                if backup.starts_with(target_root) {
                    let relative_parent =
                        relative_to_slashes(parent.strip_prefix(target_root).unwrap())?;
                    ensure_bound_directory(
                        target_root,
                        &relative_parent,
                        canonical_root,
                        staging,
                        plan,
                        journal,
                        cancelled,
                    )?;
                }
            }
            if fs::symlink_metadata(backup).is_ok() {
                return Err(PipelineTransactionError::Conflict(format!(
                    "transaction backup path already exists for {}",
                    operation.relative_path
                )));
            }
            if backup_location == Some(JournalBackupLocation::StagingManagerArtifact) {
                validate_staging_manager_backup_path(staging, backup, true)
                    .map_err(PipelineTransactionError::Invalid)?;
            }
            fs::rename(&operation.target, backup)?;
            journal.entries[index].target_had_original = true;
        }
        if let Some(source) = operation.staged_source.as_ref() {
            validate_all_targets_still_bound(canonical_root, target_root, staging, plan)?;
            ensure_safe_parent_chain(target_root, &relative_target)?;
            if fs::symlink_metadata(&operation.target).is_ok() {
                return Err(PipelineTransactionError::Conflict(format!(
                    "{} still exists at commit time",
                    operation.relative_path
                )));
            }
            fs::rename(source, &operation.target)?;
            journal.entries[index].target_has_new_file = true;
        }
        completed_operations += 1;
        if fault == Some(PublicationFault::AfterFirstMutation) && completed_operations == 1 {
            return Err(PipelineTransactionError::Failed(
                "injected failure after the first filesystem publication step".into(),
            ));
        }
    }

    if let Some(root) = backup_root {
        let manifest = BackupManifest {
            schema_version: 1,
            kind: "modpack-install-backup".into(),
            backup_id: root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .into(),
            server_id: plan.target.server_id.clone(),
            plan_id: plan.plan_id.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            files: backup_files.to_vec(),
        };
        let marker = root.join(BACKUP_MARKER);
        validate_all_targets_still_bound(canonical_root, target_root, staging, plan)?;
        let bytes = encode_json(&manifest).map_err(PipelineTransactionError::Failed)?;
        write_new_file(&marker, &bytes)?;
        journal.created_files.push(marker);
    }
    Ok(())
}

fn verify_staged_file(
    path: &Path,
    expected_size: Option<u64>,
    expected_hashes: Option<&ContentHashes>,
) -> Result<(), PipelineTransactionError> {
    let expected_size = expected_size.ok_or_else(|| {
        PipelineTransactionError::Invalid("staged operation has no expected size".into())
    })?;
    let expected_hashes = expected_hashes.ok_or_else(|| {
        PipelineTransactionError::Invalid("staged operation has no expected hashes".into())
    })?;
    let (size, hashes) =
        download::hash_regular_file(path, &AtomicBool::new(false), &AtomicBool::new(false))?;
    if size != expected_size || !hashes_equal(&hashes, expected_hashes) {
        return Err(PipelineTransactionError::Conflict(format!(
            "staged file changed before publication: {}",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_bound_directory(
    root: &Path,
    relative: &str,
    canonical_root: &Path,
    staging: &Path,
    plan: &InstallPlan,
    journal: &mut PublicationJournal,
    cancelled: &AtomicBool,
) -> Result<(), PipelineTransactionError> {
    install::validate_relative_path(relative, true)
        .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    let mut current = root.to_path_buf();
    for component in relative.trim_end_matches('/').split('/') {
        check_cancelled(cancelled)?;
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => {}
            Ok(_) => {
                return Err(PipelineTransactionError::Invalid(format!(
                    "transaction directory is not a regular directory: {}",
                    current.display()
                )))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                validate_all_targets_still_bound(canonical_root, root, staging, plan)?;
                fs::create_dir(&current)?;
                journal.created_directories.push(current.clone());
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

impl PublicationJournal {
    fn new(canonical_root: &Path, target_root: &Path, staging_root: &Path) -> Self {
        Self {
            entries: Vec::new(),
            created_directories: Vec::new(),
            created_files: Vec::new(),
            backup_root: None,
            canonical_root: canonical_root.to_path_buf(),
            target_root: target_root.to_path_buf(),
            staging_root: staging_root.to_path_buf(),
        }
    }

    fn roots_valid(&self) -> bool {
        validate_rollback_root(&self.canonical_root).is_ok()
            && validate_rollback_root(&self.target_root).is_ok()
            && validate_rollback_root(&self.staging_root).is_ok()
            && self
                .target_root
                .starts_with(self.canonical_root.join("servers"))
            && self
                .staging_root
                .starts_with(self.canonical_root.join("installer-staging"))
            && self.backup_root.as_ref().is_none_or(|root| {
                validate_rollback_path(&self.target_root, root, Some(true), true).is_ok()
            })
    }

    fn rollback(&mut self, report: &mut InstallReport) {
        let mut failures = Vec::new();
        for entry in self.entries.iter().rev() {
            if !self.roots_valid() {
                failures.push("rollback roots changed or contain a reparse point; remaining moves were skipped".to_string());
                break;
            }
            if entry.target_has_new_file {
                if let Some(staged) = entry.staged_source.as_ref() {
                    let result = if !self.path_is_staging_child(staged) {
                        Err("staging destination escaped the selected staging root".to_string())
                    } else if let Err(error) =
                        validate_rollback_path(&self.target_root, &entry.target, Some(false), false)
                    {
                        Err(format!("published file path is unsafe: {error}"))
                    } else if let Err(error) =
                        validate_rollback_path(&self.staging_root, staged, Some(false), true)
                    {
                        Err(format!("staging restore path is unsafe: {error}"))
                    } else if fs::symlink_metadata(staged).is_ok() {
                        Err(
                            "staging restore path is occupied; both copies were preserved"
                                .to_string(),
                        )
                    } else {
                        fs::rename(&entry.target, staged).map_err(|error| {
                            format!("could not move new file back to staging: {error}")
                        })
                    };
                    if let Err(error) = result {
                        failures.push(format!("{}: {error}", entry.target.display()));
                    }
                } else {
                    let result = validate_rollback_path(
                        &self.target_root,
                        &entry.target,
                        Some(false),
                        false,
                    )
                    .map_err(|error| format!("published file path is unsafe: {error}"))
                    .and_then(|()| {
                        fs::remove_file(&entry.target)
                            .map_err(|error| format!("could not remove new file: {error}"))
                    });
                    if let Err(error) = result {
                        if fs::symlink_metadata(&entry.target).is_ok() {
                            failures.push(format!("{}: {error}", entry.target.display()));
                        }
                    }
                }
            }
            if entry.target_had_original {
                if let Some(backup) = entry.backup.as_ref() {
                    let restore = self
                        .validate_backup_source(entry, backup, false)
                        .map_err(|error| format!("backup path is unsafe: {error}"))
                        .and_then(|()| {
                            validate_rollback_path(
                                &self.target_root,
                                &entry.target,
                                Some(false),
                                true,
                            )
                            .map_err(|error| format!("restore target path is unsafe: {error}"))
                        })
                        .and_then(|()| {
                            if fs::symlink_metadata(&entry.target).is_ok() {
                                return Err(
                                    "restore target is occupied; original backup was preserved"
                                        .to_string(),
                                );
                            }
                            ensure_parent_dirs_for_path(&entry.target).map_err(|error| {
                                format!("could not prepare rollback target parent: {error}")
                            })?;
                            validate_rollback_path(
                                &self.target_root,
                                &entry.target,
                                Some(false),
                                true,
                            )
                            .map_err(|error| {
                                format!("restore target changed before move: {error}")
                            })?;
                            self.validate_backup_source(entry, backup, false)
                                .map_err(|error| format!("backup changed before move: {error}"))?;
                            fs::rename(backup, &entry.target).map_err(|error| {
                                format!("could not restore original file: {error}")
                            })
                        });
                    if let Err(error) = restore {
                        failures.push(format!("{}: {error}", backup.display()));
                    }
                }
            }
        }
        for path in self.created_files.iter().rev() {
            let result = self
                .backup_root
                .as_ref()
                .ok_or_else(|| "rollback backup root is unavailable".to_string())
                .and_then(|root| validate_rollback_path(root, path, Some(false), false));
            if let Err(error) = result {
                failures.push(format!(
                    "{}: created rollback file is unsafe: {error}",
                    path.display()
                ));
                continue;
            }
            if let Err(error) = fs::remove_file(path) {
                failures.push(format!(
                    "{}: could not remove transaction-created file: {error}",
                    path.display()
                ));
            }
        }
        for directory in self.created_directories.iter().rev() {
            let result = validate_rollback_path(&self.target_root, directory, Some(true), false);
            if let Err(error) = result {
                failures.push(format!(
                    "{}: created rollback directory is unsafe: {error}",
                    directory.display()
                ));
                continue;
            }
            if let Err(error) = fs::remove_dir(directory) {
                if error.kind() != std::io::ErrorKind::DirectoryNotEmpty
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    failures.push(format!(
                        "{}: could not remove empty transaction directory: {error}",
                        directory.display()
                    ));
                }
            }
        }
        if failures.is_empty() {
            report.record_stage("rollback", "complete", None);
        } else {
            let retained = failures
                .iter()
                .take(32)
                .map(|failure| bounded_report_text(failure))
                .collect::<Vec<_>>();
            report.errors.extend(retained.iter().cloned());
            let omitted = failures.len().saturating_sub(retained.len());
            report.record_stage(
                "rollback",
                "incomplete",
                Some(bounded_report_text(&format!(
                    "{} rollback recovery action(s) failed; evidence: {}{}",
                    failures.len(),
                    retained.join(" | "),
                    if omitted > 0 {
                        format!(" | {omitted} additional failures omitted")
                    } else {
                        String::new()
                    }
                ))),
            );
        }
    }

    fn disarm(&mut self) {
        self.entries.clear();
        self.created_directories.clear();
        self.created_files.clear();
        self.backup_root = None;
    }

    fn path_is_staging_child(&self, path: &Path) -> bool {
        path.starts_with(&self.staging_root) && path != self.staging_root
    }

    fn validate_backup_source(
        &self,
        entry: &JournalEntry,
        backup: &Path,
        allow_missing: bool,
    ) -> Result<(), String> {
        let validate_path = match entry.backup_location {
            Some(JournalBackupLocation::ServerTree) => {
                let root = self
                    .backup_root
                    .as_ref()
                    .ok_or_else(|| "server backup root is unavailable".to_string())?;
                validate_rollback_path(root, backup, Some(false), allow_missing)
            }
            Some(JournalBackupLocation::StagingManagerArtifact) => {
                validate_staging_manager_backup_path(&self.staging_root, backup, allow_missing)
            }
            None => Err("rollback backup location evidence is missing".into()),
        };
        validate_path?;

        let metadata = match fs::symlink_metadata(backup) {
            Ok(metadata) => metadata,
            Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(())
            }
            Err(error) => return Err(format!("could not inspect recorded backup: {error}")),
        };
        if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            return Err("recorded backup is not a regular file".into());
        }
        let expected_size = entry
            .backup_expected_size
            .ok_or_else(|| "recorded backup size evidence is missing".to_string())?;
        let expected_hashes = entry
            .backup_expected_hashes
            .as_ref()
            .ok_or_else(|| "recorded backup hash evidence is missing".to_string())?;
        if metadata.len() != expected_size {
            return Err("recorded backup size differs from the original file evidence".into());
        }
        let (actual_size, actual_hashes) =
            download::hash_regular_file(backup, &AtomicBool::new(false), &AtomicBool::new(false))
                .map_err(|error| format!("could not verify recorded backup bytes: {error}"))?;
        if actual_size != expected_size || !hashes_equal(&actual_hashes, expected_hashes) {
            return Err("recorded backup bytes differ from the original file evidence".into());
        }
        Ok(())
    }
}

fn validate_rollback_root(root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err("rollback root is not a regular directory".into());
    }
    let canonical = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if canonical != root {
        return Err("rollback root no longer resolves to its bound canonical path".into());
    }
    Ok(())
}

fn validate_rollback_path(
    root: &Path,
    path: &Path,
    expected_directory: Option<bool>,
    allow_missing: bool,
) -> Result<(), String> {
    validate_rollback_root(root)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "rollback path escaped its bound root".to_string())?;
    let components = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err("rollback path contains a non-normal component".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        if expected_directory == Some(true) {
            return Ok(());
        }
        return Err("rollback mutation cannot target its root".into());
    }
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
                return Ok(())
            }
            Err(error) => {
                return Err(format!(
                    "could not inspect rollback path component {}: {error}",
                    current.display()
                ))
            }
        };
        if is_reparse_point(&metadata) {
            return Err(format!(
                "rollback path contains a reparse point: {}",
                current.display()
            ));
        }
        let is_final = index + 1 == components.len();
        if !is_final && !metadata.is_dir() {
            return Err(format!(
                "rollback path component is not a directory: {}",
                current.display()
            ));
        }
        let canonical = fs::canonicalize(&current).map_err(|error| error.to_string())?;
        if !canonical.starts_with(root) || canonical == root {
            return Err(format!(
                "rollback path component escaped its root: {}",
                current.display()
            ));
        }
        if is_final {
            match expected_directory {
                Some(true) if !metadata.is_dir() => {
                    return Err(format!(
                        "rollback path is not a directory: {}",
                        current.display()
                    ));
                }
                Some(false) if !metadata.file_type().is_file() => {
                    return Err(format!(
                        "rollback path is not a regular file: {}",
                        current.display()
                    ));
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn validate_staging_manager_backup_path(
    staging_root: &Path,
    backup: &Path,
    allow_missing: bool,
) -> Result<(), String> {
    let file_name = backup
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "staging backup has no valid filename".to_string())?;
    if backup.parent() != Some(staging_root)
        || !file_name.starts_with(".pipeline-rollback-")
        || !file_name.ends_with(".bak")
    {
        return Err("staging backup is outside the manager-artifact rollback zone".into());
    }
    validate_rollback_path(staging_root, backup, Some(false), allow_missing)
}

fn ensure_parent_dirs_for_path(path: &Path) -> Result<(), PipelineTransactionError> {
    let parent = path
        .parent()
        .ok_or_else(|| PipelineTransactionError::Invalid("rollback target has no parent".into()))?;
    if !parent.is_dir() {
        return Err(PipelineTransactionError::Invalid(
            "rollback target parent is not a regular directory".into(),
        ));
    }
    let metadata = fs::symlink_metadata(parent)?;
    if is_reparse_point(&metadata) {
        return Err(PipelineTransactionError::Invalid(
            "rollback target parent became a reparse point".into(),
        ));
    }
    Ok(())
}

fn merge_server_properties(
    existing_path: Option<&Path>,
    incoming_path: Option<&Path>,
    server: &ServerRecord,
) -> Result<Vec<u8>, PipelineTransactionError> {
    let existing = existing_path.map(read_bounded_properties).transpose()?;
    let incoming = incoming_path.map(read_bounded_properties).transpose()?;
    let base = existing
        .as_ref()
        .or(incoming.as_ref())
        .map(String::as_str)
        .unwrap_or("");
    let mut lines = Vec::<String>::new();
    let mut seen_user_keys = HashSet::new();
    for line in base.lines() {
        if let Some((key, _)) = line.split_once('=') {
            let key = key.trim().to_ascii_lowercase();
            if MANAGER_OWNED_PROPERTIES.contains(&key.as_str()) {
                continue;
            }
            seen_user_keys.insert(key);
        }
        lines.push(line.to_string());
    }
    if let (Some(existing), Some(incoming)) = (existing.as_ref(), incoming.as_ref()) {
        if !existing.is_empty() {
            for line in incoming.lines() {
                let Some((key, _)) = line.split_once('=') else {
                    continue;
                };
                let key = key.trim().to_ascii_lowercase();
                if MANAGER_OWNED_PROPERTIES.contains(&key.as_str()) || !seen_user_keys.insert(key) {
                    continue;
                }
                lines.push(line.to_string());
            }
        }
    }
    let manager_values = [
        ("server-port", server.port.to_string()),
        ("motd", server.name.clone()),
        ("max-players", "20".to_string()),
        ("online-mode", "true".to_string()),
        ("difficulty", "normal".to_string()),
        ("gamemode", "survival".to_string()),
        ("level-name", "world".to_string()),
        ("enable-rcon", "false".to_string()),
        ("enable-status", "true".to_string()),
    ];
    for (key, value) in manager_values {
        lines.push(format!("{key}={value}"));
    }
    let mut output = lines.join("\n");
    output.push('\n');
    Ok(output.into_bytes())
}

fn read_bounded_properties(path: &Path) -> Result<String, PipelineTransactionError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || is_reparse_point(&metadata)
        || metadata.len() > 1024 * 1024
    {
        return Err(PipelineTransactionError::Invalid(format!(
            "server.properties is not a regular file or exceeds 1 MiB: {}",
            path.display()
        )));
    }
    let content = fs::read(path)?;
    String::from_utf8(content)
        .map_err(|_| PipelineTransactionError::Invalid("server.properties is not UTF-8".into()))
}

fn relative_to_slashes(path: &Path) -> Result<String, PipelineTransactionError> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => {
                components.push(part.to_string_lossy().into_owned())
            }
            _ => {
                return Err(PipelineTransactionError::Invalid(
                    "transaction path contains a non-normal component".into(),
                ))
            }
        }
    }
    if components.is_empty() {
        return Err(PipelineTransactionError::Invalid(
            "transaction path is empty".into(),
        ));
    }
    Ok(components.join("/"))
}

fn cleanup_completed_staging(
    staging: &Path,
    app_data: &Path,
    plan: &InstallPlan,
) -> Result<(), PipelineTransactionError> {
    let canonical_root = fs::canonicalize(app_data)?;
    let canonical_staging = fs::canonicalize(staging)?;
    let expected_root = canonical_root.join("installer-staging");
    if !canonical_staging.starts_with(&expected_root) || canonical_staging == expected_root {
        return Err(PipelineTransactionError::Invalid(
            "completed staging path escaped app installer-staging".into(),
        ));
    }
    let metadata = fs::symlink_metadata(&canonical_staging)?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(PipelineTransactionError::Invalid(
            "completed staging directory changed before cleanup".into(),
        ));
    }
    let target = server_directory(&canonical_root, &plan.target.server_id);
    if !target.is_dir() {
        return Err(PipelineTransactionError::Invalid(
            "server target disappeared after publication".into(),
        ));
    }
    fs::remove_dir_all(canonical_staging)?;
    Ok(())
}

fn prune_successful_backups(
    canonical_root: &Path,
    target_root: &Path,
    server_id: &str,
    keep: usize,
) {
    let root = target_root.join(BACKUP_ROOT);
    let _root_meta = match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => metadata,
        _ => return,
    };
    let canonical_backup_root = match fs::canonicalize(&root) {
        Ok(path) => path,
        Err(_) => return,
    };
    let mut backups = Vec::new();
    let entries = match fs::read_dir(&canonical_backup_root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("install-") {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => metadata,
            _ => continue,
        };
        let _ = metadata;
        let marker = path.join(BACKUP_MARKER);
        let manifest = match read_backup_manifest(&marker) {
            Ok(manifest)
                if manifest.backup_id == name
                    && manifest.server_id == server_id
                    && verify_backup_tree(&path, &manifest) =>
            {
                manifest
            }
            _ => continue,
        };
        backups.push((manifest.created_at.clone(), path));
    }
    backups.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in backups.into_iter().skip(keep) {
        if fs::canonicalize(canonical_root).ok().as_deref() != Some(canonical_root)
            || fs::canonicalize(&server_directory(canonical_root, server_id))
                .ok()
                .as_deref()
                != Some(target_root)
            || fs::canonicalize(&root).ok().as_deref() != Some(canonical_backup_root.as_path())
        {
            return;
        }
        let Ok(canonical) = fs::canonicalize(&path) else {
            continue;
        };
        if !canonical.starts_with(&canonical_backup_root) || canonical == canonical_backup_root {
            continue;
        }
        if let Ok(metadata) = fs::symlink_metadata(&canonical) {
            if metadata.is_dir() && !is_reparse_point(&metadata) {
                if let Err(error) = fs::remove_dir_all(&canonical) {
                    tracing::warn!(path = %canonical.display(), %error, "could not prune an old successful modpack backup");
                }
            }
        }
    }
}

fn read_backup_manifest(path: &Path) -> Result<BackupManifest, PipelineTransactionError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || is_reparse_point(&metadata)
        || metadata.len() > 4 * 1024 * 1024
    {
        return Err(PipelineTransactionError::Invalid(
            "backup marker is unsafe or oversized".into(),
        ));
    }
    let bytes = fs::read(path)?;
    let manifest: BackupManifest = serde_json::from_slice(&bytes).map_err(|error| {
        PipelineTransactionError::Invalid(format!("backup marker is malformed: {error}"))
    })?;
    if manifest.schema_version != 1
        || manifest.kind != "modpack-install-backup"
        || manifest.backup_id.trim().is_empty()
        || manifest.server_id.trim().is_empty()
        || manifest.plan_id.trim().is_empty()
        || manifest.created_at.trim().is_empty()
    {
        return Err(PipelineTransactionError::Invalid(
            "backup marker identity is invalid".into(),
        ));
    }
    let mut paths = HashSet::new();
    for file in &manifest.files {
        let key = path_key(&file.relative_path)?;
        if !paths.insert(key) {
            return Err(PipelineTransactionError::Invalid(
                "backup marker repeats a file".into(),
            ));
        }
        file.hashes
            .validate()
            .map_err(|error| PipelineTransactionError::Invalid(error.to_string()))?;
    }
    Ok(manifest)
}

fn verify_backup_tree(root: &Path, manifest: &BackupManifest) -> bool {
    let mut expected = HashMap::with_capacity(manifest.files.len());
    for file in &manifest.files {
        let Ok(key) = path_key(&file.relative_path) else {
            return false;
        };
        if expected.insert(key, file).is_some() {
            return false;
        }
    }
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((directory, relative_parent)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                return false;
            };
            if is_reparse_point(&metadata) {
                return false;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if relative_parent.is_empty() && name == BACKUP_MARKER {
                if !metadata.file_type().is_file() {
                    return false;
                }
                continue;
            }
            let relative = if relative_parent.is_empty() {
                name
            } else {
                format!("{relative_parent}/{name}")
            };
            if metadata.is_dir() {
                stack.push((path, relative));
                continue;
            }
            if !metadata.file_type().is_file() {
                return false;
            }
            let Ok(key) = path_key(&relative) else {
                return false;
            };
            let Some(expected_file) = expected.remove(&key) else {
                return false;
            };
            let Ok((size, hashes)) = download::hash_regular_file(
                &path,
                &AtomicBool::new(false),
                &AtomicBool::new(false),
            ) else {
                return false;
            };
            if size != expected_file.size_bytes || !hashes_equal(&hashes, &expected_file.hashes) {
                return false;
            }
        }
    }
    expected.is_empty()
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::modpacks::pipeline::{
        loader::{LoaderCoordinate, LoaderInstallMethod, LoaderLaunchMode, LoaderRequiredFile},
        model::{
            ArchiveFingerprint, ArchiveVerification, ExactPackPin, FileDecision,
            FileDecisionReason, FileSide, ProviderPin,
        },
        plan::{InstallTarget, LoaderKind, LoaderPin},
        report::{InstallStatus, MANAGED_FILES_FILE},
    };
    use zip::{write::SimpleFileOptions, ZipWriter};

    struct Fixture {
        root: PathBuf,
        app_data: PathBuf,
        target: PathBuf,
        staging: PathBuf,
        connection: Connection,
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("pipeline-transaction-{}", uuid::Uuid::new_v4()));
            let app_data = root.join("app-data");
            let target = app_data.join("servers/server-test");
            let staging = app_data.join("installer-staging/stage-test");
            fs::create_dir_all(target.join("world")).unwrap();
            fs::create_dir_all(target.join("mods")).unwrap();
            fs::create_dir_all(&staging).unwrap();
            fs::write(root.join("java.exe"), b"fixture validated Java executable").unwrap();
            fs::write(target.join("world/level.dat"), b"world-preserved").unwrap();
            fs::write(target.join("eula.txt"), b"eula=false\n").unwrap();
            fs::write(target.join("user_jvm_args.txt"), b"-Xmx6G\n").unwrap();
            fs::write(
                target.join("server.properties"),
                b"user-value=keep\nserver-port=25565\n",
            )
            .unwrap();
            fs::write(target.join("mods/untracked.jar"), b"user-mod").unwrap();

            let connection = Connection::open_in_memory().unwrap();
            crate::db::apply_migrations(&connection).unwrap();
            connection.execute(
                "INSERT INTO servers (id, name, loader, mc_version, loader_version, modpack_id, port, ram_mb, java_path, eula_accepted, status, created_at) VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, NULL, 0, 'stopped', ?7)",
                params!["server-test", "Fixture server", "Vanilla", "1.20.1", 25571, 4096, "2026-10-12T00:00:00Z"],
            ).unwrap();
            Self {
                root,
                app_data,
                target,
                staging,
                connection,
            }
        }

        fn plan(&self, included: &[&str]) -> InstallPlan {
            InstallPlan {
                schema_version: crate::modpacks::pipeline::model::PIPELINE_SCHEMA_VERSION,
                plan_id: format!("plan-{}", uuid::Uuid::new_v4()),
                created_at: "2026-10-12T00:00:00Z".into(),
                target: InstallTarget {
                    server_id: "server-test".into(),
                    server_name: "Fixture server".into(),
                    directory: "servers/server-test".into(),
                },
                source_pin: ProviderPin {
                    source: ProviderSource::CurseForge,
                    exact: ExactPackPin::CurseForgeServerArchive {
                        file_name: "author-server.zip".into(),
                        archive: ArchiveFingerprint {
                            hashes: ContentHashes {
                                sha1: "a".repeat(40),
                                sha512: "b".repeat(128),
                            },
                            size_bytes: 10,
                            verification: ArchiveVerification::CalculatedFingerprint,
                        },
                    },
                },
                loader: LoaderPin {
                    kind: LoaderKind::Vanilla,
                    minecraft_version: "1.20.1".into(),
                    loader_version: None,
                },
                file_decisions: included
                    .iter()
                    .map(|path| FileDecision {
                        path: (*path).into(),
                        side: Some(FileSide::Server),
                        action: FileDecisionAction::Include,
                        reason: FileDecisionReason::Required,
                    })
                    .collect(),
            }
        }

        fn stage(
            &self,
            plan: &InstallPlan,
            files: &[(&str, &[u8])],
        ) -> (PreparedPayload, LoaderCompletenessEvidence) {
            let server_jar = self.staging.join("server.jar");
            fs::write(&server_jar, b"vanilla-server-jar").unwrap();
            let (loader_size, loader_hashes) = download::hash_regular_file(
                &server_jar,
                &AtomicBool::new(false),
                &AtomicBool::new(false),
            )
            .unwrap();
            let mut payload_files = Vec::new();
            let mut selected = Vec::new();
            for (relative, bytes) in files {
                let path = self.staging.join(relative.replace('/', "\\"));
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, bytes).unwrap();
                let (size_bytes, hashes) = download::hash_regular_file(
                    &path,
                    &AtomicBool::new(false),
                    &AtomicBool::new(false),
                )
                .unwrap();
                payload_files.push(StagedPayloadFile {
                    path: (*relative).into(),
                    size_bytes,
                    hashes,
                    source_host: None,
                    origin: match plan.source_pin.source {
                        ProviderSource::Modrinth => PayloadFileOrigin::ModrinthDownload,
                        ProviderSource::CurseForge => PayloadFileOrigin::CurseForgeArchive,
                    },
                });
                selected.push((*relative).to_string());
            }
            let payload = PreparedPayload {
                plan_id: plan.plan_id.clone(),
                source: plan.source_pin.source,
                selected_file_paths: selected,
                override_file_paths: Vec::new(),
                files: payload_files,
                verified_downloads: Vec::new(),
                warnings: Vec::new(),
            };
            let loader = LoaderCompletenessEvidence {
                plan: plan.clone(),
                selected_java_path: self.root.join("java.exe"),
                coordinate: LoaderCoordinate {
                    provider_pin: plan.loader.clone(),
                    resolved_version: None,
                    installer_loader_version: None,
                    forge_artifact: None,
                    artifact_url: "https://piston-data.mojang.com/server.jar".into(),
                    expected_size: Some(loader_size),
                    expected_sha1: None,
                    metadata_source: "generated transaction fixture".into(),
                    install_method: LoaderInstallMethod::MojangServerJar,
                    allowed_redirect_hosts: &["piston-data.mojang.com"],
                },
                launch_mode: LoaderLaunchMode::ServerJar {
                    file_name: "server.jar".into(),
                },
                required_files: vec![LoaderRequiredFile {
                    relative_path: "server.jar".into(),
                    size_bytes: loader_size,
                    hashes: loader_hashes,
                }],
                complete: true,
            };
            (payload, loader)
        }

        fn publish(
            &mut self,
            plan: &InstallPlan,
            payload: &PreparedPayload,
            loader: &LoaderCompletenessEvidence,
            approvals: &HashSet<String>,
            fault: Option<PublicationFault>,
        ) -> Result<InstallReport, PipelineTransactionError> {
            publish_staged_install_with_fault(
                &mut self.connection,
                &self.app_data,
                plan,
                payload,
                loader,
                &self.staging,
                approvals,
                &AtomicBool::new(false),
                fault,
            )
        }

        fn managed_count(&self) -> i64 {
            self.connection
                .query_row(
                    "SELECT COUNT(*) FROM managed_server_files WHERE server_id = 'server-test'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn candidate_server_record(fixture: &Fixture, id: String) -> ServerRecord {
        ServerRecord {
            id,
            name: "New pack server".into(),
            loader: "Vanilla".into(),
            mc_version: "1.20.1".into(),
            loader_version: None,
            modpack_id: Some(format!("curseforge-server:{}", "b".repeat(128))),
            port: 25572,
            ram_mb: 4096,
            java_path: Some(fixture.root.join("java.exe").to_string_lossy().into_owned()),
            eula_accepted: false,
            status: "stopped".into(),
            created_at: "2026-10-12T00:00:00Z".into(),
        }
    }

    fn target_new_server(plan: &mut InstallPlan, server: &ServerRecord) {
        plan.target.server_id = server.id.clone();
        plan.target.server_name = server.name.clone();
        plan.target.directory = format!("servers/{}", server.id);
    }

    #[test]
    fn new_server_publication_commits_record_files_and_ownership_together() {
        let mut fixture = Fixture::new();
        let server = candidate_server_record(&fixture, uuid::Uuid::new_v4().to_string());
        let mut plan = fixture.plan(&["mods/new.jar"]);
        target_new_server(&mut plan, &server);
        let (payload, loader) = fixture.stage(&plan, &[("mods/new.jar", b"new-pack-mod")]);

        let report = publish_staged_install_with_candidate(
            &mut fixture.connection,
            &fixture.app_data,
            &plan,
            &payload,
            &loader,
            &fixture.staging,
            &HashSet::new(),
            &AtomicBool::new(false),
            Some(&server),
            None,
        )
        .unwrap();

        let saved = servers::get_server(&fixture.connection, &server.id).unwrap();
        let target = fixture.app_data.join("servers").join(&server.id);
        let managed_count: i64 = fixture
            .connection
            .query_row(
                "SELECT COUNT(*) FROM managed_server_files WHERE server_id = ?1",
                [&server.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(report.status, InstallStatus::Complete);
        assert_eq!(saved.modpack_id, server.modpack_id);
        assert!(target.join("server.jar").is_file());
        assert_eq!(
            fs::read(target.join("mods/new.jar")).unwrap(),
            b"new-pack-mod"
        );
        assert!(fs::read_to_string(target.join("eula.txt"))
            .unwrap()
            .contains("eula=false"));
        assert!(fs::read_to_string(target.join("server.properties"))
            .unwrap()
            .contains("server-port=25572"));
        assert!(managed_count >= 2);
    }

    #[test]
    fn failed_new_server_publication_rolls_back_record_scaffold_and_file_moves() {
        let mut fixture = Fixture::new();
        let server = candidate_server_record(&fixture, uuid::Uuid::new_v4().to_string());
        let mut plan = fixture.plan(&["mods/new.jar"]);
        target_new_server(&mut plan, &server);
        let (payload, loader) = fixture.stage(&plan, &[("mods/new.jar", b"new-pack-mod")]);

        let result = publish_staged_install_with_candidate(
            &mut fixture.connection,
            &fixture.app_data,
            &plan,
            &payload,
            &loader,
            &fixture.staging,
            &HashSet::new(),
            &AtomicBool::new(false),
            Some(&server),
            Some(PublicationFault::BeforeDatabaseCommit),
        );

        assert!(result.is_err());
        assert!(servers::get_server(&fixture.connection, &server.id).is_err());
        assert!(!fixture.app_data.join("servers").join(&server.id).exists());
        assert_eq!(fixture.managed_count(), 0);
        assert!(fixture.staging.join("server.jar").is_file());
        assert_eq!(
            fs::read(fixture.staging.join("mods/new.jar")).unwrap(),
            b"new-pack-mod"
        );
    }

    fn count_backup_dirs(target: &Path) -> usize {
        let path = target.join(BACKUP_ROOT);
        fs::read_dir(path)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                    .count()
            })
            .unwrap_or(0)
    }

    fn seed_managed(fixture: &Fixture, relative: &str, bytes: &[u8], plan_id: &str) {
        let path = fixture.target.join(relative.replace('/', "\\"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        let (size, hashes) =
            download::hash_regular_file(&path, &AtomicBool::new(false), &AtomicBool::new(false))
                .unwrap();
        let canonical_root = fs::canonicalize(&fixture.app_data).unwrap();
        let updated_at = "2026-10-12T00:00:00Z";
        fixture.connection.execute(
            "INSERT INTO managed_server_files (server_id, canonical_root, path_key, relative_path, installed_size, installed_sha1, installed_sha512, plan_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params!["server-test", canonical_root.to_string_lossy(), path_key(relative).unwrap(), relative, size as i64, hashes.sha1, hashes.sha512, plan_id, updated_at],
        ).unwrap();
        let mut manifest = ManagedFilesManifest::new("server-test", &canonical_root);
        manifest.files.push(ManagedFileRecord {
            path: relative.into(),
            size_bytes: size,
            hashes,
            plan_id: plan_id.into(),
            updated_at: updated_at.into(),
        });
        fs::write(
            fixture.target.join(MANAGED_FILES_FILE),
            encode_json(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn publication_commits_owned_files_and_preserves_world_eula_user_properties_and_untracked_files(
    ) {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&["mods/new.jar"]);
        let (payload, loader) = fixture.stage(&plan, &[("mods/new.jar", b"selected-payload")]);
        let report = fixture
            .publish(&plan, &payload, &loader, &HashSet::new(), None)
            .unwrap();
        assert_eq!(report.status, InstallStatus::Complete);
        assert_eq!(fixture.managed_count(), 2);
        assert_eq!(
            fs::read(fixture.target.join("world/level.dat")).unwrap(),
            b"world-preserved"
        );
        assert_eq!(
            fs::read(fixture.target.join("eula.txt")).unwrap(),
            b"eula=false\n"
        );
        assert_eq!(
            fs::read(fixture.target.join("user_jvm_args.txt")).unwrap(),
            b"-Xmx6G\n"
        );
        let properties = fs::read_to_string(fixture.target.join("server.properties")).unwrap();
        assert!(properties.contains("user-value=keep"));
        assert!(properties.contains("server-port=25571"));
        assert_eq!(
            fs::read(fixture.target.join("mods/untracked.jar")).unwrap(),
            b"user-mod"
        );
        assert_eq!(
            fs::read(fixture.target.join("mods/new.jar")).unwrap(),
            b"selected-payload"
        );
        let launch_config: crate::modpacks::pipeline::model::LaunchConfig =
            serde_json::from_slice(&fs::read(fixture.target.join(LAUNCH_CONFIG_FILE)).unwrap())
                .unwrap();
        assert_eq!(launch_config.server_id, plan.target.server_id);
        assert_eq!(launch_config.provider_pin.as_ref(), Some(&plan.source_pin));
        assert_eq!(launch_config.loader_pin.as_ref(), Some(&plan.loader));
        assert_eq!(
            launch_config.working_directory,
            fs::canonicalize(&fixture.target)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
        assert!(!fixture.staging.exists());
    }

    #[test]
    fn stale_owned_files_are_backed_up_but_untracked_files_are_retained() {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&["mods/new.jar"]);
        let (payload, loader) = fixture.stage(&plan, &[("mods/new.jar", b"new-payload")]);
        seed_managed(&fixture, "mods/stale.jar", b"old-managed", "old-plan");
        let report = fixture
            .publish(&plan, &payload, &loader, &HashSet::new(), None)
            .unwrap();
        assert_eq!(report.status, InstallStatus::Complete);
        assert!(!fixture.target.join("mods/stale.jar").exists());
        assert_eq!(
            fs::read(fixture.target.join("mods/untracked.jar")).unwrap(),
            b"user-mod"
        );
        assert_eq!(fixture.managed_count(), 2);
        assert_eq!(count_backup_dirs(&fixture.target), 1);
        let manifest: ManagedFilesManifest =
            serde_json::from_slice(&fs::read(fixture.target.join(MANAGED_FILES_FILE)).unwrap())
                .unwrap();
        assert!(manifest
            .files
            .iter()
            .all(|file| file.path != "mods/stale.jar"));
    }

    #[test]
    fn edited_stale_managed_files_are_preserved_and_released_from_ownership() {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&[]);
        let (payload, loader) = fixture.stage(&plan, &[]);
        seed_managed(&fixture, "mods/stale.jar", b"original-managed", "old-plan");
        fs::write(fixture.target.join("mods/stale.jar"), b"user-edit").unwrap();
        let report = fixture
            .publish(&plan, &payload, &loader, &HashSet::new(), None)
            .unwrap();
        assert_eq!(report.status, InstallStatus::Complete);
        assert_eq!(
            fs::read(fixture.target.join("mods/stale.jar")).unwrap(),
            b"user-edit"
        );
        assert_eq!(fixture.managed_count(), 1);
        assert!(report
            .files
            .iter()
            .any(|file| file.path == "mods/stale.jar"
                && file.outcome == FileOutcome::PreservedUserFile));
    }

    #[test]
    fn untracked_collision_requires_explicit_replacement_approval_after_backup() {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&["mods/untracked.jar"]);
        let (payload, loader) = fixture.stage(&plan, &[("mods/untracked.jar", b"pack-version")]);
        let failed = fixture.publish(&plan, &payload, &loader, &HashSet::new(), None);
        assert!(matches!(failed, Err(PipelineTransactionError::Conflict(_))));
        assert_eq!(
            fs::read(fixture.target.join("mods/untracked.jar")).unwrap(),
            b"user-mod"
        );
        let approvals = HashSet::from(["mods/untracked.jar".to_string()]);
        fixture
            .publish(&plan, &payload, &loader, &approvals, None)
            .unwrap();
        assert_eq!(
            fs::read(fixture.target.join("mods/untracked.jar")).unwrap(),
            b"pack-version"
        );
        assert_eq!(count_backup_dirs(&fixture.target), 1);
        assert_eq!(fixture.managed_count(), 2);
    }

    #[test]
    fn manifest_tampering_blocks_cleanup_before_publication() {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&["mods/new.jar"]);
        let (payload, loader) = fixture.stage(&plan, &[("mods/new.jar", b"new")]);
        seed_managed(&fixture, "mods/old.jar", b"old", "old-plan");
        let mut manifest: ManagedFilesManifest =
            serde_json::from_slice(&fs::read(fixture.target.join(MANAGED_FILES_FILE)).unwrap())
                .unwrap();
        manifest.files[0].path = "mods/tampered.jar".into();
        fs::write(
            fixture.target.join(MANAGED_FILES_FILE),
            encode_json(&manifest).unwrap(),
        )
        .unwrap();
        let result = fixture.publish(&plan, &payload, &loader, &HashSet::new(), None);
        assert!(
            matches!(&result, Err(PipelineTransactionError::Invalid(message)) if message.contains("disagree") || message.contains("manifest omits a database-owned path")),
            "manifest tampering should fail with a registry/manifest mismatch; got {result:?}"
        );
        assert_eq!(
            fs::read(fixture.target.join("mods/old.jar")).unwrap(),
            b"old"
        );
        assert!(!fixture.target.join("mods/new.jar").exists());
        assert_eq!(fixture.managed_count(), 1);
    }

    #[test]
    fn managed_manifest_reader_and_writer_share_the_same_byte_limit() {
        let fixture = Fixture::new();
        let plan = fixture.plan(&[]);
        let exact_limit_json = "x".repeat(MAX_MANAGED_FILES_MANIFEST_BYTES - 2);
        write_stage_json(&fixture.staging, MANAGED_FILES_FILE, &exact_limit_json).unwrap();
        let staged_manifest = fixture.staging.join(MANAGED_FILES_FILE);
        assert_eq!(
            fs::metadata(&staged_manifest).unwrap().len(),
            MAX_MANAGED_FILES_MANIFEST_BYTES as u64
        );

        let target_manifest = fixture.target.join(MANAGED_FILES_FILE);
        fs::copy(&staged_manifest, &target_manifest).unwrap();
        let canonical_root = fs::canonicalize(&fixture.app_data).unwrap();
        let at_limit = load_and_validate_manifest(&plan, &fixture.target, &canonical_root);
        assert!(matches!(
            at_limit,
            Err(PipelineTransactionError::Invalid(message))
                if message.contains("manifest is malformed")
        ));

        let oversized_json = "x".repeat(MAX_MANAGED_FILES_MANIFEST_BYTES - 1);
        let write_result = write_stage_json(&fixture.staging, MANAGED_FILES_FILE, &oversized_json);
        assert!(matches!(
            write_result,
            Err(PipelineTransactionError::Invalid(message))
                if message.contains("exceeds the 16777216 byte limit")
        ));
        assert_eq!(
            fs::metadata(&staged_manifest).unwrap().len(),
            MAX_MANAGED_FILES_MANIFEST_BYTES as u64
        );

        fs::write(
            &target_manifest,
            vec![b'x'; MAX_MANAGED_FILES_MANIFEST_BYTES + 1],
        )
        .unwrap();
        let over_limit = load_and_validate_manifest(&plan, &fixture.target, &canonical_root);
        assert!(matches!(
            over_limit,
            Err(PipelineTransactionError::Invalid(message))
                if message.contains("not a regular bounded file")
        ));
    }

    #[test]
    fn guarded_archive_snapshot_survives_source_replacement_and_rejects_new_bytes() {
        let fixture = Fixture::new();
        let source = fixture.root.join("provider-archive.zip");
        let original = b"original provider archive bytes";
        let replacement = b"replaced provider archive bytes";
        assert_eq!(original.len(), replacement.len());
        fs::write(&source, original).unwrap();
        let snapshot =
            snapshot_archive_with_cancel(&source, original.len() as u64, |_| false).unwrap();
        let calculated_pin = snapshot.fingerprint().clone();
        assert_eq!(
            calculated_pin.verification,
            ArchiveVerification::CalculatedFingerprint
        );
        assert!(fs::write(snapshot.path(), b"mutation").is_err());
        assert!(fs::remove_file(snapshot.path()).is_err());

        fs::write(&source, replacement).unwrap();
        assert_eq!(fs::read(snapshot.path()).unwrap(), original);
        verify_snapshot_fingerprint(&snapshot, &calculated_pin, "Modrinth").unwrap();

        let replacement_snapshot =
            snapshot_archive_with_cancel(&source, original.len() as u64, |_| false).unwrap();
        assert!(
            verify_snapshot_fingerprint(&replacement_snapshot, &calculated_pin, "CurseForge")
                .is_err()
        );
    }

    #[test]
    fn wrapped_curseforge_inner_archive_stays_guarded_through_classification_and_extraction() {
        let fixture = Fixture::new();
        let mut plan = fixture.plan(&["mods/wrapped.jar"]);
        plan.loader = LoaderPin {
            kind: LoaderKind::Fabric,
            minecraft_version: "1.20.1".into(),
            loader_version: Some("0.19.3".into()),
        };
        let (_, loader) = fixture.stage(&plan, &[]);

        let mod_bytes = b"from-held-inner-snapshot";
        let manifest = br#"{"files":["mods\\wrapped.jar"],"minecraftVersion":"1.20.1","modloader":"Fabric","modloaderVersion":"0.19.3","serverPackCreatorVersion":"8.1.2"}"#;
        let mut inner_writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        inner_writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        inner_writer.write_all(manifest).unwrap();
        inner_writer
            .start_file("mods/wrapped.jar", SimpleFileOptions::default())
            .unwrap();
        inner_writer.write_all(mod_bytes).unwrap();
        let inner_bytes = inner_writer.finish().unwrap().into_inner();

        let outer_path = fixture.root.join("curseforge-wrapper.zip");
        let mut outer_writer = ZipWriter::new(File::create(&outer_path).unwrap());
        outer_writer
            .start_file("author-server-pack.zip", SimpleFileOptions::default())
            .unwrap();
        outer_writer.write_all(&inner_bytes).unwrap();
        outer_writer.finish().unwrap();

        let outer_plan = curseforge_import::build_archive_plan(&outer_path).unwrap();
        let prepared =
            curseforge_import::prepare_server_pack_archive(&outer_path, outer_plan).unwrap();
        let guarded_inner_path = prepared.path.clone();
        assert_ne!(guarded_inner_path, outer_path);
        assert!(fs::write(&guarded_inner_path, b"replacement inner zip").is_err());
        assert!(fs::remove_file(&guarded_inner_path).is_err());

        let replacement_path = fixture.root.join("replacement-inner.zip");
        fs::write(&replacement_path, b"replacement inner zip").unwrap();
        assert!(fs::rename(&replacement_path, &guarded_inner_path).is_err());
        assert!(replacement_path.exists());

        assert!(matches!(
            crate::modpacks::pipeline::classify::classify_curseforge_server_zip(
                &guarded_inner_path
            ),
            crate::modpacks::pipeline::classify::CurseForgeArchiveClassification::ServerPack {
                loader,
                ..
            } if loader == "Fabric"
        ));
        let selected = BTreeSet::from(["mods/wrapped.jar".to_string()]);
        let files = extract_curseforge_payload_files(
            &guarded_inner_path,
            &fixture.staging,
            &selected,
            &loader,
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "mods/wrapped.jar");
        assert_eq!(
            fs::read(fixture.staging.join("mods/wrapped.jar")).unwrap(),
            mod_bytes
        );
        assert!(guarded_inner_path.exists());
        assert!(fs::remove_file(&guarded_inner_path).is_err());
        drop(prepared);
        assert!(!guarded_inner_path.exists());
        assert!(fs::remove_file(replacement_path).is_ok());
    }

    #[test]
    fn wrapped_curseforge_inner_archive_cancellation_removes_partial_file() {
        let fixture = Fixture::new();
        let large_payload = (0usize..512 * 1024)
            .map(|index| ((index.wrapping_mul(73) + index / 7 + 19) % 251) as u8)
            .collect::<Vec<_>>();
        let mut inner_writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        inner_writer
            .start_file(
                "payload.bin",
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        inner_writer.write_all(&large_payload).unwrap();
        let inner_bytes = inner_writer.finish().unwrap().into_inner();
        assert!(inner_bytes.len() > 128 * 1024);

        let outer_path = fixture.root.join("cancelled-curseforge-wrapper.zip");
        let mut outer_writer = ZipWriter::new(File::create(&outer_path).unwrap());
        outer_writer
            .start_file("author-server-pack.zip", SimpleFileOptions::default())
            .unwrap();
        outer_writer.write_all(&inner_bytes).unwrap();
        outer_writer.finish().unwrap();
        let outer_plan = curseforge_import::build_archive_plan(&outer_path).unwrap();

        let mut cancellation_polls = 0usize;
        let mut copied_before_cancel = None;
        let mut partial_path = None;
        let result = curseforge_import::prepare_server_pack_archive_with_cancel(
            &outer_path,
            outer_plan,
            |copied_bytes| {
                cancellation_polls += 1;
                if copied_bytes > 0 {
                    let partial = fs::read_dir(&fixture.root)
                        .unwrap()
                        .filter_map(Result::ok)
                        .find(|entry| {
                            entry
                                .file_name()
                                .to_string_lossy()
                                .starts_with(".curseforge-inner-")
                        })
                        .expect("partial inner archive exists after a successful write");
                    copied_before_cancel = Some(copied_bytes);
                    partial_path = Some(partial.path());
                    return true;
                }
                false
            },
        );

        assert!(matches!(
            result,
            Err(curseforge_import::PreparedArchiveError::Cancelled)
        ));
        assert!(
            cancellation_polls < 16,
            "copy cancellation should be prompt"
        );
        let copied_before_cancel =
            copied_before_cancel.expect("cancellation observed a partial copy");
        assert!(copied_before_cancel > 0);
        assert!(
            copied_before_cancel < inner_bytes.len() as u64,
            "copy cancellation should occur before completion: {copied_before_cancel}/{} bytes after {cancellation_polls} polls",
            inner_bytes.len()
        );
        let partial_path = partial_path.expect("cancellation recorded the partial path");
        assert!(!partial_path.exists());
        fs::write(&partial_path, b"guard released").unwrap();
        assert_eq!(fs::read(&partial_path).unwrap(), b"guard released");
        fs::remove_file(partial_path).unwrap();
        assert!(outer_path.exists());
        assert!(fs::read_dir(&fixture.root)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".curseforge-inner-")));
    }

    #[test]
    fn staged_download_modified_after_verification_is_rejected_before_publication() {
        let mut fixture = Fixture::new();
        let mut plan = fixture.plan(&["mods/new.jar"]);
        plan.source_pin = ProviderPin {
            source: ProviderSource::Modrinth,
            exact: ExactPackPin::ModrinthLocalArchive {
                display_version_id: "display-only".into(),
                archive: ArchiveFingerprint {
                    hashes: ContentHashes {
                        sha1: "a".repeat(40),
                        sha512: "b".repeat(128),
                    },
                    size_bytes: 10,
                    verification: ArchiveVerification::CalculatedFingerprint,
                },
            },
        };
        let (mut payload, loader) = fixture.stage(&plan, &[("mods/new.jar", b"verified-content")]);
        let expected = download::hash_regular_file(
            &fixture.staging.join("mods/new.jar"),
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        )
        .unwrap();
        payload.files[0].source_host = Some("cdn.modrinth.com".into());
        payload.verified_downloads.push(VerifiedDownload {
            path: "mods/new.jar".into(),
            expected_size_bytes: expected.0,
            expected_hashes: expected.1.clone(),
            size_bytes: expected.0,
            hashes: expected.1,
            source_host: "cdn.modrinth.com".into(),
        });
        let tampered = b"tampered-after-verification";
        fs::write(fixture.staging.join("mods/new.jar"), tampered).unwrap();
        let staged = download::hash_regular_file(
            &fixture.staging.join("mods/new.jar"),
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        )
        .unwrap();
        payload.files[0].size_bytes = staged.0;
        payload.files[0].hashes = staged.1;

        let result = fixture.publish(&plan, &payload, &loader, &HashSet::new(), None);
        assert!(
            matches!(result, Err(PipelineTransactionError::Invalid(message)) if message.contains("provider-declared size or hashes"))
        );
        assert!(!fixture.target.join("mods/new.jar").exists());
        assert_eq!(fixture.managed_count(), 0);
    }

    #[test]
    fn same_size_loader_runtime_tampering_is_rejected_before_publication() {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&[]);
        let (payload, loader) = fixture.stage(&plan, &[]);
        let loader_path = fixture.staging.join("server.jar");
        let mut tampered = fs::read(&loader_path).unwrap();
        tampered[0] ^= 1;
        fs::write(&loader_path, &tampered).unwrap();
        assert_eq!(
            fs::metadata(&loader_path).unwrap().len(),
            loader.required_files[0].size_bytes
        );

        let result = fixture.publish(&plan, &payload, &loader, &HashSet::new(), None);

        assert!(result.is_err(), "same-size loader tampering must fail");
        assert!(!fixture.target.join("server.jar").exists());
        assert_eq!(fs::read(loader_path).unwrap(), tampered);
        assert_eq!(fixture.managed_count(), 0);
    }

    #[test]
    fn manager_artifact_backups_restore_prior_bytes_after_database_fault() {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&["mods/new.jar"]);
        let (payload, loader) = fixture.stage(&plan, &[("mods/new.jar", b"new-payload")]);

        let old_plan = b"prior install plan";
        let old_report = b"prior install report";
        fs::write(fixture.target.join(INSTALL_PLAN_FILE), old_plan).unwrap();
        fs::write(fixture.target.join(INSTALL_REPORT_FILE), old_report).unwrap();
        let canonical_root = fs::canonicalize(&fixture.app_data).unwrap();
        let old_manifest = ManagedFilesManifest::new("server-test", &canonical_root);
        let old_manifest_bytes = encode_json(&old_manifest).unwrap();
        fs::write(fixture.target.join(MANAGED_FILES_FILE), &old_manifest_bytes).unwrap();

        let result = fixture.publish(
            &plan,
            &payload,
            &loader,
            &HashSet::new(),
            Some(PublicationFault::BeforeDatabaseCommit),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read(fixture.target.join(INSTALL_PLAN_FILE)).unwrap(),
            old_plan
        );
        assert_eq!(
            fs::read(fixture.target.join(INSTALL_REPORT_FILE)).unwrap(),
            old_report
        );
        assert_eq!(
            fs::read(fixture.target.join(MANAGED_FILES_FILE)).unwrap(),
            old_manifest_bytes
        );
        assert!(!fixture.target.join("mods/new.jar").exists());
        assert_eq!(fixture.managed_count(), 0);
    }

    #[test]
    fn protected_pack_paths_are_rejected_without_touching_world_or_eula() {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&["world/level.dat"]);
        let (payload, loader) = fixture.stage(&plan, &[("world/level.dat", b"pack-world")]);
        let result = fixture.publish(&plan, &payload, &loader, &HashSet::new(), None);
        assert!(result.is_err());
        assert_eq!(
            fs::read(fixture.target.join("world/level.dat")).unwrap(),
            b"world-preserved"
        );
        assert_eq!(
            fs::read(fixture.target.join("eula.txt")).unwrap(),
            b"eula=false\n"
        );
    }

    #[test]
    fn filesystem_fault_rolls_back_published_file_moves() {
        let mut fixture = Fixture::new();
        let plan = fixture.plan(&["mods/untracked.jar"]);
        let (payload, loader) = fixture.stage(&plan, &[("mods/untracked.jar", b"replacement")]);
        let approvals = HashSet::from(["mods/untracked.jar".to_string()]);
        let result = fixture.publish(
            &plan,
            &payload,
            &loader,
            &approvals,
            Some(PublicationFault::AfterFirstMutation),
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read(fixture.target.join("mods/untracked.jar")).unwrap(),
            b"user-mod"
        );
        assert_eq!(
            fs::read(fixture.staging.join("mods/untracked.jar")).unwrap(),
            b"replacement"
        );
        assert_eq!(fixture.managed_count(), 0);
    }

    #[test]
    fn rollback_refuses_intermediate_reparse_and_records_recovery_evidence() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("rollback-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("new.jar"), b"outside-data").unwrap();
        fs::remove_dir_all(fixture.target.join("mods")).unwrap();
        let link = fixture.target.join("mods");
        if let Err(error) = std::os::windows::fs::symlink_dir(&outside, &link) {
            if matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
            ) {
                eprintln!("skipping intermediate-reparse rollback fixture: {error}");
                return;
            }
            panic!("could not create isolated reparse fixture: {error}");
        }
        let staged = fixture.staging.join("mods/new.jar");
        fs::create_dir_all(staged.parent().unwrap()).unwrap();
        fs::write(&staged, b"staged-data").unwrap();
        let mut journal = PublicationJournal::new(
            &fs::canonicalize(&fixture.app_data).unwrap(),
            &fixture.target,
            &fixture.staging,
        );
        journal.entries.push(JournalEntry {
            target: fixture.target.join("mods/new.jar"),
            staged_source: Some(staged.clone()),
            backup: None,
            backup_location: None,
            backup_expected_size: None,
            backup_expected_hashes: None,
            target_had_original: false,
            target_has_new_file: true,
        });
        let plan = fixture.plan(&[]);
        let mut report = InstallReport::preparing(&plan);

        journal.rollback(&mut report);

        assert_eq!(fs::read(outside.join("new.jar")).unwrap(), b"outside-data");
        assert_eq!(fs::read(&staged).unwrap(), b"staged-data");
        assert!(report
            .errors
            .iter()
            .any(|error| error.contains("reparse point")));
        assert!(report
            .stages
            .iter()
            .any(|stage| stage.stage == "rollback" && stage.outcome == "incomplete"));
        write_stage_json(&fixture.staging, INSTALL_REPORT_FILE, &report).unwrap();
        let persisted: InstallReport =
            serde_json::from_slice(&fs::read(fixture.staging.join(INSTALL_REPORT_FILE)).unwrap())
                .unwrap();
        assert!(persisted
            .errors
            .iter()
            .any(|error| error.contains("reparse point")));
    }

    #[test]
    fn database_fault_rolls_back_registry_rows_and_filesystem_moves() {
        let mut fixture = Fixture::new();
        let original_launch_config = b"previous launch config audit bytes";
        fs::write(
            fixture.target.join(LAUNCH_CONFIG_FILE),
            original_launch_config,
        )
        .unwrap();
        let plan = fixture.plan(&["mods/new.jar"]);
        let (payload, loader) = fixture.stage(&plan, &[("mods/new.jar", b"new")]);
        let result = fixture.publish(
            &plan,
            &payload,
            &loader,
            &HashSet::new(),
            Some(PublicationFault::BeforeDatabaseCommit),
        );
        assert!(result.is_err());
        assert_eq!(fixture.managed_count(), 0);
        assert!(!fixture.target.join("mods/new.jar").exists());
        assert_eq!(
            fs::read(fixture.target.join(LAUNCH_CONFIG_FILE)).unwrap(),
            original_launch_config
        );
        assert_eq!(
            fs::read(fixture.staging.join("mods/new.jar")).unwrap(),
            b"new"
        );
    }

    #[test]
    fn backup_retention_removes_only_verified_pipeline_backups_and_keeps_two() {
        let fixture = Fixture::new();
        let backup_root = fixture.target.join(BACKUP_ROOT);
        fs::create_dir_all(&backup_root).unwrap();
        for number in 1..=3 {
            let id = format!("install-test-{number}");
            let directory = backup_root.join(&id);
            fs::create_dir_all(directory.join("mods")).unwrap();
            let bytes = format!("backup-{number}").into_bytes();
            fs::write(directory.join("mods/file.jar"), &bytes).unwrap();
            let file_path = directory.join("mods/file.jar");
            let (size_bytes, hashes) = download::hash_regular_file(
                &file_path,
                &AtomicBool::new(false),
                &AtomicBool::new(false),
            )
            .unwrap();
            let manifest = BackupManifest {
                schema_version: 1,
                kind: "modpack-install-backup".into(),
                backup_id: id,
                server_id: "server-test".into(),
                plan_id: "test-plan".into(),
                created_at: format!("2026-10-12T00:00:0{number}Z"),
                files: vec![BackupFile {
                    relative_path: "mods/file.jar".into(),
                    size_bytes,
                    hashes,
                }],
            };
            fs::write(
                directory.join(BACKUP_MARKER),
                encode_json(&manifest).unwrap(),
            )
            .unwrap();
        }
        let user_backup = backup_root.join("install-user-owned");
        fs::create_dir_all(&user_backup).unwrap();
        fs::write(user_backup.join("keep.txt"), b"user").unwrap();
        let canonical_root = fs::canonicalize(&fixture.app_data).unwrap();
        let canonical_target = fs::canonicalize(&fixture.target).unwrap();
        prune_successful_backups(&canonical_root, &canonical_target, "server-test", 2);
        assert!(!backup_root.join("install-test-1").exists());
        assert!(backup_root.join("install-test-2").exists());
        assert!(backup_root.join("install-test-3").exists());
        assert_eq!(fs::read(user_backup.join("keep.txt")).unwrap(), b"user");
    }

    #[test]
    fn mrpack_overrides_apply_shared_then_server_and_never_execute_pack_scripts() {
        let fixture = Fixture::new();
        let plan = fixture.plan(&[]);
        let (payload, loader) = fixture.stage(&plan, &[]);
        let archive_path = fixture.root.join("source.mrpack");
        let mut writer = ZipWriter::new(File::create(&archive_path).unwrap());
        for (name, content) in [
            ("overrides/config/setting.txt", b"shared".as_slice()),
            ("server-overrides/config/setting.txt", b"server".as_slice()),
            (
                "client-overrides/config/client.txt",
                b"client-only".as_slice(),
            ),
            ("overrides/start.bat", b"echo must not execute".as_slice()),
        ] {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
        let snapshot =
            snapshot_archive_with_cancel(&archive_path, MAX_ARCHIVE_BYTES, |_| false).unwrap();
        fs::write(&archive_path, b"replacement bytes after guarded snapshot").unwrap();
        let applied = extract_mrpack_overrides(
            &snapshot,
            &fixture.staging,
            &loader,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(applied
            .iter()
            .any(|(path, origin)| path == "config/setting.txt"
                && *origin == PayloadFileOrigin::ServerOverride));
        assert!(applied
            .iter()
            .any(|(path, origin)| path == "start.bat"
                && *origin == PayloadFileOrigin::SharedOverride));
        assert_eq!(
            fs::read(fixture.staging.join("config/setting.txt")).unwrap(),
            b"server"
        );
        assert_eq!(
            fs::read(fixture.staging.join("start.bat")).unwrap(),
            b"echo must not execute"
        );
        assert!(!fixture.staging.join("config/client.txt").exists());
        assert_eq!(payload.plan_id, plan.plan_id);
    }

    #[test]
    fn mrpack_overrides_reject_protected_and_case_aliased_paths() {
        let fixture = Fixture::new();
        let plan = fixture.plan(&[]);
        let (_payload, loader) = fixture.stage(&plan, &[]);
        let archive_path = fixture.root.join("protected.mrpack");
        let mut writer = ZipWriter::new(File::create(&archive_path).unwrap());
        writer
            .start_file("overrides/world/level.dat", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"must reject").unwrap();
        writer.finish().unwrap();
        let protected_snapshot =
            snapshot_archive_with_cancel(&archive_path, MAX_ARCHIVE_BYTES, |_| false).unwrap();
        assert!(extract_mrpack_overrides(
            &protected_snapshot,
            &fixture.staging,
            &loader,
            &AtomicBool::new(false)
        )
        .is_err());

        let alias_path = fixture.root.join("aliases.mrpack");
        let mut writer = ZipWriter::new(File::create(&alias_path).unwrap());
        for name in [
            "overrides/config/Setting.txt",
            "overrides/config/setting.txt",
        ] {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"alias").unwrap();
        }
        writer.finish().unwrap();
        let alias_snapshot =
            snapshot_archive_with_cancel(&alias_path, MAX_ARCHIVE_BYTES, |_| false).unwrap();
        assert!(extract_mrpack_overrides(
            &alias_snapshot,
            &fixture.staging,
            &loader,
            &AtomicBool::new(false)
        )
        .is_err());
    }
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), PipelineTransactionError> {
    let mut output = OpenOptions::new().write(true).create_new(true).open(path)?;
    output.write_all(bytes)?;
    output.flush()?;
    output.sync_all()?;
    Ok(())
}

fn validate_all_targets_still_bound(
    canonical_root: &Path,
    target_root: &Path,
    staging: &Path,
    plan: &InstallPlan,
) -> Result<(), PipelineTransactionError> {
    let current_app = fs::canonicalize(canonical_root)?;
    let expected_target = server_directory(&current_app, &plan.target.server_id);
    let current_target = fs::canonicalize(target_root)?;
    let current_staging = fs::canonicalize(staging)?;
    let expected_staging_root = current_app.join("installer-staging");
    if current_app != canonical_root
        || current_target != expected_target
        || !current_target.starts_with(current_app.join("servers"))
        || !current_staging.starts_with(expected_staging_root)
    {
        return Err(PipelineTransactionError::Invalid(
            "app-data, staging, or server target changed during publication".into(),
        ));
    }
    let target_meta = fs::symlink_metadata(target_root)?;
    let stage_meta = fs::symlink_metadata(staging)?;
    if !target_meta.is_dir()
        || is_reparse_point(&target_meta)
        || !stage_meta.is_dir()
        || is_reparse_point(&stage_meta)
    {
        return Err(PipelineTransactionError::Invalid(
            "server target or staging became a reparse point during publication".into(),
        ));
    }
    Ok(())
}
