//! Phase 3 Java discovery and app-local Temurin provisioning.

use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

const SUPPORTED_MAJORS: [u32; 4] = [8, 17, 21, 25];
const MOJANG_MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const DISK_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;
const JAVA_VALIDATE_TIMEOUT: Duration = Duration::from_secs(5);
static JAVA_INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaCandidate {
    pub path: String,
    pub major: u32,
    pub architecture_bits: u32,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaDetection {
    pub mc_version: String,
    pub required_major: u32,
    pub install_major: u32,
    pub candidates: Vec<JavaCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    progress: u32,
    log: String,
}

#[derive(Debug)]
struct TemurinAsset {
    link: String,
    name: String,
    size: u64,
    checksum: String,
}

#[derive(Debug)]
enum MojangFetchError {
    Network(String),
    Request(String),
}

impl MojangFetchError {
    fn into_app_error(self) -> AppError {
        match self {
            Self::Network(message) | Self::Request(message) => AppError::Io(message),
        }
    }
}

/// Tauri command: resolve the selected release's Java minimum and discover compatible runtimes.
#[tauri::command]
pub async fn java_detect(app: AppHandle, mc_version: String) -> Result<JavaDetection, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_data = crate::util::paths::app_data_dir(&app)?;
        detect_java(&app_data, &mc_version)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Java detection task failed: {e}")))?
}

/// Tauri command: validate a JDK home or `java.exe` override before it is used.
#[tauri::command]
pub async fn java_validate(mc_version: String, path: String) -> Result<JavaCandidate, AppError> {
    tauri::async_runtime::spawn_blocking(move || validate_java_for_version(&path, &mc_version))
        .await
        .map_err(|e| AppError::Internal(format!("Java validation task failed: {e}")))?
}

/// Tauri command: install the requested supported Temurin runtime under app data.
#[tauri::command]
pub async fn java_ensure(
    app: AppHandle,
    major: u32,
    job_id: String,
) -> Result<JavaCandidate, AppError> {
    tauri::async_runtime::spawn_blocking(move || ensure_java(&app, major, &job_id))
        .await
        .map_err(|e| AppError::Internal(format!("Java installation task failed: {e}")))?
}

pub fn detect_java(app_data: &Path, mc_version: &str) -> Result<JavaDetection, AppError> {
    ensure_windows_x64()?;
    let required_major = required_java_major(mc_version)?;
    let install_major = install_major_for_requirement(required_major)
        .ok_or_else(|| unsupported_major(required_major))?;

    let mut candidates = Vec::new();
    for (path, source) in discover_candidates(app_data) {
        if let Ok(candidate) = inspect_candidate(&path, &source) {
            if candidate.architecture_bits == 64
                && SUPPORTED_MAJORS.contains(&candidate.major)
                && candidate.major >= required_major
            {
                candidates.push(candidate);
            }
        }
    }
    candidates.sort_by_key(|candidate| candidate.major);

    Ok(JavaDetection {
        mc_version: mc_version.to_string(),
        required_major,
        install_major,
        candidates,
    })
}

/// Resolve and validate a user-provided runtime path against a Minecraft release.
pub fn validate_java_for_version(path: &str, mc_version: &str) -> Result<JavaCandidate, AppError> {
    ensure_windows_x64()?;
    let required = required_java_major(mc_version)?;
    let candidate = inspect_candidate(&resolve_java_executable(path)?, "manual override")?;
    validate_candidate_for_requirement(candidate, required)
}

/// Pick a validated per-server runtime or the best compatible detected runtime.
pub fn resolve_server_java(
    app_data: &Path,
    mc_version: &str,
    selected_path: Option<&str>,
) -> Result<JavaCandidate, AppError> {
    ensure_windows_x64()?;
    let required_major = server_start_java_major(mc_version)?;
    if let Some(path) = selected_path.filter(|path| !path.trim().is_empty()) {
        let executable = resolve_java_executable(path)?;
        let candidate = inspect_candidate(&executable, "selected runtime")?;
        return validate_candidate_for_requirement(candidate, required_major);
    }

    let mut candidates = Vec::new();
    for (path, source) in discover_candidates(app_data) {
        if let Ok(candidate) = inspect_candidate(&path, &source) {
            if let Ok(candidate) = validate_candidate_for_requirement(candidate, required_major) {
                candidates.push(candidate);
            }
        }
    }
    candidates.sort_by_key(|candidate| candidate.major);
    let install_major = install_major_for_requirement(required_major)
        .ok_or_else(|| unsupported_major(required_major))?;
    candidates.into_iter().next().ok_or_else(|| {
        AppError::Validation(format!(
            "No compatible 64-bit Java runtime was found for Minecraft {mc_version} (Java {required_major} required). Install Temurin Java {install_major} or change the Java path in Settings."
        ))
    })
}

/// Start uses the local Java requirement mapping for official release families.
/// Metadata lookups remain part of detection and override validation, but never
/// delay an already-configured server start on Mojang network access.
fn server_start_java_major(mc_version: &str) -> Result<u32, AppError> {
    let version = mc_version.trim();
    let major = fallback_java_major(version).ok_or_else(|| {
        AppError::Validation(format!(
            "No local Java requirement is known for Minecraft '{version}'; select a supported version while online or update the app"
        ))
    })?;
    if install_major_for_requirement(major).is_none() {
        return Err(unsupported_major(major));
    }
    Ok(major)
}

