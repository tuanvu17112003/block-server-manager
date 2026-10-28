use super::{
    make_plan, snapshot::snapshot_archive_with_cancel, validate_plan_context, PlanContext,
    ProviderFileDownload, ProviderResolutionError,
};
use crate::modpacks::{
    install::{self, MrpackEnvironmentPolicy, MrpackMetadata, MrpackMetadataError},
    pipeline::{
        classify::{self, LocalMrpackClassification, LocalMrpackMetadata},
        model::{
            ArchiveFingerprint, ArchiveVerification, ContentHashes, ExactPackPin, ProviderPin,
            ProviderSource,
        },
        plan::{InstallPlan, LoaderKind, LoaderPin},
        selection::{select_file, EnvironmentPolicy, FilePolicyEvidence, UserFileChoice},
    },
};
use crate::{error::AppError, installer::JobControl};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

const MODRINTH_API_BASE: &str = "https://api.modrinth.com/v2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModrinthArchiveDownload {
    pub url: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub hashes: ContentHashes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModrinthVersionPreinspection {
    context: PlanContext,
    selected_loader: LoaderPin,
    source_pin: ProviderPin,
    archive_download: ModrinthArchiveDownload,
    game_versions: Vec<String>,
    loaders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMrpackInstall {
    pub plan: InstallPlan,
    /// The index file metadata needed by Phase 5, not persisted as installation authority.
    pub file_downloads: Vec<ProviderFileDownload>,
    pub warnings: Vec<String>,
}

impl ModrinthVersionPreinspection {
    pub fn provider_pin(&self) -> &ProviderPin {
        &self.source_pin
    }

    pub fn archive_download(&self) -> &ModrinthArchiveDownload {
        &self.archive_download
    }

    pub fn game_versions(&self) -> &[String] {
        &self.game_versions
    }

    pub fn loaders(&self) -> &[String] {
        &self.loaders
    }
}

pub fn fetch_remote_version(
    project_id: &str,
    version_id: &str,
    context: PlanContext,
    selected_loader: LoaderPin,
) -> Result<ModrinthVersionPreinspection, ProviderResolutionError> {
    if !install::valid_modrinth_id(project_id) || !install::valid_modrinth_id(version_id) {
        return Err(ProviderResolutionError::Malformed(
            "project and version IDs must be valid Modrinth IDs".into(),
        ));
    }
    let url = format!("{MODRINTH_API_BASE}/version/{version_id}");
    let version = crate::installer::fetch_modrinth_json(&url).map_err(|error| match error {
        crate::error::AppError::Validation(message)
            if message.contains("malformed JSON") || message.contains("not valid UTF-8") =>
        {
            ProviderResolutionError::Malformed(message)
        }
        other => ProviderResolutionError::Io(other.to_string()),
    })?;
    resolve_remote_version_json(project_id, version_id, &version, context, selected_loader)
}

/// Fetches the exact provider version through the pipeline's cancellable,
/// source-allowlisted HTTP transport. The returned JSON remains untrusted data
/// and must still be resolved against the selected project/version IDs.
pub fn fetch_remote_version_json_with_control(
    project_id: &str,
    version_id: &str,
    control: &JobControl,
) -> Result<Value, ProviderResolutionError> {
    if !install::valid_modrinth_id(project_id) || !install::valid_modrinth_id(version_id) {
        return Err(ProviderResolutionError::Malformed(
            "project and version IDs must be valid Modrinth IDs".into(),
        ));
    }
    let url = format!("{MODRINTH_API_BASE}/version/{version_id}");
    crate::installer::fetch_pipeline_metadata_json(
        &url,
        control,
        &["api.modrinth.com"],
    )
    .map_err(|error| match error {
        AppError::Conflict(message) if message.to_ascii_lowercase().contains("cancel") => {
            ProviderResolutionError::Cancelled
        }
        AppError::Validation(message)
            if message.contains("malformed JSON") || message.contains("not valid UTF-8") =>
        {
            ProviderResolutionError::Malformed(message)
        }
        other => ProviderResolutionError::Io(other.to_string()),
    })
}

pub fn resolve_remote_version_json(
    project_id: &str,
    version_id: &str,
    version: &Value,
    context: PlanContext,
    selected_loader: LoaderPin,
) -> Result<ModrinthVersionPreinspection, ProviderResolutionError> {
    validate_plan_context(&context)?;
    selected_loader
        .validate()
        .map_err(ProviderResolutionError::InvalidModel)?;
    if !install::valid_modrinth_id(project_id) || !install::valid_modrinth_id(version_id) {
        return Err(ProviderResolutionError::Malformed(
            "project and version IDs must be valid Modrinth IDs".into(),
        ));
    }
    let returned_version_id = required_string(version, "id")?;
    let returned_project_id = required_string(version, "project_id")?;
    if returned_version_id != version_id || returned_project_id != project_id {
        return Err(ProviderResolutionError::Malformed(
            "Modrinth exact version does not belong to the selected project and version".into(),
        ));
    }
    let version_number = required_string(version, "version_number")?;
    if version_number.trim().is_empty() || version_number.chars().any(char::is_control) {
        return Err(ProviderResolutionError::Malformed(
            "Modrinth version_number is empty or invalid".into(),
        ));
    }

    let game_versions = string_array(version, "game_versions")?;
    let loaders = string_array(version, "loaders")?;
    let loader_id = loader_id(selected_loader.kind);
    if selected_loader.kind == LoaderKind::Quilt {
        return Err(ProviderResolutionError::Unsupported(
            "Quilt installs remain a disabled placeholder".into(),
        ));
    }
    if !game_versions
        .iter()
        .any(|value| value == &selected_loader.minecraft_version)
        || !loaders.iter().any(|value| value == loader_id)
    {
        return Err(ProviderResolutionError::Unsupported(
            "selected Minecraft version or loader is not present in the exact Modrinth version metadata".into(),
        ));
    }

    let archive_download = select_mrpack_file(version)?;
    let pin = ProviderPin {
        source: ProviderSource::Modrinth,
        exact: ExactPackPin::ModrinthRemoteVersion {
            project_id: project_id.to_string(),
            version_id: version_id.to_string(),
            version_number: version_number.to_string(),
            archive: ArchiveFingerprint {
                hashes: archive_download.hashes.clone(),
                size_bytes: archive_download.size_bytes,
                verification: ArchiveVerification::ProviderMetadata,
            },
        },
    };
    pin.validate()
        .map_err(ProviderResolutionError::InvalidModel)?;
    Ok(ModrinthVersionPreinspection {
        context,
        selected_loader,
        source_pin: pin,
        archive_download,
        game_versions,
        loaders,
    })
}

pub fn cross_check_pack_metadata(
    resolved: &ModrinthVersionPreinspection,
    metadata: &LocalMrpackMetadata,
) -> Result<(), ProviderResolutionError> {
    let expected = &resolved.selected_loader;
    if metadata.minecraft_version != expected.minecraft_version
        || metadata.loader_version.as_deref() != expected.loader_version.as_deref()
        || mrpack_loader_id(metadata.loader) != loader_id(expected.kind)
        || !resolved
            .game_versions
            .iter()
            .any(|version| version == &metadata.minecraft_version)
        || !resolved
            .loaders
            .iter()
            .any(|loader| loader == mrpack_loader_id(metadata.loader))
    {
        return Err(ProviderResolutionError::Malformed(
            "downloaded Modrinth pack index conflicts with the exact version metadata".into(),
        ));
    }
    Ok(())
}

pub fn resolve_local_mrpack(
    archive_path: &Path,
    context: PlanContext,
    choices: &HashMap<String, UserFileChoice>,
) -> Result<ResolvedMrpackInstall, ProviderResolutionError> {
    resolve_local_mrpack_with_cancel(archive_path, context, choices, || false)
}

pub fn resolve_local_mrpack_with_cancel<F>(
    archive_path: &Path,
    context: PlanContext,
    choices: &HashMap<String, UserFileChoice>,
    mut is_cancelled: F,
) -> Result<ResolvedMrpackInstall, ProviderResolutionError>
where
    F: FnMut() -> bool,
{
    let snapshot =
        snapshot_archive_with_cancel(archive_path, install::MAX_MRPACK_BYTES, |_| is_cancelled())?;
    ensure_not_cancelled(&mut is_cancelled)?;
    let metadata_result = classify::inspect_local_mrpack(snapshot.path());
    ensure_not_cancelled(&mut is_cancelled)?;
    let metadata = match metadata_result {
        LocalMrpackClassification::Supported(metadata) => metadata,
        LocalMrpackClassification::QuiltPlaceholder(_) => {
            return Err(ProviderResolutionError::Unsupported(
                "Quilt installs remain a disabled placeholder".into(),
            ))
        }
        LocalMrpackClassification::Unsupported { reason } => {
            return Err(ProviderResolutionError::Unsupported(reason))
        }
        LocalMrpackClassification::Invalid { reason } => {
            return Err(ProviderResolutionError::Malformed(reason))
        }
    };
    let index_result = install::inspect_mrpack_pipeline_index(snapshot.path());
    ensure_not_cancelled(&mut is_cancelled)?;
    let index = index_result.map_err(map_mrpack_error)?;
    debug_assert_eq!(index.metadata, metadata_to_install(&metadata));

    let loader = loader_pin_from_mrpack(&metadata)?;
    let source_pin = ProviderPin {
        source: ProviderSource::Modrinth,
        exact: ExactPackPin::ModrinthLocalArchive {
            display_version_id: metadata.display_version_id.clone(),
            archive: snapshot.fingerprint().clone(),
        },
    };

    source_pin
        .validate()
        .map_err(ProviderResolutionError::InvalidModel)?;
    build_mrpack_install(
        context,
        source_pin,
        loader,
        index,
        choices,
        &mut is_cancelled,
    )
}

pub fn finalize_remote_archive(
    preinspection: &ModrinthVersionPreinspection,
    archive_path: &Path,
    choices: &HashMap<String, UserFileChoice>,
) -> Result<ResolvedMrpackInstall, ProviderResolutionError> {
    finalize_remote_archive_with_cancel(preinspection, archive_path, choices, || false)
}

pub fn finalize_remote_archive_with_cancel<F>(
    preinspection: &ModrinthVersionPreinspection,
    archive_path: &Path,
    choices: &HashMap<String, UserFileChoice>,
    mut is_cancelled: F,
) -> Result<ResolvedMrpackInstall, ProviderResolutionError>
where
    F: FnMut() -> bool,
{
    let snapshot =
        snapshot_archive_with_cancel(archive_path, install::MAX_MRPACK_BYTES, |_| is_cancelled())?;
    ensure_not_cancelled(&mut is_cancelled)?;
    let expected_archive = match &preinspection.source_pin.exact {
        ExactPackPin::ModrinthRemoteVersion { archive, .. } => archive,
        _ => {
            return Err(ProviderResolutionError::InvalidModel(
                crate::modpacks::pipeline::model::ModelError::InvalidProviderPin,
            ))
        }
    };
    let actual = snapshot.fingerprint();
    let archive_matches = actual.size_bytes == expected_archive.size_bytes
        && actual
            .hashes
            .sha1
            .eq_ignore_ascii_case(&expected_archive.hashes.sha1)
        && actual
            .hashes
            .sha512
            .eq_ignore_ascii_case(&expected_archive.hashes.sha512)
        && preinspection.archive_download.size_bytes == expected_archive.size_bytes
        && preinspection.archive_download.hashes == expected_archive.hashes;
    ensure_not_cancelled(&mut is_cancelled)?;
    if !archive_matches {
        return Err(ProviderResolutionError::Malformed(
            "downloaded Modrinth archive does not match the exact version's SHA-1, SHA-512, and size metadata".into(),
        ));
    }

    let metadata_result = classify::inspect_local_mrpack(snapshot.path());
    ensure_not_cancelled(&mut is_cancelled)?;
    let metadata = match metadata_result {
        LocalMrpackClassification::Supported(metadata) => metadata,
        LocalMrpackClassification::QuiltPlaceholder(_) => {
            return Err(ProviderResolutionError::Unsupported(
                "Quilt installs remain a disabled placeholder".into(),
            ))
        }
        LocalMrpackClassification::Unsupported { reason } => {
            return Err(ProviderResolutionError::Unsupported(reason))
        }
        LocalMrpackClassification::Invalid { reason } => {
            return Err(ProviderResolutionError::Malformed(reason))
        }
    };
    let cross_check = cross_check_pack_metadata(preinspection, &metadata);
    ensure_not_cancelled(&mut is_cancelled)?;
    cross_check?;
    let index_result = install::inspect_mrpack_pipeline_index(snapshot.path());
    ensure_not_cancelled(&mut is_cancelled)?;
    let index = index_result.map_err(map_mrpack_error)?;
    debug_assert_eq!(index.metadata, metadata_to_install(&metadata));

    build_mrpack_install(
        preinspection.context.clone(),
        preinspection.source_pin.clone(),
        preinspection.selected_loader.clone(),
        index,
        choices,
        &mut is_cancelled,
    )
}

fn build_mrpack_install(
    context: PlanContext,
    source_pin: ProviderPin,
    loader: LoaderPin,
    index: install::MrpackPipelineIndex,
    choices: &HashMap<String, UserFileChoice>,
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<ResolvedMrpackInstall, ProviderResolutionError> {
    let choices = normalize_choices(choices)?;
    let mut used_choices = HashSet::new();
    let mut decisions = Vec::with_capacity(index.files.len());
    let mut warnings = Vec::new();
    let mut file_downloads = Vec::new();
    for file in &index.files {
        ensure_not_cancelled(&mut is_cancelled)?;
        let path_key = file.path.to_lowercase();
        let choice = choices.get(&path_key).copied();
        if choice.is_some() {
            used_choices.insert(path_key);
        }
        let selected = select_file(FilePolicyEvidence {
            path: file.path.clone(),
            server: file.server.map(environment_policy).into_iter().collect(),
            client: file.client.map(environment_policy).into_iter().collect(),
            server_metadata_missing: file.server_environment_missing,
            choice,
        })
        .map_err(ProviderResolutionError::InvalidModel)?;
        append_download_if_included(&mut file_downloads, file, selected.decision.action);
        warnings.extend(selected.warnings);
        decisions.push(selected.decision);
        ensure_not_cancelled(&mut is_cancelled)?;
    }
    if choices.keys().any(|path| !used_choices.contains(path)) {
        return Err(ProviderResolutionError::Malformed(
            "a user file choice refers to a path absent from the selected Modrinth pack".into(),
        ));
    }
    let plan_result = make_plan(context, source_pin, loader, decisions);
    ensure_not_cancelled(&mut is_cancelled)?;
    let plan = plan_result?;
    ensure_not_cancelled(&mut is_cancelled)?;
    Ok(ResolvedMrpackInstall {
        plan,
        file_downloads,
        warnings,
    })
}

fn ensure_not_cancelled<F>(is_cancelled: &mut F) -> Result<(), ProviderResolutionError>
where
    F: FnMut() -> bool,
{
    if is_cancelled() {
        Err(ProviderResolutionError::Cancelled)
    } else {
        Ok(())
    }
}

fn append_download_if_included(
    file_downloads: &mut Vec<ProviderFileDownload>,
    file: &install::MrpackPipelineFile,
    action: crate::modpacks::pipeline::model::FileDecisionAction,
) {
    if action == crate::modpacks::pipeline::model::FileDecisionAction::Include {
        file_downloads.push(ProviderFileDownload {
            path: file.path.clone(),
            urls: file.downloads.clone(),
            size_bytes: file.size,
            hashes: ContentHashes {
                sha1: file.sha1.clone(),
                sha512: file.sha512.clone(),
            },
        });
    }
}

fn select_mrpack_file(version: &Value) -> Result<ModrinthArchiveDownload, ProviderResolutionError> {
    let files = version
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| ProviderResolutionError::Malformed("version files are missing".into()))?;
    // The suffix selects among provider-declared candidates only; the downloaded
    // bytes must still pass bounded `.mrpack` inspection before installation.
    let candidates = files
        .iter()
        .filter_map(|file| {
            let name = file.get("filename").and_then(Value::as_str)?;
            name.to_ascii_lowercase()
                .ends_with(".mrpack")
                .then_some(file)
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Err(ProviderResolutionError::Unsupported(
            "exact Modrinth version has no .mrpack archive".into(),
        ));
    }
    let mut primary = Vec::new();
    for file in &candidates {
        if file
            .get("primary")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                ProviderResolutionError::Malformed(
                    "archive primary flag is missing or invalid".into(),
                )
            })?
        {
            primary.push(*file);
        }
    }
    let selected = match primary.as_slice() {
        [one] => *one,
        [] if candidates.len() == 1 => candidates[0],
        [] => {
            return Err(ProviderResolutionError::Unsupported(
                "multiple .mrpack archives have no primary file".into(),
            ))
        }
        _ => {
            return Err(ProviderResolutionError::Malformed(
                "exact Modrinth version marks multiple .mrpack files as primary".into(),
            ))
        }
    };
    archive_download_from_file(selected)
}

