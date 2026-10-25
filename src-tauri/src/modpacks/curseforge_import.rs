//! CurseForge's manual website + server-pack ZIP workflow.
//!
//! This module intentionally has no CurseForge API client. It only stages
//! user-selected archives and validates local ZIP contents.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zip::ZipArchive;

use crate::{
    error::AppError,
    modpacks::install::{self, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES, MAX_MRPACK_BYTES},
};

const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const IMPORT_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;
const BASE_RUNTIME_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_INSPECTED_TEXT_BYTES: u64 = 256 * 1024;
const MAX_DOWNLOAD_ERROR_PREFIX_BYTES: usize = 1024;
#[cfg(windows)]
const INNER_ARCHIVE_FILE_SHARE: u32 = 0x0000_0001;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedZip {
    pub name: String,
    pub size: u64,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveInspection {
    pub name: String,
    pub classification: ArchiveClassification,
    pub reason: String,
    pub minecraft_version: Option<String>,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ArchiveClassification {
    SupportedServerPack,
    ClientExport,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DetectedServerPack {
    pub minecraft_version: String,
    pub loader: String,
    pub loader_version: String,
    pub runtime_root: String,
    pub legacy_forge: bool,
    pub server_pack_creator: bool,
    pub argument_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClassifiedServerPack {
    pub detected: DetectedServerPack,
    pub files: Vec<String>,
}

pub(crate) enum ArchiveContentClassification {
    ServerPack(ClassifiedServerPack),
    ClientExport(String),
    Unsupported(String),
    Invalid(String),
}

#[derive(Debug, Clone)]
struct ArchiveEntryPlan {
    index: usize,
    relative_name: String,
    is_dir: bool,
    size: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct ArchivePlan {
    entries: Vec<ArchiveEntryPlan>,
    pub(crate) expanded_bytes: u64,
}

pub(crate) struct PreparedServerPackArchive {
    pub(crate) path: PathBuf,
    pub(crate) plan: ArchivePlan,
    _temporary: Option<TemporaryArchive>,
}

#[derive(Debug)]
pub(crate) enum PreparedArchiveError {
    App(AppError),
    Cancelled,
}

impl From<AppError> for PreparedArchiveError {
    fn from(error: AppError) -> Self {
        Self::App(error)
    }
}

impl From<std::io::Error> for PreparedArchiveError {
    fn from(error: std::io::Error) -> Self {
        Self::App(AppError::from(error))
    }
}

struct TemporaryArchive {
    path: PathBuf,
    file: Option<File>,
}

impl TemporaryArchive {
    fn create(path: PathBuf) -> Result<Self, AppError> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(INNER_ARCHIVE_FILE_SHARE);
        }
        let file = options.open(&path)?;
        Ok(Self {
            path,
            file: Some(file),
        })
    }
}

impl Drop for TemporaryArchive {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) fn ensure_import_dir(app_data: &Path) -> Result<PathBuf, AppError> {
    let root_metadata = fs::symlink_metadata(app_data)?;
    if !root_metadata.file_type().is_dir() || is_reparse_point(&root_metadata) {
        return Err(validation("app-data root is not a real directory"));
    }
    let imports = app_data.join("imports");
    ensure_real_directory(&imports)?;
    let directory = imports.join("curseforge");
    ensure_real_directory(&directory)?;
    let canonical_root = fs::canonicalize(app_data)?;
    if !fs::canonicalize(&directory)?.starts_with(&canonical_root) {
        return Err(validation("CurseForge import staging escapes app data"));
    }
    Ok(directory)
}

fn ensure_real_directory(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !is_reparse_point(&metadata) => Ok(()),
        Ok(_) => Err(validation(
            "CurseForge import staging contains a symlink or reparse point",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path)?;
            let metadata = fs::symlink_metadata(path)?;
            if metadata.file_type().is_dir() && !is_reparse_point(&metadata) {
                Ok(())
            } else {
                Err(validation(
                    "CurseForge import staging contains a symlink or reparse point",
                ))
            }
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn staged_zip_path(app_data: &Path, name: &str) -> Result<PathBuf, AppError> {
    let directory = ensure_import_dir(app_data)?;
    let candidate = Path::new(name);
    if candidate.components().count() != 1
        || candidate.file_name().is_none()
        || candidate.file_name().unwrap().to_string_lossy() != name
        || !candidate
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err(validation(
            "choose a staged ZIP file by its listed filename",
        ));
    }
    let path = directory.join(candidate);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| AppError::NotFound("the selected staged ZIP no longer exists".into()))?;
    if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
        return Err(validation("the selected staged ZIP is not a regular file"));
    }
    Ok(path)
}

pub(crate) fn list_staged_zips(app_data: &Path) -> Result<Vec<StagedZip>, AppError> {
    let directory = ensure_import_dir(app_data)?;
    // Hold the registry lock for the scan and stale-part cleanup. Copy/download
    // writers register before creating their `.part` file, so Refresh cannot
    // snapshot the registry and then delete a newly-created active file.
    let active_part_names = active_part_registry()
        .lock()
        .map_err(|_| AppError::Internal("staging registry lock poisoned".into()))?;
    let mut zips = Vec::new();
    for item in fs::read_dir(&directory)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        let path = item.path();
        let metadata = fs::symlink_metadata(&path)?;
        if name.starts_with('.') || !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            continue;
        }
        if name.ends_with(".part") {
            if !active_part_names.contains(&name) {
                let _ = fs::remove_file(&path);
            }
            continue;
        }
        if !Path::new(&name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        {
            continue;
        }
        zips.push(StagedZip {
            name,
            size: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs()),
        });
    }
    zips.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(zips)
}

pub(crate) async fn pick_and_stage_zip(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<StagedZip>, AppError> {
    require_main_window(&window)?;
    let picker_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter("ZIP archives", &["zip"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| AppError::Internal(format!("ZIP picker task failed: {error}")))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let source = selected
        .into_path()
        .map_err(|error| validation(format!("could not read the selected ZIP path: {error}")))?;
    let app_data = crate::util::paths::app_data_dir(&app)?;
    let copied = copy_external_zip(&app_data, &source)?;
    Ok(Some(copied))
}

pub(crate) fn copy_external_zip(app_data: &Path, source: &Path) -> Result<StagedZip, AppError> {
    copy_external_zip_with_part_hook(app_data, source, |_| {})
}

fn copy_external_zip_with_part_hook(
    app_data: &Path,
    source: &Path,
    after_part_created: impl FnOnce(&Path),
) -> Result<StagedZip, AppError> {
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|_| AppError::NotFound("the selected ZIP file could not be found".into()))?;
    if !source_metadata.file_type().is_file() || is_reparse_point(&source_metadata) {
        return Err(validation(
            "select a regular ZIP file, not a folder or link",
        ));
    }
    if source_metadata.len() > MAX_MRPACK_BYTES {
        return Err(validation("ZIP exceeds the 2 GiB import limit"));
    }
    if !source
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err(validation("select a file with a .zip extension"));
    }

    let directory = ensure_import_dir(app_data)?;
    let needed_space = source_metadata.len().saturating_add(IMPORT_HEADROOM_BYTES);
    if crate::java::free_disk_space(&directory)? < needed_space {
        return Err(validation(
            "not enough free disk space to copy this ZIP into managed staging",
        ));
    }
    let suggested = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("curseforge-server-pack.zip");
    let final_name = unique_zip_name(&directory, suggested);
    let part_name = format!("{final_name}.{}.part", uuid::Uuid::new_v4());
    let part_path = directory.join(&part_name);
    let mut source_file = File::open(source)?;
    let _part_registration = ActivePartRegistration::new(&part_name);
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part_path)?;
    after_part_created(&part_path);
    let copied = match std::io::copy(
        &mut Read::by_ref(&mut source_file).take(MAX_MRPACK_BYTES + 1),
        &mut destination_file,
    ) {
        Ok(size) if size <= MAX_MRPACK_BYTES => size,
        Ok(_) => {
            drop(destination_file);
            let _ = fs::remove_file(&part_path);
            return Err(validation("ZIP exceeds the 2 GiB import limit"));
        }
        Err(error) => {
            drop(destination_file);
            let _ = fs::remove_file(&part_path);
            return Err(error.into());
        }
    };
    if let Err(error) = destination_file.flush() {
        drop(destination_file);
        let _ = fs::remove_file(&part_path);
        return Err(error.into());
    }
    drop(destination_file);
    let metadata = match fs::symlink_metadata(&part_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(&part_path);
            return Err(error.into());
        }
    };
    if copied != source_metadata.len()
        || !metadata.file_type().is_file()
        || is_reparse_point(&metadata)
    {
        let _ = fs::remove_file(&part_path);
        return Err(validation("the ZIP changed while it was being copied"));
    }
    let final_path = directory.join(&final_name);
    if let Err(error) = fs::hard_link(&part_path, &final_path) {
        let _ = fs::remove_file(&part_path);
        return Err(AppError::Io(format!(
            "could not safely publish the copied ZIP without overwriting an existing file: {error}"
        )));
    }
    fs::remove_file(&part_path)?;
    let metadata = fs::symlink_metadata(&final_path)?;
    Ok(StagedZip {
        name: final_name,
        size: copied,
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs()),
    })
}

pub(crate) fn inspect_staged_zip(app_data: &Path, name: &str) -> ArchiveInspection {
    let path = match staged_zip_path(app_data, name) {
        Ok(path) => path,
        Err(error) => return unsupported(name, error.to_string()),
    };
    let outer_plan = match build_archive_plan(&path) {
        Ok(plan) => plan,
        Err(error) => return unsupported(name, error.to_string()),
    };
    let prepared = match prepare_server_pack_archive(&path, outer_plan) {
        Ok(prepared) => prepared,
        Err(error) => return unsupported(name, error.to_string()),
    };
    let plan = &prepared.plan;
    if let Some(reason) = detect_client_export(&prepared.path, plan) {
        return ArchiveInspection {
            name: name.to_string(),
            classification: ArchiveClassification::ClientExport,
            reason,
            minecraft_version: None,
            loader: None,
            loader_version: None,
        };
    }
    let pack = match detect_server_pack(&prepared.path, plan) {
        Ok(pack) => pack,
        Err(reason) => return unsupported(name, reason),
    };
    let runtime_reserve = if pack.server_pack_creator {
        BASE_RUNTIME_RESERVE_BYTES
    } else {
        0
    };
    let required_space = plan
        .expanded_bytes
        .saturating_add(runtime_reserve)
        .saturating_add(IMPORT_HEADROOM_BYTES);
    let space_dir = match staged_file_space_dir(&path) {
        Some(dir) => dir,
        None => {
            return unsupported(
                name,
                format!(
                    "could not check free disk space for '{}': no containing directory",
                    path.display()
                ),
            )
        }
    };
    if let Err(error) = crate::java::free_disk_space(space_dir).and_then(|available| {
        if available >= required_space {
            Ok(available)
        } else {
            Err(validation(format!(
                "not enough free disk space to safely install this archive (need {required_space} bytes, have {available})"
            )))
        }
    }) {
        return unsupported(name, error.to_string());
    }
    if let Err(error) = crate::installer::verify_import_loader_build(
        &pack.minecraft_version,
        &pack.loader,
        &pack.loader_version,
    ) {
        return ArchiveInspection {
            name: name.to_string(),
            classification: ArchiveClassification::Unsupported,
            reason: format!(
                "{}; current official loader metadata could not verify this build",
                error
            ),
            minecraft_version: Some(pack.minecraft_version),
            loader: Some(pack.loader),
            loader_version: Some(pack.loader_version),
        };
    }
    ArchiveInspection {
        name: name.to_string(),
        classification: ArchiveClassification::SupportedServerPack,
        reason: if pack.server_pack_creator {
            "ServerPackCreator metadata identifies a Fabric server pack and its exact loader build is listed by official metadata.".into()
        } else {
            "Forge/NeoForge runtime markers are consistent and the exact loader build is listed by official metadata.".into()
        },
        minecraft_version: Some(pack.minecraft_version),
        loader: Some(pack.loader),
        loader_version: Some(pack.loader_version),
    }
}

pub(crate) fn prepare_server_pack_archive(
    path: &Path,
    outer_plan: ArchivePlan,
) -> Result<PreparedServerPackArchive, AppError> {
    prepare_server_pack_archive_with_cancel(path, outer_plan, |_| false).map_err(
        |error| match error {
            PreparedArchiveError::App(error) => error,
            PreparedArchiveError::Cancelled => {
                validation("server archive preparation was cancelled")
            }
        },
    )
}

pub(crate) fn prepare_server_pack_archive_with_cancel<F>(
    path: &Path,
    outer_plan: ArchivePlan,
    mut is_cancelled: F,
) -> Result<PreparedServerPackArchive, PreparedArchiveError>
where
    F: FnMut(u64) -> bool,
{
    check_prepared_archive_cancelled(&mut is_cancelled, 0)?;
    let files = outer_plan
        .entries
        .iter()
        .filter(|entry| !entry.is_dir)
        .collect::<Vec<_>>();
    if files.len() != 1
        || !Path::new(&files[0].relative_name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        check_prepared_archive_cancelled(&mut is_cancelled, 0)?;
        return Ok(PreparedServerPackArchive {
            path: path.to_path_buf(),
            plan: outer_plan,
            _temporary: None,
        });
    }

    let nested = (*files[0]).clone();
    prepare_archive_from_single_file_with_cancel(path, nested, &mut is_cancelled)
}