fn validate_candidate_for_requirement(
    candidate: JavaCandidate,
    required_major: u32,
) -> Result<JavaCandidate, AppError> {
    if candidate.architecture_bits != 64 {
        return Err(AppError::Validation(format!(
            "Java at '{}' is {}-bit; Minecraft server runtimes must be 64-bit",
            candidate.path, candidate.architecture_bits
        )));
    }
    if !SUPPORTED_MAJORS.contains(&candidate.major) {
        return Err(unsupported_major(candidate.major));
    }
    if candidate.major < required_major {
        return Err(AppError::Validation(format!(
            "Java {} at '{}' is too old for this Minecraft version; Java {} or later is required",
            candidate.major, candidate.path, required_major
        )));
    }
    Ok(candidate)
}

fn required_java_major(mc_version: &str) -> Result<u32, AppError> {
    ensure_windows_x64()?;
    required_java_major_with_fetch(mc_version, fetch_mojang_json)
}

fn required_java_major_with_fetch<F>(mc_version: &str, mut fetch: F) -> Result<u32, AppError>
where
    F: FnMut(&str) -> Result<Value, MojangFetchError>,
{
    let version = mc_version.trim();
    if version.is_empty() {
        return Err(AppError::Validation(
            "minecraft version is required".to_string(),
        ));
    }
    let fallback = fallback_java_major(version);

    let manifest = match fetch(MOJANG_MANIFEST) {
        Ok(manifest) => manifest,
        Err(MojangFetchError::Network(_)) if fallback.is_some() => return Ok(fallback.unwrap()),
        Err(error) => return Err(error.into_app_error()),
    };
    let versions = manifest
        .get("versions")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Io("Mojang version manifest has no version list".to_string()))?;
    let version_url = versions
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(version))
        .and_then(|item| item.get("url").and_then(Value::as_str))
        .ok_or_else(|| {
            AppError::Validation(format!(
                "Minecraft version '{version}' was not found in Mojang's version manifest"
            ))
        })?;

    let version_json = match fetch(version_url) {
        Ok(version_json) => version_json,
        Err(MojangFetchError::Network(_)) if fallback.is_some() => return Ok(fallback.unwrap()),
        Err(error) => return Err(error.into_app_error()),
    };
    let metadata_major = match version_json.get("javaVersion") {
        None => None,
        Some(Value::Object(java_version)) => match java_version.get("majorVersion") {
            None => None,
            Some(value) => Some(value.as_u64().ok_or_else(|| {
                AppError::Validation(format!(
                    "Mojang reported an invalid Java requirement for Minecraft {version}"
                ))
            })?),
        },
        Some(_) => {
            return Err(AppError::Validation(format!(
                "Mojang reported malformed Java metadata for Minecraft {version}"
            )));
        }
    };
    if let Some(major) = metadata_major {
        let major = u32::try_from(major).map_err(|_| {
            AppError::Validation("Mojang reported an invalid Java major version".to_string())
        })?;
        if major == 0 {
            return Err(AppError::Validation(
                "Mojang reported an invalid Java major version".to_string(),
            ));
        }
        if install_major_for_requirement(major).is_none() {
            return Err(unsupported_major(major));
        }
        return Ok(major);
    }

    let fallback = fallback.ok_or_else(|| {
        AppError::Validation(format!(
            "Mojang metadata does not declare a Java requirement for Minecraft {version}, and no known fallback is available"
        ))
    })?;
    if install_major_for_requirement(fallback).is_none() {
        return Err(unsupported_major(fallback));
    }
    Ok(fallback)
}

