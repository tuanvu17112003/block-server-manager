use crate::{
    error::AppError,
    installer::{self, JobControl},
    modpacks::{
        install,
        pipeline::{
            model::{validate_safe_relative_path, ContentHashes},
            plan::{InstallPlan, LoaderKind, LoaderPin},
        },
    },
};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

const MOJANG_MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const FORGE_PROMOTIONS: &str =
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_CATALOGUE: &str =
    "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const NEOFORGE_METADATA: &str =
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
const MOJANG_METADATA_HOSTS: &[&str] = &["piston-meta.mojang.com"];
const MOJANG_ARTIFACT_HOSTS: &[&str] = &["piston-data.mojang.com", "launcher.mojang.com"];
const FABRIC_HOSTS: &[&str] = &["meta.fabricmc.net"];
const FORGE_METADATA_HOSTS: &[&str] = &["files.minecraftforge.net"];
const FORGE_ARTIFACT_HOSTS: &[&str] = &["maven.minecraftforge.net"];
const NEOFORGE_HOSTS: &[&str] = &["maven.neoforged.net"];
const MAX_ARGUMENT_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_ARGUMENT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ARGUMENT_COUNT: usize = 16_384;
const MAX_ARGUMENT_TOKEN_BYTES: usize = 64 * 1024;
const MAX_ARGUMENT_INCLUDE_DEPTH: usize = 8;
const MAX_RUNTIME_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_WINDOWS_PATH_UTF16_UNITS: usize = 240;

#[derive(Debug, thiserror::Error)]
pub enum LoaderPreparationError {
    #[error("unsupported loader: {0}")]
    Unsupported(String),
    #[error("exact loader build is unavailable or mismatched: {0}")]
    Unavailable(String),
    #[error("invalid loader metadata or runtime: {0}")]
    Invalid(String),
    #[error("loader preparation was cancelled")]
    Cancelled,
    #[error("loader preparation failed: {0}")]
    Installer(String),
    #[error("loader runtime I/O failed: {0}")]
    Io(String),
}

