use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use crate::{
    error::AppError,
    java,
    modpacks::{
        install,
        pipeline::{
            model::{ContentHashes, FileDecisionAction, ProviderSource},
            providers::{
                modrinth::{ModrinthArchiveDownload, ResolvedMrpackInstall},
                ProviderFileDownload,
            },
        },
    },
};

const MAX_DOWNLOAD_FILES: usize = 10_000;
const MAX_DOWNLOAD_URLS: usize = 8;
const MAX_DOWNLOAD_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_TOTAL_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const DOWNLOAD_HEADROOM_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS: usize = 4;
const MAX_ATTEMPTS_PER_URL: usize = 3;
const MAX_REDIRECTS: usize = 3;
const MAX_URL_BYTES: usize = 8192;
const MAX_HEADER_BYTES: u64 = 64 * 1024;
const CANCEL_POLL: Duration = Duration::from_millis(200);

const MODRINTH_ALLOWED_HOSTS: &[&str] = &[
    "cdn.modrinth.com",
    "github.com",
    "raw.githubusercontent.com",
    "gitlab.com",
];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DownloadError {
    #[error("download input is invalid: {0}")]
    Invalid(String),
    #[error("download was cancelled")]
    Cancelled,
    #[error("download failed: {0}")]
    Failed(String),
    #[error("download failed for {path}: {message}")]
    FileFailed {
        path: String,
        attempted_sources: Vec<String>,
        expected_size_bytes: u64,
        expected_hashes: ContentHashes,
        observed_size_bytes: Option<u64>,
        observed_hashes: Option<ContentHashes>,
        message: String,
    },
}