fn fetch_mojang_json(url: &str) -> Result<Value, MojangFetchError> {
    ensure_windows_x64().map_err(|error| MojangFetchError::Request(error.to_string()))?;
    let output = run_hidden_output(
        "curl.exe",
        &[
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "20",
            "--max-time",
            "60",
            "--write-out",
            "\\n%{http_code}",
            "--url",
            url,
        ],
    )
    .map_err(|error| {
        MojangFetchError::Request(format!("curl.exe is required for Mojang metadata: {error}"))
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (body, status) = stdout.rsplit_once('\n').ok_or_else(|| {
        MojangFetchError::Request("Mojang metadata response was incomplete".to_string())
    })?;
    let status = status.trim().parse::<u16>().unwrap_or(0);
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if status == 0 || (500..600).contains(&status) {
            return Err(MojangFetchError::Network(format!(
                "Mojang metadata is unavailable over the network: {detail}"
            )));
        }
        return Err(MojangFetchError::Request(format!(
            "Mojang metadata request returned HTTP {status}: {detail}"
        )));
    }
    if !(200..300).contains(&status) {
        return Err(MojangFetchError::Request(format!(
            "Mojang metadata request returned unexpected HTTP status {status}"
        )));
    }
    serde_json::from_str(body)
        .map_err(|error| MojangFetchError::Request(format!("Mojang metadata was invalid: {error}")))
}

fn fallback_java_major(version: &str) -> Option<u32> {
    let parts = version
        .split('.')
        .map(|part| part.parse::<u32>().ok())
        .collect::<Option<Vec<_>>>()?;
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let major = parts[0];
    let minor = parts[1];
    let patch = parts.get(2).copied().unwrap_or(0);
    match (major, minor) {
        (1, 0..=16) => Some(8),
        (1, 17) => Some(16),
        (1, 18..=19) => Some(17),
        (1, 20) if patch <= 4 => Some(17),
        (1, 20) => Some(21),
        (1, 21) => Some(21),
        (26, 1) => Some(25),
        _ => None,
    }
}

fn install_major_for_requirement(required: u32) -> Option<u32> {
    SUPPORTED_MAJORS
        .into_iter()
        .find(|major| *major >= required)
}

fn unsupported_major(major: u32) -> AppError {
    AppError::Validation(format!(
        "Java {major} is outside this app's supported runtime set (8, 17, 21, 25). Minecraft versions requiring a newer Java major need an app update."
    ))
}

fn resolve_java_executable(path: &str) -> Result<PathBuf, AppError> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(AppError::Validation("Java path is required".to_string()));
    }
    let supplied = PathBuf::from(raw);
    let executable = if supplied.is_dir() {
        supplied.join("bin").join("java.exe")
    } else {
        supplied
    };
    if !executable.is_file() {
        return Err(AppError::Validation(format!(
            "Java executable was not found at '{}'; enter a JDK home or its bin\\java.exe",
            executable.display()
        )));
    }
    let file_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !file_name.eq_ignore_ascii_case("java.exe") {
        return Err(AppError::Validation(
            "Java path must be a JDK home directory or a java.exe file".to_string(),
        ));
    }
    fs::canonicalize(&executable).map_err(|e| {
        AppError::Validation(format!(
            "could not resolve Java executable '{}': {e}",
            executable.display()
        ))
    })
}

fn inspect_candidate(path: &Path, source: &str) -> Result<JavaCandidate, AppError> {
    ensure_windows_x64()?;
    let executable = resolve_java_executable(&path.to_string_lossy())?;
    let mut command = Command::new(&executable);
    command
        .args(["-XshowSettings:properties", "-version"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| {
        AppError::Validation(format!(
            "could not execute Java at '{}': {e}",
            executable.display()
        ))
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("Java validation stdout was not captured".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("Java validation stderr was not captured".to_string()))?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, 64 * 1024));
    let stderr_reader = thread::spawn(move || read_limited(stderr, 64 * 1024));

    let deadline = Instant::now() + JAVA_VALIDATE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Validation(format!(
                    "could not inspect Java at '{}': {error}",
                    executable.display()
                )));
            }
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if status.is_none() {
        return Err(AppError::Validation(format!(
            "Java at '{}' did not respond within {} seconds",
            executable.display(),
            JAVA_VALIDATE_TIMEOUT.as_secs()
        )));
    }
    if !status.map(|s| s.success()).unwrap_or(false) {
        return Err(AppError::Validation(format!(
            "Java at '{}' could not be run successfully",
            executable.display()
        )));
    }

    let output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );
    let major = parse_java_major(&output).ok_or_else(|| {
        AppError::Validation(format!(
            "Java at '{}' did not report a usable specification version",
            executable.display()
        ))
    })?;
    let architecture_bits = parse_architecture_bits(&output).ok_or_else(|| {
        AppError::Validation(format!(
            "Java at '{}' did not report its architecture; use a 64-bit JDK",
            executable.display()
        ))
    })?;

    Ok(JavaCandidate {
        path: executable.to_string_lossy().into_owned(),
        major,
        architecture_bits,
        source: source.to_string(),
    })
}

fn read_limited(reader: impl Read, max: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = reader.take(max as u64).read_to_end(&mut bytes);
    bytes
}

fn parse_java_major(output: &str) -> Option<u32> {
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once('=') {
            if key.trim() == "java.specification.version" {
                if let Some(major) = parse_version_major(value.trim().trim_matches('"')) {
                    return Some(major);
                }
            }
        }
        if trimmed.starts_with("java version ") || trimmed.starts_with("openjdk version ") {
            if let Some((_, rest)) = trimmed.split_once('"') {
                if let Some((version, _)) = rest.split_once('"') {
                    if let Some(major) = parse_version_major(version) {
                        return Some(major);
                    }
                }
            }
        }
    }
    None
}

fn parse_version_major(version: &str) -> Option<u32> {
    let version = version.trim();
    if let Some(rest) = version.strip_prefix("1.") {
        return rest.split(['.', '_', '+', '-']).next()?.parse().ok();
    }
    version.split(['.', '_', '+', '-']).next()?.parse().ok()
}

fn parse_architecture_bits(output: &str) -> Option<u32> {
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            let value = value.trim().trim_matches('"');
            if key == "sun.arch.data.model" {
                return value.parse().ok();
            }
        }
    }
    None
}