fn prepare_single_file_archive_candidate_with_cancel<F>(
    path: &Path,
    outer_plan: ArchivePlan,
    is_cancelled: &mut F,
) -> Result<Option<PreparedServerPackArchive>, PreparedArchiveError>
where
    F: FnMut(u64) -> bool,
{
    let files = outer_plan
        .entries
        .iter()
        .filter(|entry| !entry.is_dir)
        .collect::<Vec<_>>();
    if files.len() != 1 {
        return Ok(None);
    }
    let nested = (*files[0]).clone();
    prepare_archive_from_single_file_with_cancel(path, nested, is_cancelled).map(Some)
}

fn prepare_archive_from_single_file_with_cancel<F>(
    path: &Path,
    nested: ArchiveEntryPlan,
    is_cancelled: &mut F,
) -> Result<PreparedServerPackArchive, PreparedArchiveError>
where
    F: FnMut(u64) -> bool,
{
    if nested.size == 0 || nested.size > MAX_MRPACK_BYTES {
        return Err(validation(
            "the single nested server ZIP is empty or exceeds the 2 GiB compressed-size limit",
        )
        .into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| validation("the outer ZIP has no containing directory"))?;
    let required_temp_space = nested
        .size
        .checked_add(IMPORT_HEADROOM_BYTES)
        .ok_or_else(|| validation("nested ZIP disk estimate overflowed"))?;
    let available_temp_space = crate::java::free_disk_space(parent)?;
    if available_temp_space < required_temp_space {
        return Err(validation(format!(
            "not enough free disk space to safely unwrap the nested ZIP (need {required_temp_space} bytes, have {available_temp_space})"
        ))
        .into());
    }
    let temporary_path = parent.join(format!(".curseforge-inner-{}.zip", uuid::Uuid::new_v4()));
    let mut temporary = TemporaryArchive::create(temporary_path.clone())?;
    let mut archive = ZipArchive::new(File::open(path)?)
        .map_err(|_| validation("selected file is not a readable outer ZIP archive"))?;
    let mut source = archive
        .by_index(nested.index)
        .map_err(|_| validation("the nested server ZIP could not be opened"))?;
    if source.is_symlink() || source.is_dir() || source.size() != nested.size {
        return Err(validation("the nested server ZIP changed or is not a regular file").into());
    }
    let destination = temporary
        .file
        .as_mut()
        .expect("nested ZIP output remains open while materializing");
    let copied =
        copy_nested_archive_with_cancel(&mut source, destination, nested.size, is_cancelled)?;
    destination.flush()?;
    destination.sync_all()?;
    if copied != nested.size || copied > MAX_MRPACK_BYTES {
        return Err(validation("the nested server ZIP exceeded its validated size bound").into());
    }
    check_prepared_archive_cancelled(is_cancelled, 0)?;
    // Keep the write handle open with write/delete sharing denied while the
    // archive plan is built and for the caller's classification/extraction.
    let plan = build_archive_plan(&temporary_path)?;
    check_prepared_archive_cancelled(is_cancelled, 0)?;
    Ok(PreparedServerPackArchive {
        path: temporary_path,
        plan,
        _temporary: Some(temporary),
    })
}

fn copy_nested_archive_with_cancel<R, F>(
    source: &mut R,
    destination: &mut File,
    expected_size: u64,
    is_cancelled: &mut F,
) -> Result<u64, PreparedArchiveError>
where
    R: Read,
    F: FnMut(u64) -> bool,
{
    let mut copied = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        check_prepared_archive_cancelled(is_cancelled, copied)?;
        let remaining_with_probe = expected_size.saturating_sub(copied).saturating_add(1);
        let read_limit = remaining_with_probe.min(buffer.len() as u64) as usize;
        let read = Read::by_ref(source)
            .take(read_limit as u64)
            .read(&mut buffer[..read_limit])?;
        if read == 0 {
            break;
        }
        check_prepared_archive_cancelled(is_cancelled, copied)?;
        let next_copied = copied
            .checked_add(read as u64)
            .filter(|size| *size <= expected_size && *size <= MAX_MRPACK_BYTES)
            .ok_or_else(|| validation("the nested server ZIP exceeded its validated size bound"))?;
        destination.write_all(&buffer[..read])?;
        copied = next_copied;
        check_prepared_archive_cancelled(is_cancelled, copied)?;
    }
    if copied != expected_size {
        return Err(validation(
            "the nested server ZIP size differs from its declared archive entry size",
        )
        .into());
    }
    Ok(copied)
}

fn check_prepared_archive_cancelled<F>(
    is_cancelled: &mut F,
    copied_bytes: u64,
) -> Result<(), PreparedArchiveError>
where
    F: FnMut(u64) -> bool,
{
    if is_cancelled(copied_bytes) {
        Err(PreparedArchiveError::Cancelled)
    } else {
        Ok(())
    }
}

pub(crate) fn build_archive_plan(path: &Path) -> Result<ArchivePlan, AppError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
        return Err(validation("selected ZIP is not a regular file"));
    }
    if metadata.len() > MAX_MRPACK_BYTES {
        return Err(validation("ZIP exceeds the 2 GiB compressed-size limit"));
    }
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| validation("selected file is not a readable ZIP archive"))?;
    if archive.len() == 0 || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(validation(
            "ZIP entry count is empty or exceeds 100,000 entries",
        ));
    }

    let mut entries = Vec::with_capacity(archive.len());
    let mut expanded_bytes = 0u64;
    let mut normalized = HashMap::<String, bool>::new();
    let mut files = HashSet::<String>::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| validation("ZIP central directory contains an unreadable entry"))?;
        if entry.is_symlink() {
            return Err(validation("ZIP contains a symbolic-link entry"));
        }
        let raw_name = entry.name().to_string();
        let is_dir = entry.is_dir();
        let relative_name = install::validate_relative_path(&raw_name, is_dir)?;
        if relative_name.len() > 240 {
            return Err(validation(
                "ZIP contains a path too long for reliable Windows installation",
            ));
        }
        let size = entry.size();
        if !is_dir {
            if size > MAX_ENTRY_BYTES {
                return Err(validation(
                    "ZIP contains a file larger than the 4 GiB per-file limit",
                ));
            }
            expanded_bytes = expanded_bytes
                .checked_add(size)
                .ok_or_else(|| validation("ZIP expanded size overflowed the supported range"))?;
            if expanded_bytes > MAX_EXPANDED_BYTES {
                return Err(validation("ZIP exceeds the 20 GiB expanded-size limit"));
            }
            files.insert(relative_name.to_ascii_lowercase());
        }
        let normalized_name = relative_name.to_ascii_lowercase();
        if let Some(previous_is_dir) = normalized.insert(normalized_name, is_dir) {
            if previous_is_dir != is_dir || !is_dir {
                return Err(validation(
                    "ZIP contains duplicate or conflicting destination paths",
                ));
            }
        }
        entries.push(ArchiveEntryPlan {
            index,
            relative_name,
            is_dir,
            size,
        });
    }
    for file in &files {
        if normalized
            .keys()
            .any(|path| path.starts_with(&format!("{file}/")))
        {
            return Err(validation("ZIP file path conflicts with a directory entry"));
        }
    }

    let _ = (&mut archive, files);
    Ok(ArchivePlan {
        entries,
        expanded_bytes,
    })
}

fn unsupported(name: &str, reason: String) -> ArchiveInspection {
    ArchiveInspection {
        name: name.to_string(),
        classification: ArchiveClassification::Unsupported,
        reason,
        minecraft_version: None,
        loader: None,
        loader_version: None,
    }
}

fn validation(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// Containing directory to query for staged-file free-space preflights.
/// `GetDiskFreeSpaceExW` requires a directory; passing the staged file leaf
/// surfaces ERROR_DIRECTORY 267 on Unicode names (e.g. TM U+2122).
/// Returns `None` when there is no parent so callers fail closed.
fn staged_file_space_dir(path: &Path) -> Option<&Path> {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Some(parent),
        _ => None,
    }
}

fn unique_zip_name(directory: &Path, suggested: &str) -> String {
    let (stem, extension) = Path::new(suggested)
        .file_stem()
        .and_then(|value| value.to_str())
        .zip(
            Path::new(suggested)
                .extension()
                .and_then(|value| value.to_str()),
        )
        .filter(|(_, extension)| extension.eq_ignore_ascii_case("zip"))
        .unwrap_or(("curseforge-server-pack", "zip"));
    let stem = sanitize_filename(stem);
    for index in 0u32.. {
        let candidate = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        if !directory.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!("u32 filename suffix space exhausted")
}

fn sanitize_filename(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(180));
    for character in value.chars() {
        if character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        {
            output.push('_');
        } else {
            output.push(character);
        }
        if output.len() >= 180 {
            break;
        }
    }
    let output = output.trim().trim_end_matches([' ', '.']);
    if output.is_empty() {
        "curseforge-server-pack".into()
    } else {
        output.into()
    }
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn require_main_window(window: &WebviewWindow) -> Result<(), AppError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(validation(
            "CurseForge import commands are available only from the main app window",
        ))
    }
}

enum ClientExportManifestStatus {
    Missing,
    ClientExport(String),
    Unsupported(String),
    Malformed(String),
}

fn inspect_client_export_manifest(path: &Path, plan: &ArchivePlan) -> ClientExportManifestStatus {
    let root = common_root(plan).unwrap_or_default();
    let manifest_path = join_root(&root, "manifest.json");
    let Some(manifest_index) = plan
        .entries
        .iter()
        .find(|entry| !entry.is_dir && entry.relative_name == manifest_path)
        .map(|entry| entry.index)
    else {
        return ClientExportManifestStatus::Missing;
    };
    let manifest = match read_entry_text(path, manifest_index) {
        Ok(manifest) => manifest,
        Err(error) => {
            return ClientExportManifestStatus::Malformed(format!(
                "CurseForge manifest.json cannot be read: {error}"
            ));
        }
    };
    let value: Value = match serde_json::from_str(&manifest) {
        Ok(value) => value,
        Err(_) => {
            return ClientExportManifestStatus::Malformed(
                "CurseForge manifest.json is not valid JSON".into(),
            );
        }
    };
    if value.get("manifestType").and_then(Value::as_str) != Some("minecraftModpack")
        || value.get("manifestVersion").and_then(Value::as_u64) != Some(1)
    {
        return ClientExportManifestStatus::Unsupported(
            "manifest.json is not recognized as a CurseForge client export: it must declare manifestType=minecraftModpack and manifestVersion=1".into(),
        );
    }
    let has_client_export_shape = value.get("minecraft").and_then(Value::as_object).is_some()
        && value.get("files").and_then(Value::as_array).is_some();
    if !has_client_export_shape {
        return ClientExportManifestStatus::Malformed(
            "CurseForge client-export manifest is missing its minecraft object or files array"
                .into(),
        );
    }

    ClientExportManifestStatus::ClientExport(
        "This is a CurseForge client export. Its manifest references remote mod files and cannot be installed directly; return to CurseForge and download the SERVER pack from Additional Files.".into(),
    )
}

fn detect_client_export(path: &Path, plan: &ArchivePlan) -> Option<String> {
    match inspect_client_export_manifest(path, plan) {
        ClientExportManifestStatus::ClientExport(reason) => Some(reason),
        _ => None,
    }
}

pub(crate) fn classify_archive_contents(path: &Path) -> ArchiveContentClassification {
    match classify_archive_contents_with_cancel(path, |_| false) {
        Ok(classification) => classification,
        Err(PreparedArchiveError::App(error)) => {
            ArchiveContentClassification::Invalid(error.to_string())
        }
        Err(PreparedArchiveError::Cancelled) => {
            ArchiveContentClassification::Invalid("server archive preparation was cancelled".into())
        }
    }
}