impl From<AppError> for LoaderPreparationError {
    fn from(error: AppError) -> Self {
        match error {
            AppError::Conflict(message) if message.contains("cancelled") => Self::Cancelled,
            other => Self::Installer(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoaderInstallMethod {
    MojangServerJar,
    FabricServerJar,
    ForgeServerInstaller,
    NeoForgeServerInstaller,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoaderLaunchMode {
    ServerJar {
        file_name: String,
    },
    LegacyForgeJars {
        forge_jar: String,
        minecraft_jar: String,
    },
    ArgumentFiles {
        user_jvm_args: String,
        loader_args: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoaderCoordinate {
    /// The source plan's loader pin, preserved without rewriting.
    pub provider_pin: LoaderPin,
    /// The exact runtime version resolved from official metadata.
    pub resolved_version: Option<String>,
    /// A separate installer coordinate; it never replaces the provider pin.
    pub installer_loader_version: Option<String>,
    /// Exact Forge Maven coordinate when applicable.
    pub forge_artifact: Option<String>,
    pub artifact_url: String,
    pub expected_size: Option<u64>,
    pub expected_sha1: Option<String>,
    pub metadata_source: String,
    pub install_method: LoaderInstallMethod,
    /// Only this reviewed source-specific host set may receive artifact requests.
    pub allowed_redirect_hosts: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoaderRequiredFile {
    pub relative_path: String,
    pub size_bytes: u64,
    pub hashes: ContentHashes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoaderCompletenessEvidence {
    /// The finalized provider plan, retained verbatim as audit evidence.
    pub plan: InstallPlan,
    /// The executable selected and validated before metadata or staging work.
    pub selected_java_path: PathBuf,
    pub coordinate: LoaderCoordinate,
    pub launch_mode: LoaderLaunchMode,
    pub required_files: Vec<LoaderRequiredFile>,
    pub complete: bool,
}

/// Resolves the loader pin already selected by a validated provider plan, installs
/// the exact runtime into isolated staging, and verifies every launch reference.
/// This function never accepts an existing runtime based on its directory name.
pub(crate) fn prepare_from_plan(
    plan: &InstallPlan,
    staging: &Path,
    java_path: Option<&Path>,
    app: &AppHandle,
    job_id: &str,
    control: &JobControl,
) -> Result<LoaderCompletenessEvidence, LoaderPreparationError> {
    ensure_supported_loader(&plan.loader)?;
    plan.validate_ready_to_install()
        .map_err(|error| LoaderPreparationError::Invalid(error.to_string()))?;
    plan.loader
        .validate()
        .map_err(|error| LoaderPreparationError::Invalid(error.to_string()))?;
    validate_java_then(
        &plan.loader.minecraft_version,
        java_path,
        |path, minecraft_version| {
            crate::java::validate_java_for_version(path, minecraft_version)
                .map(|candidate| PathBuf::from(candidate.path))
        },
        |validated_java_path| {
            validate_pipeline_staging_root(app, staging)?;
            validate_staging_root(staging)?;
            installer::ensure_not_cancelled(control)?;

            let coordinate = resolve_live_coordinate(&plan.loader, control)?;
            installer::ensure_not_cancelled(control)?;
            installer::prepare_pipeline_runtime_artifact(
                app,
                job_id,
                staging,
                loader_name(plan.loader.kind),
                &plan.loader.minecraft_version,
                coordinate.installer_loader_version.as_deref(),
                Some(&validated_java_path),
                &coordinate.artifact_url,
                coordinate.expected_size,
                coordinate.expected_sha1.as_deref(),
                coordinate.allowed_redirect_hosts,
                control,
            )?;
            installer::ensure_not_cancelled(control)?;

            let (launch_mode, required_files) = inspect_prepared_runtime(staging, &coordinate)?;
            installer::ensure_not_cancelled(control)?;
            Ok(LoaderCompletenessEvidence {
                plan: plan.clone(),
                selected_java_path: validated_java_path,
                coordinate,
                launch_mode,
                required_files,
                complete: true,
            })
        },
    )
}

fn validate_java_then<T>(
    minecraft_version: &str,
    java_path: Option<&Path>,
    validate_java: impl FnOnce(&str, &str) -> Result<PathBuf, crate::error::AppError>,
    continue_after_validation: impl FnOnce(PathBuf) -> Result<T, LoaderPreparationError>,
) -> Result<T, LoaderPreparationError> {
    let supplied = java_path.ok_or_else(|| {
        LoaderPreparationError::Invalid(
            "select a compatible Java executable before loader preparation".into(),
        )
    })?;
    let supplied = supplied.to_str().ok_or_else(|| {
        LoaderPreparationError::Invalid("selected Java executable path is not valid Unicode".into())
    })?;
    let validated = validate_java(supplied, minecraft_version)
        .map_err(|error| LoaderPreparationError::Installer(error.to_string()))?;
    continue_after_validation(validated)
}

fn resolve_live_coordinate(
    pin: &LoaderPin,
    control: &JobControl,
) -> Result<LoaderCoordinate, LoaderPreparationError> {
    ensure_supported_loader(pin)?;
    pin.validate()
        .map_err(|error| LoaderPreparationError::Invalid(error.to_string()))?;
    if !safe_version_segment(&pin.minecraft_version) {
        return Err(LoaderPreparationError::Invalid(
            "Minecraft version is not a safe exact metadata coordinate".into(),
        ));
    }

    match pin.kind {
        LoaderKind::Vanilla => {
            let manifest = installer::fetch_pipeline_metadata_json(
                MOJANG_MANIFEST,
                control,
                MOJANG_METADATA_HOSTS,
            )?;
            let version_url = vanilla_version_url(&manifest, &pin.minecraft_version)?;
            let version_metadata = installer::fetch_pipeline_metadata_json(
                &version_url,
                control,
                MOJANG_METADATA_HOSTS,
            )?;
            resolve_vanilla_metadata(pin, &manifest, &version_metadata)
        }
        LoaderKind::Fabric => {
            let loader_version = required_loader_version(pin)?;
            let url = format!(
                "{FABRIC_META}/versions/loader/{}/{loader_version}",
                pin.minecraft_version
            );
            let metadata = installer::fetch_pipeline_metadata_json(&url, control, FABRIC_HOSTS)?;
            resolve_fabric_metadata(pin, &metadata)
        }
        LoaderKind::Forge => {
            let catalogue = installer::fetch_pipeline_metadata_json(
                FORGE_CATALOGUE,
                control,
                FORGE_METADATA_HOSTS,
            )?;
            let promotions = installer::fetch_pipeline_metadata_json(
                FORGE_PROMOTIONS,
                control,
                FORGE_METADATA_HOSTS,
            )?;
            resolve_forge_metadata(pin, &promotions, &catalogue)
        }
        LoaderKind::NeoForge => {
            let xml = installer::fetch_pipeline_metadata_text(
                NEOFORGE_METADATA,
                control,
                NEOFORGE_HOSTS,
            )?;
            resolve_neoforge_metadata(pin, &xml)
        }
        LoaderKind::Quilt => unreachable!("Quilt is rejected before metadata lookup"),
    }
}

fn resolve_vanilla_metadata(
    pin: &LoaderPin,
    manifest: &Value,
    version_metadata: &Value,
) -> Result<LoaderCoordinate, LoaderPreparationError> {
    if pin.kind != LoaderKind::Vanilla || pin.loader_version.is_some() {
        return Err(LoaderPreparationError::Invalid(
            "Vanilla metadata was paired with a non-Vanilla pin".into(),
        ));
    }
    let version_url = vanilla_version_url(manifest, &pin.minecraft_version)?;
    if version_metadata.get("id").and_then(Value::as_str) != Some(pin.minecraft_version.as_str()) {
        return Err(LoaderPreparationError::Unavailable(
            "Mojang version metadata returned a different Minecraft ID".into(),
        ));
    }
    let server = version_metadata
        .get("downloads")
        .and_then(|value| value.get("server"))
        .ok_or_else(|| {
            LoaderPreparationError::Unavailable("Mojang server JAR is unavailable".into())
        })?;
    let url = required_string(server, "url")?;
    let size = server
        .get("size")
        .and_then(Value::as_u64)
        .filter(|size| *size > 0 && *size <= MAX_RUNTIME_ARTIFACT_BYTES)
        .ok_or_else(|| {
            LoaderPreparationError::Invalid("Mojang server JAR size is invalid".into())
        })?;
    let sha1 = required_string(server, "sha1")?.to_ascii_lowercase();
    if !trusted_https_url(url, &["piston-data.mojang.com", "launcher.mojang.com"])
        || !valid_hash(&sha1, 40)
    {
        return Err(LoaderPreparationError::Invalid(
            "Mojang server JAR metadata is invalid or outside the official hosts".into(),
        ));
    }
    Ok(LoaderCoordinate {
        provider_pin: pin.clone(),
        resolved_version: None,
        installer_loader_version: None,
        forge_artifact: None,
        artifact_url: url.to_string(),
        expected_size: Some(size),
        expected_sha1: Some(sha1),
        metadata_source: format!("Mojang manifest and {version_url}"),
        install_method: LoaderInstallMethod::MojangServerJar,
        allowed_redirect_hosts: MOJANG_ARTIFACT_HOSTS,
    })
}

fn vanilla_version_url(
    manifest: &Value,
    minecraft_version: &str,
) -> Result<String, LoaderPreparationError> {
    let versions = manifest
        .get("versions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LoaderPreparationError::Invalid("Mojang version manifest is malformed".into())
        })?;
    let matching = versions
        .iter()
        .filter(|entry| entry.get("id").and_then(Value::as_str) == Some(minecraft_version))
        .collect::<Vec<_>>();
    let [entry] = matching.as_slice() else {
        return Err(LoaderPreparationError::Unavailable(format!(
            "Minecraft {minecraft_version} is absent or ambiguous in Mojang's version manifest"
        )));
    };
    if !matches!(
        entry.get("type").and_then(Value::as_str),
        Some("release" | "snapshot")
    ) {
        return Err(LoaderPreparationError::Unsupported(format!(
            "Minecraft {minecraft_version} is not an installable Mojang release or snapshot"
        )));
    }
    let url = required_string(entry, "url")?;
    if !trusted_https_url(url, &["piston-meta.mojang.com"]) {
        return Err(LoaderPreparationError::Invalid(
            "Mojang version metadata URL is outside the official host".into(),
        ));
    }
    Ok(url.to_string())
}

fn resolve_fabric_metadata(
    pin: &LoaderPin,
    metadata: &Value,
) -> Result<LoaderCoordinate, LoaderPreparationError> {
    if pin.kind != LoaderKind::Fabric {
        return Err(LoaderPreparationError::Invalid(
            "Fabric metadata was paired with a non-Fabric pin".into(),
        ));
    }
    let version = required_loader_version(pin)?;
    let confirmed = metadata
        .get("loader")
        .and_then(|loader| loader.get("version"))
        .and_then(Value::as_str);
    if confirmed != Some(version) {
        return Err(LoaderPreparationError::Unavailable(
            "Fabric Meta did not confirm the exact selected loader version".into(),
        ));
    }
    if let Some(game_version) = metadata
        .get("intermediary")
        .and_then(|intermediary| intermediary.get("version"))
        .and_then(Value::as_str)
    {
        if game_version != pin.minecraft_version {
            return Err(LoaderPreparationError::Unavailable(
                "Fabric Meta mapped the selected loader to a different Minecraft version".into(),
            ));
        }
    }
    let url = format!(
        "{FABRIC_META}/versions/loader/{}/{version}/server/jar",
        pin.minecraft_version
    );
    Ok(LoaderCoordinate {
        provider_pin: pin.clone(),
        resolved_version: Some(version.to_string()),
        installer_loader_version: Some(version.to_string()),
        forge_artifact: None,
        artifact_url: url,
        expected_size: None,
        expected_sha1: None,
        metadata_source: format!(
            "Fabric Meta exact loader endpoint for Minecraft {}",
            pin.minecraft_version
        ),
        install_method: LoaderInstallMethod::FabricServerJar,
        allowed_redirect_hosts: FABRIC_HOSTS,
    })
}

fn resolve_forge_metadata(
    pin: &LoaderPin,
    promotions: &Value,
    catalogue: &Value,
) -> Result<LoaderCoordinate, LoaderPreparationError> {
    if pin.kind != LoaderKind::Forge {
        return Err(LoaderPreparationError::Invalid(
            "Forge metadata was paired with a non-Forge pin".into(),
        ));
    }
    let source_version = required_loader_version(pin)?;
    let artifacts = forge_catalogue_artifacts(catalogue, &pin.minecraft_version)?;
    let (artifact, installer_version, metadata_source) = if let Some((promotion, version)) =
        source_version.split_once(':')
    {
        if !safe_version_segment(version) {
            return Err(LoaderPreparationError::Invalid(
                "Forge version marker is malformed".into(),
            ));
        }
        match promotion {
            "specific" => {
                let prefix = format!("{}-", pin.minecraft_version);
                if !version.starts_with(&prefix) {
                    return Err(LoaderPreparationError::Unavailable(
                        "specific Forge coordinate targets a different Minecraft version".into(),
                    ));
                }
                (
                    version.to_string(),
                    source_version.to_string(),
                    "Forge Maven catalogue".to_string(),
                )
            }
            "recommended" | "latest" => {
                let selected = promotions
                    .get("promos")
                    .and_then(|items| items.get(format!("{}-{promotion}", pin.minecraft_version)))
                    .and_then(Value::as_str);
                if selected != Some(version) {
                    return Err(LoaderPreparationError::Unavailable(format!(
                        "Forge {promotion} promotion no longer resolves to the pinned build"
                    )));
                }
                let artifact = format!("{}-{version}", pin.minecraft_version);
                (
                    artifact,
                    source_version.to_string(),
                    format!("Forge {promotion} promotion and Maven catalogue"),
                )
            }
            _ => {
                return Err(LoaderPreparationError::Invalid(
                    "Forge pin uses an unknown promotion marker".into(),
                ))
            }
        }
    } else if source_version.starts_with(&format!("{}-", pin.minecraft_version)) {
        (
            source_version.to_string(),
            format!("specific:{source_version}"),
            "Forge Maven catalogue".to_string(),
        )
    } else {
        let normalized = format!("{}-{source_version}", pin.minecraft_version);
        (
            normalized.clone(),
            format!("specific:{normalized}"),
            "Forge Maven catalogue".to_string(),
        )
    };
    if !safe_version_segment(&artifact) || !artifacts.contains(&artifact) {
        return Err(LoaderPreparationError::Unavailable(format!(
            "Forge artifact {artifact} is not listed for Minecraft {}",
            pin.minecraft_version
        )));
    }
    let installer_name = format!("forge-{artifact}-installer.jar");
    let artifact_url = format!(
        "https://maven.minecraftforge.net/net/minecraftforge/forge/{artifact}/{installer_name}"
    );
    Ok(LoaderCoordinate {
        provider_pin: pin.clone(),
        resolved_version: Some(
            artifact
                .strip_prefix(&format!("{}-", pin.minecraft_version))
                .unwrap_or(&artifact)
                .to_string(),
        ),
        installer_loader_version: Some(installer_version),
        forge_artifact: Some(artifact),
        artifact_url,
        expected_size: None,
        expected_sha1: None,
        metadata_source,
        install_method: LoaderInstallMethod::ForgeServerInstaller,
        allowed_redirect_hosts: FORGE_ARTIFACT_HOSTS,
    })
}

fn forge_catalogue_artifacts(
    catalogue: &Value,
    minecraft_version: &str,
) -> Result<Vec<String>, LoaderPreparationError> {
    let versions = catalogue
        .get(minecraft_version)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LoaderPreparationError::Unavailable(format!(
                "Forge has no catalogue for Minecraft {minecraft_version}"
            ))
        })?;
    let mut artifacts = BTreeSet::new();
    for value in versions {
        let entry = value
            .as_str()
            .filter(|entry| !entry.is_empty() && entry.len() <= 96)
            .ok_or_else(|| {
                LoaderPreparationError::Invalid("Forge catalogue is malformed".into())
            })?;
        let artifact = if entry.starts_with(&format!("{minecraft_version}-")) {
            entry.to_string()
        } else {
            format!("{minecraft_version}-{entry}")
        };
        if safe_version_segment(&artifact) {
            artifacts.insert(artifact);
        }
    }
    Ok(artifacts.into_iter().collect())
}

fn resolve_neoforge_metadata(
    pin: &LoaderPin,
    metadata_xml: &str,
) -> Result<LoaderCoordinate, LoaderPreparationError> {
    if pin.kind != LoaderKind::NeoForge {
        return Err(LoaderPreparationError::Invalid(
            "NeoForge metadata was paired with a different loader pin".into(),
        ));
    }
    if metadata_xml.len() > 16 * 1024 * 1024 {
        return Err(LoaderPreparationError::Invalid(
            "NeoForge Maven metadata exceeds the 16 MiB limit".into(),
        ));
    }
    let version = required_loader_version(pin)?;
    let prefix = neoforge_prefix(&pin.minecraft_version).ok_or_else(|| {
        LoaderPreparationError::Unsupported(format!(
            "NeoForge has no supported Minecraft mapping for {}",
            pin.minecraft_version
        ))
    })?;
    if !version.starts_with(prefix) {
        return Err(LoaderPreparationError::Unavailable(format!(
            "NeoForge {version} does not map to Minecraft {}",
            pin.minecraft_version
        )));
    }
    if !metadata_xml_versions(metadata_xml).any(|candidate| candidate == version) {
        return Err(LoaderPreparationError::Unavailable(format!(
            "NeoForge {version} is absent from the exact Maven metadata"
        )));
    }
    let file_name = format!("neoforge-{version}-installer.jar");
    Ok(LoaderCoordinate {
        provider_pin: pin.clone(),
        resolved_version: Some(version.to_string()),
        installer_loader_version: Some(version.to_string()),
        forge_artifact: None,
        artifact_url: format!(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/{version}/{file_name}"
        ),
        expected_size: None,
        expected_sha1: None,
        metadata_source: "NeoForge Maven metadata".into(),
        install_method: LoaderInstallMethod::NeoForgeServerInstaller,
        allowed_redirect_hosts: NEOFORGE_HOSTS,
    })
}

fn metadata_xml_versions(xml: &str) -> impl Iterator<Item = &str> {
    xml.match_indices("<version>")
        .filter_map(move |(start, _)| {
            let content_start = start + "<version>".len();
            let end = xml[content_start..].find("</version>")? + content_start;
            Some(xml[content_start..end].trim())
        })
}

fn neoforge_prefix(minecraft_version: &str) -> Option<&'static str> {
    match minecraft_version {
        "1.20.1" => Some("47."),
        "1.20.4" => Some("20.4."),
        "1.20.6" => Some("20.6."),
        "1.21" => Some("21.0."),
        _ => None,
    }
}

fn required_loader_version(pin: &LoaderPin) -> Result<&str, LoaderPreparationError> {
    let version = pin
        .loader_version
        .as_deref()
        .filter(|version| {
            if pin.kind != LoaderKind::Forge {
                return safe_version_segment(version);
            }
            match version.split_once(':') {
                Some((marker, build)) => {
                    matches!(marker, "specific" | "recommended" | "latest")
                        && safe_version_segment(build)
                }
                None => safe_version_segment(version),
            }
        })
        .ok_or_else(|| {
            LoaderPreparationError::Invalid("exact loader version is malformed".into())
        })?;
    Ok(version)
}

fn safe_version_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'))
}

fn ensure_supported_loader(pin: &LoaderPin) -> Result<(), LoaderPreparationError> {
    if pin.kind == LoaderKind::Quilt {
        return Err(LoaderPreparationError::Unsupported(
            "Quilt installs remain a disabled placeholder".into(),
        ));
    }
    Ok(())
}

fn required_string<'a>(object: &'a Value, field: &str) -> Result<&'a str, LoaderPreparationError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            LoaderPreparationError::Invalid(format!("metadata field {field} is missing"))
        })
}