fn discover_candidates(app_data: &Path) -> Vec<(PathBuf, String)> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let mut found = Vec::new();
        if let Some(home) = std::env::var_os("JAVA_HOME") {
            found.push((PathBuf::from(home), "JAVA_HOME".to_string()));
        }
        if let Ok(output) = run_hidden_output("where.exe", &["java.exe"]) {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    found.push((PathBuf::from(line.trim()), "PATH".to_string()));
                }
            }
        }
        found.extend(registry_candidates());
        found.extend(known_location_candidates());
        found.extend(managed_location_candidates(app_data));

        let mut seen = HashSet::new();
        found
            .into_iter()
            .filter_map(|(path, source)| {
                let executable = resolve_java_executable(&path.to_string_lossy()).ok()?;
                let key = executable.to_string_lossy().to_lowercase();
                if seen.insert(key) {
                    Some((executable, source))
                } else {
                    None
                }
            })
            .take(32)
            .collect()
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = app_data;
        Vec::new()
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn managed_location_candidates(app_data: &Path) -> Vec<(PathBuf, String)> {
    let root = app_data.join("java");
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy();
            if name.starts_with("temurin-") && path.join("bin").join("java.exe").is_file() {
                Some((path, "Temurin (app managed)".to_string()))
            } else {
                None
            }
        })
        .collect()
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn registry_candidates() -> Vec<(PathBuf, String)> {
    const KEYS: &[&str] = &[
        r"HKLM\SOFTWARE\JavaSoft\JDK",
        r"HKLM\SOFTWARE\JavaSoft\Java Development Kit",
        r"HKLM\SOFTWARE\Eclipse Adoptium",
        r"HKLM\SOFTWARE\Microsoft\JDK",
        r"HKLM\SOFTWARE\WOW6432Node\JavaSoft\JDK",
        r"HKCU\SOFTWARE\JavaSoft\JDK",
        r"HKCU\SOFTWARE\Eclipse Adoptium",
        r"HKCU\SOFTWARE\Microsoft\JDK",
    ];
    let mut paths = Vec::new();
    for key in KEYS {
        let Ok(output) = run_hidden_output("reg.exe", &["query", key, "/s"]) else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Some((_, value)) = line.split_once("REG_SZ") else {
                if let Some((_, value)) = line.split_once("REG_EXPAND_SZ") {
                    let value = expand_windows_env_variables(value.trim());
                    if !value.is_empty() {
                        paths.push((PathBuf::from(value), "Windows registry".to_string()));
                    }
                }
                continue;
            };
            let value = value.trim();
            if !value.is_empty() {
                paths.push((PathBuf::from(value), "Windows registry".to_string()));
            }
        }
    }
    paths
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn expand_windows_env_variables(value: &str) -> String {
    let mut expanded = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            expanded.push(ch);
            continue;
        }
        let mut name = String::new();
        for next in chars.by_ref() {
            if next == '%' {
                break;
            }
            name.push(next);
        }
        if name.is_empty() {
            expanded.push('%');
        } else if let Some(value) = std::env::var_os(&name) {
            expanded.push_str(&value.to_string_lossy());
        } else {
            expanded.push('%');
            expanded.push_str(&name);
            expanded.push('%');
        }
    }
    expanded
}

#[cfg(all(windows, target_arch = "x86_64"))]
fn known_location_candidates() -> Vec<(PathBuf, String)> {
    let mut roots = Vec::new();
    let program_files = std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(PathBuf::from);
    if let Some(program_files) = program_files {
        roots.extend([
            (program_files.join("Eclipse Adoptium"), "Adoptium location"),
            (
                program_files.join("Microsoft"),
                "Microsoft OpenJDK location",
            ),
            (program_files.join("Java"), "Java install location"),
        ]);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        roots.extend([
            (
                local.join("Programs").join("Eclipse Adoptium"),
                "Adoptium user location",
            ),
            (
                local.join("Programs").join("Microsoft"),
                "Microsoft OpenJDK user location",
            ),
        ]);
    }

    let mut paths = Vec::new();
    for (root, source) in roots {
        let direct = root.join("bin").join("java.exe");
        if direct.is_file() {
            paths.push((root.clone(), source.to_string()));
        }
        let Ok(children) = fs::read_dir(&root) else {
            continue;
        };
        for child in children.flatten() {
            let child_path = child.path();
            if child_path.is_dir() && child_path.join("bin").join("java.exe").is_file() {
                paths.push((child_path, source.to_string()));
            }
        }
    }
    paths
}

