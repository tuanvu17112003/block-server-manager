//! Safe parsing and extraction helpers for Modrinth `.mrpack` server installs.

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::Value;
use zip::ZipArchive;

use crate::{
    error::AppError,
    installer::{self, JobControl},
};

pub(crate) const MAX_MRPACK_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 100_000;
pub(crate) const MAX_EXPANDED_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FABRIC_MOD_JAR_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FABRIC_MOD_JSON_BYTES: u64 = 1024 * 1024;
const MAX_FABRIC_NESTED_MOD_DEPTH: usize = 8;
const MAX_FABRIC_DEPENDENCY_CANDIDATES: usize = 2048;
const MAX_FABRIC_DEPENDENCY_SCRATCH_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FABRIC_DEPENDENCY_METADATA_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FABRIC_DEPENDENCY_CENTRAL_ENTRIES: usize = 2_000_000;
const MAX_FABRIC_NESTED_DECLARATIONS: usize = 4096;

const RESERVED_ROOT_FILES: &[&str] = &[
    "eula.txt",
    "installer.log",
    "modrinth-pack.mrpack",
    "run.bat",
    "run.sh",
    "server.jar",
    "user_jvm_args.txt",
];
const RESERVED_ROOT_DIRS: &[&str] = &["backups", "libraries", "logs", "server", "world"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModpackInstallInput {
    pub name: String,
    pub minecraft_version: String,
    pub loader: String,
    pub port: Option<u16>,
    pub ram_mb: i64,
    pub java_path: Option<String>,
    pub eula_accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManifestPlan {
    pub minecraft_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub required_files: Vec<RequiredFile>,
    pub skipped_files: usize,
    pub skipped_server_paths: Vec<String>,
    pub override_entries: Vec<OverrideEntry>,
    pub required_bytes: u64,
    pub override_bytes: u64,
    pub expanded_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MrpackLoader {
    Vanilla,
    Fabric,
    Forge,
    NeoForge,
    Quilt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MrpackMetadata {
    pub format_version: u32,
    pub game: String,
    pub name: String,
    pub display_version_id: String,
    pub minecraft_version: String,
    pub loader: MrpackLoader,
    pub loader_version: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum MrpackMetadataError {
    #[error("invalid Modrinth pack metadata: {0}")]
    Invalid(String),
    #[error("unsupported Modrinth pack metadata: {0}")]
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RequiredFile {
    pub path: String,
    pub urls: Vec<String>,
    pub size: u64,
    pub sha1: String,
    pub sha512: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MrpackEnvironmentPolicy {
    Required,
    Optional,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MrpackPipelineFile {
    pub path: String,
    pub downloads: Vec<String>,
    pub size: u64,
    pub sha1: String,
    pub sha512: String,
    pub client: Option<MrpackEnvironmentPolicy>,
    pub server: Option<MrpackEnvironmentPolicy>,
    pub server_environment_missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MrpackPipelineIndex {
    pub metadata: MrpackMetadata,
    pub files: Vec<MrpackPipelineFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OverrideEntry {
    index: usize,
    path: String,
    size: u64,
    is_dir: bool,
    layer: OverrideLayer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverrideLayer {
    Shared,
    Server,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexManifest {
    format_version: u32,
    game: String,
    name: String,
    version_id: String,
    files: Vec<IndexFile>,
    dependencies: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MrpackMetadataIndex {
    format_version: u32,
    game: String,
    name: String,
    version_id: String,
    files: Vec<Value>,
    dependencies: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexFile {
    path: String,
    hashes: IndexHashes,
    downloads: Vec<String>,
    file_size: u64,
    env: Option<IndexFileEnvironment>,
}

#[derive(Debug, Deserialize)]
struct IndexFileEnvironment {
    #[serde(default)]
    server: IndexFileServerPolicy,
}

#[derive(Debug, Default)]
enum IndexFileServerPolicy {
    #[default]
    Missing,
    Null,
    Value(String),
    Invalid,
}

impl<'de> Deserialize<'de> for IndexFileServerPolicy {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match Value::deserialize(deserializer)? {
            Value::Null => Self::Null,
            Value::String(value) => Self::Value(value),
            _ => Self::Invalid,
        })
    }
}

#[derive(Debug, Deserialize)]
struct IndexHashes {
    sha1: String,
    sha512: String,
}

#[derive(Debug, Clone)]
struct ArchiveEntry {
    index: usize,
    name: String,
    size: u64,
    is_dir: bool,
}

struct ScannedMrpackArchive {
    entries: Vec<ArchiveEntry>,
    index_json: String,
    expanded_bytes: u64,
}

fn scan_mrpack_archive(archive_path: &Path) -> Result<ScannedMrpackArchive, AppError> {
    let actual_size = fs::metadata(archive_path)?.len();
    if actual_size == 0 || actual_size > MAX_MRPACK_BYTES {
        return Err(validation(
            "Modrinth pack archive is empty or exceeds the 2 GiB limit",
        ));
    }

    let archive_file = File::open(archive_path)?;
    let mut archive = ZipArchive::new(archive_file)
        .map_err(|_| validation("Modrinth pack is not a valid ZIP archive"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(validation(
            "Modrinth pack contains more than 100,000 entries",
        ));
    }

    let mut entries = Vec::with_capacity(archive.len());
    let mut seen_archive_paths = HashSet::with_capacity(archive.len());
    let mut expanded_bytes = 0u64;
    let mut manifest_index = None;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| validation("Modrinth pack contains an unreadable ZIP entry"))?;
        if entry.is_symlink() {
            return Err(validation("Modrinth pack contains a symbolic link"));
        }
        let name = entry.name().to_string();
        let is_dir = entry.is_dir();
        let canonical = validate_relative_path(&name, is_dir)?;
        if entry.enclosed_name().is_none() {
            return Err(validation("Modrinth pack contains an unsafe ZIP path"));
        }
        if !seen_archive_paths.insert(canonical.to_lowercase()) {
            return Err(validation(
                "Modrinth pack contains duplicate normalized paths",
            ));
        }
        expanded_bytes = expanded_bytes
            .checked_add(entry.size())
            .ok_or_else(|| validation("Modrinth pack expanded size overflowed"))?;
        if expanded_bytes > MAX_EXPANDED_BYTES {
            return Err(validation(
                "Modrinth pack exceeds the 20 GiB expanded size limit",
            ));
        }
        if is_dir && entry.size() != 0 {
            return Err(validation(
                "Modrinth pack contains a nonempty ZIP directory entry",
            ));
        }
        if canonical == "modrinth.index.json" {
            if is_dir {
                return Err(validation(
                    "Modrinth pack index must be a regular root file",
                ));
            }
            manifest_index = Some(index);
        }
        entries.push(ArchiveEntry {
            index,
            name: canonical,
            size: entry.size(),
            is_dir,
        });
    }

    let index = manifest_index
        .ok_or_else(|| validation("Modrinth pack is missing root modrinth.index.json"))?;
    let index_size = entries[index].size;
    if index_size > MAX_INDEX_BYTES {
        return Err(validation("Modrinth pack index exceeds the 16 MiB limit"));
    }
    let mut index_bytes = Vec::with_capacity(index_size as usize);
    archive
        .by_index(index)
        .map_err(|_| validation("Modrinth pack index could not be opened"))?
        .take(MAX_INDEX_BYTES + 1)
        .read_to_end(&mut index_bytes)?;
    if index_bytes.len() as u64 != index_size {
        return Err(validation(
            "Modrinth pack index size does not match its ZIP metadata",
        ));
    }
    let index_json = std::str::from_utf8(&index_bytes)
        .map_err(|_| validation("Modrinth pack index is not valid UTF-8"))?
        .to_string();

    Ok(ScannedMrpackArchive {
        entries,
        index_json,
        expanded_bytes,
    })
}

pub(crate) fn inspect_mrpack_metadata(
    archive_path: &Path,
) -> Result<MrpackMetadata, MrpackMetadataError> {
    let scanned = scan_mrpack_archive(archive_path)
        .map_err(|error| MrpackMetadataError::Invalid(error.to_string()))?;
    parse_mrpack_metadata_json(&scanned.index_json)
}

pub(crate) fn inspect_mrpack_pipeline_index(
    archive_path: &Path,
) -> Result<MrpackPipelineIndex, MrpackMetadataError> {
    let scanned = scan_mrpack_archive(archive_path)
        .map_err(|error| MrpackMetadataError::Invalid(error.to_string()))?;
    let metadata = parse_mrpack_metadata_json(&scanned.index_json)?;
    let loader = match metadata.loader {
        MrpackLoader::Vanilla => "minecraft",
        MrpackLoader::Fabric => "fabric",
        MrpackLoader::Forge => "forge",
        MrpackLoader::NeoForge => "neoforge",
        MrpackLoader::Quilt => {
            return Err(MrpackMetadataError::Unsupported(
                "Quilt modpacks are a disabled placeholder for new servers".into(),
            ))
        }
    };
    parse_manifest_json(&scanned.index_json, &metadata.minecraft_version, loader)
        .map_err(|error| MrpackMetadataError::Invalid(error.to_string()))?;

    let index: Value = serde_json::from_str(&scanned.index_json)
        .map_err(|_| MrpackMetadataError::Invalid("root index is malformed".into()))?;
    let files = index
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| MrpackMetadataError::Invalid("root index files are malformed".into()))?;
    let mut output = Vec::with_capacity(files.len());
    for file in files {
        let path = file
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| MrpackMetadataError::Invalid("file path is malformed".into()))?;
        let path = validate_relative_path(path, false)
            .map_err(|error| MrpackMetadataError::Invalid(error.to_string()))?;
        reject_manager_reserved_path(&path)
            .map_err(|error| MrpackMetadataError::Invalid(error.to_string()))?;
        let size = file
            .get("fileSize")
            .and_then(Value::as_u64)
            .ok_or_else(|| MrpackMetadataError::Invalid("file size is malformed".into()))?;
        let hashes = file
            .get("hashes")
            .ok_or_else(|| MrpackMetadataError::Invalid("file hashes are missing".into()))?;
        let sha1 = hashes
            .get("sha1")
            .and_then(Value::as_str)
            .ok_or_else(|| MrpackMetadataError::Invalid("file SHA-1 is malformed".into()))?;
        let sha512 = hashes
            .get("sha512")
            .and_then(Value::as_str)
            .ok_or_else(|| MrpackMetadataError::Invalid("file SHA-512 is malformed".into()))?;
        let downloads = file
            .get("downloads")
            .and_then(Value::as_array)
            .ok_or_else(|| MrpackMetadataError::Invalid("file downloads are malformed".into()))?
            .iter()
            .filter_map(Value::as_str)
            .filter(|url| valid_provider_download_url(url))
            .map(str::to_string)
            .collect::<Vec<_>>();
        let environment = match file.get("env") {
            None => None,
            Some(Value::Null) => {
                return Err(MrpackMetadataError::Invalid(
                    "file env must be an object when present".into(),
                ))
            }
            Some(value) => Some(value.as_object().ok_or_else(|| {
                MrpackMetadataError::Invalid("file environment is malformed".into())
            })?),
        };
        let client = parse_pipeline_environment_policy(
            environment.and_then(|environment| environment.get("client")),
            "client",
        )?;
        let server_value = environment.and_then(|environment| environment.get("server"));
        let server = parse_pipeline_environment_policy(server_value, "server")?;
        let server_environment_missing = server_value.is_none();
        output.push(MrpackPipelineFile {
            path,
            downloads,
            size,
            sha1: sha1.to_ascii_lowercase(),
            sha512: sha512.to_ascii_lowercase(),
            client,
            server,
            server_environment_missing,
        });
    }
    Ok(MrpackPipelineIndex {
        metadata,
        files: output,
    })
}

fn parse_pipeline_environment_policy(
    value: Option<&Value>,
    side: &str,
) -> Result<Option<MrpackEnvironmentPolicy>, MrpackMetadataError> {
    match value {
        None => Ok(None),
        Some(Value::String(value)) => match value.as_str() {
            "required" => Ok(Some(MrpackEnvironmentPolicy::Required)),
            "optional" => Ok(Some(MrpackEnvironmentPolicy::Optional)),
            "unsupported" => Ok(Some(MrpackEnvironmentPolicy::Unsupported)),
            _ => Err(MrpackMetadataError::Invalid(format!(
                "file has unknown env.{side} value '{value}'"
            ))),
        },
        Some(_) => Err(MrpackMetadataError::Invalid(format!(
            "file env.{side} must be required, optional, or unsupported"
        ))),
    }
}

fn parse_mrpack_metadata_json(json: &str) -> Result<MrpackMetadata, MrpackMetadataError> {
    let index: MrpackMetadataIndex = serde_json::from_str(json).map_err(|_| {
        MrpackMetadataError::Invalid("root index is malformed or missing metadata".into())
    })?;
    if index.format_version != 1 {
        return Err(MrpackMetadataError::Unsupported(format!(
            "formatVersion {} is unsupported; expected 1",
            index.format_version
        )));
    }
    if index.game != "minecraft" {
        return Err(MrpackMetadataError::Unsupported(format!(
            "game '{}' is unsupported; expected minecraft",
            index.game
        )));
    }
    if index.name.trim().is_empty() {
        return Err(MrpackMetadataError::Invalid(
            "root index name is empty".into(),
        ));
    }
    if index.version_id.trim().is_empty() {
        return Err(MrpackMetadataError::Invalid(
            "root index versionId is empty".into(),
        ));
    }

    let minecraft_version = index
        .dependencies
        .get("minecraft")
        .filter(|version| valid_version_segment(version))
        .cloned()
        .ok_or_else(|| {
            MrpackMetadataError::Invalid(
                "root index is missing a valid Minecraft dependency".into(),
            )
        })?;

    let mut loader_dependency = None;
    for (dependency, version) in &index.dependencies {
        if dependency == "minecraft" {
            continue;
        }
        let loader = match dependency.as_str() {
            "fabric-loader" => MrpackLoader::Fabric,
            "forge" => MrpackLoader::Forge,
            "neoforge" => MrpackLoader::NeoForge,
            "quilt-loader" => MrpackLoader::Quilt,
            _ => {
                return Err(MrpackMetadataError::Unsupported(format!(
                    "loader dependency '{dependency}' is unsupported"
                )))
            }
        };
        if !valid_version_segment(version) {
            return Err(MrpackMetadataError::Invalid(format!(
                "loader dependency '{dependency}' has an invalid version"
            )));
        }
        if loader_dependency
            .replace((loader, version.as_str()))
            .is_some()
        {
            return Err(MrpackMetadataError::Invalid(
                "root index contains multiple loader dependencies".into(),
            ));
        }
    }

    let (loader, loader_version) = match loader_dependency {
        Some((loader, version)) => (loader, Some(version.to_string())),
        None => (MrpackLoader::Vanilla, None),
    };

    let _ = index.files;
    Ok(MrpackMetadata {
        format_version: index.format_version,
        game: index.game,
        name: index.name,
        display_version_id: index.version_id,
        minecraft_version,
        loader,
        loader_version,
    })
}

pub(crate) fn parse_mrpack(
    archive_path: &Path,
    selected_minecraft: &str,
    selected_loader: &str,
) -> Result<ManifestPlan, AppError> {
    let scanned = scan_mrpack_archive(archive_path)?;
    let manifest = parse_manifest_json(&scanned.index_json, selected_minecraft, selected_loader)?;
    let entries = scanned.entries;
    let expanded_bytes = scanned.expanded_bytes;

    let mut override_entries = Vec::new();
    let mut override_bytes = 0u64;
    for entry in &entries {
        let (layer, relative) = match archive_layer(&entry.name)? {
            Some(value) => value,
            None => continue,
        };
        if relative.is_empty() {
            if entry.is_dir {
                continue;
            }
            return Err(validation("Modrinth override folder must be a directory"));
        }
        let relative = validate_relative_path(relative, entry.is_dir)?;
        reject_manager_reserved_path(&relative)?;
        override_bytes = override_bytes
            .checked_add(entry.size)
            .ok_or_else(|| validation("Modrinth override size overflowed"))?;
        override_entries.push(OverrideEntry {
            index: entry.index,
            path: relative,
            size: entry.size,
            is_dir: entry.is_dir,
            layer,
        });
    }

    Ok(ManifestPlan {
        minecraft_version: manifest.minecraft_version,
        loader: manifest.loader,
        loader_version: manifest.loader_version,
        required_files: manifest.required_files,
        skipped_files: manifest.skipped_files,
        skipped_server_paths: manifest.skipped_server_paths,
        override_entries,
        required_bytes: manifest.required_bytes,
        override_bytes,
        expanded_bytes,
    })
}

#[derive(Debug)]
struct ParsedManifest {
    minecraft_version: String,
    loader: String,
    loader_version: Option<String>,
    required_files: Vec<RequiredFile>,
    skipped_files: usize,
    skipped_server_paths: Vec<String>,
    required_bytes: u64,
}

fn parse_manifest_json(
    json: &str,
    selected_minecraft: &str,
    selected_loader: &str,
) -> Result<ParsedManifest, AppError> {
    let manifest: IndexManifest =
        serde_json::from_str(json).map_err(|_| validation("Modrinth pack index is malformed"))?;
    if manifest.format_version != 1 || manifest.game != "minecraft" {
        return Err(validation(
            "Modrinth pack must use formatVersion 1 for Minecraft",
        ));
    }
    if manifest.name.trim().is_empty() {
        return Err(validation("Modrinth pack name must not be empty"));
    }
    if manifest.version_id.trim().is_empty() {
        return Err(validation("Modrinth pack versionId must not be empty"));
    }

    let minecraft_version = manifest
        .dependencies
        .get("minecraft")
        .filter(|value| valid_version_segment(value))
        .ok_or_else(|| validation("Modrinth pack is missing a valid Minecraft dependency"))?
        .clone();
    if minecraft_version != selected_minecraft {
        return Err(validation(format!(
            "Modrinth pack targets Minecraft {minecraft_version}, not the selected {selected_minecraft}"
        )));
    }

    let mut loader_dependency = None;
    for (dependency, version) in &manifest.dependencies {
        if dependency == "minecraft" {
            continue;
        }
        if dependency == "quilt-loader" {
            return Err(validation(
                "Quilt modpacks are not supported for new servers",
            ));
        }
        let loader = match dependency.as_str() {
            "fabric-loader" => "fabric",
            "forge" => "forge",
            "neoforge" => "neoforge",
            _ => {
                return Err(validation(
                    "Modrinth pack contains an unsupported loader dependency",
                ))
            }
        };
        if !valid_version_segment(version) {
            return Err(validation(
                "Modrinth pack contains an invalid loader version",
            ));
        }
        if loader_dependency
            .replace((loader, version.as_str()))
            .is_some()
        {
            return Err(validation(
                "Modrinth pack contains multiple loader dependencies",
            ));
        }
    }
    let (loader, loader_version) = match loader_dependency {
        Some((loader, version)) => (loader, Some(version.to_string())),
        None => ("minecraft", None),
    };
    if loader != selected_loader {
        return Err(validation(format!(
            "Modrinth pack uses the {loader} loader, not the selected {selected_loader} loader"
        )));
    }

    let mut required_files = Vec::new();
    let mut skipped_files = 0usize;
    let mut skipped_server_paths = Vec::new();
    let mut seen_file_paths = HashSet::with_capacity(manifest.files.len());
    let mut required_bytes = 0u64;
    for file in manifest.files {
        let path = validate_relative_path(&file.path, false)?;
        reject_manager_reserved_path(&path)?;
        if !seen_file_paths.insert(path.to_lowercase()) {
            return Err(validation(
                "Modrinth manifest contains duplicate normalized file paths",
            ));
        }
        // `IndexFile.file_size` is a required u64 checked during deserialization;
        // validate both required digest formats even for server-unsupported entries.
        if !valid_hash(&file.hashes.sha1, 40) || !valid_hash(&file.hashes.sha512, 128) {
            return Err(validation(
                "Modrinth pack file is missing a valid size or hash",
            ));
        }
        let include = match file.env.as_ref().map(|environment| &environment.server) {
            None | Some(IndexFileServerPolicy::Missing) => true,
            Some(IndexFileServerPolicy::Null) => {
                return Err(validation(format!(
                    "Modrinth pack file {path} has a null env.server value; omit env.server or use required, optional, or unsupported"
                )))
            }
            Some(IndexFileServerPolicy::Invalid) => {
                return Err(validation(format!(
                    "Modrinth pack file {path} has a non-string env.server value"
                )))
            }
            Some(IndexFileServerPolicy::Value(value)) => match value.as_str() {
                "required" | "optional" => true,
                "unsupported" => false,
                _ => {
                    return Err(validation(format!(
                        "Modrinth pack file {path} has unknown env.server value '{value}'"
                    )))
                }
            },
        };
        if !include {
            skipped_files += 1;
            skipped_server_paths.push(path);
            continue;
        }
        let urls = file
            .downloads
            .into_iter()
            .filter(|url| valid_provider_download_url(url))
            .collect::<Vec<_>>();
        if urls.is_empty() {
            return Err(validation(
                "Modrinth pack file has no trusted HTTPS download URL",
            ));
        }
        required_bytes = required_bytes
            .checked_add(file.file_size)
            .ok_or_else(|| validation("Modrinth pack download size overflowed"))?;
        required_files.push(RequiredFile {
            path,
            urls,
            size: file.file_size,
            sha1: file.hashes.sha1.to_ascii_lowercase(),
            sha512: file.hashes.sha512.to_ascii_lowercase(),
        });
    }

    Ok(ParsedManifest {
        minecraft_version,
        loader: loader.to_string(),
        loader_version,
        required_files,
        skipped_files,
        skipped_server_paths,
        required_bytes,
    })
}

pub(crate) fn validate_fabric_mod_java_constraints(
    staging: &Path,
    selected_java_major: u32,
) -> Result<(), AppError> {
    validate_fabric_mod_java_constraints_with_control(staging, selected_java_major, None)
}

pub(crate) fn validate_fabric_mod_java_constraints_with_control(
    staging: &Path,
    selected_java_major: u32,
    control: Option<&JobControl>,
) -> Result<(), AppError> {
    validate_fabric_mod_java_constraints_excluding(
        staging,
        selected_java_major,
        &HashSet::new(),
        control,
    )
}

fn validate_fabric_mod_java_constraints_excluding(
    staging: &Path,
    selected_java_major: u32,
    excluded_paths: &HashSet<String>,
    control: Option<&JobControl>,
) -> Result<(), AppError> {
    ensure_fabric_preflight_active(control)?;
    let mods_dir = staging.join("mods");
    let mods_metadata = match fs::symlink_metadata(&mods_dir) {
        Ok(metadata) if metadata.file_type().is_dir() && !is_reparse_point(&metadata) => metadata,
        Ok(_) => {
            return Err(validation(
                "Fabric mods directory is not a safe regular directory",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let _ = mods_metadata;

    for item in fs::read_dir(&mods_dir)? {
        ensure_fabric_preflight_active(control)?;
        let item = item?;
        let path = item.path();
        if !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
        {
            continue;
        }
        let relative_path = format!(
            "mods/{}",
            path.file_name().unwrap_or_default().to_string_lossy()
        )
        .to_lowercase();
        if excluded_paths.contains(&relative_path) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                warn_fabric_metadata_unverified(
                    &path,
                    selected_java_major,
                    &format!("mod file metadata could not be read: {error}"),
                );
                continue;
            }
        };
        if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            return Err(validation(format!(
                "Fabric mod JAR {} is not a safe regular file",
                path.file_name().unwrap_or_default().to_string_lossy()
            )));
        }
        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
        if let Err(error) = validate_fabric_mod_jar_size(&file_name, metadata.len()) {
            warn_fabric_metadata_unverified(&path, selected_java_major, &error.to_string());
            continue;
        }
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) => {
                warn_fabric_metadata_unverified(
                    &path,
                    selected_java_major,
                    &format!("mod JAR could not be opened: {error}"),
                );
                continue;
            }
        };
        let mut archive = match ZipArchive::new(file) {
            Ok(archive) => archive,
            Err(_) => {
                warn_fabric_metadata_unverified(
                    &path,
                    selected_java_major,
                    "mod JAR is not a readable ZIP archive",
                );
                continue;
            }
        };
        if let Err(error) = validate_fabric_mod_jar_entry_count(&file_name, archive.len()) {
            warn_fabric_metadata_unverified(&path, selected_java_major, &error.to_string());
            continue;
        }
        let bytes = match read_fabric_mod_metadata(&mut archive, &file_name, control) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => continue,
            Err(reason) => {
                ensure_fabric_preflight_active(control)?;
                warn_fabric_metadata_unverified(&path, selected_java_major, &reason);
                continue;
            }
        };
        let normalized = normalize_fabric_json_string_controls(&bytes);
        let value: Value = match serde_json::from_slice(&normalized) {
            Ok(value) => value,
            Err(_) => {
                warn_fabric_metadata_unverified(
                    &path,
                    selected_java_major,
                    "fabric.mod.json could not be parsed for Java compatibility",
                );
                continue;
            }
        };
        let Some(java_requirement) = value
            .get("depends")
            .and_then(Value::as_object)
            .and_then(|dependencies| dependencies.get("java"))
        else {
            continue;
        };
        let Some(alternatives) = parse_java_major_requirement(java_requirement) else {
            warn_fabric_metadata_unverified(
                &path,
                selected_java_major,
                "depends.java syntax is unsupported or requires Java minor/patch precision unavailable to this check",
            );
            continue;
        };
        let matches = alternatives.iter().any(|comparators| {
            comparators.iter().all(|(operation, required)| {
                java_comparison_matches(selected_java_major, *operation, *required)
            })
        });
        if !matches {
            let mod_id = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .unwrap_or("unknown");
            let requirement_text = match java_requirement {
                Value::String(requirement) => requirement.clone(),
                other => other.to_string(),
            };
            return Err(validation(format!(
                "Fabric mod '{mod_id}' requires Java {requirement_text}, but the selected runtime is Java {selected_java_major}. Select or install a compatible Java runtime for this server."
            )));
        }
    }
    Ok(())
}

pub(crate) fn validate_fabric_mod_java_constraints_with_overrides(
    staging: &Path,
    selected_java_major: u32,
    archive_path: &Path,
    plan: &ManifestPlan,
    control: Option<&JobControl>,
) -> Result<(), AppError> {
    let effective_overrides = effective_override_mod_jars(plan);
    let replaced_paths = effective_overrides
        .iter()
        .map(|entry| entry.path.to_lowercase())
        .collect::<HashSet<_>>();

    validate_fabric_mod_java_constraints_excluding(
        staging,
        selected_java_major,
        &replaced_paths,
        control,
    )?;
    if effective_overrides.is_empty() {
        return Ok(());
    }

    let mut archive = ZipArchive::new(File::open(archive_path)?)
        .map_err(|_| validation("Modrinth pack is not a readable ZIP archive"))?;
    for entry in effective_overrides {
        ensure_fabric_preflight_active(control)?;
        if entry.size > MAX_FABRIC_MOD_JAR_BYTES {
            let layer = override_layer_label(entry.layer);
            tracing::warn!(
                mod_archive = %entry.path,
                override_layer = layer,
                selected_java_major,
                size = entry.size,
                "Fabric mod Java compatibility is unverified because the override JAR exceeds the 512 MiB inspection limit"
            );
            continue;
        }

        let mut source = archive
            .by_index(entry.index)
            .map_err(|_| validation("Modrinth override mod JAR could not be opened"))?;
        if source.is_symlink() || source.is_dir() || source.size() != entry.size {
            return Err(validation(
                "Modrinth override mod JAR metadata changed during Java preflight",
            ));
        }

        let scratch = TemporaryFabricModStaging::create(staging, entry)?;
        let target = safe_target(scratch.path(), &entry.path)?;
        ensure_directory_tree(scratch.path(), "mods")?;
        let mut destination = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        let mut copied = 0u64;
        let mut exceeded_limit = false;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            ensure_fabric_preflight_active(control)?;
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            copied = copied
                .checked_add(count as u64)
                .ok_or_else(|| validation("Modrinth override mod JAR size overflowed"))?;
            if copied > MAX_FABRIC_MOD_JAR_BYTES {
                exceeded_limit = true;
                break;
            }
            destination.write_all(&buffer[..count])?;
        }
        destination.flush()?;
        drop(destination);
        drop(source);
        if exceeded_limit {
            let layer = override_layer_label(entry.layer);
            tracing::warn!(
                mod_archive = %entry.path,
                override_layer = layer,
                selected_java_major,
                "Fabric mod Java compatibility is unverified because the expanded override JAR exceeds the 512 MiB inspection limit"
            );
            scratch.cleanup()?;
            continue;
        }
        if copied != entry.size {
            return Err(validation(
                "Modrinth override mod JAR size changed during Java preflight",
            ));
        }
        validate_fabric_mod_java_constraints_with_control(
            scratch.path(),
            selected_java_major,
            control,
        )?;
        scratch.cleanup()?;
    }
    Ok(())
}

#[derive(Clone)]
struct FabricDependencyCandidatePath {
    path: PathBuf,
    context: String,
    depth: usize,
}

struct FabricDependencyInventory {
    complete: bool,
    providers: HashSet<String>,
    hard_dependencies: Vec<(String, String)>,
}

impl FabricDependencyInventory {
    fn new(complete: bool) -> Self {
        Self {
            complete,
            providers: HashSet::new(),
            hard_dependencies: Vec::new(),
        }
    }
}

pub(crate) fn validate_fabric_mod_hard_dependencies_with_overrides(
    staging: &Path,
    archive_path: &Path,
    plan: &ManifestPlan,
    control: Option<&JobControl>,
) -> Result<bool, AppError> {
    let effective_overrides = effective_override_mod_jars(plan);
    let replaced_paths = effective_overrides
        .iter()
        .map(|entry| entry.path.to_lowercase())
        .collect::<HashSet<_>>();
    let (mut candidates, mut complete) =
        collect_fabric_mod_dependency_roots(staging, &replaced_paths, control)?;
    let scratch = TemporaryFabricDependencyStaging::create(staging)?;
    let mut scratch_bytes = 0u64;

    if !effective_overrides.is_empty() {
        let mut archive = ZipArchive::new(File::open(archive_path)?)
            .map_err(|_| validation("Modrinth pack is not a readable ZIP archive"))?;
        for entry in effective_overrides {
            ensure_fabric_preflight_active(control)?;
            let context = format!(
                "{}-overrides/{}",
                override_layer_label(entry.layer),
                entry.path
            );
            if candidates.len() >= MAX_FABRIC_DEPENDENCY_CANDIDATES {
                mark_fabric_dependency_incomplete(
                    &mut complete,
                    &context,
                    "server mod candidate count exceeds the inspection limit",
                );
                break;
            }
            if entry.size > MAX_FABRIC_MOD_JAR_BYTES {
                mark_fabric_dependency_incomplete(
                    &mut complete,
                    &context,
                    "override JAR exceeds the 512 MiB inspection limit",
                );
                continue;
            }
            let mut source = archive
                .by_index(entry.index)
                .map_err(|_| validation("Modrinth override mod JAR could not be opened"))?;
            if source.is_symlink() || source.is_dir() || source.size() != entry.size {
                return Err(validation(
                    "Modrinth override mod JAR metadata changed during dependency preflight",
                ));
            }
            let target = scratch.path().join(format!("override-{}.jar", entry.index));
            if !copy_fabric_dependency_candidate(
                &mut source,
                &target,
                entry.size,
                &mut scratch_bytes,
                control,
            )? {
                mark_fabric_dependency_incomplete(
                    &mut complete,
                    &context,
                    "override JAR could not be copied within the dependency scan bounds",
                );
                continue;
            }
            candidates.push(FabricDependencyCandidatePath {
                path: target,
                context,
                depth: 0,
            });
        }
    }

    let result = scan_fabric_dependency_candidates(
        candidates,
        complete,
        &plan.skipped_server_paths,
        scratch.path(),
        scratch_bytes,
        control,
    );
    scratch.cleanup()?;
    result
}

pub(crate) fn validate_fabric_mod_hard_dependencies(
    staging: &Path,
    skipped_server_paths: &[String],
    control: Option<&JobControl>,
) -> Result<bool, AppError> {
    let (candidates, complete) =
        collect_fabric_mod_dependency_roots(staging, &HashSet::new(), control)?;
    let scratch = TemporaryFabricDependencyStaging::create(staging)?;
    let result = scan_fabric_dependency_candidates(
        candidates,
        complete,
        skipped_server_paths,
        scratch.path(),
        0,
        control,
    );
    scratch.cleanup()?;
    result
}

fn collect_fabric_mod_dependency_roots(
    staging: &Path,
    excluded_paths: &HashSet<String>,
    control: Option<&JobControl>,
) -> Result<(Vec<FabricDependencyCandidatePath>, bool), AppError> {
    ensure_fabric_preflight_active(control)?;
    let mods_dir = staging.join("mods");
    match fs::symlink_metadata(&mods_dir) {
        Ok(metadata) if metadata.file_type().is_dir() && !is_reparse_point(&metadata) => {}
        Ok(_) => {
            return Err(validation(
                "Fabric mods directory is not a safe regular directory",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), true))
        }
        Err(error) => return Err(error.into()),
    }

    let mut candidates = Vec::new();
    let mut complete = true;
    for item in fs::read_dir(&mods_dir)? {
        ensure_fabric_preflight_active(control)?;
        let item = item?;
        let path = item.path();
        if !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
        {
            continue;
        }
        let relative_path = format!(
            "mods/{}",
            path.file_name().unwrap_or_default().to_string_lossy()
        )
        .to_lowercase();
        if excluded_paths.contains(&relative_path) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                mark_fabric_dependency_incomplete(
                    &mut complete,
                    &path.display().to_string(),
                    &format!("mod file metadata could not be read: {error}"),
                );
                continue;
            }
        };
        if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
            return Err(validation(format!(
                "Fabric mod JAR {} is not a safe regular file",
                path.file_name().unwrap_or_default().to_string_lossy()
            )));
        }
        if candidates.len() >= MAX_FABRIC_DEPENDENCY_CANDIDATES {
            mark_fabric_dependency_incomplete(
                &mut complete,
                &path.display().to_string(),
                "server mod candidate count exceeds the inspection limit",
            );
            break;
        }
        candidates.push(FabricDependencyCandidatePath {
            context: path.display().to_string(),
            path,
            depth: 0,
        });
    }
    Ok((candidates, complete))
}

fn scan_fabric_dependency_candidates(
    mut candidates: Vec<FabricDependencyCandidatePath>,
    initially_complete: bool,
    skipped_server_paths: &[String],
    scratch: &Path,
    mut scratch_bytes: u64,
    control: Option<&JobControl>,
) -> Result<bool, AppError> {
    ensure_fabric_preflight_active(control)?;
    let mut inventory = FabricDependencyInventory::new(initially_complete);
    let mut metadata_bytes = 0u64;
    let mut central_entries_scanned = 0usize;
    let mut nested_declarations_scanned = 0usize;
    let mut cursor = 0usize;
    while cursor < candidates.len() {
        ensure_fabric_preflight_active(control)?;
        let candidate = candidates[cursor].clone();
        cursor += 1;
        let file_metadata = match fs::symlink_metadata(&candidate.path) {
            Ok(metadata) => metadata,
            Err(error) => {
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    &format!("candidate JAR could not be inspected: {error}"),
                );
                continue;
            }
        };
        if !file_metadata.file_type().is_file() || is_reparse_point(&file_metadata) {
            return Err(validation(format!(
                "Fabric dependency candidate {} is not a safe regular file",
                candidate.context
            )));
        }
        if let Err(error) = validate_fabric_mod_jar_size(&candidate.context, file_metadata.len()) {
            mark_fabric_dependency_incomplete(
                &mut inventory.complete,
                &candidate.context,
                &error.to_string(),
            );
            continue;
        }
        let file = match File::open(&candidate.path) {
            Ok(file) => file,
            Err(error) => {
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    &format!("candidate JAR could not be opened: {error}"),
                );
                continue;
            }
        };
        let mut archive = match ZipArchive::new(file) {
            Ok(archive) => archive,
            Err(_) => {
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    "candidate JAR is not a readable ZIP archive",
                );
                continue;
            }
        };
        if let Err(error) = validate_fabric_mod_jar_entry_count(&candidate.context, archive.len()) {
            mark_fabric_dependency_incomplete(
                &mut inventory.complete,
                &candidate.context,
                &error.to_string(),
            );
            continue;
        }
        if !account_fabric_dependency_central_entries(&mut central_entries_scanned, archive.len()) {
            mark_fabric_dependency_incomplete(
                &mut inventory.complete,
                &candidate.context,
                "aggregate central-directory traversal exceeds the 2,000,000-entry limit",
            );
            break;
        }
        let metadata = match read_fabric_mod_metadata(&mut archive, &candidate.context, control) {
            Ok(Some(metadata)) => metadata,
            Ok(None) => continue,
            Err(reason) => {
                ensure_fabric_preflight_active(control)?;
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    &reason,
                );
                continue;
            }
        };
        metadata_bytes = metadata_bytes.saturating_add(metadata.len() as u64);
        if metadata_bytes > MAX_FABRIC_DEPENDENCY_METADATA_BYTES {
            mark_fabric_dependency_incomplete(
                &mut inventory.complete,
                &candidate.context,
                "total Fabric dependency metadata exceeds the 32 MiB inspection limit",
            );
            break;
        }
        let normalized = normalize_fabric_json_string_controls(&metadata);
        let value: Value = match serde_json::from_slice(&normalized) {
            Ok(value) => value,
            Err(_) => {
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    "fabric.mod.json could not be parsed for hard dependency inspection",
                );
                continue;
            }
        };

        let server_active = match value.get("environment") {
            None => true,
            Some(Value::String(environment)) if environment == "*" || environment == "server" => {
                true
            }
            Some(Value::String(environment)) if environment == "client" => false,
            Some(_) => {
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    "Fabric environment is not a recognized string; server activity is unknown",
                );
                continue;
            }
        };
        if !server_active {
            continue;
        }

        let Some(mod_id) = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && !id.chars().any(char::is_control))
        else {
            mark_fabric_dependency_incomplete(
                &mut inventory.complete,
                &candidate.context,
                "server-active Fabric metadata has no usable mod id",
            );
            continue;
        };
        inventory.providers.insert(mod_id.to_string());

        if let Some(provides) = value.get("provides") {
            match provides.as_array() {
                Some(aliases) => {
                    for alias in aliases {
                        match alias
                            .as_str()
                            .filter(|id| !id.is_empty() && !id.chars().any(char::is_control))
                        {
                            Some(alias) => {
                                inventory.providers.insert(alias.to_string());
                            }
                            None => mark_fabric_dependency_incomplete(
                                &mut inventory.complete,
                                &candidate.context,
                                "provides contains an invalid alias",
                            ),
                        }
                    }
                }
                None => mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    "provides is not an array",
                ),
            }
        }

        if let Some(depends) = value.get("depends") {
            match depends.as_object() {
                Some(dependencies) => {
                    for (dependency_id, requirement) in dependencies {
                        let valid_requirement = match requirement {
                            Value::String(_) => true,
                            Value::Array(alternatives) => alternatives.iter().all(Value::is_string),
                            _ => false,
                        };
                        if dependency_id.is_empty()
                            || dependency_id.chars().any(char::is_control)
                            || !valid_requirement
                        {
                            mark_fabric_dependency_incomplete(
                                &mut inventory.complete,
                                &candidate.context,
                                "depends contains an invalid hard dependency entry",
                            );
                            continue;
                        }
                        inventory
                            .hard_dependencies
                            .push((mod_id.to_string(), dependency_id.clone()));
                    }
                }
                None => mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    "depends is not an object",
                ),
            }
        }

        let nested_paths = match parse_declared_nested_jar_paths(&value) {
            Ok(paths) => paths,
            Err(reason) => {
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    &reason,
                );
                Vec::new()
            }
        };
        if nested_paths.is_empty() {
            continue;
        }
        if !account_fabric_nested_declarations(&mut nested_declarations_scanned, nested_paths.len())
        {
            mark_fabric_dependency_incomplete(
                &mut inventory.complete,
                &candidate.context,
                "total declared nested-path lookups exceed the 4,096-entry limit",
            );
            break;
        }
        if candidate.depth >= MAX_FABRIC_NESTED_MOD_DEPTH {
            mark_fabric_dependency_incomplete(
                &mut inventory.complete,
                &candidate.context,
                "declared nested JAR depth exceeds the inspection limit",
            );
            continue;
        }

        let mut safe_nested_paths = Vec::with_capacity(nested_paths.len());
        let mut seen_nested_paths = HashSet::new();
        for nested_path in nested_paths {
            ensure_fabric_preflight_active(control)?;
            let nested_path = match validate_relative_path(&nested_path, false) {
                Ok(path)
                    if Path::new(&path)
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("jar")) =>
                {
                    path
                }
                _ => {
                    mark_fabric_dependency_incomplete(
                        &mut inventory.complete,
                        &candidate.context,
                        "declared nested JAR path is unsafe or not a JAR",
                    );
                    continue;
                }
            };
            if !seen_nested_paths.insert(nested_path.to_lowercase()) {
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    "jars declares the same nested path more than once",
                );
                continue;
            }
            safe_nested_paths.push(nested_path);
        }
        if safe_nested_paths.is_empty() {
            continue;
        }
        let Some(nested_entry_counts) = index_declared_nested_fabric_jars(
            &archive,
            &safe_nested_paths,
            &mut central_entries_scanned,
            &candidate.context,
            &mut inventory.complete,
            control,
        )?
        else {
            break;
        };
        for nested_path in safe_nested_paths {
            ensure_fabric_preflight_active(control)?;
            if nested_entry_counts.get(&nested_path).copied() != Some(1) {
                continue;
            }
            if candidates.len() >= MAX_FABRIC_DEPENDENCY_CANDIDATES {
                mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    "total Fabric candidate count exceeds the 2,048-candidate limit",
                );
                break;
            }
            let target = scratch.join(format!("nested-{}.jar", uuid::Uuid::new_v4()));
            match copy_declared_nested_fabric_jar(
                &mut archive,
                &nested_path,
                &target,
                &mut scratch_bytes,
                control,
            )? {
                true => candidates.push(FabricDependencyCandidatePath {
                    path: target,
                    context: format!("{}!/{nested_path}", candidate.context),
                    depth: candidate.depth + 1,
                }),
                false => mark_fabric_dependency_incomplete(
                    &mut inventory.complete,
                    &candidate.context,
                    &format!("declared nested JAR {nested_path} could not be inspected within the bounds"),
                ),
            }
        }
    }

    if !inventory.complete {
        tracing::warn!(
            "Fabric hard dependency preflight is incomplete; no missing-provider result will be claimed"
        );
        return Ok(false);
    }

    let providers = inventory.providers;
    let mut missing = inventory
        .hard_dependencies
        .into_iter()
        .filter(|(_, dependency_id)| {
            !matches!(
                dependency_id.as_str(),
                "minecraft" | "fabricloader" | "java"
            ) && !providers.contains(dependency_id)
        })
        .collect::<Vec<_>>();
    missing.sort();
    missing.dedup();
    if !missing.is_empty() {
        let details = missing
            .iter()
            .map(|(dependent, dependency)| {
                let skipped = matching_skipped_unsupported_path(dependency, skipped_server_paths)
                    .map(|path| {
                        format!(" (matching file '{path}' is marked env.server=unsupported)")
                    })
                    .unwrap_or_default();
                format!("'{dependent}' requires missing hard dependency '{dependency}'{skipped}")
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(validation(format!(
            "Modrinth server pack has missing hard Fabric dependencies: {details}. Choose a server-compatible pack/version or correct the pack's server metadata; unsupported files are never added automatically."
        )));
    }
    Ok(true)
}

fn account_fabric_dependency_central_entries(scanned: &mut usize, entries: usize) -> bool {
    let Some(next) = scanned.checked_add(entries) else {
        return false;
    };
    if next > MAX_FABRIC_DEPENDENCY_CENTRAL_ENTRIES {
        return false;
    }
    *scanned = next;
    true
}

fn account_fabric_nested_declarations(scanned: &mut usize, declarations: usize) -> bool {
    let Some(next) = scanned.checked_add(declarations) else {
        return false;
    };
    if next > MAX_FABRIC_NESTED_DECLARATIONS {
        return false;
    }
    *scanned = next;
    true
}

fn index_declared_nested_fabric_jars(
    archive: &ZipArchive<File>,
    nested_paths: &[String],
    central_entries_scanned: &mut usize,
    context: &str,
    complete: &mut bool,
    control: Option<&JobControl>,
) -> Result<Option<std::collections::HashMap<String, usize>>, AppError> {
    if !account_fabric_dependency_central_entries(central_entries_scanned, archive.len()) {
        mark_fabric_dependency_incomplete(
            complete,
            context,
            "aggregate central-directory traversal exceeds the 2,000,000-entry limit",
        );
        return Ok(None);
    }
    let wanted = nested_paths.iter().cloned().collect::<HashSet<_>>();
    let mut counts = std::collections::HashMap::new();
    for (index, name) in archive.file_names().enumerate() {
        if index % 1024 == 0 {
            ensure_fabric_preflight_active(control)?;
        }
        if wanted.contains(name) {
            let count = counts.entry(name.to_string()).or_insert(0usize);
            *count += 1;
        }
    }
    for nested_path in nested_paths {
        ensure_fabric_preflight_active(control)?;
        match counts.get(nested_path).copied().unwrap_or(0) {
            1 => {}
            0 => mark_fabric_dependency_incomplete(
                complete,
                context,
                &format!("declared nested JAR {nested_path} is missing from its parent archive"),
            ),
            _ => mark_fabric_dependency_incomplete(
                complete,
                context,
                &format!(
                    "parent archive has duplicate entries for declared nested JAR {nested_path}"
                ),
            ),
        }
    }
    Ok(Some(counts))
}

fn parse_declared_nested_jar_paths(value: &Value) -> Result<Vec<String>, String> {
    let Some(jars) = value.get("jars") else {
        return Ok(Vec::new());
    };
    let Some(jars) = jars.as_array() else {
        return Err("jars is not an array".into());
    };
    let mut paths = Vec::with_capacity(jars.len());
    for jar in jars {
        let Some(path) = jar.get("file").and_then(Value::as_str) else {
            return Err("jars contains an entry without a string file path".into());
        };
        paths.push(path.to_string());
    }
    Ok(paths)
}

fn copy_declared_nested_fabric_jar(
    parent: &mut ZipArchive<File>,
    nested_path: &str,
    target: &Path,
    scratch_bytes: &mut u64,
    control: Option<&JobControl>,
) -> Result<bool, AppError> {
    let mut source = match parent.by_name(nested_path) {
        Ok(source) => source,
        Err(_) => return Ok(false),
    };
    if source.is_symlink() || source.is_dir() || source.size() > MAX_FABRIC_MOD_JAR_BYTES {
        return Ok(false);
    }
    let size = source.size();
    copy_fabric_dependency_candidate(&mut source, target, size, scratch_bytes, control)
}

fn copy_fabric_dependency_candidate<R: Read>(
    source: &mut R,
    target: &Path,
    declared_size: u64,
    scratch_bytes: &mut u64,
    control: Option<&JobControl>,
) -> Result<bool, AppError> {
    if declared_size > MAX_FABRIC_MOD_JAR_BYTES
        || (*scratch_bytes).saturating_add(declared_size) > MAX_FABRIC_DEPENDENCY_SCRATCH_BYTES
    {
        return Ok(false);
    }
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let mut copied = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        ensure_fabric_preflight_active(control)?;
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let next = copied
            .checked_add(count as u64)
            .ok_or_else(|| validation("Fabric dependency candidate size overflowed"))?;
        if next > declared_size
            || next > MAX_FABRIC_MOD_JAR_BYTES
            || (*scratch_bytes).saturating_add(next) > MAX_FABRIC_DEPENDENCY_SCRATCH_BYTES
        {
            drop(destination);
            fs::remove_file(target)?;
            return Ok(false);
        }
        destination.write_all(&buffer[..count])?;
        copied = next;
    }
    if copied != declared_size {
        drop(destination);
        fs::remove_file(target)?;
        return Ok(false);
    }
    destination.flush()?;
    *scratch_bytes = (*scratch_bytes).saturating_add(copied);
    Ok(true)
}