fn valid_hash(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn trusted_https_url(url: &str, hosts: &[&str]) -> bool {
    let Some(authority) = url
        .strip_prefix("https://")
        .and_then(|tail| tail.split(['/', '?', '#']).next())
    else {
        return false;
    };
    !authority.is_empty()
        && !authority.contains(['@', ':'])
        && hosts
            .iter()
            .any(|expected| authority.eq_ignore_ascii_case(expected))
}

fn loader_name(kind: LoaderKind) -> &'static str {
    match kind {
        LoaderKind::Vanilla => "Vanilla",
        LoaderKind::Fabric => "Fabric",
        LoaderKind::Forge => "Forge",
        LoaderKind::NeoForge => "NeoForge",
        LoaderKind::Quilt => "Quilt",
    }
}

fn validate_staging_root(staging: &Path) -> Result<(), LoaderPreparationError> {
    install::ensure_safe_staging(staging)
        .map_err(|error| LoaderPreparationError::Invalid(error.to_string()))?;
    validate_windows_path_length(
        &staging.as_os_str().to_string_lossy(),
        "loader staging path",
    )?;
    Ok(())
}

fn validate_pipeline_staging_root(
    app: &AppHandle,
    staging: &Path,
) -> Result<(), LoaderPreparationError> {
    let app_data = crate::util::paths::app_data_dir(app)
        .map_err(|error| LoaderPreparationError::Io(error.to_string()))?;
    let managed_staging = app_data.join("installer-staging");
    let relative = staging.strip_prefix(&managed_staging).map_err(|_| {
        LoaderPreparationError::Invalid(
            "loader preparation must target an isolated app installer-staging directory".into(),
        )
    })?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(LoaderPreparationError::Invalid(
            "loader staging target must be a child of app installer-staging".into(),
        ));
    }
    let managed_metadata = fs::symlink_metadata(&managed_staging)
        .map_err(|error| LoaderPreparationError::Io(error.to_string()))?;
    if !managed_metadata.is_dir() || is_reparse_point(&managed_metadata) {
        return Err(LoaderPreparationError::Invalid(
            "app installer-staging is not a regular directory".into(),
        ));
    }
    let stage_metadata = fs::symlink_metadata(staging)
        .map_err(|error| LoaderPreparationError::Io(error.to_string()))?;
    if !stage_metadata.is_dir() || is_reparse_point(&stage_metadata) {
        return Err(LoaderPreparationError::Invalid(
            "loader staging target is not a regular directory".into(),
        ));
    }
    let canonical_root = fs::canonicalize(&managed_staging)
        .map_err(|error| LoaderPreparationError::Io(error.to_string()))?;
    let canonical_stage =
        fs::canonicalize(staging).map_err(|error| LoaderPreparationError::Io(error.to_string()))?;
    if !canonical_stage.starts_with(&canonical_root) {
        return Err(LoaderPreparationError::Invalid(
            "loader staging target resolves outside app installer-staging".into(),
        ));
    }
    Ok(())
}