fn ensure_java(app: &AppHandle, major: u32, job_id: &str) -> Result<JavaCandidate, AppError> {
    ensure_windows_x64()?;
    validate_job_id(job_id)?;
    if !SUPPORTED_MAJORS.contains(&major) {
        return Err(unsupported_major(major));
    }

    emit_progress(app, job_id, 1, "Waiting for the Java installer…");
    let _install_guard = JAVA_INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    emit_progress(app, job_id, 1, &format!("Preparing Temurin Java {major}…"));
    let app_data = crate::util::paths::app_data_dir(app)?;
    let java_root = app_data.join("java");
    fs::create_dir_all(&java_root)?;
    if let Some(installed) = find_managed_runtime(&java_root, major) {
        emit_progress(app, job_id, 100, &format!("Temurin Java {major} is ready."));
        return Ok(installed);
    }

    emit_progress(
        app,
        job_id,
        5,
        "Looking up the latest GA Windows x64 Temurin JDK…",
    );
    let asset = fetch_temurin_asset(major)?;
    let checksum = asset.checksum.to_lowercase();
    let downloads = java_root.join("downloads");
    fs::create_dir_all(&downloads)?;
    let archive = downloads.join(format!("{checksum}.zip.part"));
    let headers = downloads.join(format!("{checksum}.headers"));
    preflight_disk_space(
        &java_root,
        asset.size,
        fs::metadata(&archive).map(|m| m.len()).unwrap_or(0),
    )?;

    emit_progress(app, job_id, 8, &format!("Downloading {}…", asset.name));
    download_asset(app, job_id, &asset, &archive, &headers)?;

    emit_progress(
        app,
        job_id,
        80,
        "Checking Temurin archive size and SHA-256…",
    );
    let archive_size = fs::metadata(&archive)?.len();
    if archive_size != asset.size {
        let _ = fs::remove_file(&archive);
        return Err(AppError::Io(format!(
            "Temurin archive size did not match the release metadata (expected {} bytes, got {}). The partial file was removed; retry the installation.",
            asset.size, archive_size
        )));
    }
    let actual_checksum = sha256_file(&archive)?;
    if !actual_checksum.eq_ignore_ascii_case(&asset.checksum) {
        let _ = fs::remove_file(&archive);
        return Err(AppError::Io(
            "Temurin archive SHA-256 did not match the release metadata. The partial file was removed; retry the installation.".to_string(),
        ));
    }

    let staging = java_root.join(format!("staging-{checksum}"));
    let extract = staging.join("extract");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&extract)?;
    emit_progress(
        app,
        job_id,
        85,
        "Extracting the verified JDK into a staging folder…",
    );
    let tar_args = [
        "-xf".to_string(),
        archive.to_string_lossy().into_owned(),
        "-C".to_string(),
        extract.to_string_lossy().into_owned(),
    ];
    let tar_refs: Vec<&str> = tar_args.iter().map(String::as_str).collect();
    let tar = run_hidden_output("tar.exe", &tar_refs).map_err(|_| {
        AppError::Validation(
            "Windows tar.exe is required to extract the Temurin ZIP; install Windows updates and retry".to_string(),
        )
    })?;
    if !tar.status.success() {
        let _ = fs::remove_dir_all(&staging);
        return Err(AppError::Io(format!(
            "Windows tar.exe could not extract the Temurin archive: {}",
            String::from_utf8_lossy(&tar.stderr).trim()
        )));
    }

    let extracted_home = find_jdk_home(&extract)
        .ok_or_else(|| AppError::Io("Temurin archive did not contain bin\\java.exe".to_string()))?;
    emit_progress(app, job_id, 93, "Verifying the staged Java runtime…");
    let staged = inspect_candidate(&extracted_home, "Temurin (app managed)")?;
    if staged.major != major || staged.architecture_bits != 64 {
        let _ = fs::remove_dir_all(&staging);
        return Err(AppError::Validation(format!(
            "Downloaded Temurin package reported Java {} with {}-bit architecture; Java {major} 64-bit was expected",
            staged.major, staged.architecture_bits
        )));
    }

    let final_dir = java_root.join(format!("temurin-{major}-{}", &checksum[..12]));
    let _ = fs::remove_dir_all(&final_dir);
    fs::rename(&extracted_home, &final_dir)
        .map_err(|e| AppError::Io(format!("could not publish the verified Java runtime: {e}")))?;
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&archive);
    let _ = fs::remove_file(&headers);

    let executable = final_dir.join("bin").join("java.exe");
    let published = inspect_candidate(&executable, "Temurin (app managed)")?;
    if published.major != major || published.architecture_bits != 64 {
        return Err(AppError::Validation(
            "published Temurin runtime did not pass final Java validation".to_string(),
        ));
    }
    emit_progress(app, job_id, 100, &format!("Temurin Java {major} is ready."));
    Ok(published)
}

fn find_managed_runtime(root: &Path, major: u32) -> Option<JavaCandidate> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name()?.to_string_lossy();
        if !name.starts_with(&format!("temurin-{major}-")) {
            continue;
        }
        let executable = path.join("bin").join("java.exe");
        if let Ok(candidate) = inspect_candidate(&executable, "Temurin (app managed)") {
            if candidate.major == major && candidate.architecture_bits == 64 {
                return Some(candidate);
            }
        }
    }
    None
}

fn fetch_temurin_asset(major: u32) -> Result<TemurinAsset, AppError> {
    let endpoint = format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?architecture=x64&image_type=jdk&os=windows&release_type=ga&vendor=eclipse"
    );
    let bytes = curl_capture(&[
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "20",
        "--max-time",
        "60",
        "--url",
        &endpoint,
    ])?;
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Io(format!("Adoptium asset metadata was invalid: {e}")))?;
    let items = payload.as_array().ok_or_else(|| {
        AppError::Io(format!("Adoptium returned no Temurin Java {major} package"))
    })?;
    let package = items
        .iter()
        .find_map(|item| item.get("binary").and_then(|binary| binary.get("package")))
        .ok_or_else(|| {
            AppError::Io(format!(
                "Temurin Java {major} JDK ZIP is unavailable for Windows x64"
            ))
        })?;
    let link = package
        .get("link")
        .and_then(Value::as_str)
        .filter(|link| link.starts_with("https://"))
        .ok_or_else(|| {
            AppError::Io("Adoptium package did not include an HTTPS link".to_string())
        })?;
    let name = package.get("name").and_then(Value::as_str).ok_or_else(|| {
        AppError::Io("Adoptium package did not include its archive name".to_string())
    })?;
    if !name.to_ascii_lowercase().ends_with(".zip") {
        return Err(AppError::Io(
            "Adoptium did not return a ZIP archive".to_string(),
        ));
    }
    let size = package
        .get("size")
        .and_then(Value::as_u64)
        .filter(|size| *size > 0)
        .ok_or_else(|| {
            AppError::Io("Adoptium package did not include a valid expected size".to_string())
        })?;
    let checksum = package
        .get("checksum")
        .and_then(Value::as_str)
        .filter(|sum| sum.len() == 64 && sum.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| {
            AppError::Io("Adoptium package did not include a valid SHA-256 checksum".to_string())
        })?;

    Ok(TemurinAsset {
        link: link.to_string(),
        name: name.to_string(),
        size,
        checksum: checksum.to_string(),
    })
}