pub(crate) fn classify_archive_contents_with_cancel<F>(
    path: &Path,
    mut is_cancelled: F,
) -> Result<ArchiveContentClassification, PreparedArchiveError>
where
    F: FnMut(u64) -> bool,
{
    check_prepared_archive_cancelled(&mut is_cancelled, 0)?;
    let outer_plan = match build_archive_plan(path) {
        Ok(plan) => plan,
        Err(error) => return Ok(ArchiveContentClassification::Invalid(error.to_string())),
    };
    let outer_root = common_root(&outer_plan).unwrap_or_default();
    if has_server_files_root(&outer_plan, &outer_root) {
        return Ok(ArchiveContentClassification::Unsupported(
            "generic server_files/ templates are unsupported".into(),
        ));
    }
    let outer_client_manifest = inspect_client_export_manifest(path, &outer_plan);
    if let ClientExportManifestStatus::ClientExport(reason) = &outer_client_manifest {
        return Ok(ArchiveContentClassification::ClientExport(reason.clone()));
    }

    let direct_reason = match detect_server_pack(path, &outer_plan) {
        Ok(pack) => {
            return Ok(ArchiveContentClassification::ServerPack(
                classified_server_pack(pack, &outer_plan),
            ));
        }
        Err(reason) => reason,
    };
    if is_terminal_unsupported_server_pack_reason(&direct_reason)
        && !direct_reason.contains("generic server.jar cannot distinguish")
    {
        return Ok(ArchiveContentClassification::Unsupported(direct_reason));
    }

    match prepare_single_file_archive_candidate_with_cancel(path, outer_plan, &mut is_cancelled) {
        Ok(Some(prepared)) => {
            let nested_root = common_root(&prepared.plan).unwrap_or_default();
            if has_server_files_root(&prepared.plan, &nested_root) {
                return Ok(ArchiveContentClassification::Unsupported(
                    "nested generic server_files/ templates are unsupported".into(),
                ));
            }
            let nested_client_manifest =
                inspect_client_export_manifest(&prepared.path, &prepared.plan);
            if let ClientExportManifestStatus::ClientExport(reason) = nested_client_manifest {
                return Ok(ArchiveContentClassification::ClientExport(reason));
            }
            return Ok(match detect_server_pack(&prepared.path, &prepared.plan) {
                Ok(pack) if pack.server_pack_creator => {
                    ArchiveContentClassification::ServerPack(classified_server_pack(
                        pack,
                        &prepared.plan,
                    ))
                }
                Ok(_) => ArchiveContentClassification::Unsupported(
                    "a single nested archive is supported only when its contents match a validated ServerPackCreator Fabric server pack".into(),
                ),
                Err(reason) if is_unsupported_server_pack_reason(&reason) => {
                    ArchiveContentClassification::Unsupported(format!(
                        "nested archive is not a supported ServerPackCreator Fabric server pack: {reason}"
                    ))
                }
                Err(reason) => ArchiveContentClassification::Invalid(format!(
                    "nested archive failed ServerPackCreator validation: {reason}"
                )),
            });
        }
        Ok(None) => {}
        Err(PreparedArchiveError::App(error)) => {
            let reason = error.to_string();
            if !reason.contains("selected file is not a readable ZIP archive") {
                return Ok(ArchiveContentClassification::Invalid(format!(
                    "single-file wrapper could not be validated: {reason}"
                )));
            }
        }
        Err(PreparedArchiveError::Cancelled) => return Err(PreparedArchiveError::Cancelled),
    }

    Ok(match outer_client_manifest {
        ClientExportManifestStatus::Malformed(reason) => {
            ArchiveContentClassification::Invalid(reason)
        }
        ClientExportManifestStatus::Unsupported(reason)
            if direct_reason
                .contains("archive has no supported Forge or NeoForge server-pack markers") =>
        {
            ArchiveContentClassification::Unsupported(reason)
        }
        ClientExportManifestStatus::Missing
        | ClientExportManifestStatus::ClientExport(_)
        | ClientExportManifestStatus::Unsupported(_) => {
            if is_unsupported_server_pack_reason(&direct_reason) {
                ArchiveContentClassification::Unsupported(direct_reason)
            } else {
                ArchiveContentClassification::Invalid(direct_reason)
            }
        }
    })
}

fn classified_server_pack(pack: DetectedServerPack, plan: &ArchivePlan) -> ClassifiedServerPack {
    let files = plan
        .entries
        .iter()
        .filter(|entry| !entry.is_dir)
        .filter_map(|entry| strip_root(&entry.relative_name, &pack.runtime_root))
        .map(str::to_string)
        .collect();
    ClassifiedServerPack {
        detected: pack,
        files,
    }
}

fn is_unsupported_server_pack_reason(reason: &str) -> bool {
    reason.contains("archive has no supported Forge or NeoForge server-pack markers")
        || reason.contains("generic server.jar cannot distinguish")
        || reason.contains("Quilt imports are unsupported")
        || reason.contains("server packs are unsupported")
        || reason.contains("does not map to a supported Minecraft release")
        || reason.contains("legacy Forge server-pack marker is not Minecraft 1.12.2")
}

fn is_terminal_unsupported_server_pack_reason(reason: &str) -> bool {
    reason.contains("Quilt imports are unsupported")
        || reason.contains("server packs are unsupported")
        || reason.contains("does not map to a supported Minecraft release")
        || reason.contains("legacy Forge server-pack marker is not Minecraft 1.12.2")
}

fn detect_server_pack(path: &Path, plan: &ArchivePlan) -> Result<DetectedServerPack, String> {
    let root = common_root(plan).unwrap_or_default();
    let entries = plan
        .entries
        .iter()
        .filter_map(|entry| {
            strip_root(&entry.relative_name, &root).map(|relative| (entry, relative.to_string()))
        })
        .collect::<Vec<_>>();
    let file_paths = entries
        .iter()
        .filter(|(entry, _)| !entry.is_dir)
        .map(|(_, relative)| relative.as_str())
        .collect::<HashSet<_>>();

    if let Some(pack) = detect_server_pack_creator(path, plan, &root, &entries)? {
        return Ok(pack);
    }

    let forge_args = entries
        .iter()
        .filter_map(|(entry, relative)| {
            forge_version_from_args_path(relative)
                .map(|(mc, build)| (entry, relative.clone(), mc.to_string(), build.to_string()))
        })
        .collect::<Vec<_>>();
    let neo_args = entries
        .iter()
        .filter_map(|(entry, relative)| {
            neoforge_version_from_args_path(relative)
                .map(|version| (entry, relative.clone(), version.to_string()))
        })
        .collect::<Vec<_>>();
    let legacy_forge = entries
        .iter()
        .filter_map(|(entry, relative)| {
            legacy_forge_version(relative).map(|version| (entry, version))
        })
        .collect::<Vec<_>>();

    let signatures = usize::from(!forge_args.is_empty())
        + usize::from(!neo_args.is_empty())
        + usize::from(!legacy_forge.is_empty());
    if signatures > 1 {
        return Err("archive contains mixed Forge/NeoForge runtime markers".into());
    }
    if forge_args.len() == 1 {
        let (marker, marker_path, minecraft_version, forge_build) = &forge_args[0];
        let expected = marker_path.clone();
        let expected_loader_args = expected
            .strip_suffix("/win_args.txt")
            .map(|_| expected.as_str())
            .unwrap_or_default();
        if expected_loader_args.is_empty() {
            return Err("Forge argument-file marker is malformed".into());
        }
        require_nonempty(&entries, "run.bat")?;
        require_nonempty(&entries, "user_jvm_args.txt")?;
        if marker.size == 0 {
            return Err("Forge win_args.txt is empty".into());
        }
        let args_text = read_entry_text(path, marker.index)?;
        validate_launch_payload_jars(&args_text, &entries)?;
        let run_index = entries
            .iter()
            .find(|(_, relative)| relative == "run.bat")
            .map(|(entry, _)| entry.index)
            .ok_or_else(|| "Forge run.bat is missing".to_string())?;
        let run_script = read_entry_text(path, run_index)?;
        crate::servers::process::expected_generated_arg_file(
            &run_script,
            expected_loader_args,
            "Forge",
        )
        .map_err(|error| error.to_string())?;
        return Ok(DetectedServerPack {
            minecraft_version: minecraft_version.clone(),
            loader: "Forge".into(),
            loader_version: format!("specific:{minecraft_version}-{forge_build}"),
            runtime_root: root,
            legacy_forge: false,
            server_pack_creator: false,
            argument_file: Some(expected),
        });
    }
    if neo_args.len() == 1 {
        let (marker, marker_path, version) = &neo_args[0];
        let minecraft_version = neoforge_minecraft_version(version).ok_or_else(|| {
            "NeoForge version does not map to a supported Minecraft release".to_string()
        })?;
        require_nonempty(&entries, "run.bat")?;
        require_nonempty(&entries, "user_jvm_args.txt")?;
        if marker.size == 0 {
            return Err("NeoForge win_args.txt is empty".into());
        }
        let args_text = read_entry_text(path, marker.index)?;
        validate_launch_payload_jars(&args_text, &entries)?;
        let run_index = entries
            .iter()
            .find(|(_, relative)| relative == "run.bat")
            .map(|(entry, _)| entry.index)
            .ok_or_else(|| "NeoForge run.bat is missing".to_string())?;
        let run_script = read_entry_text(path, run_index)?;
        crate::servers::process::expected_generated_arg_file(&run_script, marker_path, "NeoForge")
            .map_err(|error| error.to_string())?;
        return Ok(DetectedServerPack {
            minecraft_version: minecraft_version.into(),
            loader: "NeoForge".into(),
            loader_version: version.clone(),
            runtime_root: root,
            legacy_forge: false,
            server_pack_creator: false,
            argument_file: Some(marker_path.clone()),
        });
    }
    if legacy_forge.len() == 1 {
        let (universal, build) = &legacy_forge[0];
        let minecraft_version = build
            .strip_prefix("1.12.2-")
            .map(|_| "1.12.2")
            .ok_or_else(|| "legacy Forge server-pack marker is not Minecraft 1.12.2".to_string())?;
        let server_jar = format!("minecraft_server.{minecraft_version}.jar");
        if universal.size == 0 || !file_paths.contains(server_jar.as_str()) {
            return Err(
                "legacy Forge pack requires nonempty Forge universal and Minecraft server JARs"
                    .into(),
            );
        }
        require_nonempty(&entries, &server_jar)?;
        return Ok(DetectedServerPack {
            minecraft_version: minecraft_version.into(),
            loader: "Forge".into(),
            loader_version: format!("specific:{build}"),
            runtime_root: root,
            legacy_forge: true,
            server_pack_creator: false,
            argument_file: None,
        });
    }
    if file_paths.iter().any(|path| {
        path.ends_with("/quilt-server-launch.jar") || *path == "quilt-server-launch.jar"
    }) {
        return Err("Quilt imports are unsupported for new server installations".into());
    }
    if file_paths.contains("server.jar") {
        return Err("a generic server.jar cannot distinguish Vanilla, Paper, and Fabric; this importer supports only verified Forge and NeoForge packs".into());
    }
    Err("archive has no supported Forge or NeoForge server-pack markers".into())
}

fn detect_server_pack_creator(
    path: &Path,
    plan: &ArchivePlan,
    root: &str,
    entries: &[(&ArchiveEntryPlan, String)],
) -> Result<Option<DetectedServerPack>, String> {
    let manifest_path = join_root(root, "manifest.json");
    let Some(manifest_entry) = plan
        .entries
        .iter()
        .find(|entry| !entry.is_dir && entry.relative_name == manifest_path)
    else {
        return Ok(None);
    };
    let text = read_entry_text(path, manifest_entry.index)?;
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if !value.get("serverPackCreatorVersion").is_some() {
        return Ok(None);
    }

    let creator_version = required_server_pack_string(&value, "serverPackCreatorVersion")?;
    if !install::valid_version_segment(creator_version) {
        return Err("ServerPackCreator manifest has an invalid creator version".into());
    }
    let minecraft_version = required_server_pack_string(&value, "minecraftVersion")?;
    if !valid_dotted_version(minecraft_version) {
        return Err("ServerPackCreator manifest has an invalid Minecraft version".into());
    }
    let modloader = required_server_pack_string(&value, "modloader")?;
    if !modloader.eq_ignore_ascii_case("fabric") {
        return Err(format!(
            "ServerPackCreator {modloader} server packs are unsupported; only Fabric metadata packs are currently supported"
        ));
    }
    let loader_version = required_server_pack_string(&value, "modloaderVersion")?;
    if !install::valid_version_segment(loader_version) {
        return Err("ServerPackCreator manifest has an invalid Fabric loader version".into());
    }
    let inventory = value
        .get("files")
        .and_then(Value::as_array)
        .filter(|files| !files.is_empty() && files.len() <= MAX_ARCHIVE_ENTRIES)
        .ok_or_else(|| {
            "ServerPackCreator manifest must contain a nonempty files inventory".to_string()
        })?;
    if inventory
        .iter()
        .any(|file| file.as_str().is_none_or(|path| path.trim().is_empty()))
    {
        return Err("ServerPackCreator files inventory contains an invalid item".into());
    }
    if entries.iter().filter(|(entry, _)| !entry.is_dir).count() <= 1 {
        return Err("ServerPackCreator archive contains no server-pack payload files".into());
    }

    Ok(Some(DetectedServerPack {
        minecraft_version: minecraft_version.to_string(),
        loader: "Fabric".into(),
        loader_version: loader_version.to_string(),
        runtime_root: root.to_string(),
        legacy_forge: false,
        server_pack_creator: true,
        argument_file: None,
    }))
}

fn required_server_pack_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("ServerPackCreator manifest is missing a valid {field}"))
}

pub(crate) fn is_client_export(path: &Path, plan: &ArchivePlan) -> bool {
    detect_client_export(path, plan).is_some()
}