impl From<AppError> for DownloadError {
    fn from(error: AppError) -> Self {
        Self::Failed(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadProgress {
    pub path: String,
    pub bytes_received: u64,
    pub expected_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedDownload {
    pub path: String,
    pub expected_size_bytes: u64,
    pub expected_hashes: ContentHashes,
    pub size_bytes: u64,
    pub hashes: ContentHashes,
    pub source_host: String,
}

/// Download every resolved Modrinth file into fresh staging. File metadata is
/// accepted only when it exactly matches the active, provider-derived plan.
pub fn download_modrinth_files<F>(
    resolved: &ResolvedMrpackInstall,
    staging: &Path,
    cancelled: &AtomicBool,
    on_progress: F,
) -> Result<Vec<VerifiedDownload>, DownloadError>
where
    F: Fn(DownloadProgress) + Sync,
{
    let files = validate_modrinth_download_plan(resolved)?;
    download_files(
        &files,
        ProviderSource::Modrinth,
        staging,
        cancelled,
        &on_progress,
    )
}

/// Downloads a provider-pinned `.mrpack` archive into an isolated source
/// directory using the same redirect, size, hash, retry, and cleanup policy as
/// payload files. The caller snapshots this file before parsing it.
pub fn download_modrinth_archive<F>(
    archive: &ModrinthArchiveDownload,
    staging: &Path,
    cancelled: &AtomicBool,
    on_progress: F,
) -> Result<VerifiedDownload, DownloadError>
where
    F: Fn(DownloadProgress) + Sync,
{
    if archive.file_name.trim().is_empty() || archive.file_name.chars().any(char::is_control) {
        return Err(DownloadError::Invalid(
            "Modrinth archive filename is empty or invalid".into(),
        ));
    }
    let file = ProviderFileDownload {
        path: "source.mrpack".into(),
        urls: vec![archive.url.clone()],
        size_bytes: archive.size_bytes,
        hashes: archive.hashes.clone(),
    };
    validate_download_metadata(&file, MODRINTH_ALLOWED_HOSTS)?;
    let mut downloaded = download_files(
        &[file],
        ProviderSource::Modrinth,
        staging,
        cancelled,
        &on_progress,
    )?;
    downloaded
        .pop()
        .ok_or_else(|| DownloadError::Failed("Modrinth archive download returned no file".into()))
}

fn validate_modrinth_download_plan(
    resolved: &ResolvedMrpackInstall,
) -> Result<Vec<ProviderFileDownload>, DownloadError> {
    resolved
        .plan
        .validate_ready_to_install()
        .map_err(|error| DownloadError::Invalid(error.to_string()))?;
    if resolved.plan.source_pin.source != ProviderSource::Modrinth {
        return Err(DownloadError::Invalid(
            "Modrinth downloads require a Modrinth source pin".into(),
        ));
    }
    if resolved.file_downloads.len() > MAX_DOWNLOAD_FILES {
        return Err(DownloadError::Invalid(
            "selected pack has too many files to download safely".into(),
        ));
    }
    let mut included = std::collections::BTreeSet::new();
    for decision in &resolved.plan.file_decisions {
        if decision.action == FileDecisionAction::Include {
            included.insert(decision.path.clone());
        }
    }
    let mut actual = std::collections::BTreeSet::new();
    for file in &resolved.file_downloads {
        validate_download_metadata(file, MODRINTH_ALLOWED_HOSTS)?;
        if !actual.insert(file.path.clone()) {
            return Err(DownloadError::Invalid(format!(
                "resolved download list repeats {}",
                file.path
            )));
        }
    }
    if actual != included {
        return Err(DownloadError::Invalid(
            "resolved Modrinth download work differs from included plan decisions".into(),
        ));
    }
    Ok(resolved.file_downloads.clone())
}

fn validate_download_metadata(
    file: &ProviderFileDownload,
    allowed_hosts: &[&str],
) -> Result<(), DownloadError> {
    install::validate_relative_path(&file.path, false)
        .map_err(|error| DownloadError::Invalid(error.to_string()))?;
    if file.size_bytes == 0 || file.size_bytes > MAX_DOWNLOAD_FILE_BYTES {
        return Err(DownloadError::Invalid(format!(
            "declared size for {} is outside the download bound",
            file.path
        )));
    }
    file.hashes
        .validate()
        .map_err(|error| DownloadError::Invalid(format!("{}: {error}", file.path)))?;
    if file.urls.is_empty() || file.urls.len() > MAX_DOWNLOAD_URLS {
        return Err(DownloadError::Invalid(format!(
            "{} has no download source or too many fallbacks",
            file.path
        )));
    }
    for url in &file.urls {
        if !trusted_https_url(url, allowed_hosts) {
            return Err(DownloadError::Invalid(format!(
                "download URL for {} is outside the provider's approved HTTPS hosts",
                file.path
            )));
        }
    }
    Ok(())
}

fn download_files<F>(
    files: &[ProviderFileDownload],
    source: ProviderSource,
    staging: &Path,
    cancelled: &AtomicBool,
    on_progress: &F,
) -> Result<Vec<VerifiedDownload>, DownloadError>
where
    F: Fn(DownloadProgress) + Sync,
{
    if source != ProviderSource::Modrinth {
        return Err(DownloadError::Invalid(
            "network file downloads are available only for Modrinth; CurseForge remains author-ZIP-only".into(),
        ));
    }
    install::ensure_safe_staging(staging)
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    if files.len() > MAX_DOWNLOAD_FILES {
        return Err(DownloadError::Invalid(
            "pack contains too many selected files".into(),
        ));
    }
    if !files.is_empty() {
        let available = java::free_disk_space(staging).map_err(|error| {
            DownloadError::Failed(format!("disk-space preflight failed: {error}"))
        })?;
        validate_download_space(files, available)?;
    }

    let mut verified = Vec::with_capacity(files.len());
    for batch in files.chunks(MAX_CONCURRENT_DOWNLOADS) {
        if cancelled.load(Ordering::Acquire) {
            cleanup_verified_downloads(staging, &verified);
            return Err(DownloadError::Cancelled);
        }
        let abort_batch = AtomicBool::new(false);
        let results = thread::scope(|scope| {
            let handles = batch
                .iter()
                .map(|file| {
                    let abort = &abort_batch;
                    scope.spawn(move || {
                        let result = download_one(file, staging, cancelled, abort, on_progress);
                        if result.is_err() {
                            abort.store(true, Ordering::Release);
                        }
                        result
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| {
                    handle.join().unwrap_or_else(|_| {
                        Err(DownloadError::Failed("download worker panicked".into()))
                    })
                })
                .collect::<Vec<_>>()
        });
        let mut batch_files = Vec::with_capacity(results.len());
        let mut primary_error = None;
        for result in results {
            match result {
                Ok(file) => batch_files.push(file),
                Err(DownloadError::Cancelled) if !cancelled.load(Ordering::Acquire) => {}
                Err(error @ DownloadError::Cancelled) => {
                    if primary_error.is_none() {
                        primary_error = Some(error);
                    }
                }
                Err(error) => {
                    if !matches!(
                        primary_error.as_ref(),
                        Some(
                            DownloadError::Failed(_)
                                | DownloadError::Invalid(_)
                                | DownloadError::FileFailed { .. }
                        )
                    ) {
                        primary_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = primary_error {
            cleanup_verified_downloads(staging, &verified);
            cleanup_verified_downloads(staging, &batch_files);
            return Err(error);
        }
        verified.extend(batch_files);
    }
    Ok(verified)
}

fn cleanup_verified_downloads(staging: &Path, files: &[VerifiedDownload]) {
    for file in files {
        let Ok(path) = install::safe_target(staging, &file.path) else {
            continue;
        };
        let Ok((size, hashes)) =
            hash_regular_file(&path, &AtomicBool::new(false), &AtomicBool::new(false))
        else {
            continue;
        };
        if size == file.size_bytes && hashes_equal(&hashes, &file.hashes) {
            let _ = fs::remove_file(path);
        }
    }
}

fn hashes_equal(left: &ContentHashes, right: &ContentHashes) -> bool {
    left.sha1.eq_ignore_ascii_case(&right.sha1) && left.sha512.eq_ignore_ascii_case(&right.sha512)
}

fn validate_download_space(
    files: &[ProviderFileDownload],
    available_bytes: u64,
) -> Result<(), DownloadError> {
    let total = files.iter().try_fold(0u64, |sum, file| {
        sum.checked_add(file.size_bytes)
            .filter(|value| *value <= MAX_DOWNLOAD_TOTAL_BYTES)
            .ok_or_else(|| {
                DownloadError::Invalid("selected files exceed the 20 GiB total bound".into())
            })
    })?;
    let required = total
        .checked_add(DOWNLOAD_HEADROOM_BYTES)
        .ok_or_else(|| DownloadError::Invalid("download space estimate overflowed".into()))?;
    if available_bytes < required {
        return Err(DownloadError::Invalid(format!(
            "not enough staging-volume space for selected files (need {required} bytes, have {available_bytes})"
        )));
    }
    Ok(())
}

fn download_one<F>(
    file: &ProviderFileDownload,
    staging: &Path,
    cancelled: &AtomicBool,
    abort_batch: &AtomicBool,
    on_progress: &F,
) -> Result<VerifiedDownload, DownloadError>
where
    F: Fn(DownloadProgress) + Sync,
{
    let allowed_hosts = MODRINTH_ALLOWED_HOSTS;
    validate_download_metadata(file, allowed_hosts)?;
    if is_cancelled(cancelled, abort_batch) {
        return Err(DownloadError::Cancelled);
    }
    let destination = install::safe_target(staging, &file.path)
        .map_err(|error| DownloadError::Invalid(error.to_string()))?;
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(DownloadError::Invalid(format!(
            "staging already contains {}, refusing to overwrite it",
            file.path
        )));
    }
    if let Some(parent) = Path::new(&file.path)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        install::ensure_directory_tree(staging, &parent.to_string_lossy())
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| DownloadError::Invalid("download destination has no parent".into()))?;
    let unique = uuid::Uuid::new_v4();
    let part = parent.join(format!(".pipeline-download-{unique}.part"));
    let headers = parent.join(format!(".pipeline-download-{unique}.headers"));
    let mut failures = Vec::new();
    let mut attempted_sources = Vec::new();
    let mut observed_size_bytes = None;
    let mut observed_hashes = None;
    let result = (|| {
        for url in &file.urls {
            if !trusted_https_url(url, allowed_hosts) {
                return Err(DownloadError::Invalid(format!(
                    "download URL for {} is outside the approved HTTPS hosts",
                    file.path
                )));
            }
            if let Some(host) = url_host(url) {
                if !attempted_sources.iter().any(|attempted| attempted == host) {
                    attempted_sources.push(host.to_string());
                }
            }
            for attempt in 0..MAX_ATTEMPTS_PER_URL {
                if is_cancelled(cancelled, abort_batch) {
                    return Err(DownloadError::Cancelled);
                }
                let _ = fs::remove_file(&part);
                let _ = fs::remove_file(&headers);
                match fetch_with_redirects(
                    url,
                    &part,
                    &headers,
                    file.size_bytes,
                    allowed_hosts,
                    cancelled,
                    abort_batch,
                    &file.path,
                    on_progress,
                ) {
                    Ok(source_host) => match verify_file(&part, file, cancelled, abort_batch) {
                        Ok(hashes) => {
                            fs::rename(&part, &destination).map_err(|error| {
                                DownloadError::Failed(format!(
                                    "could not publish verified {} into staging: {error}",
                                    file.path
                                ))
                            })?;
                            return Ok(VerifiedDownload {
                                path: file.path.clone(),
                                expected_size_bytes: file.size_bytes,
                                expected_hashes: file.hashes.clone(),
                                size_bytes: file.size_bytes,
                                hashes,
                                source_host,
                            });
                        }
                        Err(DownloadError::Cancelled) => return Err(DownloadError::Cancelled),
                        Err(error) => {
                            if let Ok((size, hashes)) = hash_regular_file(
                                &part,
                                &AtomicBool::new(false),
                                &AtomicBool::new(false),
                            ) {
                                observed_size_bytes = Some(size);
                                observed_hashes = Some(hashes);
                            }
                            failures.push(error.to_string());
                        }
                    },
                    Err(DownloadError::Cancelled) => return Err(DownloadError::Cancelled),
                    Err(error) => failures.push(error.to_string()),
                }
                let _ = fs::remove_file(&part);
                let _ = fs::remove_file(&headers);
                if attempt + 1 < MAX_ATTEMPTS_PER_URL {
                    thread::sleep(Duration::from_millis(150 * (attempt as u64 + 1)));
                }
            }
        }
        Err(DownloadError::FileFailed {
            path: file.path.clone(),
            attempted_sources: attempted_sources.clone(),
            expected_size_bytes: file.size_bytes,
            expected_hashes: file.hashes.clone(),
            observed_size_bytes,
            observed_hashes,
            message: bounded_diagnostic(&format!(
                "could not download and verify from approved sources: {}",
                failures.join("; ")
            )),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
        let _ = fs::remove_file(&headers);
    }
    result
}

fn bounded_diagnostic(message: &str) -> String {
    const MAX_DIAGNOSTIC_CHARS: usize = 2048;
    if message.chars().count() <= MAX_DIAGNOSTIC_CHARS {
        return message.to_string();
    }
    let mut bounded = message
        .chars()
        .take(MAX_DIAGNOSTIC_CHARS - 1)
        .collect::<String>();
    bounded.push('…');
    bounded
}

fn verify_file(
    path: &Path,
    expected: &ProviderFileDownload,
    cancelled: &AtomicBool,
    abort_batch: &AtomicBool,
) -> Result<ContentHashes, DownloadError> {
    let (actual_size, hashes) = hash_regular_file(path, cancelled, abort_batch)?;
    if actual_size != expected.size_bytes {
        return Err(DownloadError::Failed(format!(
            "size mismatch for {} (expected {}, received {})",
            expected.path, expected.size_bytes, actual_size
        )));
    }
    if !hashes.sha1.eq_ignore_ascii_case(&expected.hashes.sha1)
        || !hashes.sha512.eq_ignore_ascii_case(&expected.hashes.sha512)
    {
        return Err(DownloadError::Failed(format!(
            "hash mismatch for {} (SHA-1/SHA-512 did not match provider metadata)",
            expected.path
        )));
    }
    Ok(hashes)
}

pub(crate) fn hash_regular_file(
    path: &Path,
    cancelled: &AtomicBool,
    abort_batch: &AtomicBool,
) -> Result<(u64, ContentHashes), DownloadError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        DownloadError::Failed(format!("could not inspect {}: {error}", path.display()))
    })?;
    if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
        return Err(DownloadError::Failed(format!(
            "{} is not a regular non-reparse file",
            path.display()
        )));
    }
    let mut file = open_regular_file(path).map_err(|error| {
        DownloadError::Failed(format!("could not safely open {}: {error}", path.display()))
    })?;
    let opened = file
        .metadata()
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    if !opened.is_file() || is_reparse_point(&opened) || opened.len() != metadata.len() {
        return Err(DownloadError::Failed(format!(
            "{} changed while it was being opened",
            path.display()
        )));
    }
    let mut hashers = cng::HashPair::new().map_err(|error| {
        DownloadError::Failed(format!("Windows CNG could not initialize: {error}"))
    })?;
    let mut buffer = [0u8; 128 * 1024];
    let mut actual_size = 0u64;
    loop {
        if is_cancelled(cancelled, abort_batch) {
            return Err(DownloadError::Cancelled);
        }
        let read = file.read(&mut buffer).map_err(|error| {
            DownloadError::Failed(format!("could not hash {}: {error}", path.display()))
        })?;
        if read == 0 {
            break;
        }
        actual_size = actual_size
            .checked_add(read as u64)
            .ok_or_else(|| DownloadError::Failed("download size overflowed".into()))?;
        if actual_size > MAX_DOWNLOAD_TOTAL_BYTES {
            return Err(DownloadError::Failed(format!(
                "{} exceeded the file verification bound",
                path.display()
            )));
        }
        hashers.update(&buffer[..read]).map_err(|error| {
            DownloadError::Failed(format!(
                "Windows CNG could not hash {}: {error}",
                path.display()
            ))
        })?;
    }
    if actual_size != opened.len() {
        return Err(DownloadError::Failed(format!(
            "{} changed while hashing",
            path.display()
        )));
    }
    if file
        .metadata()
        .map_err(|error| DownloadError::Failed(error.to_string()))?
        .len()
        != actual_size
    {
        return Err(DownloadError::Failed(format!(
            "{} changed after hashing",
            path.display()
        )));
    }
    let (sha1, sha512) = hashers.finish().map_err(|error| {
        DownloadError::Failed(format!(
            "Windows CNG could not finalize {}: {error}",
            path.display()
        ))
    })?;
    Ok((actual_size, ContentHashes { sha1, sha512 }))
}

fn fetch_with_redirects<F>(
    start_url: &str,
    part: &Path,
    headers: &Path,
    maximum_bytes: u64,
    allowed_hosts: &[&str],
    cancelled: &AtomicBool,
    abort_batch: &AtomicBool,
    file_path: &str,
    on_progress: &F,
) -> Result<String, DownloadError>
where
    F: Fn(DownloadProgress) + Sync,
{
    if !trusted_https_url(start_url, allowed_hosts) {
        return Err(DownloadError::Invalid(format!(
            "initial URL for {file_path} is not on an approved HTTPS host"
        )));
    }
    let mut current = start_url.to_string();
    let mut redirects = 0;
    loop {
        if is_cancelled(cancelled, abort_batch) {
            return Err(DownloadError::Cancelled);
        }
        let status = curl_one_hop(
            &current,
            part,
            headers,
            maximum_bytes,
            cancelled,
            abort_batch,
            file_path,
            on_progress,
        )?;
        if status == 200 {
            let host = url_host(&current)
                .ok_or_else(|| DownloadError::Invalid("final download URL has no host".into()))?;
            return Ok(host.to_string());
        }
        if !matches!(status, 301 | 302 | 303 | 307 | 308) {
            return Err(DownloadError::Failed(format!(
                "download for {file_path} returned HTTP {status}"
            )));
        }
        let location = read_location(headers, status)?;
        let target = validate_redirect(&current, &location, redirects, allowed_hosts)?;
        current = target;
        redirects += 1;
    }
}

fn curl_one_hop<F>(
    url: &str,
    part: &Path,
    headers: &Path,
    maximum_bytes: u64,
    cancelled: &AtomicBool,
    abort_batch: &AtomicBool,
    file_path: &str,
    on_progress: &F,
) -> Result<u16, DownloadError>
where
    F: Fn(DownloadProgress) + Sync,
{
    let _ = fs::remove_file(part);
    let _ = fs::remove_file(headers);
    let executable = resolve_system_curl()?;
    let maximum = maximum_bytes.to_string();
    let mut command = Command::new(executable);
    command.args([
        "--disable",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "120",
        "--max-filesize",
        &maximum,
        "--proto",
        "=https",
        "--dump-header",
    ]);
    command
        .arg(headers)
        .args(["--output"])
        .arg(part)
        .args([
            "--write-out",
            "%{http_code}",
            "--header",
            "User-Agent: MinecraftServerManager/1.0",
        ])
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|error| {
        DownloadError::Failed(format!("could not start trusted system curl.exe: {error}"))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| DownloadError::Failed("curl status stream unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| DownloadError::Failed("curl error stream unavailable".into()))?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, 64));
    let stderr_reader = thread::spawn(move || read_limited(stderr, 8192));
    let mut previous = 0u64;
    let status = loop {
        if is_cancelled(cancelled, abort_batch) {
            terminate_child(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let _ = fs::remove_file(part);
            let _ = fs::remove_file(headers);
            return Err(DownloadError::Cancelled);
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| DownloadError::Failed(error.to_string()))?
        {
            break status;
        }
        let size = fs::metadata(part)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let header_size = fs::metadata(headers)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if size > maximum_bytes || header_size > MAX_HEADER_BYTES {
            terminate_child(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let _ = fs::remove_file(part);
            let _ = fs::remove_file(headers);
            return Err(DownloadError::Failed(format!(
                "download response for {file_path} exceeded its byte or header bound"
            )));
        }
        if size != previous {
            on_progress(DownloadProgress {
                path: file_path.to_string(),
                bytes_received: size,
                expected_bytes: maximum_bytes,
            });
            previous = size;
        }
        thread::sleep(CANCEL_POLL);
    };
    let (stdout, too_large) = stdout_reader
        .join()
        .map_err(|_| DownloadError::Failed("curl status reader failed".into()))?
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    let (stderr, _) = stderr_reader
        .join()
        .map_err(|_| DownloadError::Failed("curl error reader failed".into()))?
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    if too_large {
        return Err(DownloadError::Failed(
            "curl returned an oversized HTTP status".into(),
        ));
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr)
            .chars()
            .filter(|character| !character.is_control())
            .take(1024)
            .collect::<String>();
        return Err(DownloadError::Failed(if detail.trim().is_empty() {
            format!("curl exited with status {}", status.code().unwrap_or(-1))
        } else {
            format!("curl request failed: {}", detail.trim())
        }));
    }
    let status_code = String::from_utf8(stdout)
        .map_err(|_| DownloadError::Failed("curl returned a non-UTF8 status".into()))?
        .trim()
        .parse::<u16>()
        .map_err(|_| DownloadError::Failed("curl returned an invalid HTTP status".into()))?;
    if fs::metadata(headers)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
        == 0
    {
        return Err(DownloadError::Failed(
            "curl response headers were missing".into(),
        ));
    }
    Ok(status_code)
}

fn validate_redirect(
    current: &str,
    location: &str,
    redirect_count: usize,
    allowed_hosts: &[&str],
) -> Result<String, DownloadError> {
    if redirect_count >= MAX_REDIRECTS {
        return Err(DownloadError::Invalid(format!(
            "download exceeded the {MAX_REDIRECTS}-redirect limit"
        )));
    }
    let target = resolve_redirect_target(current, location)?;
    if !trusted_https_url(&target, allowed_hosts) {
        return Err(DownloadError::Invalid(format!(
            "redirect target {} is not on an approved HTTPS host",
            url_host(&target).unwrap_or("invalid host")
        )));
    }
    Ok(target)
}

fn read_location(headers_path: &Path, expected_status: u16) -> Result<String, DownloadError> {
    let metadata = fs::metadata(headers_path).map_err(|error| {
        DownloadError::Failed(format!("could not read response headers: {error}"))
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_HEADER_BYTES {
        return Err(DownloadError::Invalid(
            "redirect response headers are missing or oversized".into(),
        ));
    }
    let bytes = fs::read(headers_path).map_err(|error| DownloadError::Failed(error.to_string()))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| DownloadError::Invalid("redirect response headers are not UTF-8".into()))?;
    let blocks = text
        .split("\r\n\r\n")
        .filter(|block| response_status(block) == Some(expected_status))
        .collect::<Vec<_>>();
    if blocks.len() != 1 {
        return Err(DownloadError::Invalid(
            "redirect response has missing or ambiguous status headers".into(),
        ));
    }
    let locations = blocks[0]
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
        [] => Err(DownloadError::Invalid(
            "redirect response is missing Location".into(),
        )),
        _ => Err(DownloadError::Invalid(
            "redirect response has duplicate or ambiguous Location headers".into(),
        )),
    }
}

fn response_status(block: &str) -> Option<u16> {
    let mut parts = block.lines().next()?.split_ascii_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

fn trusted_https_url(url: &str, allowed_hosts: &[&str]) -> bool {
    url.len() <= MAX_URL_BYTES
        && !url
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        && url_host(url).is_some_and(|host| {
            allowed_hosts
                .iter()
                .any(|allowed| host.eq_ignore_ascii_case(allowed))
        })
}

fn url_host(url: &str) -> Option<&str> {
    let authority = url
        .strip_prefix("https://")?
        .split(['/', '?', '#'])
        .next()?;
    if authority.is_empty() || authority.contains(['@', ':', '\\']) {
        return None;
    }
    Some(authority)
}

fn resolve_redirect_target(current: &str, location: &str) -> Result<String, DownloadError> {
    let location = location.trim();
    if location.is_empty()
        || location.len() > MAX_URL_BYTES
        || location
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(DownloadError::Invalid(
            "redirect Location is malformed".into(),
        ));
    }
    if location.starts_with("https://") || location.starts_with("//") {
        return Ok(if location.starts_with("//") {
            format!("https:{location}")
        } else {
            location.to_string()
        });
    }
    if location
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .contains(':')
    {
        return Err(DownloadError::Invalid(
            "redirect uses an unsupported URL scheme".into(),
        ));
    }
    let host = url_host(current)
        .ok_or_else(|| DownloadError::Invalid("current URL is malformed".into()))?;
    let tail = current
        .strip_prefix("https://")
        .and_then(|tail| tail.get(host.len()..))
        .unwrap_or("/");
    let base_path = tail
        .split(['?', '#'])
        .next()
        .filter(|path| !path.is_empty())
        .unwrap_or("/");
    let location_without_fragment = location.split('#').next().unwrap_or_default();
    let (path, query) = location_without_fragment
        .split_once('?')
        .map(|(path, query)| (path, Some(query)))
        .unwrap_or((location_without_fragment, None));
    let joined = if path.is_empty() && query.is_some() {
        base_path.to_string()
    } else if path.starts_with('/') {
        path.to_string()
    } else {
        let parent = base_path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        format!("{parent}/{path}")
    };
    let normalized = normalize_url_path(&joined)?;
    let query = query.map(|value| format!("?{value}")).unwrap_or_default();
    Ok(format!("https://{host}{normalized}{query}"))
}

fn normalize_url_path(path: &str) -> Result<String, DownloadError> {
    if !path.starts_with('/') || path.contains('\\') {
        return Err(DownloadError::Invalid("redirect path is malformed".into()));
    }
    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            value => components.push(value),
        }
    }
    Ok(format!("/{}", components.join("/")))
}

fn is_cancelled(user: &AtomicBool, abort_batch: &AtomicBool) -> bool {
    user.load(Ordering::Acquire) || abort_batch.load(Ordering::Acquire)
}

fn open_regular_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options.open(path)
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

fn read_limited(reader: impl Read, max_bytes: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    reader.take(max_bytes as u64 + 1).read_to_end(&mut output)?;
    let too_large = output.len() > max_bytes;
    if too_large {
        output.truncate(max_bytes);
    }
    Ok((output, too_large))
}

#[cfg(windows)]
fn resolve_system_curl() -> Result<PathBuf, DownloadError> {
    use std::os::windows::ffi::OsStringExt;

    let mut buffer = vec![0u16; 260];
    loop {
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err(DownloadError::Failed(format!(
                "could not resolve the Windows system directory: {}",
                std::io::Error::last_os_error()
            )));
        }
        let length = length as usize;
        if length >= buffer.len() {
            if length >= 32_768 {
                return Err(DownloadError::Invalid(
                    "Windows system path is too long".into(),
                ));
            }
            buffer.resize(length + 1, 0);
            continue;
        }
        let directory = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
        if !directory.is_absolute() {
            return Err(DownloadError::Invalid(
                "Windows system path is not absolute".into(),
            ));
        }
        let executable = directory.join("curl.exe");
        let metadata = fs::symlink_metadata(&executable).map_err(|error| {
            DownloadError::Failed(format!("system curl.exe is unavailable: {error}"))
        })?;
        if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            return Err(DownloadError::Invalid(
                "system curl.exe is not a regular non-reparse file".into(),
            ));
        }
        return Ok(executable);
    }
}

#[cfg(not(windows))]
fn resolve_system_curl() -> Result<PathBuf, DownloadError> {
    Err(DownloadError::Failed(
        "verified modpack downloads require Windows system curl.exe".into(),
    ))
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
mod cng {
    use std::{
        alloc::{alloc, dealloc, Layout},
        ffi::c_void,
        io,
        ptr::NonNull,
    };

    const MAX_HASH_OBJECT_BYTES: usize = 1024 * 1024;

    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptOpenAlgorithmProvider(
            algorithm: *mut *mut c_void,
            algorithm_id: *const u16,
            implementation: *const u16,
            flags: u32,
        ) -> i32;
        fn BCryptGetProperty(
            object: *mut c_void,
            property: *const u16,
            output: *mut u8,
            output_len: u32,
            result_len: *mut u32,
            flags: u32,
        ) -> i32;
        fn BCryptCreateHash(
            algorithm: *mut c_void,
            hash: *mut *mut c_void,
            hash_object: *mut u8,
            hash_object_len: u32,
            secret: *mut u8,
            secret_len: u32,
            flags: u32,
        ) -> i32;
        fn BCryptHashData(hash: *mut c_void, input: *mut u8, input_len: u32, flags: u32) -> i32;
        fn BCryptFinishHash(hash: *mut c_void, output: *mut u8, output_len: u32, flags: u32)
            -> i32;
        fn BCryptDestroyHash(hash: *mut c_void) -> i32;
        fn BCryptCloseAlgorithmProvider(algorithm: *mut c_void, flags: u32) -> i32;
    }

    pub struct HashPair {
        sha1: HashObject,
        sha512: HashObject,
    }

    impl HashPair {
        pub fn new() -> io::Result<Self> {
            Ok(Self {
                sha1: HashObject::new("SHA1", 20)?,
                sha512: HashObject::new("SHA512", 64)?,
            })
        }

        pub fn update(&mut self, bytes: &[u8]) -> io::Result<()> {
            self.sha1.update(bytes)?;
            self.sha512.update(bytes)
        }

        pub fn finish(self) -> io::Result<(String, String)> {
            let Self { sha1, sha512 } = self;
            Ok((sha1.finish()?, sha512.finish()?))
        }
    }

    struct AlgorithmProvider(NonNull<c_void>);

    impl Drop for AlgorithmProvider {
        fn drop(&mut self) {
            unsafe {
                let _ = BCryptCloseAlgorithmProvider(self.0.as_ptr(), 0);
            }
        }
    }

    struct HashObject {
        _algorithm: AlgorithmProvider,
        hash: NonNull<c_void>,
        object: NonNull<u8>,
        layout: Layout,
        digest_len: usize,
    }

    impl HashObject {
        fn new(name: &str, expected_digest_len: usize) -> io::Result<Self> {
            let algorithm_id = wide(name);
            let mut raw_algorithm = std::ptr::null_mut();
            check(
                unsafe {
                    BCryptOpenAlgorithmProvider(
                        &mut raw_algorithm,
                        algorithm_id.as_ptr(),
                        std::ptr::null(),
                        0,
                    )
                },
                "BCryptOpenAlgorithmProvider",
            )?;
            let algorithm = AlgorithmProvider(
                NonNull::new(raw_algorithm)
                    .ok_or_else(|| io::Error::other("CNG returned a null algorithm handle"))?,
            );
            let object_len = property(algorithm.0, "ObjectLength")? as usize;
            let digest_len = property(algorithm.0, "HashDigestLength")? as usize;
            if object_len == 0
                || object_len > MAX_HASH_OBJECT_BYTES
                || digest_len != expected_digest_len
            {
                return Err(io::Error::other(
                    "CNG reported invalid SHA object or digest length",
                ));
            }
            let layout = Layout::from_size_align(object_len, 16).map_err(io::Error::other)?;
            let object = NonNull::new(unsafe { alloc(layout) })
                .ok_or_else(|| io::Error::other("could not allocate CNG hash state"))?;
            let mut raw_hash = std::ptr::null_mut();
            let status = unsafe {
                BCryptCreateHash(
                    algorithm.0.as_ptr(),
                    &mut raw_hash,
                    object.as_ptr(),
                    object_len as u32,
                    std::ptr::null_mut(),
                    0,
                    0,
                )
            };
            if let Err(error) = check(status, "BCryptCreateHash") {
                unsafe { dealloc(object.as_ptr(), layout) };
                return Err(error);
            }
            let Some(hash) = NonNull::new(raw_hash) else {
                unsafe { dealloc(object.as_ptr(), layout) };
                return Err(io::Error::other("CNG returned a null hash handle"));
            };
            Ok(Self {
                _algorithm: algorithm,
                hash,
                object,
                layout,
                digest_len,
            })
        }

        fn update(&mut self, bytes: &[u8]) -> io::Result<()> {
            let len = u32::try_from(bytes.len())
                .map_err(|_| io::Error::other("CNG input chunk exceeds ULONG"))?;
            check(
                unsafe { BCryptHashData(self.hash.as_ptr(), bytes.as_ptr() as *mut u8, len, 0) },
                "BCryptHashData",
            )
        }

        fn finish(self) -> io::Result<String> {
            let mut digest = vec![0; self.digest_len];
            check(
                unsafe {
                    BCryptFinishHash(
                        self.hash.as_ptr(),
                        digest.as_mut_ptr(),
                        digest.len() as u32,
                        0,
                    )
                },
                "BCryptFinishHash",
            )?;
            Ok(to_hex(&digest))
        }
    }

    impl Drop for HashObject {
        fn drop(&mut self) {
            unsafe {
                let _ = BCryptDestroyHash(self.hash.as_ptr());
                dealloc(self.object.as_ptr(), self.layout);
            }
        }
    }

    fn property(object: NonNull<c_void>, name: &str) -> io::Result<u32> {
        let property_name = wide(name);
        let mut value = 0u32;
        let mut result_len = 0u32;
        check(
            unsafe {
                BCryptGetProperty(
                    object.as_ptr(),
                    property_name.as_ptr(),
                    (&mut value as *mut u32).cast::<u8>(),
                    4,
                    &mut result_len,
                    0,
                )
            },
            "BCryptGetProperty",
        )?;
        if result_len != 4 {
            return Err(io::Error::other("CNG returned an invalid property length"));
        }
        Ok(value)
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(status: i32, operation: &str) -> io::Result<()> {
        if status >= 0 {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "{operation} failed with NTSTATUS 0x{:08x}",
                status as u32
            )))
        }
    }

    fn to_hex(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }
}

#[cfg(not(windows))]
mod cng {
    use std::io;

    pub struct HashPair;

    impl HashPair {
        pub fn new() -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "verified pack downloads require Windows CNG",
            ))
        }
        pub fn update(&mut self, _bytes: &[u8]) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "verified pack downloads require Windows CNG",
            ))
        }
        pub fn finish(self) -> io::Result<(String, String)> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "verified pack downloads require Windows CNG",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_file(path: &str, bytes: &[u8]) -> ProviderFileDownload {
        let hashes = if bytes == b"abc" {
            ContentHashes {
                sha1: "a9993e364706816aba3e25717850c26c9cd0d89d".into(),
                sha512: "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f".into(),
            }
        } else {
            ContentHashes {
                sha1: "0".repeat(40),
                sha512: "0".repeat(128),
            }
        };
        ProviderFileDownload {
            path: path.into(),
            urls: vec!["https://cdn.modrinth.com/file.jar".into()],
            size_bytes: bytes.len() as u64,
            hashes,
        }
    }