fn preflight_disk_space(
    root: &Path,
    archive_size: u64,
    existing_partial: u64,
) -> Result<(), AppError> {
    // Temurin's expanded tree is budgeted at twice the ZIP size, plus a 512 MiB headroom.
    let remaining_archive = archive_size.saturating_sub(existing_partial.min(archive_size));
    let required = remaining_archive
        .saturating_add(archive_size.saturating_mul(2))
        .saturating_add(DISK_HEADROOM_BYTES);
    let free = free_disk_space(root)?;
    if free < required {
        return Err(AppError::Validation(format!(
            "not enough free disk space to install Temurin (need about {:.1} GiB; {:.1} GiB available)",
            required as f64 / 1_073_741_824.0,
            free as f64 / 1_073_741_824.0
        )));
    }
    Ok(())
}

/// Resolve the path to pass to `GetDiskFreeSpaceExW`, which requires a directory.
/// A staged file leaf (especially non-ASCII, e.g. U+2122 TM) fails directory
/// validation with ERROR_DIRECTORY 267, so file paths resolve to their
/// containing directory. Directory inputs are returned unchanged.
fn disk_space_query_path(path: &Path) -> &Path {
    if path.is_dir() {
        return path;
    }
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => path,
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub(crate) fn free_disk_space(path: &Path) -> Result<u64, AppError> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available: *mut u64,
            total_number_of_bytes: *mut u64,
            total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    let query_path = disk_space_query_path(path);
    let mut wide: Vec<u16> = query_path.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut available = 0u64;
    // The total-volume outputs are optional for this free-space preflight.
    let result = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if result == 0 {
        return Err(AppError::Io(format!(
            "could not check free disk space for '{}': {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    Ok(available)
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
pub(crate) fn free_disk_space(_path: &Path) -> Result<u64, AppError> {
    Err(platform_error())
}

fn download_asset(
    app: &AppHandle,
    job_id: &str,
    asset: &TemurinAsset,
    archive: &Path,
    headers: &Path,
) -> Result<(), AppError> {
    let existing = fs::metadata(archive).map(|m| m.len()).unwrap_or(0);
    if existing == asset.size {
        return Ok(());
    }
    if existing > 0 {
        let status = curl_download(app, job_id, asset, archive, headers, true)?;
        let valid_range = headers_contain_range(headers, existing, asset.size);
        if valid_range {
            if status.success() {
                return Ok(());
            }
            // A valid 206 response may have stopped mid-transfer; preserve its bytes for resume.
            return Err(AppError::Io(
                "Temurin download stopped before completion. The asset partial was kept; retry to resume.".to_string(),
            ));
        }
        if last_http_status(headers).is_none() {
            // A connection failure before an HTTP response leaves the old partial unchanged.
            return Err(AppError::Io(
                "Could not reach the Temurin download server. The existing partial was kept; retry to resume.".to_string(),
            ));
        }
        // No valid byte-range response means the server ignored or rejected resume.
        let _ = fs::remove_file(archive);
        let _ = fs::remove_file(headers);
    }

    let _ = fs::remove_file(archive);
    let _ = fs::remove_file(headers);
    let status = curl_download(app, job_id, asset, archive, headers, false)?;
    if !status.success() {
        let response_status = last_http_status(headers).unwrap_or_default();
        if response_status >= 400 {
            let _ = fs::remove_file(archive);
        }
        return Err(AppError::Io(
            "Temurin download failed. Retry the installation; an incomplete transfer can be resumed.".to_string(),
        ));
    }
    if last_http_status(headers) != Some(200) {
        let _ = fs::remove_file(archive);
        return Err(AppError::Io(
            "Temurin download returned an unexpected HTTP response; retry the installation"
                .to_string(),
        ));
    }
    Ok(())
}

fn curl_download(
    app: &AppHandle,
    job_id: &str,
    asset: &TemurinAsset,
    archive: &Path,
    headers: &Path,
    resume: bool,
) -> Result<std::process::ExitStatus, AppError> {
    let _ = fs::remove_file(headers);
    let mut command = Command::new(inbox_tool("curl.exe"));
    command
        .args([
            "--fail",
            "--location",
            "--show-error",
            "--progress-bar",
            "--connect-timeout",
            "30",
        ])
        .arg("--dump-header")
        .arg(headers)
        .arg("--output")
        .arg(archive);
    if resume {
        command.args(["--continue-at", "-"]);
    }
    command.arg("--url").arg(&asset.link);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| {
        AppError::Validation(format!(
            "curl.exe is required to download Java; Windows could not start curl.exe: {e}"
        ))
    })?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Internal("curl progress output was not captured".to_string()))?;
    let app = app.clone();
    let job_id = job_id.to_string();
    let progress_reader = thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut pending = Vec::new();
        let mut byte = [0u8; 1];
        let mut last_progress = 7u32;
        while reader.read_exact(&mut byte).is_ok() {
            if byte[0] == b'\r' || byte[0] == b'\n' {
                if let Some(percent) = percent_from_line(&pending) {
                    let fraction = (percent / 100.0).clamp(0.0, 1.0);
                    let progress = 8 + ((fraction * 70.0) as u32);
                    if progress > last_progress {
                        emit_progress(
                            &app,
                            &job_id,
                            progress,
                            &format!("Downloading Temurin archive… {percent:.0}%"),
                        );
                        last_progress = progress;
                    }
                }
                pending.clear();
            } else if pending.len() < 2048 {
                pending.push(byte[0]);
            }
        }
    });
    let status = child.wait()?;
    let _ = progress_reader.join();
    Ok(status)
}

fn percent_from_line(line: &[u8]) -> Option<f64> {
    let line = String::from_utf8_lossy(line);
    let before_percent = line.rsplit_once('%')?.0;
    let number = before_percent
        .chars()
        .rev()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    number.parse().ok()
}

fn headers_contain_range(headers: &Path, expected_start: u64, expected_total: u64) -> bool {
    let Ok(text) = fs::read_to_string(headers) else {
        return false;
    };
    range_headers_match_text(&text, expected_start, expected_total)
}

fn range_headers_match_text(text: &str, expected_start: u64, expected_total: u64) -> bool {
    let status = last_http_status_text(text);
    if status != Some(206) {
        return false;
    }
    for line in text.lines().rev() {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-range") {
                let Some((unit, range)) = value.trim().split_once(' ') else {
                    return false;
                };
                if !unit.eq_ignore_ascii_case("bytes") {
                    return false;
                }
                let Some((start, remainder)) = range.split_once('-') else {
                    return false;
                };
                let Some((end, total)) = remainder.split_once('/') else {
                    return false;
                };
                return start.parse::<u64>().ok() == Some(expected_start)
                    && end.parse::<u64>().ok().and_then(|end| end.checked_add(1))
                        == Some(expected_total)
                    && total.parse::<u64>().ok() == Some(expected_total);
            }
        }
        if line.to_ascii_uppercase().starts_with("HTTP/") {
            break;
        }
    }
    false
}