pub(crate) fn detect_pack_for_install(
    path: &Path,
    plan: &ArchivePlan,
) -> Result<DetectedServerPack, String> {
    detect_server_pack(path, plan)
}

pub(crate) fn remove_staged_zip(app_data: &Path, name: &str) -> Result<(), AppError> {
    let path = staged_zip_path(app_data, name)?;
    fs::remove_file(path)?;
    Ok(())
}

fn common_root(plan: &ArchivePlan) -> Option<String> {
    let mut common: Option<&str> = None;
    let mut found_file = false;
    for entry in plan.entries.iter().filter(|entry| !entry.is_dir) {
        found_file = true;
        let (root, remainder) = entry.relative_name.split_once('/')?;
        if remainder.is_empty() || common.is_some_and(|previous| previous != root) {
            return None;
        }
        common = Some(root);
    }
    found_file.then(|| common.map(str::to_string)).flatten()
}

fn join_root(root: &str, relative: &str) -> String {
    if root.is_empty() {
        relative.into()
    } else {
        format!("{root}/{relative}")
    }
}

fn strip_root<'a>(name: &'a str, root: &str) -> Option<&'a str> {
    if root.is_empty() {
        return Some(name);
    }
    name.strip_prefix(root)
        .and_then(|rest| rest.strip_prefix('/'))
}

fn has_server_files_root(plan: &ArchivePlan, root: &str) -> bool {
    if root.eq_ignore_ascii_case("server_files") {
        return true;
    }
    plan.entries
        .iter()
        .filter(|entry| !entry.is_dir)
        .any(|entry| {
            let relative = strip_root(&entry.relative_name, root).unwrap_or(&entry.relative_name);
            relative
                .split('/')
                .next()
                .is_some_and(|component| component.eq_ignore_ascii_case("server_files"))
        })
}

fn forge_version_from_args_path(path: &str) -> Option<(&str, &str)> {
    let remainder = path.strip_prefix("libraries/net/minecraftforge/forge/")?;
    let (version_dir, file) = remainder.split_once('/')?;
    if file != "win_args.txt" || version_dir.contains('/') {
        return None;
    }
    let (minecraft, build) = version_dir.split_once('-')?;
    valid_dotted_version(minecraft).then_some(())?;
    install::valid_version_segment(build).then_some((minecraft, build))
}

fn neoforge_version_from_args_path(path: &str) -> Option<&str> {
    let remainder = path.strip_prefix("libraries/net/neoforged/neoforge/")?;
    let (version, file) = remainder.split_once('/')?;
    (file == "win_args.txt" && !version.contains('/') && install::valid_version_segment(version))
        .then_some(version)
}

fn legacy_forge_version(path: &str) -> Option<String> {
    if path.contains('/') {
        return None;
    }
    let file_name = Path::new(path).file_name()?.to_str()?;
    let version = file_name
        .strip_prefix("forge-")?
        .strip_suffix("-universal.jar")?;
    version
        .strip_prefix("1.12.2-")
        .filter(|build| install::valid_version_segment(build))?;
    Some(version.into())
}

fn neoforge_minecraft_version(version: &str) -> Option<&'static str> {
    if version.starts_with("47.") {
        Some("1.20.1")
    } else if version.starts_with("20.4.") {
        Some("1.20.4")
    } else if version.starts_with("20.6.") {
        Some("1.20.6")
    } else if version.starts_with("21.0.") {
        Some("1.21")
    } else {
        None
    }
}

fn valid_dotted_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.as_bytes().first().is_some_and(u8::is_ascii_digit)
        && value.as_bytes().last().is_some_and(u8::is_ascii_digit)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && !value.contains("..")
}

fn require_nonempty(entries: &[(&ArchiveEntryPlan, String)], name: &str) -> Result<(), String> {
    match entries
        .iter()
        .find(|(entry, relative)| !entry.is_dir && relative == name)
    {
        Some((entry, _)) if entry.size > 0 => Ok(()),
        Some(_) => Err(format!("required server-pack file {name} is empty")),
        None => Err(format!("required server-pack file {name} is missing")),
    }
}

fn read_entry_text(path: &Path, index: usize) -> Result<String, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| "selected file is not a readable ZIP archive".to_string())?;
    let mut entry = archive
        .by_index(index)
        .map_err(|_| "ZIP entry is unreadable".to_string())?;
    if entry.size() > MAX_INSPECTED_TEXT_BYTES {
        return Err("server launch metadata is too large to inspect".into());
    }
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|_| "server launch metadata is not valid UTF-8".to_string())?;
    Ok(text)
}

fn validate_launch_payload_jars(
    args_text: &str,
    entries: &[(&ArchiveEntryPlan, String)],
) -> Result<(), String> {
    let mut references = HashSet::new();
    for line in args_text.lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        let mut quoted = false;
        let mut token = String::new();
        for character in line.chars() {
            if character == '"' {
                quoted = !quoted;
            } else if character.is_whitespace() && !quoted {
                collect_launch_payload_token(&token, &mut references)?;
                token.clear();
            } else {
                token.push(character);
            }
        }
        collect_launch_payload_token(&token, &mut references)?;
    }
    if references.is_empty() {
        return Err("win_args.txt does not reference a launch payload JAR".into());
    }
    for reference in references {
        let matched = entries
            .iter()
            .find(|(entry, relative)| !entry.is_dir && relative.eq_ignore_ascii_case(&reference));
        match matched {
            Some((entry, _)) if entry.size > 0 => {}
            Some(_) => {
                return Err(format!(
                    "launch payload JAR referenced by win_args.txt is empty: {reference}"
                ));
            }
            None => {
                return Err(format!(
                    "launch payload JAR referenced by win_args.txt is missing: {reference}"
                ));
            }
        }
    }
    Ok(())
}

fn collect_launch_payload_token(
    token: &str,
    references: &mut HashSet<String>,
) -> Result<(), String> {
    let token =
        token.trim_matches(|character: char| matches!(character, '"' | '\'' | ',' | '(' | ')'));
    if token
        .split_once('=')
        .is_some_and(|(property, _)| property.eq_ignore_ascii_case("-DignoreList"))
    {
        return Ok(());
    }
    let value = token
        .split_once('=')
        .map(|(_, value)| value)
        .unwrap_or(token);
    for candidate in value.split([';', ':']) {
        let candidate = candidate
            .trim_matches(|character: char| matches!(character, '"' | '\'' | ',' | '(' | ')'));
        let candidate = candidate
            .strip_prefix('@')
            .unwrap_or(candidate)
            .trim_start_matches("./")
            .trim_start_matches(".\\");
        if !Path::new(candidate)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
        {
            continue;
        }
        let normalized = candidate.replace('\\', "/");
        let relative = install::validate_relative_path(&normalized, false)
            .map_err(|_| "win_args.txt contains an unsafe launch payload path".to_string())?;
        references.insert(relative.to_ascii_lowercase());
    }
    Ok(())
}

pub(crate) fn extract_server_pack_zip(
    app: &AppHandle,
    job_id: &str,
    source_path: &Path,
    plan: &ArchivePlan,
    pack: &DetectedServerPack,
    staging: &Path,
    control: &crate::installer::JobControl,
) -> Result<(), AppError> {
    fs::create_dir_all(staging)?;
    install::ensure_safe_staging(staging)?;
    let file = File::open(source_path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| validation("selected file is not a readable ZIP archive"))?;
    let mut extracted_bytes = 0u64;
    let mut last_reported = 0u8;
    let mut buffer = [0u8; 128 * 1024];

    for planned in &plan.entries {
        crate::installer::ensure_not_cancelled(control)?;
        let Some(relative) = strip_root(&planned.relative_name, &pack.runtime_root) else {
            if planned.is_dir && planned.relative_name == pack.runtime_root {
                continue;
            }
            return Err(validation(
                "archive has entries outside its unambiguous server root",
            ));
        };
        if relative.is_empty() {
            continue;
        }
        let relative = install::validate_relative_path(relative, planned.is_dir)?;
        if reserved_import_path(&relative) {
            return Err(validation(format!(
                "server pack targets manager-reserved path {relative}"
            )));
        }
        if planned.is_dir {
            install::ensure_directory_tree(staging, &relative)?;
            continue;
        }

        if let Some(parent) = Path::new(&relative).parent() {
            let parent = parent.to_string_lossy().replace('\\', "/");
            if !parent.is_empty() && parent != "." {
                install::ensure_directory_tree(staging, &parent)?;
            }
        }
        let target = staged_target(staging, &relative)?;
        install::remove_existing_regular_file(&target)?;
        let mut source = archive
            .by_index(planned.index)
            .map_err(|_| validation("ZIP entry became unreadable during extraction"))?;
        if source.is_symlink() || source.is_dir() || source.size() != planned.size {
            return Err(validation("ZIP entry changed or contains a symbolic link"));
        }
        let mut destination = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        let mut entry_bytes = 0u64;
        loop {
            crate::installer::ensure_not_cancelled(control)?;
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            entry_bytes = entry_bytes
                .checked_add(count as u64)
                .ok_or_else(|| validation("ZIP entry expanded size overflowed"))?;
            extracted_bytes = extracted_bytes
                .checked_add(count as u64)
                .ok_or_else(|| validation("ZIP expanded size overflowed"))?;
            if entry_bytes > planned.size || extracted_bytes > MAX_EXPANDED_BYTES {
                return Err(validation("ZIP expanded beyond its validated size bounds"));
            }
            destination.write_all(&buffer[..count])?;
            let progress = if plan.expanded_bytes == 0 {
                98
            } else {
                10 + ((extracted_bytes.saturating_mul(88) / plan.expanded_bytes).min(88) as u8)
            };
            if progress > last_reported {
                last_reported = progress;
                crate::installer::emit_curseforge_progress(
                    app,
                    job_id,
                    progress,
                    "Extracting server pack",
                    &format!(
                        "Extracted {extracted_bytes} of {} bytes.",
                        plan.expanded_bytes
                    ),
                    Some(extracted_bytes),
                    Some(plan.expanded_bytes),
                );
            }
        }
        destination.flush()?;
        if entry_bytes != planned.size {
            return Err(validation(format!(
                "ZIP entry {} expanded to an unexpected size",
                planned.relative_name
            )));
        }
    }
    if extracted_bytes != plan.expanded_bytes {
        return Err(validation(
            "ZIP total expanded size did not match its validated directory",
        ));
    }
    crate::installer::ensure_not_cancelled(control)?;
    crate::servers::process::resolve_launch_mode(
        staging,
        &pack.loader,
        &pack.minecraft_version,
        Some(&pack.loader_version),
    )?;
    Ok(())
}

fn staged_target(staging: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let mut target = staging.to_path_buf();
    for component in relative.split('/') {
        target.push(component);
    }
    let root = fs::canonicalize(staging)?;
    let parent = target
        .parent()
        .ok_or_else(|| validation("archive path has no parent"))?;
    if parent.exists() {
        let canonical_parent = fs::canonicalize(parent)?;
        if !canonical_parent.starts_with(&root) {
            return Err(validation("archive path escapes server staging"));
        }
    }
    Ok(target)
}

fn reserved_import_path(relative: &str) -> bool {
    let first = relative
        .split('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    first == "installer.log"
        || first.starts_with("modrinth-download-")
        || first.starts_with("modrinth-headers-")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadUpdate {
    id: String,
    name: String,
    status: String,
    bytes_received: u64,
    total_bytes: Option<u64>,
    message: String,
}

#[derive(Debug, Clone)]
struct DownloadTransfer {
    id: String,
    name: String,
    part_path: PathBuf,
    final_name: String,
    bytes_received: u64,
    total_bytes: Option<u64>,
    native_finished: Option<NativeFinish>,
    tauri_finished: Option<bool>,
    cancel_requested: bool,
    failed_reason: Option<String>,
}

#[derive(Debug, Clone)]
enum NativeFinish {
    Completed,
    Interrupted(String),
}

#[derive(Default)]
pub(crate) struct CurseForgeDownloadState {
    transfers: std::sync::Mutex<HashMap<String, DownloadTransfer>>,
}

const DOWNLOAD_EVENT: &str = "curseforge://download";

#[cfg(windows)]
thread_local! {
    static NEXT_TRANSFER_IDS: std::cell::RefCell<std::collections::VecDeque<String>> =
        std::cell::RefCell::new(std::collections::VecDeque::new());
    static WEBVIEW_DOWNLOAD_OPERATIONS: std::cell::RefCell<HashMap<String, webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation>> =
        std::cell::RefCell::new(HashMap::new());
}

static ACTIVE_PART_NAMES: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::OnceLock::new();

fn active_part_registry() -> &'static std::sync::Mutex<HashSet<String>> {
    ACTIVE_PART_NAMES.get_or_init(Default::default)
}

fn register_active_part(name: &str, active: bool) {
    let lock = active_part_registry();
    if let Ok(mut names) = lock.lock() {
        if active {
            names.insert(name.to_string());
        } else {
            names.remove(name);
        }
    }
}

struct ActivePartRegistration(String);

impl ActivePartRegistration {
    fn new(name: &str) -> Self {
        register_active_part(name, true);
        Self(name.to_string())
    }
}

impl Drop for ActivePartRegistration {
    fn drop(&mut self) {
        register_active_part(&self.0, false);
    }
}

fn emit_download(app: &AppHandle, update: DownloadUpdate) {
    use tauri::Emitter;
    let _ = app.emit_to("main", DOWNLOAD_EVENT, update);
}

fn part_creation_failure_message(kind: std::io::ErrorKind) -> &'static str {
    match kind {
        std::io::ErrorKind::AlreadyExists => {
            "A temporary staging filename is already in use. Retry the download."
        }
        std::io::ErrorKind::PermissionDenied => {
            "The app could not create a staging file. Check app-data folder permissions."
        }
        _ => "The app could not create a staging file. Check free space and try again.",
    }
}