    #[test]
    fn temp_volume_preflight_rejects_insufficient_space_before_transfer() {
        let file = fixture_file("mods/example.jar", b"abc");
        let required = file.size_bytes + DOWNLOAD_HEADROOM_BYTES;
        let error = validate_download_space(&[file], required - 1).unwrap_err();
        assert!(error
            .to_string()
            .contains("not enough staging-volume space"));
    }

    #[test]
    fn redirect_fixtures_allow_same_and_source_hosts_but_block_other_hosts_and_schemes() {
        let allowed = ["cdn.modrinth.com", "raw.githubusercontent.com"];
        assert_eq!(
            validate_redirect("https://cdn.modrinth.com/a", "/b", 0, &allowed).unwrap(),
            "https://cdn.modrinth.com/b"
        );
        assert_eq!(
            validate_redirect(
                "https://cdn.modrinth.com/a",
                "https://raw.githubusercontent.com/org/repo/file",
                0,
                &allowed
            )
            .unwrap(),
            "https://raw.githubusercontent.com/org/repo/file"
        );
        assert!(validate_redirect(
            "https://cdn.modrinth.com/a",
            "https://evil.invalid/file",
            0,
            &allowed
        )
        .is_err());
        assert!(validate_redirect(
            "https://cdn.modrinth.com/a",
            "http://raw.githubusercontent.com/file",
            0,
            &allowed
        )
        .is_err());
    }