pub(crate) fn inspect_prepared_runtime(
    staging: &Path,
    coordinate: &LoaderCoordinate,
) -> Result<(LoaderLaunchMode, Vec<LoaderRequiredFile>), LoaderPreparationError> {
    validate_staging_root(staging)?;
    let pin = &coordinate.provider_pin;
    let loader = loader_name(pin.kind);
    let launch_mode = crate::servers::process::resolve_launch_mode(
        staging,
        loader,
        &pin.minecraft_version,
        coordinate.installer_loader_version.as_deref(),
    )
    .map_err(|error| LoaderPreparationError::Invalid(error.to_string()))?;
    let mut required = BTreeSet::new();

    let mode = match launch_mode {
        crate::servers::process::LaunchMode::Jar { file_name } => {
            add_required_file(staging, &file_name, &mut required)?;
            if pin.kind == LoaderKind::Forge && pin.minecraft_version == "1.12.2" {
                let artifact = coordinate.forge_artifact.as_deref().ok_or_else(|| {
                    LoaderPreparationError::Invalid(
                        "legacy Forge artifact coordinate is missing".into(),
                    )
                })?;
                let forge_jar = format!("forge-{artifact}-universal.jar");
                let minecraft_jar = format!("minecraft_server.{}.jar", pin.minecraft_version);
                add_required_file(staging, &forge_jar, &mut required)?;
                add_required_file(staging, &minecraft_jar, &mut required)?;
                LoaderLaunchMode::LegacyForgeJars {
                    forge_jar,
                    minecraft_jar,
                }
            } else {
                LoaderLaunchMode::ServerJar { file_name }
            }
        }
        crate::servers::process::LaunchMode::ArgumentFiles {
            user_jvm_args,
            loader_args,
        } => {
            add_required_file(staging, &user_jvm_args, &mut required)?;
            add_required_file(staging, &loader_args, &mut required)?;
            let script_path = "run.bat";
            add_required_file(staging, script_path, &mut required)?;
            let script = read_bounded_text(&staging.join(script_path), 256 * 1024, "run.bat")?;
            if !references_user_jvm_args(&script) {
                return Err(LoaderPreparationError::Invalid(
                    "run.bat does not reference user_jvm_args.txt".into(),
                ));
            }
            let expected = expected_loader_args_path(coordinate)?;
            let validated =
                crate::servers::process::expected_generated_arg_file(&script, &expected, loader)
                    .map_err(|error| LoaderPreparationError::Invalid(error.to_string()))?;
            if validated != loader_args {
                return Err(LoaderPreparationError::Invalid(
                    "run.bat argument file differs from the exact pinned loader coordinate".into(),
                ));
            }
            verify_argument_files(staging, &loader_args, &mut required, coordinate)?;
            LoaderLaunchMode::ArgumentFiles {
                user_jvm_args,
                loader_args,
            }
        }
    };

    let required_files = required
        .into_iter()
        .map(|relative_path| {
            let path = safe_staging_target(staging, &relative_path)?;
            let metadata = regular_file_metadata(&path, &relative_path)?;
            if metadata.len() == 0 || metadata.len() > MAX_RUNTIME_ARTIFACT_BYTES {
                return Err(LoaderPreparationError::Invalid(format!(
                    "required loader file {relative_path} is empty or exceeds the 2 GiB bound"
                )));
            }
            let (size_bytes, hashes) = crate::modpacks::pipeline::download::hash_regular_file(
                &path,
                &std::sync::atomic::AtomicBool::new(false),
                &std::sync::atomic::AtomicBool::new(false),
            )
            .map_err(|error| LoaderPreparationError::Io(error.to_string()))?;
            if size_bytes != metadata.len() {
                return Err(LoaderPreparationError::Invalid(format!(
                    "required loader file {relative_path} changed while its completeness evidence was calculated"
                )));
            }
            Ok(LoaderRequiredFile {
                relative_path,
                size_bytes,
                hashes,
            })
        })
        .collect::<Result<Vec<_>, LoaderPreparationError>>()?;
    Ok((mode, required_files))
}