fn create_download_part(path: &Path, id: &str, name: &str) -> Result<File, DownloadUpdate> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| DownloadUpdate {
            id: id.to_string(),
            name: name.to_string(),
            status: "failed".into(),
            bytes_received: 0,
            total_bytes: None,
            message: part_creation_failure_message(error.kind()).into(),
        })
}

fn begin_download(
    app: &AppHandle,
    state: &CurseForgeDownloadState,
    app_data: &Path,
    suggested_destination: &mut PathBuf,
) -> bool {
    let suggested = suggested_destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    if !Path::new(&suggested)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        emit_download(
            app,
            DownloadUpdate {
                id: uuid::Uuid::new_v4().to_string(),
                name: sanitize_filename(&suggested),
                status: "failed".into(),
                bytes_received: 0,
                total_bytes: None,
                message: "Only ZIP downloads can be staged here. Use the external browser and Browse for ZIP if CurseForge starts a different download.".into(),
            },
        );
        return false;
    }
    let directory = match ensure_import_dir(app_data) {
        Ok(directory) => directory,
        Err(error) => {
            emit_download(
                app,
                DownloadUpdate {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: sanitize_filename(&suggested),
                    status: "failed".into(),
                    bytes_received: 0,
                    total_bytes: None,
                    message: format!("Could not prepare CurseForge staging: {error}"),
                },
            );
            return false;
        }
    };
    if crate::java::free_disk_space(&directory).unwrap_or(0) < IMPORT_HEADROOM_BYTES {
        emit_download(
            app,
            DownloadUpdate {
                id: uuid::Uuid::new_v4().to_string(),
                name: sanitize_filename(&suggested),
                status: "failed".into(),
                bytes_received: 0,
                total_bytes: None,
                message: "Not enough free disk space to start a managed download.".into(),
            },
        );
        return false;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let mut transfers = match state.transfers.lock() {
        Ok(transfers) => transfers,
        Err(_) => {
            emit_download(
                app,
                DownloadUpdate {
                    id,
                    name: sanitize_filename(&suggested),
                    status: "failed".into(),
                    bytes_received: 0,
                    total_bytes: None,
                    message: "The app could not register this managed download. Please retry."
                        .into(),
                },
            );
            return false;
        }
    };
    let final_name = unique_transfer_name(&directory, &suggested, &transfers);
    let display_name = final_name.clone();
    let stem = Path::new(&final_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("curseforge-server-pack");
    let part_name = format!("{stem}.{id}.part");
    let part_path = directory.join(&part_name);
    // Register before creating the path so a concurrent Refresh cannot treat
    // a just-created download file as an abandoned `.part` file.
    register_active_part(&part_name, true);
    let part_file = match create_download_part(&part_path, &id, &display_name) {
        Ok(file) => file,
        Err(update) => {
            register_active_part(&part_name, false);
            emit_download(app, update);
            return false;
        }
    };
    drop(part_file);
    *suggested_destination = part_path.clone();
    transfers.insert(
        id.clone(),
        DownloadTransfer {
            id: id.clone(),
            name: final_name.clone(),
            part_path,
            final_name,
            bytes_received: 0,
            total_bytes: None,
            native_finished: None,
            tauri_finished: None,
            cancel_requested: false,
            failed_reason: None,
        },
    );
    drop(transfers);
    #[cfg(windows)]
    NEXT_TRANSFER_IDS.with(|ids| ids.borrow_mut().push_back(id.clone()));
    emit_download(
        app,
        DownloadUpdate {
            id,
            name: display_name,
            status: "starting".into(),
            bytes_received: 0,
            total_bytes: None,
            message: "Starting managed CurseForge ZIP download…".into(),
        },
    );
    true
}

fn unique_transfer_name(
    directory: &Path,
    suggested: &str,
    transfers: &HashMap<String, DownloadTransfer>,
) -> String {
    let mut candidate = unique_zip_name(directory, suggested);
    let (stem, extension) = Path::new(&candidate)
        .file_stem()
        .and_then(|value| value.to_str())
        .zip(
            Path::new(&candidate)
                .extension()
                .and_then(|value| value.to_str()),
        )
        .map(|(stem, extension)| (stem.to_string(), extension.to_string()))
        .unwrap_or_else(|| ("curseforge-server-pack".into(), "zip".into()));
    let mut suffix = 0u32;
    while transfers
        .values()
        .any(|transfer| transfer.final_name.eq_ignore_ascii_case(&candidate))
    {
        suffix = suffix.saturating_add(1);
        candidate = format!("{stem} ({suffix}).{extension}");
    }
    candidate
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_ascii_lowercase()
}

fn tauri_download_finished(
    app: &AppHandle,
    state: &CurseForgeDownloadState,
    path: Option<PathBuf>,
    success: bool,
) {
    if let Some(path) = path {
        let key = path_key(&path);
        let id = state.transfers.lock().ok().and_then(|transfers| {
            transfers
                .values()
                .find(|transfer| path_key(&transfer.part_path) == key)
                .map(|transfer| transfer.id.clone())
        });
        if let Some(id) = id {
            set_tauri_finish(app, state, &id, success);
        }
    }
    // Wry reports pathless interrupted downloads. The native operation
    // observer correlates those by operation ID; don't pair them by queue
    // order because rejected or concurrent downloads can finish out of order.
    let _ = (app, state, success);
}

fn set_tauri_finish(app: &AppHandle, state: &CurseForgeDownloadState, id: &str, success: bool) {
    if let Ok(mut transfers) = state.transfers.lock() {
        if let Some(transfer) = transfers.get_mut(id) {
            transfer.tauri_finished = Some(success);
        }
    }
    finish_if_ready(app, state, id);
}

fn set_native_finish(
    app: &AppHandle,
    state: &CurseForgeDownloadState,
    id: &str,
    finish: NativeFinish,
) {
    if let Ok(mut transfers) = state.transfers.lock() {
        if let Some(transfer) = transfers.get_mut(id) {
            transfer.native_finished = Some(finish);
        }
    }
    finish_if_ready(app, state, id);
}

fn set_download_progress(
    app: &AppHandle,
    state: &CurseForgeDownloadState,
    id: &str,
    bytes_received: u64,
    total_bytes: Option<u64>,
    failure: Option<String>,
) {
    let update = state.transfers.lock().ok().and_then(|mut transfers| {
        let transfer = transfers.get_mut(id)?;
        transfer.bytes_received = bytes_received;
        transfer.total_bytes = total_bytes;
        if let Some(failure) = failure {
            transfer.failed_reason = Some(failure);
        }
        Some(DownloadUpdate {
            id: transfer.id.clone(),
            name: transfer.name.clone(),
            status: if transfer.cancel_requested {
                "canceling"
            } else {
                "downloading"
            }
            .into(),
            bytes_received,
            total_bytes,
            message: transfer
                .failed_reason
                .clone()
                .unwrap_or_else(|| "Downloading into app-managed staging…".into()),
        })
    });
    if let Some(update) = update {
        emit_download(app, update);
    }
}

fn finish_if_ready(app: &AppHandle, state: &CurseForgeDownloadState, id: &str) {
    let transfer = {
        let mut transfers = match state.transfers.lock() {
            Ok(transfers) => transfers,
            Err(_) => return,
        };
        let ready = transfers.get(id).is_some_and(|transfer| {
            transfer.native_finished.is_some() && transfer.tauri_finished.is_some()
        });
        if ready {
            transfers.remove(id)
        } else {
            None
        }
    };
    let Some(transfer) = transfer else { return };
    let (status, message, completed_name) = match (
        &transfer.native_finished,
        transfer.tauri_finished,
    ) {
        (Some(NativeFinish::Completed), Some(true)) => match promote_completed_zip(&transfer) {
            Ok(name) => (
                "completed",
                "CurseForge ZIP download completed and is ready to inspect.".to_string(),
                Some(name),
            ),
            Err(error) => (
                "failed",
                format!("Download completed but did not produce a readable ZIP: {error}"),
                None,
            ),
        },
        (native, tauri_success) => {
            let canceled = transfer.cancel_requested
                || matches!(native, Some(NativeFinish::Interrupted(reason)) if reason == "user-canceled");
            let reason = transfer.failed_reason.clone().or_else(|| match native {
                Some(NativeFinish::Interrupted(reason)) => Some(interrupt_message(reason)),
                _ => None,
            });
            if canceled {
                (
                    "cancelled",
                    reason.unwrap_or_else(|| "Download canceled.".into()),
                    None,
                )
            } else {
                let mismatch =
                    matches!(native, Some(NativeFinish::Completed)) && tauri_success != Some(true);
                let message = if mismatch {
                    "WebView2 and Tauri reported different completion results. Try Open in External Browser.".into()
                } else {
                    reason.unwrap_or_else(|| {
                        "Download failed before completion. Try Open in External Browser.".into()
                    })
                };
                ("failed", message, None)
            }
        }
    };
    if completed_name.is_none() {
        let _ = fs::remove_file(&transfer.part_path);
    }
    if let Some(part_name) = transfer
        .part_path
        .file_name()
        .and_then(|name| name.to_str())
    {
        register_active_part(part_name, false);
    }
    emit_download(
        app,
        DownloadUpdate {
            id: transfer.id,
            name: completed_name.unwrap_or(transfer.name),
            status: status.into(),
            bytes_received: transfer.bytes_received,
            total_bytes: transfer.total_bytes,
            message,
        },
    );
}

fn downloaded_file_looks_like_html_or_json_error(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut prefix = Vec::with_capacity(MAX_DOWNLOAD_ERROR_PREFIX_BYTES);
    let mut prefix_reader = file.take(MAX_DOWNLOAD_ERROR_PREFIX_BYTES as u64);
    if prefix_reader.read_to_end(&mut prefix).is_err() {
        return false;
    }

    let prefix = String::from_utf8_lossy(&prefix)
        .trim_start_matches('\u{feff}')
        .trim_start()
        .to_ascii_lowercase();
    if ["<!doctype html", "<html", "<head", "<body"]
        .iter()
        .any(|marker| prefix.starts_with(marker))
    {
        return true;
    }

    (prefix.starts_with('{') || prefix.starts_with('['))
        && ["\"error", "\"errors", "\"message\"", "\"detail\""]
            .iter()
            .any(|marker| prefix.contains(marker))
}

fn promote_completed_zip(transfer: &DownloadTransfer) -> Result<String, AppError> {
    let metadata = fs::symlink_metadata(&transfer.part_path)?;
    if !metadata.file_type().is_file()
        || is_reparse_point(&metadata)
        || metadata.len() > MAX_MRPACK_BYTES
    {
        return Err(validation(
            "downloaded file is not a regular ZIP within the size limit",
        ));
    }
    let file = File::open(&transfer.part_path)?;
    let archive = match ZipArchive::new(file) {
        Ok(archive) => archive,
        Err(_) if downloaded_file_looks_like_html_or_json_error(&transfer.part_path) => {
            return Err(validation(
                "CurseForge returned a webpage or JSON response instead of a ZIP. Use Open in External Browser, open Additional Files, download the author's SERVER pack, then select that ZIP.",
            ));
        }
        Err(_) => {
            return Err(validation(
                "downloaded file has a corrupt ZIP central directory",
            ));
        }
    };
    if archive.len() == 0 || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(validation(
            "downloaded ZIP has no entries or exceeds the entry-count limit",
        ));
    }
    let directory = transfer
        .part_path
        .parent()
        .ok_or_else(|| validation("download staging path has no parent"))?;
    let final_name = unique_zip_name(directory, &transfer.final_name);
    let final_path = directory.join(&final_name);
    fs::rename(&transfer.part_path, &final_path)?;
    Ok(final_name)
}

fn interrupt_message(reason: &str) -> String {
    match reason {
        "user-canceled" => "Download canceled.".into(),
        "file-access-denied" => "WebView2 could not write the staged ZIP. Check folder permissions and try again.".into(),
        "file-no-space" => "Download stopped because the staging drive ran out of space.".into(),
        "network-failed" | "server-failed" | "server-bad-content" | "redirect-failed" => "CurseForge or its download redirect could not complete the transfer. Try Open in External Browser.".into(),
        "webview-closed" => "Download stopped because the CurseForge browser closed.".into(),
        other => format!("WebView2 interrupted the download ({other}). Try Open in External Browser."),
    }
}