fn archive_download_from_file(
    file: &Value,
) -> Result<ModrinthArchiveDownload, ProviderResolutionError> {
    let file_name = required_string(file, "filename")?;
    if file_name.contains(['/', '\\']) || file_name.chars().any(char::is_control) {
        return Err(ProviderResolutionError::Malformed(
            "Modrinth archive filename is not a safe single component".into(),
        ));
    }
    let url = required_string(file, "url")?;
    if !install::valid_provider_download_url(url) {
        return Err(ProviderResolutionError::Malformed(
            "Modrinth archive URL is not trusted HTTPS".into(),
        ));
    }
    let size_bytes = file
        .get("size")
        .and_then(Value::as_u64)
        .filter(|size| *size > 0 && *size <= install::MAX_MRPACK_BYTES)
        .ok_or_else(|| {
            ProviderResolutionError::Malformed(
                "Modrinth archive size is missing or outside the 2 GiB limit".into(),
            )
        })?;
    let hashes = file
        .get("hashes")
        .ok_or_else(|| ProviderResolutionError::Malformed("archive hashes are missing".into()))?;
    let sha1 = required_string(hashes, "sha1")?;
    let sha512 = required_string(hashes, "sha512")?;
    if !install::valid_hash(sha1, 40) || !install::valid_hash(sha512, 128) {
        return Err(ProviderResolutionError::Malformed(
            "Modrinth archive SHA-1 or SHA-512 is invalid".into(),
        ));
    }
    Ok(ModrinthArchiveDownload {
        url: url.to_string(),
        file_name: file_name.to_string(),
        size_bytes,
        hashes: ContentHashes {
            sha1: sha1.to_ascii_lowercase(),
            sha512: sha512.to_ascii_lowercase(),
        },
    })
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, ProviderResolutionError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ProviderResolutionError::Malformed(format!("{key} is missing or empty")))
}