fn mark_fabric_dependency_incomplete(complete: &mut bool, context: &str, reason: &str) {
    *complete = false;
    tracing::warn!(
        mod_archive = %context,
        reason = %reason,
        "Fabric hard dependency metadata is incomplete; continuing without claiming pack compatibility"
    );
}

fn matching_skipped_unsupported_path<'a>(
    dependency_id: &str,
    skipped_server_paths: &'a [String],
) -> Option<&'a str> {
    let normalize = |value: &str| {
        value
            .bytes()
            .filter(u8::is_ascii_alphanumeric)
            .map(|byte| byte.to_ascii_lowercase() as char)
            .collect::<String>()
    };
    let dependency = normalize(dependency_id);
    if dependency.len() < 4 {
        return None;
    }
    skipped_server_paths.iter().find_map(|path| {
        if !path
            .split('/')
            .next()
            .is_some_and(|directory| directory.eq_ignore_ascii_case("mods"))
        {
            return None;
        }
        let file_name = path.rsplit('/').next().unwrap_or(path);
        if !Path::new(file_name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
        {
            return None;
        }
        filename_has_delimited_dependency_prefix(file_name, &dependency).then_some(path.as_str())
    })
}

fn filename_has_delimited_dependency_prefix(file_name: &str, dependency: &str) -> bool {
    let mut normalized_prefix = String::new();
    for byte in file_name.bytes() {
        if byte.is_ascii_alphanumeric() {
            normalized_prefix.push(byte.to_ascii_lowercase() as char);
        } else if normalized_prefix == dependency {
            return true;
        }
    }
    normalized_prefix == dependency
}