#[cfg(windows)]
fn pop_native_transfer_id() -> Option<String> {
    NEXT_TRANSFER_IDS.with(|ids| ids.borrow_mut().pop_front())
}

#[cfg(windows)]
fn cancel_live_operation(id: &str) -> Result<bool, String> {
    WEBVIEW_DOWNLOAD_OPERATIONS.with(|operations| {
        let operations = operations.borrow();
        let Some(operation) = operations.get(id) else {
            return Ok(false);
        };
        unsafe { operation.Cancel() }.map_err(|error| error.to_string())?;
        Ok(true)
    })
}

#[cfg(windows)]
fn cancel_all_live_operations() {
    WEBVIEW_DOWNLOAD_OPERATIONS.with(|operations| {
        for operation in operations.borrow().values() {
            let _ = unsafe { operation.Cancel() };
        }
    });
}

#[cfg(windows)]
fn attach_webview2_download_handler(
    app: AppHandle,
    state: std::sync::Arc<CurseForgeDownloadState>,
    webview: tauri::webview::PlatformWebview,
) -> Result<(), String> {
    use webview2_com::{
        BytesReceivedChangedEventHandler, DownloadStartingEventHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_4, COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_DOWNLOAD_PROCESS_CRASHED,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_ACCESS_DENIED,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_DISCONNECTED,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_FAILED,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_INVALID_REQUEST,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_SERVER_DOWN,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_TIMEOUT,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_BAD_CONTENT,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_CERTIFICATE_PROBLEM,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_CROSS_ORIGIN_REDIRECT,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FAILED,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FORBIDDEN,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_UNAUTHORIZED,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED,
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_SHUTDOWN,
            COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
        },
        StateChangedEventHandler,
    };
    use windows_core::Interface;

    unsafe {
        let controller = webview.controller();
        let core = controller
            .CoreWebView2()
            .map_err(|error| error.to_string())?;
        let core4: ICoreWebView2_4 = core.cast().map_err(|error| error.to_string())?;
        let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let Some(id) = pop_native_transfer_id() else {
                let _ = args.SetCancel(true);
                return Ok(());
            };
            let operation = match args.DownloadOperation() {
                Ok(operation) => operation,
                Err(error) => {
                    if let Ok(mut transfers) = state.transfers.lock() {
                        if let Some(transfer) = transfers.get_mut(&id) {
                            transfer.failed_reason =
                                Some(format!("Could not attach WebView2 download state: {error}"));
                        }
                    }
                    let _ = args.SetCancel(true);
                    return Ok(());
                }
            };
            WEBVIEW_DOWNLOAD_OPERATIONS.with(|operations| {
                operations
                    .borrow_mut()
                    .insert(id.clone(), operation.clone());
            });

            let progress_app = app.clone();
            let progress_state = state.clone();
            let progress_id = id.clone();
            let mut bytes_token = Default::default();
            let progress_observer = operation.add_BytesReceivedChanged(
                &BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
                    let Some(operation) = operation else { return Ok(()) };
                    let mut bytes = 0i64;
                    let mut total = 0i64;
                    if operation.BytesReceived(&mut bytes).is_err()
                        || operation.TotalBytesToReceive(&mut total).is_err()
                    {
                        return Ok(());
                    }
                    let received = bytes.max(0) as u64;
                    let total = (total > 0).then_some(total as u64);
                    let max_size = MAX_MRPACK_BYTES;
                    let too_large = received > max_size || total.is_some_and(|value| value > max_size);
                    let lack_space = total.is_some_and(|value| {
                        progress_state
                            .transfers
                            .lock()
                            .ok()
                            .and_then(|transfers| transfers.get(&progress_id).map(|transfer| transfer.part_path.clone()))
                            .and_then(|path| {
                                let query =
                                    staged_file_space_dir(&path).unwrap_or_else(|| path.as_path());
                                crate::java::free_disk_space(query).ok()
                            })
                            .is_some_and(|available| available < value.saturating_add(IMPORT_HEADROOM_BYTES))
                    });
                    let failure = if too_large {
                        Some("Download exceeded the 2 GiB managed ZIP limit.".to_string())
                    } else if lack_space {
                        Some("Download stopped because the staging drive does not have enough free space.".to_string())
                    } else {
                        None
                    };
                    set_download_progress(
                        &progress_app,
                        &progress_state,
                        &progress_id,
                        received,
                        total,
                        failure.clone(),
                    );
                    if failure.is_some() {
                        let _ = operation.Cancel();
                    }
                    Ok(())
                })),
                &mut bytes_token,
            );
            if let Err(error) = progress_observer {
                if let Ok(mut transfers) = state.transfers.lock() {
                    if let Some(transfer) = transfers.get_mut(&id) {
                        transfer.failed_reason = Some(format!(
                            "Could not attach WebView2 download progress observer: {error}"
                        ));
                    }
                }
                let _ = operation.Cancel();
            }

            let finish_app = app.clone();
            let finish_state = state.clone();
            let finish_id = id.clone();
            let mut state_token = Default::default();
            let state_observer = operation.add_StateChanged(
                &StateChangedEventHandler::create(Box::new(move |operation, _| {
                    let Some(operation) = operation else {
                        return Ok(());
                    };
                    let mut download_state = Default::default();
                    if operation.State(&mut download_state).is_err()
                        || download_state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS
                    {
                        return Ok(());
                    }
                    let native_finish = if download_state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                        NativeFinish::Completed
                    } else {
                        let mut reason = Default::default();
                        let reason_text = if operation.InterruptReason(&mut reason).is_err() {
                            "interrupted".to_string()
                        } else if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED {
                            "user-canceled".to_string()
                        } else if reason
                            == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_ACCESS_DENIED
                        {
                            "file-access-denied".to_string()
                        } else if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE {
                            "file-no-space".to_string()
                        } else if reason
                            == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_CROSS_ORIGIN_REDIRECT
                        {
                            "redirect-failed".to_string()
                        } else if reason
                            == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_DOWNLOAD_PROCESS_CRASHED
                            || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_SHUTDOWN
                        {
                            "webview-closed".to_string()
                        } else if reason
                            == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_DISCONNECTED
                            || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_FAILED
                            || reason
                                == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_INVALID_REQUEST
                            || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_SERVER_DOWN
                            || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_TIMEOUT
                            || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FAILED
                            || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_BAD_CONTENT
                            || reason
                                == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_CERTIFICATE_PROBLEM
                            || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FORBIDDEN
                            || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_UNAUTHORIZED
                        {
                            "network-failed".to_string()
                        } else {
                            "interrupted".to_string()
                        };
                        NativeFinish::Interrupted(reason_text)
                    };
                    let interrupted = matches!(native_finish, NativeFinish::Interrupted(_));
                    set_native_finish(&finish_app, &finish_state, &finish_id, native_finish);
                    if interrupted {
                        // Wry reports pathless failures, so finish this
                        // specific interrupted transfer from its native ID.
                        set_tauri_finish(&finish_app, &finish_state, &finish_id, false);
                    }
                    WEBVIEW_DOWNLOAD_OPERATIONS.with(|operations| {
                        operations.borrow_mut().remove(&finish_id);
                    });
                    Ok(())
                })),
                &mut state_token,
            );
            if let Err(error) = state_observer {
                if let Ok(mut transfers) = state.transfers.lock() {
                    if let Some(transfer) = transfers.get_mut(&id) {
                        transfer.failed_reason = Some(format!(
                            "Could not attach WebView2 download completion observer: {error}"
                        ));
                    }
                }
                let _ = operation.Cancel();
                set_native_finish(
                    &app,
                    &state,
                    &id,
                    NativeFinish::Interrupted("observer-failed".into()),
                );
                set_tauri_finish(&app, &state, &id, false);
            }
            Ok(())
        }));
        let mut token = Default::default();
        core4
            .add_DownloadStarting(&handler, &mut token)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn curseforge_open_browser(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<CurseForgeDownloadState>>,
) -> Result<bool, AppError> {
    require_main_window(&window)?;
    #[cfg(not(windows))]
    {
        let _ = state;
        app.opener()
            .open_url("https://www.curseforge.com/minecraft", None::<&str>)
            .map_err(|error| AppError::Internal(format!("could not open CurseForge: {error}")))?;
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use tauri::{
            webview::{DownloadEvent, NewWindowResponse},
            WebviewUrl, WebviewWindowBuilder,
        };
        if let Some(existing) = app.get_webview_window("curseforge-browser") {
            let _ = existing.show();
            let _ = existing.set_focus();
            return Ok(true);
        }
        let app_data = crate::util::paths::app_data_dir(&app)?;
        ensure_import_dir(&app_data)?;
        let download_state = state.inner().clone();
        let callback_app = app.clone();
        let window = WebviewWindowBuilder::new(
            &app,
            "curseforge-browser",
            WebviewUrl::External("https://www.curseforge.com/minecraft".parse().unwrap()),
        )
        .title("CurseForge")
        .inner_size(1280.0, 900.0)
        .visible(false)
        .on_navigation(|url| allowed_curseforge_navigation(url.scheme(), url.host_str()))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(move |_webview, event| match event {
            DownloadEvent::Requested { destination, .. } => {
                begin_download(&callback_app, &download_state, &app_data, destination)
            }
            DownloadEvent::Finished { path, success, .. } => {
                tauri_download_finished(&callback_app, &download_state, path, success);
                true
            }
            _ => true,
        })
        .build()?;

        let bridge_app = app.clone();
        let bridge_state = state.inner().clone();
        let shown_window = window.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        window.with_webview(move |webview| {
            let attached = attach_webview2_download_handler(bridge_app.clone(), bridge_state, webview);
            if let Err(error) = &attached {
                use tauri::Emitter;
                let _ = bridge_app.emit_to(
                    "main",
                    DOWNLOAD_EVENT,
                    DownloadUpdate {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: "CurseForge browser".into(),
                        status: "failed".into(),
                        bytes_received: 0,
                        total_bytes: None,
                        message: format!("Managed WebView2 downloads are unavailable: {error}. Use Open in External Browser and Browse for ZIP."),
                    },
                );
                let _ = shown_window.close();
            } else {
                let _ = shown_window.show();
                let _ = shown_window.set_focus();
            }
            let _ = sender.send(attached);
        })?;
        match tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(std::time::Duration::from_secs(10))
        })
        .await
        .map_err(|error| {
            AppError::Internal(format!("WebView2 handler setup task failed: {error}"))
        })? {
            Ok(Ok(())) => Ok(true),
            Ok(Err(error)) => Err(AppError::Internal(format!(
                "WebView2 download bridge setup failed: {error}"
            ))),
            Err(error) => Err(AppError::Internal(format!(
                "WebView2 download bridge setup timed out: {error}"
            ))),
        }
    }
}

fn allowed_curseforge_navigation(scheme: &str, host: Option<&str>) -> bool {
    if !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    let Some(host) = host else {
        return false;
    };
    is_domain_or_true_subdomain(host, "curseforge.com")
        || is_domain_or_true_subdomain(host, "forgecdn.net")
}

fn is_domain_or_true_subdomain(host: &str, domain: &str) -> bool {
    if host.eq_ignore_ascii_case(domain) {
        return true;
    }
    let host = host.to_ascii_lowercase();
    let suffix = format!(".{domain}");
    let Some(subdomains) = host.strip_suffix(&suffix) else {
        return false;
    };
    !subdomains.is_empty() && subdomains.split('.').all(valid_dns_label)
}

fn valid_dns_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && label
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && label
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
mod curseforge_navigation_policy_tests {
    use super::allowed_curseforge_navigation;

    #[test]
    fn allows_exact_https_website_and_cdn_roots() {
        assert!(allowed_curseforge_navigation(
            "https",
            Some("curseforge.com")
        ));
        assert!(allowed_curseforge_navigation("https", Some("forgecdn.net")));
    }

    #[test]
    fn allows_true_https_subdomains_of_website_and_cdn() {
        assert!(allowed_curseforge_navigation(
            "https",
            Some("www.curseforge.com")
        ));
        assert!(allowed_curseforge_navigation(
            "https",
            Some("edge.forgecdn.net")
        ));
        assert!(allowed_curseforge_navigation(
            "https",
            Some("downloads.edge.forgecdn.net")
        ));
    }

    #[test]
    fn rejects_non_https_navigation_even_for_allowed_hosts() {
        assert!(!allowed_curseforge_navigation(
            "http",
            Some("www.curseforge.com")
        ));
        assert!(!allowed_curseforge_navigation(
            "http",
            Some("edge.forgecdn.net")
        ));
        assert!(!allowed_curseforge_navigation(
            "file",
            Some("curseforge.com")
        ));
    }