fn string_array(value: &Value, key: &str) -> Result<Vec<String>, ProviderResolutionError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ProviderResolutionError::Malformed(format!("{key} is missing")))?
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|text| !text.trim().is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    ProviderResolutionError::Malformed(format!("{key} contains an invalid item"))
                })
        })
        .collect()
}

fn loader_id(loader: LoaderKind) -> &'static str {
    match loader {
        LoaderKind::Vanilla => "minecraft",
        LoaderKind::Fabric => "fabric",
        LoaderKind::Forge => "forge",
        LoaderKind::NeoForge => "neoforge",
        LoaderKind::Quilt => "quilt",
    }
}

fn mrpack_loader_id(loader: classify::MrpackLoader) -> &'static str {
    match loader {
        classify::MrpackLoader::Vanilla => "minecraft",
        classify::MrpackLoader::Fabric => "fabric",
        classify::MrpackLoader::Forge => "forge",
        classify::MrpackLoader::NeoForge => "neoforge",
        classify::MrpackLoader::Quilt => "quilt",
    }
}

fn loader_pin_from_mrpack(
    metadata: &LocalMrpackMetadata,
) -> Result<LoaderPin, ProviderResolutionError> {
    let kind = match metadata.loader {
        classify::MrpackLoader::Vanilla => LoaderKind::Vanilla,
        classify::MrpackLoader::Fabric => LoaderKind::Fabric,
        classify::MrpackLoader::Forge => LoaderKind::Forge,
        classify::MrpackLoader::NeoForge => LoaderKind::NeoForge,
        classify::MrpackLoader::Quilt => {
            return Err(ProviderResolutionError::Unsupported(
                "Quilt installs remain a disabled placeholder".into(),
            ))
        }
    };
    Ok(LoaderPin {
        kind,
        minecraft_version: metadata.minecraft_version.clone(),
        loader_version: metadata.loader_version.clone(),
    })
}