struct TemporaryFabricDependencyStaging {
    path: Option<PathBuf>,
}

impl TemporaryFabricDependencyStaging {
    fn create(staging: &Path) -> Result<Self, AppError> {
        let path = staging.join(format!(
            ".fabric-dependency-preflight-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&path)?;
        Ok(Self { path: Some(path) })
    }

    fn path(&self) -> &Path {
        self.path
            .as_deref()
            .expect("temporary dependency staging path remains available until cleanup")
    }

    fn cleanup(mut self) -> Result<(), AppError> {
        let path = self
            .path
            .take()
            .expect("temporary dependency staging path is present before cleanup");
        fs::remove_dir_all(&path).map_err(|error| {
            validation(format!(
                "could not remove Fabric dependency preflight scratch before publication: {error}"
            ))
        })
    }
}

impl Drop for TemporaryFabricDependencyStaging {
    fn drop(&mut self) {
        if let Some(path) = self.path.as_ref() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn effective_override_mod_jars(plan: &ManifestPlan) -> Vec<&OverrideEntry> {
    let mut effective = std::collections::BTreeMap::<String, &OverrideEntry>::new();
    for layer in [OverrideLayer::Shared, OverrideLayer::Server] {
        for entry in plan.override_entries.iter().filter(|entry| {
            entry.layer == layer && !entry.is_dir && is_direct_mod_jar_path(&entry.path)
        }) {
            effective.insert(entry.path.to_lowercase(), entry);
        }
    }
    effective.into_values().collect()
}

fn is_direct_mod_jar_path(path: &str) -> bool {
    let mut components = path.split('/');
    let Some(directory) = components.next() else {
        return false;
    };
    let Some(file_name) = components.next() else {
        return false;
    };
    directory.eq_ignore_ascii_case("mods")
        && components.next().is_none()
        && Path::new(file_name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
}

fn override_layer_label(layer: OverrideLayer) -> &'static str {
    match layer {
        OverrideLayer::Shared => "shared",
        OverrideLayer::Server => "server",
    }
}

fn ensure_fabric_preflight_active(control: Option<&JobControl>) -> Result<(), AppError> {
    if let Some(control) = control {
        installer::ensure_not_cancelled(control)?;
    }
    Ok(())
}

struct TemporaryFabricModStaging {
    path: Option<PathBuf>,
}

impl TemporaryFabricModStaging {
    fn create(staging: &Path, entry: &OverrideEntry) -> Result<Self, AppError> {
        let file_name = Path::new(&entry.path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let label = file_name
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                    character
                } else {
                    '_'
                }
            })
            .take(64)
            .collect::<String>();
        let path = staging.join(format!(
            ".fabric-java-preflight-{}-{}-{label}-{}",
            override_layer_label(entry.layer),
            entry.index,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&path)?;
        Ok(Self { path: Some(path) })
    }

    fn path(&self) -> &Path {
        self.path
            .as_deref()
            .expect("temporary Fabric staging path remains available until cleanup")
    }

    fn cleanup(mut self) -> Result<(), AppError> {
        let path = self
            .path
            .take()
            .expect("temporary Fabric staging path is present before cleanup");
        fs::remove_dir_all(&path).map_err(|error| {
            validation(format!(
                "could not remove Fabric Java preflight scratch before publication: {error}"
            ))
        })
    }
}

impl Drop for TemporaryFabricModStaging {
    fn drop(&mut self) {
        if let Some(path) = self.path.as_ref() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn read_fabric_mod_metadata(
    archive: &mut ZipArchive<File>,
    file_name: &str,
    control: Option<&JobControl>,
) -> Result<Option<Vec<u8>>, String> {
    let mut metadata_entries = 0usize;
    for (index, name) in archive.file_names().enumerate() {
        if index % 1024 == 0 {
            if let Some(control) = control {
                installer::ensure_not_cancelled(control)
                    .map_err(|_| "fabric.mod.json lookup was cancelled".to_string())?;
            }
        }
        if name == "fabric.mod.json" {
            metadata_entries += 1;
            if metadata_entries > 1 {
                break;
            }
        }
    }
    if metadata_entries == 0 {
        return Ok(None);
    }
    if metadata_entries > 1 {
        return Err("mod JAR has duplicate fabric.mod.json entries".into());
    }
    let mut descriptor = archive
        .by_name("fabric.mod.json")
        .map_err(|_| "fabric.mod.json could not be opened".to_string())?;
    if descriptor.size() > MAX_FABRIC_MOD_JSON_BYTES {
        return Err(format!(
            "fabric.mod.json exceeds the {MAX_FABRIC_MOD_JSON_BYTES}-byte inspection limit"
        ));
    }
    let declared_size = descriptor.size();
    let mut bytes = Vec::with_capacity(declared_size as usize);
    let limit = declared_size.saturating_add(1);
    let mut buffer = [0u8; 16 * 1024];
    while (bytes.len() as u64) < limit {
        if let Some(control) = control {
            installer::ensure_not_cancelled(control)
                .map_err(|_| "fabric.mod.json read was cancelled".to_string())?;
        }
        let remaining = (limit - bytes.len() as u64).min(buffer.len() as u64) as usize;
        let count = descriptor
            .read(&mut buffer[..remaining])
            .map_err(|_| "fabric.mod.json could not be read".to_string())?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    if bytes.len() as u64 != declared_size {
        return Err(format!(
            "fabric.mod.json size does not match its ZIP entry in {file_name}"
        ));
    }
    Ok(Some(bytes))
}

fn normalize_fabric_json_string_controls(bytes: &[u8]) -> Vec<u8> {
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut in_string = false;
    let mut escaped = false;
    for byte in bytes.iter().copied() {
        if in_string && byte < 0x20 {
            normalized.extend_from_slice(format!("\\u{byte:04x}").as_bytes());
            escaped = false;
            continue;
        }
        normalized.push(byte);
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else if byte == b'"' {
            in_string = true;
        }
    }
    normalized
}

fn warn_fabric_metadata_unverified(path: &Path, selected_java_major: u32, reason: &str) {
    tracing::warn!(
        mod_archive = %path.display(),
        selected_java_major,
        reason,
        "Fabric mod Java compatibility is unverified; continuing installation"
    );
}

fn validate_fabric_mod_jar_size(file_name: &str, size: u64) -> Result<(), AppError> {
    if size > MAX_FABRIC_MOD_JAR_BYTES {
        return Err(validation(format!(
            "Fabric mod JAR {file_name} exceeds the 512 MiB inspection limit"
        )));
    }
    Ok(())
}

fn validate_fabric_mod_jar_entry_count(file_name: &str, entries: usize) -> Result<(), AppError> {
    if entries > MAX_ARCHIVE_ENTRIES {
        return Err(validation(format!(
            "Fabric mod JAR {file_name} exceeds the {MAX_ARCHIVE_ENTRIES}-entry inspection limit"
        )));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum JavaMajorComparison {
    Equal,
    Compatible,
    Greater,
    GreaterOrEqual,
    Less,
    LessOrEqual,
}

fn parse_java_major_requirement(value: &Value) -> Option<Vec<Vec<(JavaMajorComparison, u32)>>> {
    match value {
        Value::String(requirement) => Some(vec![parse_java_major_constraint(requirement)?]),
        Value::Array(alternatives) if !alternatives.is_empty() => alternatives
            .iter()
            .map(|alternative| parse_java_major_constraint(alternative.as_str()?))
            .collect(),
        _ => None,
    }
}

fn parse_java_major_constraint(value: &str) -> Option<Vec<(JavaMajorComparison, u32)>> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    value
        .split_whitespace()
        .filter(|part| *part != "*")
        .map(parse_java_major_comparator)
        .collect()
}

fn parse_java_major_comparator(value: &str) -> Option<(JavaMajorComparison, u32)> {
    for (prefix, operation) in [
        (">=", JavaMajorComparison::GreaterOrEqual),
        ("<=", JavaMajorComparison::LessOrEqual),
        ("==", JavaMajorComparison::Equal),
        ("~", JavaMajorComparison::Compatible),
        ("^", JavaMajorComparison::Compatible),
        (">", JavaMajorComparison::Greater),
        ("<", JavaMajorComparison::Less),
        ("=", JavaMajorComparison::Equal),
    ] {
        if let Some(version) = value.strip_prefix(prefix) {
            if (version.ends_with(".x") || version.ends_with(".X"))
                && !matches!(operation, JavaMajorComparison::Equal)
            {
                return None;
            }
            return Some((operation, parse_java_major_prefix(version)?));
        }
    }
    let (operation, version) = if let Some(version) = value
        .strip_suffix(".x")
        .or_else(|| value.strip_suffix(".X"))
    {
        (JavaMajorComparison::Equal, version)
    } else {
        (JavaMajorComparison::Equal, value)
    };
    Some((operation, parse_java_major_prefix(version)?))
}

fn parse_java_major_prefix(value: &str) -> Option<u32> {
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let remainder = &value[digits..];
    if !remainder.is_empty() && !matches!(remainder, ".x" | ".X") {
        return None;
    }
    value[..digits].parse().ok()
}

fn java_comparison_matches(selected: u32, operation: JavaMajorComparison, required: u32) -> bool {
    match operation {
        JavaMajorComparison::Equal => selected == required,
        JavaMajorComparison::Compatible => selected == required,
        JavaMajorComparison::Greater => selected > required,
        JavaMajorComparison::GreaterOrEqual => selected >= required,
        JavaMajorComparison::Less => selected < required,
        JavaMajorComparison::LessOrEqual => selected <= required,
    }
}

pub(crate) fn apply_override_layer(
    archive_path: &Path,
    plan: &ManifestPlan,
    staging: &Path,
    server_layer: bool,
    control: &JobControl,
    completed_before: u64,
    total: u64,
    mut report: impl FnMut(u64, u64),
) -> Result<u64, AppError> {
    let file = fs::File::open(archive_path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|_| validation("Modrinth pack is not a valid ZIP archive"))?;
    let target_layer = if server_layer {
        OverrideLayer::Server
    } else {
        OverrideLayer::Shared
    };
    let mut copied = 0u64;
    for entry in plan
        .override_entries
        .iter()
        .filter(|entry| entry.layer == target_layer)
    {
        installer::ensure_not_cancelled(control)?;
        let mut source = archive
            .by_index(entry.index)
            .map_err(|_| validation("Modrinth override could not be opened"))?;
        if source.is_symlink() || source.size() != entry.size || source.is_dir() != entry.is_dir {
            return Err(validation(
                "Modrinth override metadata changed while extracting",
            ));
        }
        if entry.is_dir {
            safe_target(staging, &entry.path)?;
            ensure_directory_tree(staging, &entry.path)?;
            continue;
        }
        let target = prepare_override_file_target(staging, &entry.path)?;
        remove_existing_regular_file(&target)?;
        let mut destination = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        let mut entry_bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            installer::ensure_not_cancelled(control)?;
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            entry_bytes = entry_bytes
                .checked_add(count as u64)
                .ok_or_else(|| validation("Modrinth override expanded size overflowed"))?;
            copied = copied
                .checked_add(count as u64)
                .ok_or_else(|| validation("Modrinth override expanded size overflowed"))?;
            if entry_bytes > entry.size {
                return Err(validation(
                    "Modrinth override exceeded its declared expanded size",
                ));
            }
            let total_expanded = completed_before
                .checked_add(copied)
                .ok_or_else(|| validation("Modrinth override expanded size overflowed"))?;
            if total_expanded > MAX_EXPANDED_BYTES {
                return Err(validation(
                    "Modrinth pack exceeded the 20 GiB expanded size limit",
                ));
            }
            destination.write_all(&buffer[..count])?;
            report(total_expanded, total);
        }
        if entry_bytes != entry.size {
            return Err(validation(
                "Modrinth override size does not match its ZIP metadata",
            ));
        }
        destination.flush()?;
    }
    Ok(copied)
}

fn prepare_override_file_target(staging: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let target = safe_target(staging, relative)?;
    if let Some(parent) = Path::new(relative)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        ensure_directory_tree(staging, &parent.to_string_lossy())?;
    }
    Ok(target)
}

pub(crate) fn valid_modrinth_id(value: &str) -> bool {
    value.len() == 8 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

pub(crate) fn valid_hash(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn valid_version_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+'))
}

pub(crate) fn valid_provider_download_url(value: &str) -> bool {
    url_host(value).is_some_and(|host| {
        [
            "cdn.modrinth.com",
            "github.com",
            "raw.githubusercontent.com",
            "gitlab.com",
        ]
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
    })
}

pub(crate) fn valid_redirect_url(value: &str) -> bool {
    valid_provider_download_url(value)
        || url_host(value).is_some_and(|host| {
            [
                "release-assets.githubusercontent.com",
                "objects.githubusercontent.com",
                "github-releases.githubusercontent.com",
            ]
            .iter()
            .any(|allowed| host.eq_ignore_ascii_case(allowed))
        })
}

fn url_host(value: &str) -> Option<&str> {
    let (scheme, remainder) = value.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https")
        || value.len() > 8192
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace() || byte == b'\\')
    {
        return None;
    }
    let authority = remainder.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') || authority.contains('%') {
        return None;
    }
    let host = authority.strip_suffix(":443").unwrap_or(authority);
    if host.is_empty()
        || host.contains(':')
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return None;
    }
    Some(host)
}

fn archive_layer(name: &str) -> Result<Option<(OverrideLayer, &str)>, AppError> {
    let (root, remainder) = name.split_once('/').unwrap_or((name, ""));
    match root.to_ascii_lowercase().as_str() {
        "overrides" => {
            if root != "overrides" {
                return Err(validation("Modrinth override folder name is not canonical"));
            }
            Ok(Some((OverrideLayer::Shared, remainder)))
        }
        "server-overrides" => {
            if root != "server-overrides" {
                return Err(validation(
                    "Modrinth server override folder name is not canonical",
                ));
            }
            Ok(Some((OverrideLayer::Server, remainder)))
        }
        "client-overrides" => {
            if root != "client-overrides" {
                return Err(validation(
                    "Modrinth client override folder name is not canonical",
                ));
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

pub(crate) fn validate_relative_path(value: &str, is_dir: bool) -> Result<String, AppError> {
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('/')
        || value.starts_with("\\")
        || value.contains('\\')
        || value.contains(':')
        || value.contains('\0')
        || value.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err(validation(
            "Modrinth pack contains an unsafe or invalid path",
        ));
    }
    let candidate = if is_dir {
        value.strip_suffix('/').unwrap_or(value)
    } else {
        value
    };
    if candidate.is_empty() || candidate.ends_with('/') {
        return Err(validation(
            "Modrinth pack contains an invalid path component",
        ));
    }
    for component in candidate.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with(' ')
            || component.ends_with('.')
            || is_windows_device_name(component)
        {
            return Err(validation(
                "Modrinth pack contains an unsafe path component",
            ));
        }
    }
    if std::path::Path::new(candidate)
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(validation(
            "Modrinth pack contains an absolute or traversing path",
        ));
    }
    Ok(candidate.to_string())
}

fn is_windows_device_name(component: &str) -> bool {
    let base = component.split('.').next().unwrap_or_default();
    let base = base.trim_end_matches([' ', '.']).to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.len() == 1
                    && suffix
                        .as_bytes()
                        .first()
                        .is_some_and(|digit| (b'1'..=b'9').contains(digit))
            })
        })
}