fn expected_loader_args_path(
    coordinate: &LoaderCoordinate,
) -> Result<String, LoaderPreparationError> {
    match coordinate.provider_pin.kind {
        LoaderKind::Forge => {
            let artifact = coordinate.forge_artifact.as_deref().ok_or_else(|| {
                LoaderPreparationError::Invalid("Forge artifact coordinate is missing".into())
            })?;
            Ok(format!(
                "libraries/net/minecraftforge/forge/{artifact}/win_args.txt"
            ))
        }
        LoaderKind::NeoForge => {
            let version = coordinate.resolved_version.as_deref().ok_or_else(|| {
                LoaderPreparationError::Invalid("NeoForge version is missing".into())
            })?;
            Ok(format!(
                "libraries/net/neoforged/neoforge/{version}/win_args.txt"
            ))
        }
        _ => Err(LoaderPreparationError::Invalid(
            "argument-file launch mode is only valid for Forge and NeoForge".into(),
        )),
    }
}

pub(crate) fn references_user_jvm_args(script: &str) -> bool {
    script
        .split(|character: char| {
            character.is_whitespace() || matches!(character, '"' | '\'' | ';' | '&' | '|')
        })
        .any(|token| {
            token
                .trim_start_matches('@')
                .eq_ignore_ascii_case("user_jvm_args.txt")
        })
}

fn verify_argument_files(
    staging: &Path,
    loader_args: &str,
    required: &mut BTreeSet<String>,
    coordinate: &LoaderCoordinate,
) -> Result<(), LoaderPreparationError> {
    let expected_payload = expected_server_payload(coordinate)?;
    verify_argument_file_roots(
        staging,
        &[loader_args],
        required,
        expected_payload.as_deref(),
    )
}

/// Recheck argument-file and library references before Start. `expected_payload`
/// is derived from the DB-pinned loader path; no saved launch JSON is consulted.
pub(crate) fn verify_start_argument_files(
    server_root: &Path,
    user_jvm_args: &str,
    loader_args: &str,
    expected_payload: Option<&str>,
) -> Result<(), LoaderPreparationError> {
    let mut required = BTreeSet::new();
    verify_argument_file_roots(
        server_root,
        &[user_jvm_args, loader_args],
        &mut required,
        expected_payload,
    )
}

fn verify_argument_file_roots(
    staging: &Path,
    roots: &[&str],
    required: &mut BTreeSet<String>,
    expected_payload: Option<&str>,
) -> Result<(), LoaderPreparationError> {
    let mut pending = roots
        .iter()
        .map(|relative| ((*relative).to_string(), 0usize))
        .collect::<Vec<_>>();
    let mut visited = HashSet::new();
    let mut total_bytes = 0u64;
    let mut jar_files = BTreeSet::new();
    while let Some((relative, depth)) = pending.pop() {
        if depth > MAX_ARGUMENT_INCLUDE_DEPTH {
            return Err(LoaderPreparationError::Invalid(
                "generated Java argument files exceed the include-depth limit".into(),
            ));
        }
        let key = relative.to_ascii_lowercase();
        if !visited.insert(key) {
            continue;
        }
        let path = safe_staging_target(staging, &relative)?;
        let metadata = regular_file_metadata(&path, &relative)?;
        if metadata.len() == 0 || metadata.len() > MAX_ARGUMENT_FILE_BYTES {
            return Err(LoaderPreparationError::Invalid(format!(
                "argument file {relative} is empty or exceeds the 1 MiB limit"
            )));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .filter(|size| *size <= MAX_TOTAL_ARGUMENT_BYTES)
            .ok_or_else(|| {
                LoaderPreparationError::Invalid(
                    "generated Java argument files exceed the 4 MiB total limit".into(),
                )
            })?;
        let text = read_bounded_text(&path, MAX_ARGUMENT_FILE_BYTES as usize, &relative)?;
        required.insert(relative.clone());
        let args = tokenize_java_argument_file(&text)?;
        if args.len() > MAX_ARGUMENT_COUNT {
            return Err(LoaderPreparationError::Invalid(
                "generated Java argument file has too many arguments".into(),
            ));
        }
        for argument in &args {
            if let Some(include) = argument.strip_prefix('@') {
                if include.is_empty() {
                    return Err(LoaderPreparationError::Invalid(
                        "generated Java argument file contains an empty include".into(),
                    ));
                }
                let include = normalize_argument_path(include)?;
                pending.push((include, depth + 1));
            }
            for candidate in jar_path_candidates(argument) {
                let relative = normalize_argument_path(candidate)?;
                let path = safe_staging_target(staging, &relative)?;
                let file_metadata = regular_file_metadata(&path, &relative)?;
                if file_metadata.len() == 0 || file_metadata.len() > MAX_RUNTIME_ARTIFACT_BYTES {
                    return Err(LoaderPreparationError::Invalid(format!(
                        "referenced library JAR {relative} is empty or exceeds the 2 GiB bound"
                    )));
                }
                jar_files.insert(relative);
            }
        }
    }
    if jar_files.is_empty() {
        return Err(LoaderPreparationError::Invalid(
            "generated loader arguments do not reference any library JAR".into(),
        ));
    }
    required.extend(jar_files);
    if let Some(server_payload) = expected_payload {
        if !required.contains(server_payload) {
            return Err(LoaderPreparationError::Invalid(format!(
                "generated loader arguments do not reference expected server payload {server_payload}"
            )));
        }
    }
    Ok(())
}

fn expected_server_payload(
    coordinate: &LoaderCoordinate,
) -> Result<Option<String>, LoaderPreparationError> {
    match coordinate.provider_pin.kind {
        LoaderKind::Forge => {
            let artifact = coordinate.forge_artifact.as_deref().ok_or_else(|| {
                LoaderPreparationError::Invalid("Forge artifact coordinate is missing".into())
            })?;
            Ok(Some(format!(
                "libraries/net/minecraftforge/forge/{artifact}/forge-{artifact}-server.jar"
            )))
        }
        LoaderKind::NeoForge => {
            let version = coordinate.resolved_version.as_deref().ok_or_else(|| {
                LoaderPreparationError::Invalid("NeoForge version is missing".into())
            })?;
            Ok(Some(format!(
                "libraries/net/neoforged/neoforge/{version}/neoforge-{version}-server.jar"
            )))
        }
        _ => Ok(None),
    }
}

fn tokenize_java_argument_file(text: &str) -> Result<Vec<String>, LoaderPreparationError> {
    let mut arguments = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut escaped = false;
    let mut comment = false;
    for character in text.chars() {
        if character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(LoaderPreparationError::Invalid(
                "generated Java argument file contains a control character".into(),
            ));
        }
        if comment {
            if matches!(character, '\n' | '\r') {
                comment = false;
            }
            continue;
        }
        if escaped {
            token.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            '#' if !quoted && token.is_empty() => comment = true,
            value if value.is_whitespace() && !quoted => {
                if !token.is_empty() {
                    arguments.push(std::mem::take(&mut token));
                }
            }
            value => token.push(value),
        }
        if token.len() > MAX_ARGUMENT_TOKEN_BYTES || arguments.len() > MAX_ARGUMENT_COUNT {
            return Err(LoaderPreparationError::Invalid(
                "generated Java arguments exceed a parser limit".into(),
            ));
        }
    }
    if quoted || escaped {
        return Err(LoaderPreparationError::Invalid(
            "generated Java argument file contains an unterminated quote or escape".into(),
        ));
    }
    if !token.is_empty() {
        arguments.push(token);
    }
    if arguments.len() > MAX_ARGUMENT_COUNT {
        return Err(LoaderPreparationError::Invalid(
            "generated Java argument file has too many arguments".into(),
        ));
    }
    Ok(arguments)
}