fn last_http_status(path: &Path) -> Option<u16> {
    let text = fs::read_to_string(path).ok()?;
    last_http_status_text(&text)
}

fn last_http_status_text(headers: &str) -> Option<u16> {
    headers
        .lines()
        .filter_map(|line| {
            if !line.to_ascii_uppercase().starts_with("HTTP/") {
                return None;
            }
            line.split_whitespace().nth(1)?.parse().ok()
        })
        .next_back()
}

fn sha256_file(path: &Path) -> Result<String, AppError> {
    let output = run_hidden_output(
        "certutil.exe",
        &["-hashfile", &path.to_string_lossy(), "SHA256"],
    )
    .map_err(|e| {
        AppError::Validation(format!(
            "certutil.exe is required to verify Java downloads: {e}"
        ))
    })?;
    if !output.status.success() {
        return Err(AppError::Io(
            "certutil.exe could not calculate the Temurin SHA-256".to_string(),
        ));
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let candidate: String = line.chars().filter(|c| !c.is_whitespace()).collect();
        if candidate.len() == 64 && candidate.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(candidate.to_ascii_lowercase());
        }
    }
    Err(AppError::Io(
        "certutil.exe returned no SHA-256 digest".to_string(),
    ))
}

fn find_jdk_home(extract: &Path) -> Option<PathBuf> {
    let direct = extract.join("bin").join("java.exe");
    if direct.is_file() {
        return Some(extract.to_path_buf());
    }
    for entry in fs::read_dir(extract).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("bin").join("java.exe").is_file() {
            return Some(path);
        }
    }
    None
}