    #[test]
    fn rejects_lookalikes_and_malformed_subdomains() {
        for host in [
            "forgecdn.net.attacker.example",
            "edge-forgecdn.net",
            "notcurseforge.com",
            "curseforge.com.attacker.example",
            "edge..forgecdn.net",
            "-edge.forgecdn.net",
            "edge-.forgecdn.net",
        ] {
            assert!(
                !allowed_curseforge_navigation("https", Some(host)),
                "unexpectedly allowed {host}"
            );
        }
        assert!(!allowed_curseforge_navigation("https", None));
    }
}

#[tauri::command]
pub fn curseforge_open_external_browser(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), AppError> {
    require_main_window(&window)?;
    app.opener()
        .open_url("https://www.curseforge.com/minecraft", None::<&str>)
        .map_err(|error| AppError::Internal(format!("could not open CurseForge: {error}")))
}

#[tauri::command]
pub async fn curseforge_list_zips(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<StagedZip>, AppError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        list_staged_zips(&crate::util::paths::app_data_dir(&app)?)
    })
    .await
    .map_err(|error| AppError::Internal(format!("CurseForge staging scan failed: {error}")))?
}

#[tauri::command]
pub async fn curseforge_pick_zip(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<StagedZip>, AppError> {
    require_main_window(&window)?;
    pick_and_stage_zip(app, window).await
}

#[tauri::command]
pub async fn curseforge_inspect_zip(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
) -> Result<ArchiveInspection, AppError> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let app_data = crate::util::paths::app_data_dir(&app)?;
        Ok(inspect_staged_zip(&app_data, &name))
    })
    .await
    .map_err(|error| AppError::Internal(format!("CurseForge ZIP inspection failed: {error}")))?
}

#[tauri::command]
pub async fn curseforge_cancel_download(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<CurseForgeDownloadState>>,
    transfer_id: String,
) -> Result<bool, AppError> {
    require_main_window(&window)?;
    let active = state
        .transfers
        .lock()
        .map_err(|_| AppError::Internal("download registry lock poisoned".into()))?
        .get_mut(&transfer_id)
        .map(|transfer| {
            transfer.cancel_requested = true;
            true
        })
        .unwrap_or(false);
    if !active {
        return Ok(false);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(false)
    }
    #[cfg(windows)]
    {
        let browser = app
            .get_webview_window("curseforge-browser")
            .ok_or_else(|| {
                AppError::NotFound("the embedded CurseForge browser is closed".into())
            })?;
        let id = transfer_id;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        browser.with_webview(move |_| {
            let _ = sender.send(cancel_live_operation(&id));
        })?;
        let canceled = tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .map_err(|error| AppError::Internal(format!("download cancel task failed: {error}")))?
        .map_err(|error| AppError::Internal(format!("WebView2 cancel call timed out: {error}")))?
        .map_err(|error| {
            AppError::Internal(format!("WebView2 could not cancel download: {error}"))
        })?;
        Ok(canceled)
    }
}