    #[test]
    fn redirect_fixtures_reject_malformed_or_duplicate_locations_and_limit_to_three_hops() {
        let allowed = ["cdn.modrinth.com"];
        assert!(read_location_from_text("HTTP/1.1 302 Found\r\n\r\n", 302).is_err());
        assert!(read_location_from_text(
            "HTTP/1.1 302 Found\r\nLocation: /a\r\nLocation: /b\r\n\r\n",
            302
        )
        .is_err());
        assert!(
            validate_redirect("https://cdn.modrinth.com/a", "file:///tmp/a", 0, &allowed).is_err()
        );
        let mut current = "https://cdn.modrinth.com/start".to_string();
        for (count, location) in ["/one", "/two", "/three"].into_iter().enumerate() {
            current = validate_redirect(&current, location, count, &allowed).unwrap();
        }
        assert!(validate_redirect(&current, "/four", 3, &allowed)
            .unwrap_err()
            .to_string()
            .contains("3-redirect limit"));
    }

    #[test]
    fn cancellation_and_integrity_failures_remove_partial_files() {
        let root = std::env::temp_dir().join(format!("pipeline-download-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let file = fixture_file("mods/example.jar", b"abc");
        let cancelled = AtomicBool::new(false);
        let abort = AtomicBool::new(false);
        let result = download_one_with_transport(
            &file,
            &root,
            &cancelled,
            &abort,
            |_, part, _, cancelled| {
                fs::write(part, b"partial").unwrap();
                cancelled.store(true, Ordering::Release);
                Err(DownloadError::Cancelled)
            },
        );
        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert!(fs::read_dir(root.join("mods")).unwrap().next().is_none());

        cancelled.store(false, Ordering::Release);
        let wrong_size = ProviderFileDownload {
            size_bytes: 4,
            ..file.clone()
        };
        let result =
            download_one_with_transport(&wrong_size, &root, &cancelled, &abort, |_, part, _, _| {
                fs::write(part, b"abc").unwrap();
                Ok(())
            });
        assert!(result.is_err());
        assert!(fs::read_dir(root.join("mods")).unwrap().next().is_none());

        let wrong_hash = ProviderFileDownload {
            hashes: ContentHashes {
                sha1: "0".repeat(40),
                sha512: "0".repeat(128),
            },
            ..file
        };
        let result =
            download_one_with_transport(&wrong_hash, &root, &cancelled, &abort, |_, part, _, _| {
                fs::write(part, b"abc").unwrap();
                Ok(())
            });
        assert!(result.is_err());
        assert!(fs::read_dir(root.join("mods")).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn batch_abort_cleanup_removes_only_unchanged_verified_downloads() {
        let root = std::env::temp_dir().join(format!(
            "pipeline-download-cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let record = VerifiedDownload {
            path: "mods/verified.jar".into(),
            expected_size_bytes: 3,
            expected_hashes: fixture_file("mods/verified.jar", b"abc").hashes.clone(),
            size_bytes: 3,
            hashes: fixture_file("mods/verified.jar", b"abc").hashes,
            source_host: "cdn.modrinth.com".into(),
        };
        let verified_path = root.join("mods/verified.jar");
        fs::create_dir_all(verified_path.parent().unwrap()).unwrap();
        fs::write(&verified_path, b"abc").unwrap();
        cleanup_verified_downloads(&root, &[record.clone()]);
        assert!(!verified_path.exists());

        fs::write(&verified_path, b"edited").unwrap();
        cleanup_verified_downloads(&root, &[record]);
        assert_eq!(fs::read(&verified_path).unwrap(), b"edited");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cng_matches_known_sha_vectors_and_verifies_file_size() {
        let root =
            std::env::temp_dir().join(format!("pipeline-download-hash-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("abc.bin");
        fs::write(&path, b"abc").unwrap();
        let expected = fixture_file("mods/example.jar", b"abc");
        let hashes = verify_file(
            &path,
            &expected,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(hashes, expected.hashes);
        let wrong = ProviderFileDownload {
            size_bytes: 4,
            ..expected
        };
        assert!(verify_file(
            &path,
            &wrong,
            &AtomicBool::new(false),
            &AtomicBool::new(false)
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn download_one_with_transport<T>(
        file: &ProviderFileDownload,
        staging: &Path,
        cancelled: &AtomicBool,
        abort_batch: &AtomicBool,
        mut transport: T,
    ) -> Result<VerifiedDownload, DownloadError>
    where
        T: FnMut(&str, &Path, &Path, &AtomicBool) -> Result<(), DownloadError>,
    {
        validate_download_metadata(file, MODRINTH_ALLOWED_HOSTS)?;
        let destination = install::safe_target(staging, &file.path)
            .map_err(|error| DownloadError::Invalid(error.to_string()))?;
        let parent = destination.parent().unwrap();
        fs::create_dir_all(parent).map_err(|error| DownloadError::Failed(error.to_string()))?;
        let part = parent.join(format!(".test-{}.part", uuid::Uuid::new_v4()));
        let headers = parent.join(format!(".test-{}.headers", uuid::Uuid::new_v4()));
        let result = (|| {
            for url in &file.urls {
                for _ in 0..MAX_ATTEMPTS_PER_URL {
                    if is_cancelled(cancelled, abort_batch) {
                        return Err(DownloadError::Cancelled);
                    }
                    match transport(url, &part, &headers, cancelled) {
                        Ok(()) => match verify_file(&part, file, cancelled, abort_batch) {
                            Ok(hashes) => {
                                let host = url_host(url).unwrap_or_default().to_string();
                                fs::rename(&part, &destination)
                                    .map_err(|error| DownloadError::Failed(error.to_string()))?;
                                return Ok(VerifiedDownload {
                                    path: file.path.clone(),
                                    expected_size_bytes: file.size_bytes,
                                    expected_hashes: file.hashes.clone(),
                                    size_bytes: file.size_bytes,
                                    hashes,
                                    source_host: host,
                                });
                            }
                            Err(error) => return Err(error),
                        },
                        Err(DownloadError::Cancelled) => return Err(DownloadError::Cancelled),
                        Err(_) => {
                            let _ = fs::remove_file(&part);
                        }
                    }
                }
            }
            Err(DownloadError::Failed("fixture download failed".into()))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&part);
            let _ = fs::remove_file(&headers);
        }
        result
    }

    fn read_location_from_text(
        headers: &str,
        expected_status: u16,
    ) -> Result<String, DownloadError> {
        let root = std::env::temp_dir().join(format!("pipeline-headers-{}", uuid::Uuid::new_v4()));
        fs::write(&root, headers).map_err(|error| DownloadError::Failed(error.to_string()))?;
        let result = read_location(&root, expected_status);
        let _ = fs::remove_file(root);
        result
    }
}