fn reject_manager_reserved_path(path: &str) -> Result<(), AppError> {
    let mut components = path.split('/');
    let first = components.next().unwrap_or_default().to_ascii_lowercase();
    if RESERVED_ROOT_FILES.contains(&first.as_str())
        || RESERVED_ROOT_DIRS.contains(&first.as_str())
        || first.starts_with("modrinth-download-")
        || first.starts_with("modrinth-headers-")
    {
        return Err(validation(
            "Modrinth pack targets a server-manager reserved path",
        ));
    }
    Ok(())
}

pub(crate) fn safe_target(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let relative = validate_relative_path(relative, false)?;
    reject_manager_reserved_path(&relative)?;
    let mut target = root.to_path_buf();
    for component in relative.split('/') {
        target.push(component);
    }
    reject_reparse_components(root, &relative)?;
    Ok(target)
}

pub(crate) fn ensure_safe_staging(root: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => Ok(()),
        Ok(_) => Err(validation(
            "Modrinth staging directory is a symlink or reparse point",
        )),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn ensure_directory_tree(root: &Path, relative: &str) -> Result<(), AppError> {
    let relative = validate_relative_path(relative, true)?;
    reject_reparse_components(root, &relative)?;
    let mut current = root.to_path_buf();
    for component in relative.split('/') {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if !metadata.is_dir() || is_reparse_point(&metadata) {
                    return Err(validation(
                        "Modrinth target path contains a symlink or reparse point",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn reject_reparse_components(root: &Path, relative: &str) -> Result<(), AppError> {
    ensure_safe_staging(root)?;
    let mut current = root.to_path_buf();
    let components = relative.split('/').collect::<Vec<_>>();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        current.push(component);
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if !metadata.is_dir() || is_reparse_point(&metadata) {
                return Err(validation(
                    "Modrinth target path contains a symlink or reparse point",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn remove_existing_regular_file(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => {
            fs::remove_file(path)?
        }
        Ok(_) => return Err(validation("Modrinth target is not a regular file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn validation(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(dependencies: &str, loader: &str) -> String {
        format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Generated fixture","versionId":"fixture-version","files":[],"dependencies":{{{dependencies}}}}}"#
        )
        .replace("__loader__", loader)
    }

    #[test]
    fn parses_exact_minecraft_and_fabric_dependencies() {
        let json = manifest(
            r#""minecraft":"1.20.1","fabric-loader":"__loader__""#,
            "0.15.11",
        );
        let parsed = parse_manifest_json(&json, "1.20.1", "fabric").unwrap();
        assert_eq!(parsed.minecraft_version, "1.20.1");
        assert_eq!(parsed.loader, "fabric");
        assert_eq!(parsed.loader_version.as_deref(), Some("0.15.11"));
    }

    #[test]
    fn full_manifest_parser_requires_nonempty_name_and_version_id() {
        let valid = manifest(r#""minecraft":"1.20.1""#, "");
        let cases = [
            valid.replace("\"name\":\"Generated fixture\",", ""),
            valid.replace("\"name\":\"Generated fixture\"", "\"name\":\"\""),
            valid.replace(",\"versionId\":\"fixture-version\"", ""),
            valid.replace("\"versionId\":\"fixture-version\"", "\"versionId\":\"\""),
        ];

        for json in cases {
            assert!(parse_manifest_json(&json, "1.20.1", "minecraft").is_err());
        }
    }

    #[test]
    fn rejects_selected_version_mismatch_quilt_unknown_and_multiple_loaders() {
        let mismatch = manifest(r#""minecraft":"1.20.1""#, "");
        assert!(parse_manifest_json(&mismatch, "1.20.4", "minecraft").is_err());

        let quilt = manifest(r#""minecraft":"1.20.1","quilt-loader":"0.24.0""#, "");
        assert!(parse_manifest_json(&quilt, "1.20.1", "minecraft")
            .unwrap_err()
            .to_string()
            .contains("Quilt"));

        let unknown = manifest(r#""minecraft":"1.20.1","unknown-loader":"1.0""#, "");
        assert!(parse_manifest_json(&unknown, "1.20.1", "minecraft").is_err());

        let multiple = manifest(
            r#""minecraft":"1.20.1","forge":"47.2.0","fabric-loader":"0.15.11""#,
            "",
        );
        assert!(parse_manifest_json(&multiple, "1.20.1", "forge")
            .unwrap_err()
            .to_string()
            .contains("multiple loader"));
    }

    #[test]
    fn rejects_zip_escape_ads_device_and_manager_reserved_paths() {
        for path in [
            "../outside.txt",
            "/outside.txt",
            "C:/outside.txt",
            "folder\\outside.txt",
            "mods/file.jar:payload",
            "CON.txt",
            "LPT9.log",
        ] {
            assert!(validate_relative_path(path, false).is_err(), "{path}");
        }
        assert!(reject_manager_reserved_path("eula.txt").is_err());
        assert!(reject_manager_reserved_path("libraries/net/example.jar").is_err());
        assert!(validate_relative_path("config/good.json", false).is_ok());
    }

    #[test]
    fn prepares_override_targets_for_root_and_nested_files() {
        let staging = std::env::temp_dir().join(format!(
            "mc-server-manager-modpack-overrides-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&staging).unwrap();

        let root_target = prepare_override_file_target(&staging, "options.txt").unwrap();
        assert_eq!(root_target, staging.join("options.txt"));
        fs::write(&root_target, b"root override").unwrap();
        assert_eq!(fs::read(&root_target).unwrap(), b"root override");

        let nested_target = prepare_override_file_target(&staging, "config/server.json").unwrap();
        assert_eq!(nested_target, staging.join("config/server.json"));
        assert!(staging.join("config").is_dir());
        fs::write(&nested_target, b"nested override").unwrap();
        assert_eq!(fs::read(&nested_target).unwrap(), b"nested override");

        fs::remove_dir_all(staging).unwrap();
    }

    #[test]
    fn compares_normalized_paths_case_insensitively() {
        let mut paths = HashSet::new();
        let first = validate_relative_path("mods/Example.jar", false).unwrap();
        let second = validate_relative_path("mods/example.jar", false).unwrap();
        assert!(paths.insert(first.to_lowercase()));
        assert!(!paths.insert(second.to_lowercase()));
    }

    #[test]
    fn accepts_only_explicit_provider_and_redirect_hosts() {
        assert!(valid_provider_download_url(
            "https://cdn.modrinth.com/data/a.jar"
        ));
        assert!(!valid_provider_download_url(
            "https://objects.githubusercontent.com/a"
        ));
        assert!(valid_redirect_url(
            "https://objects.githubusercontent.com/a"
        ));
        assert!(!valid_redirect_url("https://evil.example/a"));
        assert!(!valid_redirect_url("https://github.com.evil.example/a"));
        assert!(!valid_redirect_url("https://github.com@evil.example/a"));
        assert!(!valid_redirect_url("https://github.com:8443/a"));
    }

    #[test]
    fn applies_server_environment_policy_and_keeps_absent_metadata_compatible() {
        let sha1 = "a".repeat(40);
        let sha512 = "b".repeat(128);
        let json = format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Fixture","versionId":"fixture-version","dependencies":{{"minecraft":"1.20.1"}},"files":[
              {{"path":"mods/required.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":["https://cdn.modrinth.com/data/required.jar"],"fileSize":7,"env":{{"server":"required"}}}},
              {{"path":"mods/optional.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":["https://cdn.modrinth.com/data/optional.jar"],"fileSize":7,"env":{{"server":"optional"}}}},
              {{"path":"mods/unsupported.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":["https://evil.example/unsupported.jar"],"fileSize":0,"env":{{"server":"unsupported"}}}},
              {{"path":"mods/client-only.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":["https://cdn.modrinth.com/data/client-only.jar"],"fileSize":7,"env":{{"client":"required","server":"unsupported"}}}},
              {{"path":"mods/client-only-missing-server.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":["https://cdn.modrinth.com/data/client-only-missing-server.jar"],"fileSize":7,"env":{{"client":"required"}}}},
              {{"path":"mods/no-environment.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":["https://cdn.modrinth.com/data/no-environment.jar"],"fileSize":7}}
            ]}}"#
        );
        let parsed = parse_manifest_json(&json, "1.20.1", "minecraft").unwrap();
        assert_eq!(
            parsed
                .required_files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "mods/required.jar",
                "mods/optional.jar",
                "mods/client-only-missing-server.jar",
                "mods/no-environment.jar",
            ]
        );
        assert_eq!(parsed.required_files[0].size, 7);
        assert_eq!(parsed.required_bytes, 28);
        assert_eq!(parsed.skipped_files, 2);
        assert_eq!(
            parsed
                .skipped_server_paths
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["mods/unsupported.jar", "mods/client-only.jar"]
        );
    }

    #[test]
    fn rejects_unknown_server_environment_values_and_unsafe_unsupported_paths() {
        let sha1 = "a".repeat(40);
        let sha512 = "b".repeat(128);
        let unknown = format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Fixture","versionId":"fixture-version","dependencies":{{"minecraft":"1.20.1"}},"files":[{{"path":"mods/unknown.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":["https://evil.example/unknown.jar"],"fileSize":0,"env":{{"server":"future-value"}}}}]}}"#
        );
        assert!(parse_manifest_json(&unknown, "1.20.1", "minecraft")
            .unwrap_err()
            .to_string()
            .contains("unknown env.server"));

        let explicit_null = format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Fixture","versionId":"fixture-version","dependencies":{{"minecraft":"1.20.1"}},"files":[{{"path":"mods/null-policy.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":["https://cdn.modrinth.com/data/null-policy.jar"],"fileSize":1,"env":{{"server":null}}}}]}}"#
        );
        assert!(parse_manifest_json(&explicit_null, "1.20.1", "minecraft")
            .unwrap_err()
            .to_string()
            .contains("null env.server"));

        let unsafe_path = format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Fixture","versionId":"fixture-version","dependencies":{{"minecraft":"1.20.1"}},"files":[{{"path":"../client.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":[],"fileSize":1,"env":{{"server":"unsupported"}}}}]}}"#
        );
        assert!(parse_manifest_json(&unsafe_path, "1.20.1", "minecraft").is_err());
    }

    #[test]
    fn validates_hashes_and_size_types_before_skipping_unsupported_files() {
        let sha1 = "a".repeat(40);
        let sha512 = "b".repeat(128);
        let invalid_hash = format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Fixture","versionId":"fixture-version","dependencies":{{"minecraft":"1.20.1"}},"files":[{{"path":"mods/unsupported.jar","hashes":{{"sha1":"bad","sha512":"{sha512}"}},"downloads":[],"fileSize":1,"env":{{"server":"unsupported"}}}}]}}"#
        );
        assert!(parse_manifest_json(&invalid_hash, "1.20.1", "minecraft")
            .unwrap_err()
            .to_string()
            .contains("valid size or hash"));

        let invalid_size = format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Fixture","versionId":"fixture-version","dependencies":{{"minecraft":"1.20.1"}},"files":[{{"path":"mods/unsupported.jar","hashes":{{"sha1":"{sha1}","sha512":"{sha512}"}},"downloads":[],"fileSize":"1","env":{{"server":"unsupported"}}}}]}}"#
        );
        assert!(parse_manifest_json(&invalid_size, "1.20.1", "minecraft").is_err());
    }

    #[test]
    fn rejects_invalid_pack_file_hashes() {
        let json = r#"{"formatVersion":1,"game":"minecraft","name":"Fixture","versionId":"fixture-version","dependencies":{"minecraft":"1.20.1"},"files":[{"path":"mods/bad.jar","hashes":{"sha1":"0000000000000000000000000000000000000000","sha512":"invalid"},"downloads":["https://cdn.modrinth.com/data/bad.jar"],"fileSize":1,"env":{"server":"required"}}]}"#;
        assert!(parse_manifest_json(json, "1.20.1", "minecraft").is_err());
    }

    #[test]
    fn rejects_java_25_for_fabric_mod_requiring_exact_java_21() {
        use zip::write::{SimpleFileOptions, ZipWriter};

        let staging = std::env::temp_dir().join(format!(
            "mc-server-manager-fabric-java-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(staging.join("mods")).unwrap();
        let mod_path = staging.join("mods/cobblemon.jar");
        let mut archive = ZipWriter::new(File::create(&mod_path).unwrap());
        archive
            .start_file("fabric.mod.json", SimpleFileOptions::default())
            .unwrap();
        archive
            .write_all(br#"{"id":"cobblemon","depends":{"java":"21"}}"#)
            .unwrap();
        archive.finish().unwrap();

        let error = validate_fabric_mod_java_constraints(&staging, 25)
            .unwrap_err()
            .to_string();
        let _ = fs::remove_dir_all(&staging);
        assert!(error.contains("cobblemon"));
        assert!(error.contains("Java 21"));
        assert!(error.contains("Java 25"));
    }

    fn write_fabric_test_mod(staging: &Path, file_name: &str, metadata: &[u8]) {
        fs::create_dir_all(staging.join("mods")).unwrap();
        let mod_path = staging.join("mods").join(file_name);
        fs::write(mod_path, fabric_test_mod_jar_bytes(metadata)).unwrap();
    }

    fn fabric_test_mod_jar_bytes(metadata: &[u8]) -> Vec<u8> {
        fabric_test_mod_jar_bytes_with_entries(metadata, &[])
    }

    fn fabric_test_mod_jar_bytes_with_entries(
        metadata: &[u8],
        nested_entries: &[(&str, &[u8])],
    ) -> Vec<u8> {
        use std::io::Cursor;
        use zip::write::{SimpleFileOptions, ZipWriter};

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file("fabric.mod.json", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(metadata).unwrap();
        for (path, bytes) in nested_entries {
            archive
                .start_file(*path, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(bytes).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    fn fabric_java_test_staging() -> PathBuf {
        std::env::temp_dir().join(format!(
            "mc-server-manager-fabric-java-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn write_fabric_override_archive(
        entries: &[(&str, OverrideLayer, &[u8])],
    ) -> (PathBuf, Vec<OverrideEntry>) {
        use std::io::Cursor;
        use zip::write::{SimpleFileOptions, ZipWriter};

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let mut planned = Vec::new();
        for (index, (path, layer, metadata)) in entries.iter().enumerate() {
            let prefix = match *layer {
                OverrideLayer::Shared => "overrides",
                OverrideLayer::Server => "server-overrides",
            };
            archive
                .start_file(format!("{prefix}/{path}"), SimpleFileOptions::default())
                .unwrap();
            archive.write_all(metadata).unwrap();
            planned.push(OverrideEntry {
                index,
                path: (*path).to_string(),
                size: metadata.len() as u64,
                is_dir: false,
                layer: *layer,
            });
        }
        let path = std::env::temp_dir().join(format!(
            "mc-server-manager-fabric-overrides-{}.mrpack",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, archive.finish().unwrap().into_inner()).unwrap();
        (path, planned)
    }

    fn fabric_plan_with_overrides(override_entries: Vec<OverrideEntry>) -> ManifestPlan {
        let override_bytes = override_entries.iter().map(|entry| entry.size).sum();
        ManifestPlan {
            minecraft_version: "1.20.1".into(),
            loader: "fabric".into(),
            loader_version: None,
            required_files: Vec::new(),
            skipped_files: 0,
            skipped_server_paths: Vec::new(),
            override_entries,
            required_bytes: 0,
            override_bytes,
            expanded_bytes: override_bytes,
        }
    }

    #[test]
    fn accepts_better_end_metadata_with_literal_newlines_and_no_java_dependency() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "better-end.jar",
            br#"{"id":"betterend","description":"World generation and more.
Made by:
- paulevs"}"#,
        );

        validate_fabric_mod_java_constraints(&staging, 25).unwrap();
        let _ = fs::remove_dir_all(staging);
    }

    #[test]
    fn accepts_java_range_and_array_alternatives() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "range.jar",
            br#"{"id":"range","depends":{"java":["17"," >=21 <26"]}}"#,
        );

        validate_fabric_mod_java_constraints(&staging, 25).unwrap();
        let _ = fs::remove_dir_all(staging);
    }

    #[test]
    fn accepts_java_25_for_fabric_mod_requiring_java_21_or_newer() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "range.jar",
            br#"{"id":"range","depends":{"java":">=21"}}"#,
        );

        validate_fabric_mod_java_constraints(&staging, 25).unwrap();
        let _ = fs::remove_dir_all(staging);
    }

    #[test]
    fn rejects_java_array_when_no_alternative_matches() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "array.jar",
            br#"{"id":"array","depends":{"java":["17","21"]}}"#,
        );

        let error = validate_fabric_mod_java_constraints(&staging, 25)
            .unwrap_err()
            .to_string();
        let _ = fs::remove_dir_all(staging);
        assert!(error.contains("array"));
        assert!(error.contains("[\"17\",\"21\"]"));
    }

    #[test]
    fn skips_unrecognized_java_predicate_without_fabricating_a_mismatch() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "future-syntax.jar",
            br#"{"id":"future","depends":{"java":"21 || 25"}}"#,
        );

        validate_fabric_mod_java_constraints(&staging, 25).unwrap();
        let _ = fs::remove_dir_all(staging);
    }

    #[test]
    fn skips_precision_dependent_and_empty_java_predicates() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "minor-range.jar",
            br#"{"id":"minor-range","depends":{"java":">=21.1"}}"#,
        );
        write_fabric_test_mod(
            &staging,
            "patch-exact.jar",
            br#"{"id":"patch-exact","depends":{"java":"21.0.8"}}"#,
        );
        write_fabric_test_mod(
            &staging,
            "empty-requirement.jar",
            br#"{"id":"empty-requirement","depends":{"java":"   "}}"#,
        );

        validate_fabric_mod_java_constraints(&staging, 17).unwrap();
        assert!(parse_java_major_constraint(">=21.1").is_none());
        assert!(parse_java_major_constraint("21.0.8").is_none());
        assert!(parse_java_major_constraint("").is_none());
        assert!(parse_java_major_constraint("  \t ").is_none());
        let _ = fs::remove_dir_all(staging);
    }

    #[test]
    fn preflights_only_the_effective_override_mod_after_server_layer_replacement() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "replaced.jar",
            br#"{"id":"downloaded","depends":{"java":"21"}}"#,
        );
        let shared = fabric_test_mod_jar_bytes(br#"{"id":"shared","depends":{"java":"21"}}"#);
        let server = fabric_test_mod_jar_bytes(br#"{"id":"server","depends":{"java":">=21"}}"#);
        let (archive, entries) = write_fabric_override_archive(&[
            ("mods/replaced.jar", OverrideLayer::Shared, &shared),
            ("mods/replaced.jar", OverrideLayer::Server, &server),
        ]);
        let plan = fabric_plan_with_overrides(entries);

        validate_fabric_mod_java_constraints_with_overrides(&staging, 25, &archive, &plan, None)
            .unwrap();

        assert!(fs::read_dir(&staging).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".fabric-java-preflight-")));

        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(archive);
    }

    #[test]
    fn detects_java_conflict_in_override_mod_before_copying_the_layer() {
        let staging = fabric_java_test_staging();
        fs::create_dir_all(&staging).unwrap();
        let server =
            fabric_test_mod_jar_bytes(br#"{"id":"override-conflict","depends":{"java":"21"}}"#);
        let (archive, entries) =
            write_fabric_override_archive(&[("mods/conflict.jar", OverrideLayer::Server, &server)]);
        let plan = fabric_plan_with_overrides(entries);

        let error = validate_fabric_mod_java_constraints_with_overrides(
            &staging, 25, &archive, &plan, None,
        )
        .unwrap_err()
        .to_string();

        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(archive);
        assert!(error.contains("override-conflict"));
        assert!(error.contains("Java 21"));
    }

    #[test]
    fn blocks_missing_hard_ids_and_names_matching_unsupported_files() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "forgeconfigscreens.jar",
            br#"{"id":"forgeconfigscreens","depends":{"modmenu":"*"}}"#,
        );
        write_fabric_test_mod(
            &staging,
            "mutant-skeleton.jar",
            br#"{"id":"mutant_skeleton_armor_tweaks","depends":{"s_lib":">=3.0.1"}}"#,
        );
        write_fabric_test_mod(
            &staging,
            "simplyswords.jar",
            br#"{"id":"simplyswords","depends":{"simplytooltips":"*"}}"#,
        );
        let skipped = vec![
            "mods/modmenu-7.2.2.jar".to_string(),
            "mods/s-lib-fabric-3.0.1+1.20.1.jar".to_string(),
            "mods/SimplyTooltips-fabric-0.1.5-1.20.1.jar".to_string(),
        ];

        let error = validate_fabric_mod_hard_dependencies(&staging, &skipped, None)
            .unwrap_err()
            .to_string();

        let _ = fs::remove_dir_all(&staging);
        assert!(error.contains("forgeconfigscreens"));
        assert!(error.contains("modmenu"));
        assert!(error.contains("mutant_skeleton_armor_tweaks"));
        assert!(error.contains("s_lib"));
        assert!(error.contains("simplyswords"));
        assert!(error.contains("simplytooltips"));
        assert!(error.contains("mods/modmenu-7.2.2.jar"));
        assert!(error.contains("mods/s-lib-fabric-3.0.1+1.20.1.jar"));
        assert!(error.contains("mods/SimplyTooltips-fabric-0.1.5-1.20.1.jar"));
        assert!(error.contains("env.server=unsupported"));
    }

    #[test]
    fn does_not_report_a_skipped_filename_with_only_a_dependency_id_prefix() {
        let skipped = vec!["mods/modmenuhelper.jar".to_string()];
        assert!(matching_skipped_unsupported_path("modmenu", &skipped).is_none());
    }

    #[test]
    fn counts_fabric_builtins_and_provides_aliases_but_ignores_soft_dependencies() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "fabric-api.jar",
            br#"{"id":"fabric-api","provides":["fabric"]}"#,
        );
        write_fabric_test_mod(
            &staging,
            "dependent.jar",
            br#"{"id":"dependent","depends":{"minecraft":"1.20.1","java":">=17","fabricloader":">=0.15","fabric":"*"},"recommends":{"optional":"*"},"suggests":{"suggested":"*"}}"#,
        );

        let complete = validate_fabric_mod_hard_dependencies(&staging, &[], None).unwrap();

        assert!(fs::read_dir(&staging).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".fabric-dependency-preflight-")));
        let _ = fs::remove_dir_all(&staging);
        assert!(complete);
    }

    #[test]
    fn includes_only_declared_nested_jars_as_server_candidates() {
        let staging = fabric_java_test_staging();
        let nested = fabric_test_mod_jar_bytes(br#"{"id":"nested_provider"}"#);
        let parent = fabric_test_mod_jar_bytes_with_entries(
            br#"{"id":"parent","jars":[{"file":"META-INF/jars/nested-provider.jar"}]}"#,
            &[("META-INF/jars/nested-provider.jar", &nested)],
        );
        fs::create_dir_all(staging.join("mods")).unwrap();
        fs::write(staging.join("mods/parent.jar"), parent).unwrap();
        write_fabric_test_mod(
            &staging,
            "dependent.jar",
            br#"{"id":"dependent","depends":{"nested_provider":"*"}}"#,
        );

        let complete = validate_fabric_mod_hard_dependencies(&staging, &[], None).unwrap();

        let _ = fs::remove_dir_all(&staging);
        assert!(complete);
    }

    #[test]
    fn duplicate_and_missing_nested_declarations_mark_inventory_incomplete() {
        let staging = fabric_java_test_staging();
        let nested = fabric_test_mod_jar_bytes(br#"{"id":"nested_provider"}"#);
        let nested_path = "META-INF/jars/nested-provider.jar";
        let parent = fabric_test_mod_jar_bytes_with_entries(
            br#"{"id":"parent","jars":[{"file":"META-INF/jars/nested-provider.jar"},{"file":"META-INF/jars/nested-provider.jar"},{"file":"META-INF/jars/missing.jar"}]}"#,
            &[(nested_path, &nested)],
        );
        fs::create_dir_all(staging.join("mods")).unwrap();
        fs::write(staging.join("mods/parent.jar"), parent).unwrap();
        write_fabric_test_mod(
            &staging,
            "dependent.jar",
            br#"{"id":"dependent","depends":{"nested_provider":"*"}}"#,
        );

        let complete = validate_fabric_mod_hard_dependencies(&staging, &[], None).unwrap();

        let _ = fs::remove_dir_all(staging);
        assert!(!complete);
    }

    #[test]
    fn duplicate_nested_declarations_are_marked_incomplete_even_when_the_entry_exists() {
        let staging = fabric_java_test_staging();
        let nested = fabric_test_mod_jar_bytes(br#"{"id":"nested_provider"}"#);
        let nested_path = "META-INF/jars/nested-provider.jar";
        let parent = fabric_test_mod_jar_bytes_with_entries(
            br#"{"id":"parent","jars":[{"file":"META-INF/jars/nested-provider.jar"},{"file":"META-INF/jars/nested-provider.jar"}]}"#,
            &[(nested_path, &nested)],
        );
        fs::create_dir_all(staging.join("mods")).unwrap();
        fs::write(staging.join("mods/parent.jar"), parent).unwrap();

        let complete = validate_fabric_mod_hard_dependencies(&staging, &[], None).unwrap();

        let _ = fs::remove_dir_all(staging);
        assert!(!complete);
    }

    #[test]
    fn nested_archive_index_marks_a_missing_declared_entry_incomplete() {
        let staging = fabric_java_test_staging();
        fs::create_dir_all(&staging).unwrap();
        let nested_path = "META-INF/jars/nested-provider.jar";
        let nested = fabric_test_mod_jar_bytes(br#"{"id":"nested_provider"}"#);
        let archive_path = staging.join("parent.jar");
        fs::write(
            &archive_path,
            fabric_test_mod_jar_bytes_with_entries(
                br#"{"id":"parent"}"#,
                &[(nested_path, &nested)],
            ),
        )
        .unwrap();
        let archive = ZipArchive::new(File::open(&archive_path).unwrap()).unwrap();
        let mut central_entries_scanned = 0;
        let mut complete = true;
        let counts = index_declared_nested_fabric_jars(
            &archive,
            &[
                nested_path.to_string(),
                "META-INF/jars/missing.jar".to_string(),
            ],
            &mut central_entries_scanned,
            "parent.jar",
            &mut complete,
            None,
        )
        .unwrap()
        .unwrap();

        let _ = fs::remove_dir_all(staging);
        assert_eq!(counts.get(nested_path), Some(&1));
        assert_eq!(counts.get("META-INF/jars/missing.jar"), None);
        assert!(!complete);
    }

    #[test]
    fn fabric_dependency_preflight_work_limits_are_aggregate_and_bounded() {
        let mut central_entries = MAX_FABRIC_DEPENDENCY_CENTRAL_ENTRIES - 1;
        assert!(account_fabric_dependency_central_entries(
            &mut central_entries,
            1
        ));
        assert_eq!(central_entries, MAX_FABRIC_DEPENDENCY_CENTRAL_ENTRIES);
        assert!(!account_fabric_dependency_central_entries(
            &mut central_entries,
            1
        ));
        assert_eq!(central_entries, MAX_FABRIC_DEPENDENCY_CENTRAL_ENTRIES);

        let mut declarations = MAX_FABRIC_NESTED_DECLARATIONS - 1;
        assert!(account_fabric_nested_declarations(&mut declarations, 1));
        assert_eq!(declarations, MAX_FABRIC_NESTED_DECLARATIONS);
        assert!(!account_fabric_nested_declarations(&mut declarations, 1));
        assert_eq!(declarations, MAX_FABRIC_NESTED_DECLARATIONS);
    }

    #[test]
    fn does_not_count_client_only_or_undeclared_embedded_jars_as_providers() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "client-provider.jar",
            br#"{"id":"modmenu","environment":"client"}"#,
        );
        let undeclared = fabric_test_mod_jar_bytes(br#"{"id":"embedded_provider"}"#);
        fs::write(
            staging.join("mods/undeclared-parent.jar"),
            fabric_test_mod_jar_bytes_with_entries(
                br#"{"id":"parent"}"#,
                &[("META-INF/jars/embedded.jar", &undeclared)],
            ),
        )
        .unwrap();
        write_fabric_test_mod(
            &staging,
            "dependent.jar",
            br#"{"id":"dependent","depends":{"modmenu":"*","embedded_provider":"*"}}"#,
        );

        let error = validate_fabric_mod_hard_dependencies(&staging, &[], None)
            .unwrap_err()
            .to_string();

        let _ = fs::remove_dir_all(&staging);
        assert!(error.contains("dependent"));
        assert!(error.contains("modmenu"));
        assert!(error.contains("embedded_provider"));
    }

    #[test]
    fn server_override_replacement_wins_over_shared_and_downloaded_providers() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "dependent.jar",
            br#"{"id":"dependent","depends":{"provider":"*"}}"#,
        );
        write_fabric_test_mod(&staging, "provider.jar", br#"{"id":"provider"}"#);
        let shared = fabric_test_mod_jar_bytes(br#"{"id":"provider"}"#);
        let server = fabric_test_mod_jar_bytes(br#"{"id":"provider","environment":"client"}"#);
        let (archive, entries) = write_fabric_override_archive(&[
            ("mods/provider.jar", OverrideLayer::Shared, &shared),
            ("mods/provider.jar", OverrideLayer::Server, &server),
        ]);
        let plan = fabric_plan_with_overrides(entries);

        let error =
            validate_fabric_mod_hard_dependencies_with_overrides(&staging, &archive, &plan, None)
                .unwrap_err()
                .to_string();

        assert!(fs::read_dir(&staging).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".fabric-dependency-preflight-")));
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(archive);
        assert!(error.contains("dependent"));
        assert!(error.contains("provider"));
    }

    #[test]
    fn reports_incomplete_dependency_metadata_without_asserting_a_missing_id() {
        let staging = fabric_java_test_staging();
        write_fabric_test_mod(
            &staging,
            "dependent.jar",
            br#"{"id":"dependent","depends":{"provider":"*"}}"#,
        );
        fs::write(staging.join("mods/unreadable.jar"), b"not a JAR").unwrap();

        let complete = validate_fabric_mod_hard_dependencies(&staging, &[], None).unwrap();

        let _ = fs::remove_dir_all(&staging);
        assert!(!complete);
    }

    #[test]
    fn bounds_fabric_mod_jar_size_and_central_directory_entries() {
        assert!(
            validate_fabric_mod_jar_size("oversized.jar", MAX_FABRIC_MOD_JAR_BYTES + 1)
                .unwrap_err()
                .to_string()
                .contains("512 MiB inspection limit")
        );
        assert!(
            validate_fabric_mod_jar_entry_count("many-entries.jar", MAX_ARCHIVE_ENTRIES + 1)
                .unwrap_err()
                .to_string()
                .contains("entry inspection limit")
        );
    }

    #[test]
    fn rejects_zip_symbolic_link_entries() {
        use std::io::Cursor;
        use zip::write::{SimpleFileOptions, ZipWriter};

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("modrinth.index.json", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"{}").unwrap();
        writer
            .add_symlink(
                "overrides/link",
                "../../outside",
                SimpleFileOptions::default(),
            )
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let path = std::env::temp_dir().join(format!(
            "mc-server-manager-modpack-symlink-{}.mrpack",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, bytes).unwrap();
        let error = parse_mrpack(&path, "1.20.1", "minecraft").unwrap_err();
        assert!(error.to_string().contains("symbolic link"));
        let _ = fs::remove_file(path);
    }
}