pub(crate) fn browser_window_closing(app: &AppHandle) {
    #[cfg(windows)]
    {
        if let Some(state) = app.try_state::<std::sync::Arc<CurseForgeDownloadState>>() {
            if let Ok(mut transfers) = state.transfers.lock() {
                for transfer in transfers.values_mut() {
                    transfer.cancel_requested = true;
                    transfer.failed_reason = Some("The embedded CurseForge browser closed.".into());
                }
            }
        }
        cancel_all_live_operations();
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::{SimpleFileOptions, ZipWriter};

    struct TempZip(PathBuf);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mc-server-manager-curseforge-dir-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl TempZip {
        fn from_entries(entries: &[(&str, &[u8])]) -> Self {
            let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
            for (name, content) in entries {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(content).unwrap();
            }
            Self::from_writer_with_extension(writer, "zip")
        }

        fn from_entries_with_extension(entries: &[(&str, &[u8])], extension: &str) -> Self {
            let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
            for (name, content) in entries {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(content).unwrap();
            }
            Self::from_writer_with_extension(writer, extension)
        }

        fn from_writer(writer: ZipWriter<Cursor<Vec<u8>>>) -> Self {
            Self::from_writer_with_extension(writer, "zip")
        }

        fn from_writer_with_extension(writer: ZipWriter<Cursor<Vec<u8>>>, extension: &str) -> Self {
            let bytes = writer.finish().unwrap().into_inner();
            let path = std::env::temp_dir().join(format!(
                "mc-server-manager-curseforge-{}.{}",
                uuid::Uuid::new_v4(),
                extension
            ));
            fs::write(&path, bytes).unwrap();
            Self(path)
        }

        fn from_raw(bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!(
                "mc-server-manager-curseforge-{}.payload",
                uuid::Uuid::new_v4()
            ));
            fs::write(&path, bytes).unwrap();
            Self(path)
        }
    }

    impl Drop for TempZip {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn forge_modern_entries() -> Vec<(&'static str, &'static [u8])> {
        vec![
            (
                "run.bat",
                b"@echo off\r\njava @user_jvm_args.txt @libraries\\net\\minecraftforge\\forge\\1.20.1-47.2.0\\win_args.txt %*\r\n",
            ),
            ("user_jvm_args.txt", b"-Xmx4G\n"),
            (
                "libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt",
                b"--launchTarget forgeserver -jar libraries/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-server.jar\n",
            ),
            (
                "libraries/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-server.jar",
                b"fixture server shim",
            ),
            ("libraries/example/runtime.jar", b"fixture jar"),
            ("mods/example.jar", b"fixture mod"),
        ]
    }

    #[test]
    fn detects_modern_forge_from_exact_args_and_unambiguous_root() {
        let mut entries = forge_modern_entries()
            .into_iter()
            .map(|(name, bytes)| (format!("Server/{name}"), bytes))
            .collect::<Vec<_>>();
        entries.push(("Server/config/options.txt".into(), b"fixture config"));
        let borrowed = entries
            .iter()
            .map(|(name, bytes)| (name.as_str(), *bytes))
            .collect::<Vec<_>>();
        let zip = TempZip::from_entries(&borrowed);
        let plan = build_archive_plan(&zip.0).unwrap();

        let pack = detect_server_pack(&zip.0, &plan).unwrap();
        assert_eq!(pack.minecraft_version, "1.20.1");
        assert_eq!(pack.loader, "Forge");
        assert_eq!(pack.loader_version, "specific:1.20.1-47.2.0");
        assert_eq!(pack.runtime_root, "Server");
        assert_eq!(
            pack.argument_file.as_deref(),
            Some("libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt")
        );
    }

    #[test]
    fn detects_neoforge_from_exact_args_and_supported_version_mapping() {
        let entries = [
            (
                "run.bat",
                b"java @user_jvm_args.txt @libraries\\net\\neoforged\\neoforge\\20.4.237\\win_args.txt %*" as &[u8],
            ),
            ("user_jvm_args.txt", b"-Xmx4G\n"),
            (
                "libraries/net/neoforged/neoforge/20.4.237/win_args.txt",
                b"--launchTarget neoforgeserver -jar libraries/net/neoforged/neoforge/20.4.237/neoforge-20.4.237-server.jar\n",
            ),
            (
                "libraries/net/neoforged/neoforge/20.4.237/neoforge-20.4.237-server.jar",
                b"fixture server shim",
            ),
            ("libraries/example/runtime.jar", b"fixture jar"),
        ];
        let zip = TempZip::from_entries(&entries);
        let plan = build_archive_plan(&zip.0).unwrap();

        let pack = detect_server_pack(&zip.0, &plan).unwrap();
        assert_eq!(pack.minecraft_version, "1.20.4");
        assert_eq!(pack.loader, "NeoForge");
        assert_eq!(pack.loader_version, "20.4.237");
    }

    #[test]
    fn detects_legacy_forge_only_with_both_server_jars() {
        let entries = [
            (
                "Server/forge-1.12.2-14.23.5.2859-universal.jar",
                b"forge" as &[u8],
            ),
            ("Server/minecraft_server.1.12.2.jar", b"minecraft"),
        ];
        let zip = TempZip::from_entries(&entries);
        let plan = build_archive_plan(&zip.0).unwrap();

        let pack = detect_server_pack(&zip.0, &plan).unwrap();
        assert!(pack.legacy_forge);
        assert_eq!(pack.minecraft_version, "1.12.2");
        assert_eq!(pack.loader_version, "specific:1.12.2-14.23.5.2859");

        let nested = TempZip::from_entries(&[
            (
                "Server/nested/forge-1.12.2-14.23.5.2859-universal.jar",
                b"forge" as &[u8],
            ),
            ("Server/minecraft_server.1.12.2.jar", b"minecraft"),
        ]);
        let nested_plan = build_archive_plan(&nested.0).unwrap();
        assert!(detect_server_pack(&nested.0, &nested_plan)
            .unwrap_err()
            .contains("no supported Forge or NeoForge"));
    }

    #[test]
    fn rejects_modern_loader_when_args_reference_a_missing_payload_jar() {
        let mut entries = forge_modern_entries();
        entries[2] = (
            "libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt",
            b"--launchTarget forgeserver -jar libraries/net/minecraftforge/forge/1.20.1-47.2.0/missing-server.jar\n" as &[u8],
        );
        let zip = TempZip::from_entries(&entries);
        let plan = build_archive_plan(&zip.0).unwrap();

        assert!(detect_server_pack(&zip.0, &plan)
            .unwrap_err()
            .contains("launch payload JAR referenced by win_args.txt is missing"));
    }

    #[test]
    fn ignores_forge_ignore_list_basenames_but_checks_real_payload_paths() {
        let mut entries = forge_modern_entries();
        entries[2] = (
            "libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt",
            b"-DignoreList=bootstraplauncher-1.1.2.jar,securejarhandler-2.1.10.jar,asm-commons-9.9.1.jar,asm-util-9.9.1.jar,asm-analysis-9.9.1.jar,asm-tree-9.9.1.jar,asm-9.9.1.jar,jarjarfilesystems-0.3.19.jar -jar libraries/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-server.jar\n" as &[u8],
        );
        let zip = TempZip::from_entries(&entries);
        let plan = build_archive_plan(&zip.0).unwrap();
        assert_eq!(detect_server_pack(&zip.0, &plan).unwrap().loader, "Forge");

        entries[2] = (
            "libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt",
            b"-DignoreList=ignored.jar -jar libraries/net/minecraftforge/forge/1.20.1-47.2.0/missing.jar\n" as &[u8],
        );
        let zip = TempZip::from_entries(&entries);
        let plan = build_archive_plan(&zip.0).unwrap();
        assert!(detect_server_pack(&zip.0, &plan)
            .unwrap_err()
            .contains("missing: libraries/net/minecraftforge/forge/1.20.1-47.2.0/missing.jar"));
    }

    #[test]
    fn unwraps_exactly_one_serverpackcreator_zip_and_cleans_temporary_archive() {
        let manifest = br#"{"files":["mods\\example.jar"],"minecraftVersion":"1.20.1","modloader":"Fabric","modloaderVersion":"0.19.3","serverPackCreatorVersion":"8.1.2"}"#;
        let inner = TempZip::from_entries(&[
            ("manifest.json", manifest),
            ("mods/example.jar", b"mod payload"),
            ("start.bat", b"do not execute"),
        ]);
        let inner_bytes = fs::read(&inner.0).unwrap();
        let outer = TempZip::from_entries(&[("Prominence_server_pack.zip", &inner_bytes)]);
        let outer_plan = build_archive_plan(&outer.0).unwrap();
        let prepared = prepare_server_pack_archive(&outer.0, outer_plan).unwrap();
        assert_ne!(prepared.path, outer.0);
        assert!(prepared.path.exists());
        let pack = detect_server_pack(&prepared.path, &prepared.plan).unwrap();
        assert!(pack.server_pack_creator);
        assert_eq!(pack.loader, "Fabric");
        assert_eq!(pack.loader_version, "0.19.3");
        let temporary_path = prepared.path.clone();
        drop(prepared);
        assert!(!temporary_path.exists());
    }

    #[test]
    fn content_classifier_accepts_validated_forge_and_neoforge_markers() {
        let forge = TempZip::from_entries(&forge_modern_entries());
        assert!(matches!(
            classify_archive_contents(&forge.0),
            ArchiveContentClassification::ServerPack(pack)
                if pack.detected.loader == "Forge" && pack.detected.minecraft_version == "1.20.1"
        ));

        let neo = TempZip::from_entries(&[
            (
                "run.bat",
                b"@echo off\r\njava @user_jvm_args.txt @libraries\\net\\neoforged\\neoforge\\20.4.237\\win_args.txt %*\r\n",
            ),
            ("user_jvm_args.txt", b"-Xmx4G\n"),
            (
                "libraries/net/neoforged/neoforge/20.4.237/win_args.txt",
                b"-jar libraries/net/neoforged/neoforge/20.4.237/neoforge-20.4.237-server.jar\n",
            ),
            (
                "libraries/net/neoforged/neoforge/20.4.237/neoforge-20.4.237-server.jar",
                b"payload",
            ),
        ]);
        assert!(matches!(
            classify_archive_contents(&neo.0),
            ArchiveContentClassification::ServerPack(pack)
                if pack.detected.loader == "NeoForge" && pack.detected.minecraft_version == "1.20.4"
        ));
    }

    #[test]
    fn rejects_server_files_root_even_with_valid_forge_markers() {
        let forge_entries = forge_modern_entries();
        let rooted_entries = forge_entries
            .iter()
            .map(|(name, content)| (format!("server_files/{name}"), *content))
            .collect::<Vec<_>>();
        let entry_refs = rooted_entries
            .iter()
            .map(|(name, content)| (name.as_str(), *content))
            .collect::<Vec<_>>();
        let zip = TempZip::from_entries(&entry_refs);
        let plan = build_archive_plan(&zip.0).unwrap();

        // The shared detector used by the active legacy path remains unchanged.
        assert_eq!(detect_server_pack(&zip.0, &plan).unwrap().loader, "Forge");

        assert!(matches!(
            classify_archive_contents(&zip.0),
            ArchiveContentClassification::Unsupported(reason)
                if reason.contains("server_files/")
        ));
    }

    #[test]
    fn content_classifier_unwraps_only_one_matching_inner_spsc_zip() {
        let manifest = br#"{"files":["mods/example.jar"],"minecraftVersion":"1.20.1","modloader":"Fabric","modloaderVersion":"0.19.3","serverPackCreatorVersion":"8.1.2"}"#;
        let inner = TempZip::from_entries(&[
            ("manifest.json", manifest),
            ("mods/example.jar", b"mod payload"),
            ("start.bat", b"do not execute"),
        ]);
        let inner_bytes = fs::read(&inner.0).unwrap();

        let outer = TempZip::from_entries_with_extension(
            &[("server-pack.payload", &inner_bytes)],
            "bundle",
        );
        assert!(matches!(
            classify_archive_contents(&outer.0),
            ArchiveContentClassification::ServerPack(pack)
                if pack.detected.server_pack_creator && pack.detected.loader == "Fabric"
        ));

        let server_jar_wrapper = TempZip::from_entries(&[("server.jar", &inner_bytes)]);
        assert!(matches!(
            classify_archive_contents(&server_jar_wrapper.0),
            ArchiveContentClassification::ServerPack(pack)
                if pack.detected.server_pack_creator && pack.detected.loader == "Fabric"
        ));

        let server_files = TempZip::from_entries(&[
            ("server_files/manifest.json", manifest),
            ("server_files/mods/example.jar", b"mod payload"),
            ("server_files/start.bat", b"do not execute"),
        ]);
        let server_files_bytes = fs::read(&server_files.0).unwrap();
        let nested_server_files =
            TempZip::from_entries(&[("wrapper.payload", &server_files_bytes)]);
        assert!(matches!(
            classify_archive_contents(&nested_server_files.0),
            ArchiveContentClassification::Unsupported(reason)
                if reason.contains("server_files/")
        ));

        let multiple = TempZip::from_entries(&[
            ("server-pack.payload", &inner_bytes),
            ("README.txt", b"extra wrapper file"),
        ]);
        assert!(matches!(
            classify_archive_contents(&multiple.0),
            ArchiveContentClassification::Unsupported(_)
        ));

        let middle = TempZip::from_entries(&[("deep.payload", &inner_bytes)]);
        let middle_bytes = fs::read(&middle.0).unwrap();
        let deep = TempZip::from_entries(&[("outer.payload", &middle_bytes)]);
        assert!(matches!(
            classify_archive_contents(&deep.0),
            ArchiveContentClassification::Unsupported(_)
        ));
    }

    #[test]
    fn removes_nested_zip_temp_when_truncated_entry_fails_during_copy() {
        let directory = TempDir::new();
        let outer_path = directory.0.join("outer.zip");
        let mut writer = ZipWriter::new(File::create(&outer_path).unwrap());
        writer
            .start_file("truncated-server.zip", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"PK\x03\x04truncated").unwrap();
        writer.finish().unwrap();

        let mut outer_bytes = fs::read(&outer_path).unwrap();
        let central_header = outer_bytes
            .windows(4)
            .rposition(|window| window == b"PK\x01\x02")
            .expect("fixture has a central-directory header");
        let crc_offset = central_header + 16;
        let crc = u32::from_le_bytes(outer_bytes[crc_offset..crc_offset + 4].try_into().unwrap());
        outer_bytes[crc_offset..crc_offset + 4].copy_from_slice(&crc.wrapping_add(1).to_le_bytes());
        fs::write(&outer_path, outer_bytes).unwrap();

        let outer_plan = build_archive_plan(&outer_path).unwrap();
        let error = match prepare_server_pack_archive(&outer_path, outer_plan) {
            Ok(_) => panic!("corrupt nested ZIP entry should fail during extraction"),
            Err(error) => error,
        };
        assert!(matches!(error, AppError::Io(_)));
        let temporary_files = fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".curseforge-inner-")
            })
            .count();
        assert_eq!(temporary_files, 0);
    }

    #[test]
    fn refresh_during_external_copy_preserves_temp_and_published_zip() {
        let app_data = TempDir::new();
        let source = TempZip::from_entries(&[("readme.txt", b"external fixture")]);
        let mut observed_part = false;

        let copied = copy_external_zip_with_part_hook(&app_data.0, &source.0, |part_path| {
            observed_part = true;
            assert!(part_path.exists());
            assert!(list_staged_zips(&app_data.0).unwrap().is_empty());
            assert!(part_path.exists(), "Refresh must not remove an active copy");
        })
        .unwrap();

        assert!(observed_part);
        assert!(
            source.0.exists(),
            "browsing must preserve the original file"
        );
        assert!(list_staged_zips(&app_data.0)
            .unwrap()
            .iter()
            .any(|item| item.name == copied.name));
    }

    #[test]
    fn failed_part_creation_emits_transfer_identity_and_safe_message() {
        let path = std::env::temp_dir().join(format!(
            "mc-server-manager-curseforge-existing-{}.part",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, b"already exists").unwrap();

        let update = create_download_part(&path, "transfer-id", "pack.zip").unwrap_err();

        assert_eq!(update.id, "transfer-id");
        assert_eq!(update.name, "pack.zip");
        assert_eq!(update.status, "failed");
        assert!(update.message.contains("temporary staging filename"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn classifies_curseforge_client_export_before_runtime_detection() {
        let entries = [
            (
                "manifest.json",
                br#"{"manifestType":"minecraftModpack","manifestVersion":1,"minecraft":{"version":"1.20.1","modLoaders":[]},"files":[{"projectID":1,"fileID":2}],"overrides":"overrides"}"# as &[u8],
            ),
            ("overrides/config/example.txt", b"client config"),
        ];
        let zip = TempZip::from_entries(&entries);
        let plan = build_archive_plan(&zip.0).unwrap();

        assert!(detect_client_export(&zip.0, &plan).is_some());
        assert!(matches!(
            classify_archive_contents(&zip.0),
            ArchiveContentClassification::ClientExport(_)
        ));
    }

    #[test]
    fn partial_or_mismatched_curseforge_manifest_is_not_a_client_export() {
        let partial = TempZip::from_entries(&[(
            "manifest.json",
            br#"{"minecraft":{"version":"1.20.1","modLoaders":[]},"files":[]}"#,
        )]);
        let partial_plan = build_archive_plan(&partial.0).unwrap();
        assert!(detect_client_export(&partial.0, &partial_plan).is_none());
        assert!(matches!(
            classify_archive_contents(&partial.0),
            ArchiveContentClassification::Unsupported(reason)
                if reason.contains("manifestType=minecraftModpack")
        ));

        let wrong_version = TempZip::from_entries(&[(
            "manifest.json",
            br#"{"manifestType":"minecraftModpack","manifestVersion":2,"minecraft":{"version":"1.20.1","modLoaders":[]},"files":[]}"#,
        )]);
        let wrong_version_plan = build_archive_plan(&wrong_version.0).unwrap();
        assert!(detect_client_export(&wrong_version.0, &wrong_version_plan).is_none());
        assert!(matches!(
            classify_archive_contents(&wrong_version.0),
            ArchiveContentClassification::Unsupported(reason)
                if reason.contains("manifestVersion=1")
        ));

        let malformed = TempZip::from_entries(&[(
            "manifest.json",
            br#"{"manifestType":"minecraftModpack","manifestVersion":1,"minecraft":{},"files":null}"#,
        )]);
        assert!(matches!(
            classify_archive_contents(&malformed.0),
            ArchiveContentClassification::Invalid(reason)
                if reason.contains("missing its minecraft object or files array")
        ));
    }

    #[test]
    fn content_classifier_returns_explicit_unsupported_and_invalid_results() {
        let generic = TempZip::from_entries(&[
            ("server_files/config/server.properties", b"motd=unknown"),
            ("README.txt", b"generic template"),
        ]);
        assert!(matches!(
            classify_archive_contents(&generic.0),
            ArchiveContentClassification::Unsupported(_)
        ));

        let invalid = TempZip::from_raw(b"not a zip archive");
        assert!(matches!(
            classify_archive_contents(&invalid.0),
            ArchiveContentClassification::Invalid(_)
        ));
    }

    #[test]
    fn refuses_to_read_oversized_client_export_manifest() {
        let mut manifest =
            br#"{"minecraft":{"version":"1.20.1","modLoaders":[]},"files":[]}"#.to_vec();
        manifest.resize(MAX_INSPECTED_TEXT_BYTES as usize + 1, b' ');
        let zip = TempZip::from_entries(&[("manifest.json", manifest.as_slice())]);
        let plan = build_archive_plan(&zip.0).unwrap();

        assert!(detect_client_export(&zip.0, &plan).is_none());
    }

    #[test]
    fn rejects_generic_server_jar_and_unsupported_quilt_markers() {
        let generic = TempZip::from_entries(&[("server.jar", b"jar")]);
        let generic_plan = build_archive_plan(&generic.0).unwrap();
        assert!(detect_server_pack(&generic.0, &generic_plan)
            .unwrap_err()
            .contains("cannot distinguish"));

        let quilt = TempZip::from_entries(&[("quilt-server-launch.jar", b"jar")]);
        let quilt_plan = build_archive_plan(&quilt.0).unwrap();
        assert!(detect_server_pack(&quilt.0, &quilt_plan)
            .unwrap_err()
            .contains("Quilt imports are unsupported"));
    }

    #[test]
    fn rejects_traversal_case_collisions_and_zip_symlinks() {
        let traversal = TempZip::from_entries(&[("../escape.txt", b"escape")]);
        assert!(build_archive_plan(&traversal.0).is_err());

        let duplicate = TempZip::from_entries(&[
            ("mods/Example.jar", b"first"),
            ("mods/example.jar", b"second"),
        ]);
        assert!(build_archive_plan(&duplicate.0)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("mods/link", "../../outside", SimpleFileOptions::default())
            .unwrap();
        let symlink = TempZip::from_writer(writer);
        assert!(build_archive_plan(&symlink.0)
            .unwrap_err()
            .to_string()
            .contains("symbolic-link"));
    }

    #[test]
    fn staged_file_space_dir_resolves_tm_leaf_to_parent() {
        let dir = TempDir::new();
        let tm_path = dir.0.join("Prominence\u{2122}_II_test.zip");
        fs::write(&tm_path, b"fixture").unwrap();
        assert_eq!(staged_file_space_dir(&tm_path), Some(dir.0.as_path()));

        let ascii_path = dir.0.join("plain-pack.zip");
        fs::write(&ascii_path, b"fixture").unwrap();
        assert_eq!(staged_file_space_dir(&ascii_path), Some(dir.0.as_path()));
    }

    #[test]
    fn staged_file_space_dir_without_parent_fails_closed() {
        assert_eq!(staged_file_space_dir(Path::new("lonely.zip")), None);
    }

    fn write_staged_fixture(app_data: &Path, name: &str) {
        let directory = ensure_import_dir(app_data).unwrap();
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("readme.txt", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"unicode inspect fixture").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        fs::write(directory.join(name), bytes).unwrap();
    }

    #[test]
    fn inspect_staged_zip_tm_leaf_does_not_report_267() {
        let app_data = TempDir::new();
        let tm_name = "Prominence\u{2122}_II_Hasturian_Era_test.zip";
        write_staged_fixture(&app_data.0, tm_name);
        let ascii_name = "plain-pack-test.zip";
        write_staged_fixture(&app_data.0, ascii_name);

        for name in [tm_name, ascii_name] {
            let inspection = inspect_staged_zip(&app_data.0, name);
            assert!(
                !inspection.reason.contains("267"),
                "staged file {name} regressed to os error 267: {}",
                inspection.reason
            );
            assert!(
                !inspection
                    .reason
                    .contains("could not check free disk space"),
                "staged file {name} failed the free-space preflight: {}",
                inspection.reason
            );
            assert!(
                !inspection.reason.contains("not enough free disk space"),
                "staged file {name} reported insufficient space for a byte-sized fixture: {}",
                inspection.reason
            );
        }
    }
}