fn jar_path_candidates(argument: &str) -> Vec<&str> {
    if argument.to_ascii_lowercase().starts_with("-dignorelist=") {
        // Forge's ignore list names bootstrap artifacts for its loader, not
        // class-path files. The actual paths remain validated in -p/-cp args.
        return Vec::new();
    }
    let mut candidates = Vec::new();
    for piece in argument.split([';', ',']) {
        let piece = piece.trim_matches(['"', '\'']);
        for candidate in std::iter::once(piece).chain(piece.split_once('=').map(|(_, value)| value))
        {
            if candidate.to_ascii_lowercase().ends_with(".jar") {
                candidates.push(candidate);
            }
        }
    }
    candidates
}

fn normalize_argument_path(value: &str) -> Result<String, LoaderPreparationError> {
    let normalized = value.replace('\\', "/");
    validate_safe_relative_path(&normalized)
        .map_err(|error| LoaderPreparationError::Invalid(error.to_string()))?;
    Ok(normalized)
}

fn add_required_file(
    staging: &Path,
    relative: &str,
    required: &mut BTreeSet<String>,
) -> Result<(), LoaderPreparationError> {
    let normalized = normalize_argument_path(relative)?;
    let target = safe_staging_target(staging, &normalized)?;
    let metadata = regular_file_metadata(&target, &normalized)?;
    if metadata.len() == 0 || metadata.len() > MAX_RUNTIME_ARTIFACT_BYTES {
        return Err(LoaderPreparationError::Invalid(format!(
            "required loader file {normalized} is empty or exceeds the 2 GiB bound"
        )));
    }
    required.insert(normalized);
    Ok(())
}

fn safe_staging_target(staging: &Path, relative: &str) -> Result<PathBuf, LoaderPreparationError> {
    validate_safe_relative_path(relative)
        .map_err(|error| LoaderPreparationError::Invalid(error.to_string()))?;
    let target = staging.join(relative);
    validate_windows_path_length(
        &target.as_os_str().to_string_lossy(),
        &format!("loader runtime path {relative}"),
    )?;
    let mut current = staging.to_path_buf();
    for component in relative.split('/') {
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                LoaderPreparationError::Invalid(format!(
                    "required runtime path {relative} is missing"
                ))
            } else {
                LoaderPreparationError::Io(error.to_string())
            }
        })?;
        if is_reparse_point(&metadata) {
            return Err(LoaderPreparationError::Invalid(format!(
                "loader runtime path {relative} contains a reparse point"
            )));
        }
    }
    Ok(target)
}

fn validate_windows_path_length(path: &str, display: &str) -> Result<(), LoaderPreparationError> {
    if path.encode_utf16().count() >= MAX_WINDOWS_PATH_UTF16_UNITS {
        return Err(LoaderPreparationError::Invalid(format!(
            "{display} exceeds the Windows path limit of 239 UTF-16 code units"
        )));
    }
    Ok(())
}

fn regular_file_metadata(
    path: &Path,
    relative: &str,
) -> Result<fs::Metadata, LoaderPreparationError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        LoaderPreparationError::Invalid(format!("required runtime file {relative} is missing"))
    })?;
    if !metadata.file_type().is_file() || is_reparse_point(&metadata) {
        return Err(LoaderPreparationError::Invalid(format!(
            "required runtime path {relative} is not a regular non-reparse file"
        )));
    }
    Ok(metadata)
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