fn metadata_to_install(metadata: &LocalMrpackMetadata) -> MrpackMetadata {
    MrpackMetadata {
        format_version: metadata.format_version,
        game: metadata.game.clone(),
        name: metadata.name.clone(),
        display_version_id: metadata.display_version_id.clone(),
        minecraft_version: metadata.minecraft_version.clone(),
        loader: match metadata.loader {
            classify::MrpackLoader::Vanilla => install::MrpackLoader::Vanilla,
            classify::MrpackLoader::Fabric => install::MrpackLoader::Fabric,
            classify::MrpackLoader::Forge => install::MrpackLoader::Forge,
            classify::MrpackLoader::NeoForge => install::MrpackLoader::NeoForge,
            classify::MrpackLoader::Quilt => install::MrpackLoader::Quilt,
        },
        loader_version: metadata.loader_version.clone(),
    }
}

fn map_mrpack_error(error: MrpackMetadataError) -> ProviderResolutionError {
    match error {
        MrpackMetadataError::Invalid(reason) => ProviderResolutionError::Malformed(reason),
        MrpackMetadataError::Unsupported(reason) => ProviderResolutionError::Unsupported(reason),
    }
}

fn environment_policy(value: MrpackEnvironmentPolicy) -> EnvironmentPolicy {
    match value {
        MrpackEnvironmentPolicy::Required => EnvironmentPolicy::Required,
        MrpackEnvironmentPolicy::Optional => EnvironmentPolicy::Optional,
        MrpackEnvironmentPolicy::Unsupported => EnvironmentPolicy::Unsupported,
    }
}