fn curl_capture(args: &[&str]) -> Result<Vec<u8>, AppError> {
    ensure_windows_x64()?;
    let output = run_hidden_output("curl.exe", args).map_err(|e| {
        AppError::Validation(format!(
            "curl.exe is required for Java metadata and downloads: {e}"
        ))
    })?;
    if !output.status.success() {
        return Err(AppError::Io(format!(
            "could not retrieve Java metadata: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

fn run_hidden_output(program: &str, args: &[&str]) -> std::io::Result<Output> {
    let mut command = Command::new(inbox_tool(program));
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    command.output()
}

fn inbox_tool(name: &str) -> PathBuf {
    let windows_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    windows_root.join("System32").join(name)
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn emit_progress(app: &AppHandle, job_id: &str, progress: u32, log: &str) {
    let _ = app.emit(
        &crate::util::events::job_progress_event(job_id),
        JobProgress {
            progress: progress.min(100),
            log: log.to_string(),
        },
    );
}

fn validate_job_id(job_id: &str) -> Result<(), AppError> {
    if job_id.is_empty()
        || job_id.len() > 80
        || !job_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::Validation(
            "invalid Java install job id".to_string(),
        ));
    }
    Ok(())
}

fn ensure_windows_x64() -> Result<(), AppError> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        Ok(())
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        Err(platform_error())
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn platform_error() -> AppError {
    AppError::Validation("Java provisioning is supported on Windows x64 only".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_versions_use_offline_fallbacks_when_mojang_is_unreachable() {
        for (version, expected) in [("1.12.2", 8_u32), ("1.20.1", 17_u32), ("1.21", 21_u32)] {
            let resolved = required_java_major_with_fetch(version, |_| {
                Err(MojangFetchError::Network("offline".to_string()))
            });
            assert_eq!(resolved.unwrap(), expected, "version {version}");
        }
    }

    #[test]
    fn unknown_versions_still_fail_closed_when_mojang_is_unreachable() {
        let resolved = required_java_major_with_fetch("1.22.1", |_| {
            Err(MojangFetchError::Network("offline".to_string()))
        });
        assert!(matches!(resolved, Err(AppError::Io(_))));
    }

    #[test]
    fn explicit_unsupported_mojang_major_does_not_use_a_known_fallback() {
        let resolved = required_java_major_with_fetch("1.12.2", |url| {
            if url == MOJANG_MANIFEST {
                Ok(serde_json::json!({
                    "versions": [{"id": "1.12.2", "url": "version-json"}]
                }))
            } else {
                Ok(serde_json::json!({
                    "javaVersion": {"majorVersion": 26}
                }))
            }
        });
        assert!(matches!(resolved, Err(AppError::Validation(_))));
    }

    #[test]
    fn resume_requires_a_bytes_content_range_unit() {
        let valid = "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 10-19/20\r\n";
        let wrong_unit = "HTTP/1.1 206 Partial Content\r\nContent-Range: items 10-19/20\r\n";
        assert!(range_headers_match_text(valid, 10, 20));
        assert!(!range_headers_match_text(wrong_unit, 10, 20));
    }

    #[test]
    fn server_start_java_major_maps_catalogue_and_rejects_unknown_versions() {
        for (version, expected) in [
            ("1.0", 8_u32),
            ("1.12.2", 8_u32),
            ("1.16.5", 8_u32),
            ("1.17.1", 16_u32),
            ("1.18.2", 17_u32),
            ("1.19.2", 17_u32),
            ("1.20.1", 17_u32),
            ("1.20.4", 17_u32),
            ("1.20.6", 21_u32),
            ("1.21", 21_u32),
            ("1.21.11", 21_u32),
            ("26.1", 25_u32),
            ("26.1.1", 25_u32),
        ] {
            assert_eq!(server_start_java_major(version).unwrap(), expected);
        }
        for version in ["1.22.1", "27.1"] {
            assert!(matches!(
                server_start_java_major(version),
                Err(AppError::Validation(_))
            ));
        }
    }

    fn unique_disk_space_dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mc-server-manager-disk-space-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn disk_space_query_path_resolves_tm_leaf_file_to_parent() {
        let dir = unique_disk_space_dir("tm");
        let tm_file = dir.join("Prominence\u{2122}_II_test.zip");
        std::fs::write(&tm_file, b"fixture").unwrap();
        let ascii_file = dir.join("plain-pack.zip");
        std::fs::write(&ascii_file, b"fixture").unwrap();

        assert_eq!(disk_space_query_path(&tm_file), dir.as_path());
        assert_eq!(disk_space_query_path(&ascii_file), dir.as_path());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_space_query_path_keeps_directories_unchanged() {
        let dir = unique_disk_space_dir("dir");
        assert_eq!(disk_space_query_path(&dir), dir.as_path());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_space_query_path_bare_filename_falls_back_to_original() {
        let bare = Path::new("lonely.zip");
        assert_eq!(disk_space_query_path(bare), bare);
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn free_disk_space_tm_leaf_matches_directory() {
        let dir = unique_disk_space_dir("free");
        let tm_file = dir.join("Prominence\u{2122}_II_Hasturian_Era_test.zip");
        std::fs::write(&tm_file, b"fixture").unwrap();
        let ascii_file = dir.join("plain-pack.zip");
        std::fs::write(&ascii_file, b"fixture").unwrap();

        let from_dir = free_disk_space(&dir).unwrap();
        let from_tm = free_disk_space(&tm_file).unwrap();
        let from_ascii = free_disk_space(&ascii_file).unwrap();

        assert_eq!(from_tm, from_dir);
        assert_eq!(from_ascii, from_dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn free_disk_space_insufficient_space_stays_a_validation_message() {
        let dir = unique_disk_space_dir("headroom");
        let available = free_disk_space(&dir).unwrap();
        let required = available.saturating_add(1);
        let error = preflight_disk_space(&dir, required, 0).unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("not enough free disk space"),
            "unexpected message: {message}"
        );
        assert!(
            !message.contains("267"),
            "must not regress to os error 267: {message}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