fn read_bounded_text(
    path: &Path,
    maximum_bytes: usize,
    display: &str,
) -> Result<String, LoaderPreparationError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        LoaderPreparationError::Invalid(format!("required runtime file {display} is missing"))
    })?;
    if !metadata.file_type().is_file()
        || is_reparse_point(&metadata)
        || metadata.len() > maximum_bytes as u64
    {
        return Err(LoaderPreparationError::Invalid(format!(
            "runtime text file {display} is unsafe or exceeds its size limit"
        )));
    }
    let bytes = fs::read(path).map_err(|error| LoaderPreparationError::Io(error.to_string()))?;
    String::from_utf8(bytes).map_err(|_| {
        LoaderPreparationError::Invalid(format!("runtime text file {display} is not UTF-8"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("pipeline-loader-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn pin(kind: LoaderKind, mc: &str, version: Option<&str>) -> LoaderPin {
        LoaderPin {
            kind,
            minecraft_version: mc.into(),
            loader_version: version.map(str::to_string),
        }
    }

    fn forge_catalogue(versions: &[&str]) -> Value {
        serde_json::json!({ "1.20.1": versions })
    }

    #[test]
    fn accepts_exact_vanilla_and_fabric_metadata_pins() {
        let vanilla = pin(LoaderKind::Vanilla, "1.20.1", None);
        let manifest = serde_json::json!({
            "versions": [{
                "id": "1.20.1",
                "type": "release",
                "url": "https://piston-meta.mojang.com/v1/packages/hash/1.20.1.json"
            }]
        });
        let version = serde_json::json!({
            "id": "1.20.1",
            "downloads": { "server": {
                "url": "https://piston-data.mojang.com/v1/objects/hash/server.jar",
                "size": 1024,
                "sha1": "a".repeat(40)
            }}
        });
        assert_eq!(
            resolve_vanilla_metadata(&vanilla, &manifest, &version)
                .unwrap()
                .install_method,
            LoaderInstallMethod::MojangServerJar
        );

        let fabric = pin(LoaderKind::Fabric, "1.20.1", Some("0.15.11"));
        let metadata = serde_json::json!({
            "loader": { "version": "0.15.11" },
            "intermediary": { "version": "1.20.1" }
        });
        assert_eq!(
            resolve_fabric_metadata(&fabric, &metadata)
                .unwrap()
                .resolved_version
                .as_deref(),
            Some("0.15.11")
        );
    }

    #[test]
    fn rejects_unavailable_mismatched_and_wrong_minecraft_builds() {
        let vanilla = pin(LoaderKind::Vanilla, "1.20.1", None);
        let manifest = serde_json::json!({
            "versions": [{
                "id": "1.20.1",
                "type": "release",
                "url": "https://piston-meta.mojang.com/v1/packages/hash/1.20.1.json"
            }]
        });
        let wrong_game = serde_json::json!({ "id": "1.20.4", "downloads": {} });
        assert!(matches!(
            resolve_vanilla_metadata(&vanilla, &manifest, &wrong_game),
            Err(LoaderPreparationError::Unavailable(_))
        ));

        let fabric = pin(LoaderKind::Fabric, "1.20.1", Some("0.15.11"));
        let wrong_loader = serde_json::json!({
            "loader": { "version": "0.15.10" },
            "intermediary": { "version": "1.20.1" }
        });
        assert!(matches!(
            resolve_fabric_metadata(&fabric, &wrong_loader),
            Err(LoaderPreparationError::Unavailable(_))
        ));
        let wrong_game = serde_json::json!({
            "loader": { "version": "0.15.11" },
            "intermediary": { "version": "1.20.4" }
        });
        assert!(matches!(
            resolve_fabric_metadata(&fabric, &wrong_game),
            Err(LoaderPreparationError::Unavailable(_))
        ));

        let neo = pin(LoaderKind::NeoForge, "1.20.6", Some("20.4.237"));
        assert!(matches!(
            resolve_neoforge_metadata(&neo, "<metadata><version>20.4.237</version></metadata>"),
            Err(LoaderPreparationError::Unavailable(_))
        ));
    }

    #[test]
    fn normalizes_modrinth_and_curseforge_forge_pins_to_one_exact_artifact() {
        let promotions = serde_json::json!({ "promos": { "1.20.1-recommended": "47.2.0" } });
        let catalogue = forge_catalogue(&["47.2.0"]);
        let modrinth = resolve_forge_metadata(
            &pin(LoaderKind::Forge, "1.20.1", Some("47.2.0")),
            &promotions,
            &catalogue,
        )
        .unwrap();
        let curseforge = resolve_forge_metadata(
            &pin(LoaderKind::Forge, "1.20.1", Some("specific:1.20.1-47.2.0")),
            &promotions,
            &catalogue,
        )
        .unwrap();
        assert_eq!(modrinth.forge_artifact, curseforge.forge_artifact);
        assert_eq!(
            modrinth.installer_loader_version.as_deref(),
            Some("specific:1.20.1-47.2.0")
        );
        assert_eq!(
            curseforge.provider_pin.loader_version.as_deref(),
            Some("specific:1.20.1-47.2.0")
        );
        assert_eq!(
            resolve_forge_metadata(
                &pin(LoaderKind::Forge, "1.20.1", Some("recommended:47.2.0")),
                &promotions,
                &catalogue
            )
            .unwrap()
            .forge_artifact,
            Some("1.20.1-47.2.0".into())
        );
    }

    #[test]
    fn rejects_changed_forge_promotion_unavailable_build_and_wrong_mc_catalogue() {
        let pin_latest = pin(LoaderKind::Forge, "1.20.1", Some("latest:47.2.0"));
        let changed = serde_json::json!({ "promos": { "1.20.1-latest": "47.2.1" } });
        assert!(matches!(
            resolve_forge_metadata(
                &pin_latest,
                &changed,
                &forge_catalogue(&["47.2.0", "47.2.1"])
            ),
            Err(LoaderPreparationError::Unavailable(_))
        ));
        let missing = pin(LoaderKind::Forge, "1.20.1", Some("47.9.9"));
        assert!(matches!(
            resolve_forge_metadata(
                &missing,
                &serde_json::json!({ "promos": {} }),
                &forge_catalogue(&["47.2.0"])
            ),
            Err(LoaderPreparationError::Unavailable(_))
        ));
        let wrong_mc = pin(
            LoaderKind::Forge,
            "1.20.1",
            Some("specific:1.20.4-20.4.237"),
        );
        assert!(matches!(
            resolve_forge_metadata(
                &wrong_mc,
                &serde_json::json!({ "promos": {} }),
                &forge_catalogue(&["47.2.0"])
            ),
            Err(LoaderPreparationError::Unavailable(_))
        ));
    }

    #[test]
    fn accepts_only_exact_neoforge_version_for_supported_minecraft_mapping() {
        let neo_pin = pin(LoaderKind::NeoForge, "1.20.4", Some("20.4.237"));
        let metadata = "<metadata><versioning><versions><version>20.4.236</version><version>20.4.237</version></versions></versioning></metadata>";
        assert_eq!(
            resolve_neoforge_metadata(&neo_pin, metadata)
                .unwrap()
                .resolved_version
                .as_deref(),
            Some("20.4.237")
        );
        let unavailable = pin(LoaderKind::NeoForge, "1.20.4", Some("20.4.999"));
        assert!(matches!(
            resolve_neoforge_metadata(&unavailable, metadata),
            Err(LoaderPreparationError::Unavailable(_))
        ));
    }

    #[test]
    fn legacy_forge_launch_requires_both_exact_server_jars() {
        let root = TempDir::new();
        let pin = pin(LoaderKind::Forge, "1.12.2", Some("14.23.5.2859"));
        let coordinate = resolve_forge_metadata(
            &pin,
            &serde_json::json!({ "promos": {} }),
            &serde_json::json!({ "1.12.2": ["14.23.5.2859"] }),
        )
        .unwrap();
        let forge_jar = "forge-1.12.2-14.23.5.2859-universal.jar";
        let minecraft_jar = "minecraft_server.1.12.2.jar";
        write_fixture(&root.0, forge_jar, b"forge");
        write_fixture(&root.0, minecraft_jar, b"minecraft");
        let (mode, required) = inspect_prepared_runtime(&root.0, &coordinate).unwrap();
        assert_eq!(
            mode,
            LoaderLaunchMode::LegacyForgeJars {
                forge_jar: forge_jar.into(),
                minecraft_jar: minecraft_jar.into(),
            }
        );
        assert_eq!(required.len(), 2);

        fs::remove_file(root.0.join(minecraft_jar)).unwrap();
        assert!(inspect_prepared_runtime(&root.0, &coordinate).is_err());
    }

    #[test]
    fn rejects_quilt_as_a_disabled_placeholder() {
        let quilt = pin(LoaderKind::Quilt, "1.20.1", Some("0.23.1"));
        assert!(matches!(
            quilt.validate(),
            Err(crate::modpacks::pipeline::model::ModelError::InvalidValue(
                _
            ))
        ));
        assert!(matches!(
            ensure_supported_loader(&quilt),
            Err(LoaderPreparationError::Unsupported(_))
        ));
    }

    #[test]
    fn windows_path_bound_allows_239_utf16_units_and_rejects_240() {
        assert!(validate_windows_path_length(&"x".repeat(239), "fixture").is_ok());
        assert!(matches!(
            validate_windows_path_length(&"x".repeat(240), "fixture"),
            Err(LoaderPreparationError::Invalid(_))
        ));
    }

    #[test]
    fn missing_java_stops_before_staging_or_metadata_work() {
        let later_stage_called = std::cell::Cell::new(false);
        let result = validate_java_then(
            "1.20.1",
            None,
            |_, _| panic!("validator must not run when Java is missing"),
            |_| {
                later_stage_called.set(true);
                Ok(())
            },
        );

        assert!(matches!(result, Err(LoaderPreparationError::Invalid(_))));
        assert!(!later_stage_called.get());
    }

    #[test]
    fn invalid_java_path_stops_before_staging_or_metadata_work() {
        let later_stage_called = std::cell::Cell::new(false);
        let missing_path = Path::new("missing-java.exe");
        let result = validate_java_then(
            "1.20.1",
            Some(missing_path),
            |path, version| {
                assert_eq!(path, "missing-java.exe");
                assert_eq!(version, "1.20.1");
                Err(crate::error::AppError::Validation(
                    "Java executable was not found".into(),
                ))
            },
            |_| {
                later_stage_called.set(true);
                Ok(())
            },
        );

        assert!(
            matches!(result, Err(LoaderPreparationError::Installer(message)) if message.contains("not found"))
        );
        assert!(!later_stage_called.get());
    }

    #[test]
    fn incompatible_java_version_stops_before_staging_or_metadata_work() {
        let later_stage_called = std::cell::Cell::new(false);
        let result = validate_java_then(
            "1.20.1",
            Some(Path::new("java.exe")),
            |_, version| {
                assert_eq!(version, "1.20.1");
                Err(crate::error::AppError::Validation(
                    "Java 8 is incompatible with Minecraft 1.20.1; Java 17 is required".into(),
                ))
            },
            |_| {
                later_stage_called.set(true);
                Ok(())
            },
        );

        assert!(
            matches!(result, Err(LoaderPreparationError::Installer(message)) if message.contains("incompatible"))
        );
        assert!(!later_stage_called.get());
    }

    #[cfg(windows)]
    #[test]
    fn non_unicode_java_path_stops_before_validation_or_later_work() {
        use std::os::windows::ffi::OsStringExt;

        let invalid_path = PathBuf::from(std::ffi::OsString::from_wide(&[0xD800]));
        let later_stage_called = std::cell::Cell::new(false);
        let result = validate_java_then(
            "1.20.1",
            Some(&invalid_path),
            |_, _| panic!("validator must not receive a non-Unicode path"),
            |_| {
                later_stage_called.set(true);
                Ok(())
            },
        );

        assert!(matches!(result, Err(LoaderPreparationError::Invalid(_))));
        assert!(!later_stage_called.get());
    }

    #[test]
    fn modern_forge_runtime_requires_exact_args_file_and_referenced_libraries() {
        let root = TempDir::new();
        let artifact = "1.20.1-47.2.0";
        let args = format!(
            "--launchTarget\nforgeserver\n-DignoreList=bootstrap-only.jar\n-p\nlibraries/example/bootstrap.jar;libraries/net/minecraftforge/forge/{artifact}/forge-{artifact}-server.jar\n"
        );
        let args_path = format!("libraries/net/minecraftforge/forge/{artifact}/win_args.txt");
        let script = format!("@echo off\r\njava @user_jvm_args.txt @{args_path} %*\r\n");
        write_fixture(&root.0, "user_jvm_args.txt", b"-Xmx2G\n");
        write_fixture(&root.0, "run.bat", script.as_bytes());
        write_fixture(&root.0, &args_path, args.as_bytes());
        write_fixture(&root.0, "libraries/example/bootstrap.jar", b"bootstrap");
        write_fixture(
            &root.0,
            &format!("libraries/net/minecraftforge/forge/{artifact}/forge-{artifact}-server.jar"),
            b"server",
        );
        let pin = pin(LoaderKind::Forge, "1.20.1", Some("47.2.0"));
        let coordinate = resolve_forge_metadata(
            &pin,
            &serde_json::json!({ "promos": {} }),
            &forge_catalogue(&["47.2.0"]),
        )
        .unwrap();
        let (mode, required) = inspect_prepared_runtime(&root.0, &coordinate).unwrap();
        assert!(matches!(mode, LoaderLaunchMode::ArgumentFiles { .. }));
        assert!(required
            .iter()
            .any(|entry| entry.relative_path.ends_with("bootstrap.jar")));

        fs::remove_file(root.0.join(&args_path)).unwrap();
        assert!(inspect_prepared_runtime(&root.0, &coordinate).is_err());
        write_fixture(&root.0, &args_path, args.as_bytes());
        fs::remove_file(root.0.join("run.bat")).unwrap();
        assert!(inspect_prepared_runtime(&root.0, &coordinate).is_err());
    }

    #[test]
    fn rejects_missing_library_jar_and_malformed_argument_path() {
        let root = TempDir::new();
        let artifact = "1.20.1-47.2.0";
        let args_path = format!("libraries/net/minecraftforge/forge/{artifact}/win_args.txt");
        let script = format!("java @user_jvm_args.txt @{args_path}\n");
        write_fixture(&root.0, "user_jvm_args.txt", b"-Xmx2G\n");
        write_fixture(&root.0, "run.bat", script.as_bytes());
        write_fixture(&root.0, &args_path, b"-p\nlibraries/missing.jar\n");
        let pin = pin(LoaderKind::Forge, "1.20.1", Some("47.2.0"));
        let coordinate = resolve_forge_metadata(
            &pin,
            &serde_json::json!({ "promos": {} }),
            &forge_catalogue(&["47.2.0"]),
        )
        .unwrap();
        assert!(matches!(
            inspect_prepared_runtime(&root.0, &coordinate),
            Err(LoaderPreparationError::Invalid(message)) if message.contains("missing")
        ));

        write_fixture(&root.0, &args_path, b"-p\n../outside.jar\n");
        assert!(matches!(
            inspect_prepared_runtime(&root.0, &coordinate),
            Err(LoaderPreparationError::Invalid(_))
        ));
    }

    fn write_fixture(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }
}