fn normalize_choices(
    choices: &HashMap<String, UserFileChoice>,
) -> Result<HashMap<String, UserFileChoice>, ProviderResolutionError> {
    let mut normalized = HashMap::with_capacity(choices.len());
    for (path, choice) in choices {
        if path.is_empty() || path.contains(['\\', ':']) || path.starts_with('/') {
            return Err(ProviderResolutionError::Malformed(
                "a user file choice contains an unsafe path".into(),
            ));
        }
        let key = path.to_lowercase();
        if normalized.insert(key, *choice).is_some() {
            return Err(ProviderResolutionError::Malformed(
                "user file choices contain duplicate normalized paths".into(),
            ));
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modpacks::pipeline::plan::InstallTarget;

    const PROJECT: &str = "Prjct001";
    const VERSION: &str = "Vrsion01";

    fn context() -> PlanContext {
        PlanContext {
            plan_id: "plan-modrinth".into(),
            created_at: "2026-10-11T00:00:00Z".into(),
            target: InstallTarget {
                server_id: "server-1".into(),
                server_name: "Fixture server".into(),
                directory: "servers/server-1".into(),
            },
        }
    }

    fn loader() -> LoaderPin {
        LoaderPin {
            kind: LoaderKind::Fabric,
            minecraft_version: "1.20.1".into(),
            loader_version: Some("0.15.11".into()),
        }
    }

    fn fixture(files: Value) -> Value {
        serde_json::json!({
            "id": VERSION,
            "project_id": PROJECT,
            "version_number": "2.1.0",
            "game_versions": ["1.20.1"],
            "loaders": ["fabric"],
            "files": files
        })
    }

    fn file(name: &str, primary: bool) -> Value {
        serde_json::json!({
            "filename": name,
            "primary": primary,
            "url": "https://cdn.modrinth.com/data/Prjct001/versions/Vrsion01/pack.mrpack",
            "size": 1024,
            "hashes": { "sha1": "a".repeat(40), "sha512": "b".repeat(128) }
        })
    }

    fn pipeline_file() -> install::MrpackPipelineFile {
        install::MrpackPipelineFile {
            path: "mods/example.jar".into(),
            downloads: vec!["https://cdn.modrinth.com/data/file.jar".into()],
            size: 256,
            sha1: "a".repeat(40),
            sha512: "b".repeat(128),
            client: None,
            server: Some(install::MrpackEnvironmentPolicy::Required),
            server_environment_missing: false,
        }
    }

    fn local_source_pin() -> ProviderPin {
        ProviderPin {
            source: ProviderSource::Modrinth,
            exact: ExactPackPin::ModrinthLocalArchive {
                display_version_id: "display-only".into(),
                archive: ArchiveFingerprint {
                    hashes: ContentHashes {
                        sha1: "a".repeat(40),
                        sha512: "b".repeat(128),
                    },
                    size_bytes: 1,
                    verification: ArchiveVerification::CalculatedFingerprint,
                },
            },
        }
    }

    #[test]
    fn only_resolved_include_decisions_create_file_download_work() {
        let file = pipeline_file();
        let mut downloads = Vec::new();
        let conflict_evidence = |choice| FilePolicyEvidence {
            path: file.path.clone(),
            server: vec![EnvironmentPolicy::Required, EnvironmentPolicy::Unsupported],
            client: Vec::new(),
            server_metadata_missing: false,
            choice,
        };
        let unresolved = select_file(conflict_evidence(None)).unwrap();
        assert_eq!(
            unresolved.decision.action,
            crate::modpacks::pipeline::model::FileDecisionAction::AwaitingUserChoice
        );

        append_download_if_included(&mut downloads, &file, unresolved.decision.action);
        assert!(downloads.is_empty());

        let explicitly_included =
            select_file(conflict_evidence(Some(UserFileChoice::Include))).unwrap();
        assert_eq!(
            explicitly_included.decision.action,
            crate::modpacks::pipeline::model::FileDecisionAction::Include
        );
        append_download_if_included(&mut downloads, &file, explicitly_included.decision.action);
        assert_eq!(downloads.len(), 1);
        assert_eq!(downloads[0].path, file.path);
    }

    #[test]
    fn cancellation_after_plan_validation_never_returns_a_resolved_install() {
        let index = install::MrpackPipelineIndex {
            metadata: install::MrpackMetadata {
                format_version: 1,
                game: "minecraft".into(),
                name: "Fixture pack".into(),
                display_version_id: "display-only".into(),
                minecraft_version: "1.20.1".into(),
                loader: install::MrpackLoader::Fabric,
                loader_version: Some("0.15.11".into()),
            },
            files: vec![pipeline_file()],
        };
        let mut calls = 0;

        let result = build_mrpack_install(
            context(),
            local_source_pin(),
            loader(),
            index,
            &HashMap::new(),
            || {
                calls += 1;
                calls == 4
            },
        );

        assert!(matches!(result, Err(ProviderResolutionError::Cancelled)));
        assert_eq!(calls, 4);
    }

    #[test]
    fn exact_version_must_match_both_selected_project_and_version() {
        let version = fixture(serde_json::json!([file("pack.mrpack", true)]));
        let resolved =
            resolve_remote_version_json(PROJECT, VERSION, &version, context(), loader()).unwrap();
        assert_eq!(resolved.archive_download().file_name, "pack.mrpack");
        assert!(matches!(
            resolved.source_pin.exact,
            ExactPackPin::ModrinthRemoteVersion {
                ref project_id,
                ref version_id,
                ref version_number,
                ref archive,
            } if project_id == PROJECT
                && version_id == VERSION
                && version_number == "2.1.0"
                && archive.verification == ArchiveVerification::ProviderMetadata
        ));
        let wrong_project =
            resolve_remote_version_json("Other001", VERSION, &version, context(), loader());
        assert!(matches!(
            wrong_project,
            Err(ProviderResolutionError::Malformed(_))
        ));

        let mut wrong_version = version;
        wrong_version["id"] = Value::String("Other001".into());
        assert!(matches!(
            resolve_remote_version_json(PROJECT, VERSION, &wrong_version, context(), loader()),
            Err(ProviderResolutionError::Malformed(_))
        ));
    }

    #[test]
    fn selects_primary_mrpack_and_falls_back_only_for_one_candidate() {
        let primary = fixture(serde_json::json!([
            file("extra.jar", true),
            file("pack-one.mrpack", false),
            file("pack-two.mrpack", true)
        ]));
        let resolved =
            resolve_remote_version_json(PROJECT, VERSION, &primary, context(), loader()).unwrap();
        assert_eq!(resolved.archive_download().file_name, "pack-two.mrpack");

        let unique_fallback = fixture(serde_json::json!([
            file("extra.jar", true),
            file("one.mrpack", false)
        ]));
        let resolved =
            resolve_remote_version_json(PROJECT, VERSION, &unique_fallback, context(), loader())
                .unwrap();
        assert_eq!(resolved.archive_download().file_name, "one.mrpack");

        let ambiguous = fixture(serde_json::json!([
            file("one.mrpack", false),
            file("two.mrpack", false)
        ]));
        assert!(matches!(
            resolve_remote_version_json(PROJECT, VERSION, &ambiguous, context(), loader()),
            Err(ProviderResolutionError::Unsupported(_))
        ));
    }

    #[test]
    fn rejects_untrusted_url_bad_hash_and_invalid_size() {
        for (mut invalid, expected) in [
            (
                {
                    let mut value = file("pack.mrpack", true);
                    value["url"] = Value::String("http://cdn.modrinth.com/pack.mrpack".into());
                    value
                },
                "URL",
            ),
            (
                {
                    let mut value = file("pack.mrpack", true);
                    value["hashes"]["sha1"] = Value::String("xyz".into());
                    value
                },
                "SHA",
            ),
            (
                {
                    let mut value = file("pack.mrpack", true);
                    value["size"] = Value::from(0);
                    value
                },
                "size",
            ),
            (
                {
                    let mut value = file("pack.mrpack", true);
                    value["size"] = Value::from(install::MAX_MRPACK_BYTES + 1);
                    value
                },
                "size",
            ),
        ] {
            let version = fixture(serde_json::json!([invalid.take()]));
            let error =
                resolve_remote_version_json(PROJECT, VERSION, &version, context(), loader())
                    .unwrap_err();
            assert!(error
                .to_string()
                .to_ascii_lowercase()
                .contains(&expected.to_ascii_lowercase()));
        }
    }

    #[test]
    fn cross_checks_exact_pack_metadata_against_version_metadata() {
        let version = fixture(serde_json::json!([file("pack.mrpack", true)]));
        let resolved =
            resolve_remote_version_json(PROJECT, VERSION, &version, context(), loader()).unwrap();
        let metadata = LocalMrpackMetadata {
            format_version: 1,
            game: "minecraft".into(),
            name: "Fixture".into(),
            display_version_id: "display-only".into(),
            minecraft_version: "1.20.1".into(),
            loader: classify::MrpackLoader::Fabric,
            loader_version: Some("0.15.11".into()),
        };
        cross_check_pack_metadata(&resolved, &metadata).unwrap();

        let mut mismatch = metadata;
        mismatch.loader = classify::MrpackLoader::Forge;
        assert!(matches!(
            cross_check_pack_metadata(&resolved, &mismatch),
            Err(ProviderResolutionError::Malformed(_))
        ));

        let mut mismatch = resolved.clone();
        mismatch.game_versions = vec!["1.20.4".into()];
        assert!(matches!(
            cross_check_pack_metadata(
                &mismatch,
                &LocalMrpackMetadata {
                    format_version: 1,
                    game: "minecraft".into(),
                    name: "Fixture".into(),
                    display_version_id: "display-only".into(),
                    minecraft_version: "1.20.1".into(),
                    loader: classify::MrpackLoader::Fabric,
                    loader_version: Some("0.15.11".into()),
                }
            ),
            Err(ProviderResolutionError::Malformed(_))
        ));
    }

    #[cfg(windows)]
    fn preinspection_for_archive(
        archive_path: &Path,
        advertised_game_versions: &[&str],
        sha1_override: Option<&str>,
        size_delta: u64,
    ) -> ModrinthVersionPreinspection {
        let snapshot =
            super::super::snapshot::snapshot_archive(archive_path, install::MAX_MRPACK_BYTES)
                .unwrap();
        let fingerprint = snapshot.fingerprint();
        let mut archive_file = file("pack.mrpack", true);
        archive_file["size"] = Value::from(fingerprint.size_bytes + size_delta);
        archive_file["hashes"]["sha1"] = Value::String(
            sha1_override
                .unwrap_or(&fingerprint.hashes.sha1)
                .to_string(),
        );
        archive_file["hashes"]["sha512"] = Value::String(fingerprint.hashes.sha512.clone());
        let mut version = fixture(serde_json::json!([archive_file]));
        version["game_versions"] = serde_json::json!(advertised_game_versions);
        resolve_remote_version_json(PROJECT, VERSION, &version, context(), loader()).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn remote_archive_finalization_creates_the_plan_only_after_snapshot_validation() {
        let archive = mrpack(&local_index(&local_file(
            ",\"env\":{\"server\":\"required\"}",
        )));
        let preinspection = preinspection_for_archive(&archive.0, &["1.20.1"], None, 0);
        assert!(preinspection.provider_pin().validate().is_ok());
        assert_eq!(preinspection.archive_download().file_name, "pack.mrpack");

        let resolved =
            finalize_remote_archive(&preinspection, &archive.0, &HashMap::new()).unwrap();
        assert!(resolved.plan.validate_ready_to_install().is_ok());
        assert_eq!(resolved.plan.file_decisions.len(), 1);
        assert_eq!(
            resolved.plan.file_decisions[0].action,
            crate::modpacks::pipeline::model::FileDecisionAction::Include
        );
        assert_eq!(
            resolved.plan.file_decisions[0].reason,
            crate::modpacks::pipeline::model::FileDecisionReason::Required
        );
        assert_eq!(resolved.file_downloads.len(), 1);
        assert!(matches!(
            resolved.plan.source_pin.exact,
            ExactPackPin::ModrinthRemoteVersion {
                ref project_id,
                ref version_id,
                ref version_number,
                ref archive,
            } if project_id == PROJECT
                && version_id == VERSION
                && version_number == "2.1.0"
                && archive.verification == ArchiveVerification::ProviderMetadata
        ));
    }

    #[cfg(windows)]
    #[test]
    fn remote_archive_finalization_rejects_hash_size_and_index_metadata_mismatches() {
        let archive = mrpack(&local_index(&local_file(
            ",\"env\":{\"server\":\"required\"}",
        )));
        let wrong_hash =
            preinspection_for_archive(&archive.0, &["1.20.1"], Some(&"c".repeat(40)), 0);
        assert!(matches!(
            finalize_remote_archive(&wrong_hash, &archive.0, &HashMap::new()),
            Err(ProviderResolutionError::Malformed(_))
        ));

        let wrong_size = preinspection_for_archive(&archive.0, &["1.20.1"], None, 1);
        assert!(matches!(
            finalize_remote_archive(&wrong_size, &archive.0, &HashMap::new()),
            Err(ProviderResolutionError::Malformed(_))
        ));

        let mismatch_index = local_index(&local_file(",\"env\":{\"server\":\"required\"}"))
            .replace("\"minecraft\":\"1.20.1\"", "\"minecraft\":\"1.20.4\"");
        let mismatch_archive = mrpack(&mismatch_index);
        let exact_hashes = preinspection_for_archive(&mismatch_archive.0, &["1.20.1"], None, 0);
        assert!(matches!(
            finalize_remote_archive(&exact_hashes, &mismatch_archive.0, &HashMap::new()),
            Err(ProviderResolutionError::Malformed(_))
        ));
    }

    fn mrpack(index: &str) -> TempMrpack {
        use std::io::Write;
        use zip::{write::SimpleFileOptions, ZipWriter};

        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("modrinth.index.json", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(index.as_bytes()).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let path = std::env::temp_dir().join(format!(
            "pipeline-local-modrinth-{}.mrpack",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, bytes).unwrap();
        TempMrpack(path)
    }

    struct TempMrpack(std::path::PathBuf);
    impl Drop for TempMrpack {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn local_index(file_metadata: &str) -> String {
        format!(
            r#"{{"formatVersion":1,"game":"minecraft","name":"Fixture pack","versionId":"display-v2","files":[{file_metadata}],"dependencies":{{"minecraft":"1.20.1","fabric-loader":"0.15.11"}}}}"#
        )
    }

    fn local_file(env: &str) -> String {
        format!(
            r#"{{"path":"mods/example.jar","downloads":["https://cdn.modrinth.com/data/file.jar"],"fileSize":256,"hashes":{{"sha1":"{}","sha512":"{}"}}{env}}}"#,
            "a".repeat(40),
            "b".repeat(128)
        )
    }

    #[cfg(windows)]
    #[test]
    fn local_archive_uses_calculated_fingerprint_and_keeps_version_id_display_only() {
        let source_archive = mrpack(&local_index(&local_file(
            ",\"env\":{\"client\":\"required\",\"server\":\"optional\"}",
        )));
        let resolved = resolve_local_mrpack(&source_archive.0, context(), &HashMap::new()).unwrap();
        let ExactPackPin::ModrinthLocalArchive {
            display_version_id,
            archive,
        } = &resolved.plan.source_pin.exact
        else {
            panic!("expected a local Modrinth pin");
        };
        assert_eq!(display_version_id, "display-v2");
        assert_eq!(
            archive.verification,
            ArchiveVerification::CalculatedFingerprint
        );
        assert_eq!(
            archive.size_bytes,
            std::fs::metadata(&source_archive.0).unwrap().len()
        );
        assert!(!resolved.file_downloads.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn local_resolution_honors_cancellation_after_archive_classification() {
        let source_archive = mrpack(&local_index(&local_file(
            ",\"env\":{\"server\":\"required\"}",
        )));
        let mut calls = 0;

        let result =
            resolve_local_mrpack_with_cancel(&source_archive.0, context(), &HashMap::new(), || {
                calls += 1;
                calls == 4
            });

        assert!(matches!(result, Err(ProviderResolutionError::Cancelled)));
        assert_eq!(calls, 4);
    }

    #[cfg(windows)]
    #[test]
    fn local_archive_excludes_server_unsupported_files_without_download_requirements() {
        let archive = mrpack(&local_index(&local_file(
            ",\"env\":{\"client\":\"required\",\"server\":\"unsupported\"}",
        )));
        let resolved = resolve_local_mrpack(&archive.0, context(), &HashMap::new()).unwrap();
        assert!(resolved.file_downloads.is_empty());
        assert_eq!(resolved.plan.file_decisions.len(), 1);
        assert_eq!(
            resolved.plan.file_decisions[0].action,
            crate::modpacks::pipeline::model::FileDecisionAction::Exclude
        );
        assert_eq!(
            resolved.plan.file_decisions[0].side,
            Some(crate::modpacks::pipeline::model::FileSide::Client)
        );
    }

    #[cfg(windows)]
    #[test]
    fn local_archive_missing_server_metadata_is_retained_with_warning() {
        let archive = mrpack(&local_index(&local_file("")));
        let resolved = resolve_local_mrpack(&archive.0, context(), &HashMap::new()).unwrap();
        assert_eq!(resolved.plan.file_decisions[0].side, None);
        assert_eq!(
            resolved.plan.file_decisions[0].reason,
            crate::modpacks::pipeline::model::FileDecisionReason::MissingEnvironmentRetained
        );
        assert_eq!(resolved.file_downloads.len(), 1);
        assert_eq!(resolved.warnings.len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn local_archive_retains_each_path_specific_missing_environment_warning() {
        let first = local_file("").replace("mods/example.jar", "mods/first.jar");
        let second = local_file("").replace("mods/example.jar", "mods/second.jar");
        let archive = mrpack(&local_index(&format!("{first},{second}")));
        let resolved = resolve_local_mrpack(&archive.0, context(), &HashMap::new()).unwrap();
        assert_eq!(resolved.warnings.len(), 2);
        assert!(resolved
            .warnings
            .iter()
            .any(|warning| warning.contains("mods/first.jar")));
        assert!(resolved
            .warnings
            .iter()
            .any(|warning| warning.contains("mods/second.jar")));
    }

    #[cfg(windows)]
    #[test]
    fn local_archive_optional_exclusion_is_stored_as_user_choice() {
        let archive = mrpack(&local_index(&local_file(
            ",\"env\":{\"server\":\"optional\"}",
        )));
        let choices = HashMap::from([("MODS/EXAMPLE.JAR".into(), UserFileChoice::Exclude)]);
        let resolved = resolve_local_mrpack(&archive.0, context(), &choices).unwrap();
        assert_eq!(resolved.file_downloads.len(), 0);
        assert_eq!(
            resolved.plan.file_decisions[0].reason,
            crate::modpacks::pipeline::model::FileDecisionReason::UserChoice
        );
        assert_eq!(
            resolved.plan.file_decisions[0].action,
            crate::modpacks::pipeline::model::FileDecisionAction::Exclude
        );
    }

    #[cfg(windows)]
    #[test]
    fn local_archive_rejects_malformed_environment_metadata() {
        for environment in [",\"env\":null", ",\"env\":{\"client\":null}"] {
            let archive = mrpack(&local_index(&local_file(environment)));
            assert!(matches!(
                resolve_local_mrpack(&archive.0, context(), &HashMap::new()),
                Err(ProviderResolutionError::Malformed(_))
            ));
        }
    }
}
