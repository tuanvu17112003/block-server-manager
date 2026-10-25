use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

pub const PIPELINE_SCHEMA_VERSION: u32 = 1;
const MAX_RELATIVE_PATH_UTF16_UNITS: usize = 4096;
const MAX_PATH_COMPONENT_UTF16_UNITS: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSource {
    #[serde(rename = "curseforge")]
    CurseForge,
    #[serde(rename = "modrinth")]
    Modrinth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPin {
    pub source: ProviderSource,
    pub exact: ExactPackPin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExactPackPin {
    CurseForgeServerArchive {
        file_name: String,
        archive: ArchiveFingerprint,
    },
    ModrinthRemoteVersion {
        project_id: String,
        version_id: String,
        version_number: String,
        archive: ArchiveFingerprint,
    },
    ModrinthLocalArchive {
        /// Author-provided display metadata only, never a trusted identity pin.
        display_version_id: String,
        archive: ArchiveFingerprint,
    },
}

impl ProviderPin {
    pub fn validate(&self) -> Result<(), ModelError> {
        match (&self.source, &self.exact) {
            (
                ProviderSource::CurseForge,
                ExactPackPin::CurseForgeServerArchive { file_name, archive },
            ) => {
                require_non_empty(file_name, "fileName")?;
                if archive.verification != ArchiveVerification::CalculatedFingerprint {
                    return Err(ModelError::InvalidValue(
                        "CurseForge server archives must use a calculated fingerprint".into(),
                    ));
                }
                archive.validate()
            }
            (
                ProviderSource::Modrinth,
                ExactPackPin::ModrinthRemoteVersion {
                    project_id,
                    version_id,
                    version_number,
                    archive,
                },
            ) => {
                require_non_empty(project_id, "projectId")?;
                require_non_empty(version_id, "versionId")?;
                require_non_empty(version_number, "versionNumber")?;
                if archive.verification != ArchiveVerification::ProviderMetadata {
                    return Err(ModelError::InvalidValue(
                        "remote Modrinth archives must use provider metadata verification".into(),
                    ));
                }
                archive.validate()
            }
            (
                ProviderSource::Modrinth,
                ExactPackPin::ModrinthLocalArchive {
                    display_version_id,
                    archive,
                },
            ) => {
                require_non_empty(display_version_id, "displayVersionId")?;
                if archive.verification != ArchiveVerification::CalculatedFingerprint {
                    return Err(ModelError::InvalidValue(
                        "local Modrinth archives must use a calculated fingerprint".into(),
                    ));
                }
                archive.validate()
            }
            _ => Err(ModelError::InvalidProviderPin),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveVerification {
    ProviderMetadata,
    CalculatedFingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveFingerprint {
    pub hashes: ContentHashes,
    pub size_bytes: u64,
    pub verification: ArchiveVerification,
}

impl ArchiveFingerprint {
    pub fn validate(&self) -> Result<(), ModelError> {
        self.hashes.validate()?;
        if self.size_bytes == 0 {
            return Err(ModelError::InvalidValue(
                "archive size must be greater than zero".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentHashes {
    pub sha1: String,
    pub sha512: String,
}

impl ContentHashes {
    pub fn validate(&self) -> Result<(), ModelError> {
        if !is_lower_or_upper_hex_of_len(&self.sha1, 40) {
            return Err(ModelError::InvalidHash("sha1"));
        }
        if !is_lower_or_upper_hex_of_len(&self.sha512, 128) {
            return Err(ModelError::InvalidHash("sha512"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileSide {
    Client,
    Server,
    Both,
}

impl FileSide {
    pub fn applies_to_server(self) -> bool {
        matches!(self, Self::Server | Self::Both)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileDecisionAction {
    Include,
    Exclude,
    AwaitingUserChoice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileDecisionReason {
    Required,
    OptionalDefaultKeep,
    UserChoice,
    ServerUnsupported,
    MissingEnvironmentRetained,
    ConflictingSignals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDecision {
    pub path: String,
    pub side: Option<FileSide>,
    pub action: FileDecisionAction,
    pub reason: FileDecisionReason,
}

impl FileDecision {
    pub fn validate(&self) -> Result<(), ModelError> {
        validate_safe_relative_path(&self.path)?;

        if self.reason == FileDecisionReason::MissingEnvironmentRetained && self.side.is_some() {
            return Err(ModelError::InvalidValue(
                "missing-environment files must not claim a side".into(),
            ));
        }

        match self.reason {
            FileDecisionReason::Required | FileDecisionReason::MissingEnvironmentRetained
                if self.action != FileDecisionAction::Include =>
            {
                return Err(ModelError::InvalidValue(
                    "required and missing-environment files must be included".into(),
                ));
            }
            FileDecisionReason::OptionalDefaultKeep
                if self.action != FileDecisionAction::Include =>
            {
                return Err(ModelError::InvalidValue(
                    "optional files default to included; an exclusion requires an explicit choice"
                        .into(),
                ));
            }
            FileDecisionReason::ServerUnsupported if self.action != FileDecisionAction::Exclude => {
                return Err(ModelError::InvalidValue(
                    "server-unsupported files must be excluded".into(),
                ));
            }
            FileDecisionReason::ConflictingSignals
                if self.action != FileDecisionAction::AwaitingUserChoice =>
            {
                return Err(ModelError::InvalidValue(
                    "conflicting file signals must await an explicit user choice".into(),
                ));
            }
            FileDecisionReason::UserChoice
                if self.action == FileDecisionAction::AwaitingUserChoice =>
            {
                return Err(ModelError::InvalidValue(
                    "a resolved user choice must include or exclude the file".into(),
                ));
            }
            _ => {}
        }

        if self.side == Some(FileSide::Client) && self.action != FileDecisionAction::Exclude {
            return Err(ModelError::InvalidValue(
                "client-only files must be excluded from a server install".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallStage {
    Resolve,
    Validate,
    SelectFiles,
    Download,
    PrepareLoader,
    StageAndMerge,
    ConfigureLaunch,
    ValidateAndPublish,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StageStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageReport {
    pub stage: InstallStage,
    pub status: StageStatus,
    pub message: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallStatus {
    Planned,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    AwaitingEula,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValidationState {
    NotRun,
    Passed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileOutcome {
    Included,
    Skipped,
    Failed,
    Preserved,
    Replaced,
    RemovedStale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedFileSource {
    PackFile,
    BaseOverride,
    ServerOverride,
    LoaderRuntime,
    AppGenerated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallFileResult {
    pub decision: FileDecision,
    pub outcome: FileOutcome,
    pub hashes: Option<ContentHashes>,
    pub source: Option<ManagedFileSource>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallReport {
    pub schema_version: u32,
    pub plan_id: String,
    pub status: InstallStatus,
    pub validation: ValidationState,
    pub stages: Vec<StageReport>,
    pub files: Vec<InstallFileResult>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl InstallReport {
    pub fn validate(&self) -> Result<(), ModelError> {
        validate_schema_version("installReport", self.schema_version)?;
        require_non_empty(&self.plan_id, "planId")?;
        for file in &self.files {
            file.decision.validate()?;
            if let Some(hashes) = &file.hashes {
                hashes.validate()?;
            }
        }
        if matches!(
            self.status,
            InstallStatus::Running | InstallStatus::Succeeded | InstallStatus::AwaitingEula
        ) && self
            .files
            .iter()
            .any(|file| file.decision.action == FileDecisionAction::AwaitingUserChoice)
        {
            return Err(ModelError::InvalidValue(
                "an active or completed install report cannot retain unresolved file choices"
                    .into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedFileEntry {
    pub path: String,
    pub source: ManagedFileSource,
    pub installed_hashes: ContentHashes,
}

impl ManagedFileEntry {
    fn validate(&self) -> Result<(), ModelError> {
        validate_safe_relative_path(&self.path)?;
        self.installed_hashes.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedFilesManifest {
    pub schema_version: u32,
    pub server_id: String,
    pub files: Vec<ManagedFileEntry>,
}

impl ManagedFilesManifest {
    pub fn validate(&self) -> Result<(), ModelError> {
        validate_schema_version("managedFiles", self.schema_version)?;
        require_non_empty(&self.server_id, "serverId")?;
        let mut paths = HashSet::with_capacity(self.files.len());
        for file in &self.files {
            file.validate()?;
            let path_key = validate_safe_relative_path(&file.path)?;
            if !paths.insert(path_key) {
                return Err(ModelError::InvalidValue(format!(
                    "duplicate managed path: {}",
                    file.path
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchConfigSource {
    PackMetadata,
    LoaderArguments,
    DetectedConvention,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchConfig {
    pub schema_version: u32,
    pub server_id: String,
    /// Provider and loader pins are copied from the active plan as audit evidence.
    pub provider_pin: Option<ProviderPin>,
    pub loader_pin: Option<crate::modpacks::pipeline::plan::LoaderPin>,
    pub java_path: String,
    pub argv: Vec<String>,
    pub working_directory: String,
    pub source: LaunchConfigSource,
    /// Candidate sources in the deterministic order used to derive `source`.
    pub source_precedence: Vec<LaunchConfigSource>,
}

impl LaunchConfig {
    pub fn validate(&self) -> Result<(), ModelError> {
        validate_schema_version("launchConfig", self.schema_version)?;
        require_non_empty(&self.server_id, "serverId")?;
        require_non_empty(&self.java_path, "javaPath")?;
        require_non_empty(&self.working_directory, "workingDirectory")?;
        if !Path::new(&self.java_path).is_absolute()
            || !Path::new(&self.working_directory).is_absolute()
        {
            return Err(ModelError::InvalidValue(
                "launch Java path and working directory must be absolute".into(),
            ));
        }
        if self.provider_pin.is_some() && self.loader_pin.is_none() {
            return Err(ModelError::InvalidValue(
                "launch provider evidence requires its selected loader pin".into(),
            ));
        }
        if let Some(provider_pin) = &self.provider_pin {
            provider_pin.validate()?;
        }
        if let Some(loader_pin) = &self.loader_pin {
            loader_pin.validate()?;
        }
        if self.argv.is_empty() {
            return Err(ModelError::InvalidValue(
                "launch argv must contain at least one argument".into(),
            ));
        }
        if self.argv.len() > 16_384
            || self
                .argv
                .iter()
                .any(|argument| argument.is_empty() || argument.contains('\0'))
        {
            return Err(ModelError::InvalidValue(
                "launch argv is empty, contains NUL, or exceeds its argument-count limit".into(),
            ));
        }
        if self.source_precedence.is_empty()
            || !self.source_precedence.contains(&self.source)
            || self
                .source_precedence
                .windows(2)
                .any(|pair| launch_source_rank(pair[0]) >= launch_source_rank(pair[1]))
        {
            return Err(ModelError::InvalidValue(
                "launch source precedence is missing, duplicated, or out of order".into(),
            ));
        }
        Ok(())
    }
}

fn launch_source_rank(source: LaunchConfigSource) -> u8 {
    match source {
        LaunchConfigSource::PackMetadata => 0,
        LaunchConfigSource::LoaderArguments => 1,
        LaunchConfigSource::DetectedConvention => 2,
        LaunchConfigSource::Manual => 3,
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ModelError {
    #[error("{artifact} schema version {found} is unsupported (expected {expected})")]
    UnsupportedSchemaVersion {
        artifact: &'static str,
        found: u32,
        expected: u32,
    },
    #[error("{0} must not be empty")]
    MissingField(&'static str),
    #[error("invalid {0} digest")]
    InvalidHash(&'static str),
    #[error("provider and exact pin variants do not match")]
    InvalidProviderPin,
    #[error("unsafe relative path: {0}")]
    InvalidRelativePath(&'static str),
    #[error("invalid model value: {0}")]
    InvalidValue(String),
}

pub(crate) fn validate_schema_version(
    artifact: &'static str,
    actual: u32,
) -> Result<(), ModelError> {
    if actual != PIPELINE_SCHEMA_VERSION {
        return Err(ModelError::UnsupportedSchemaVersion {
            artifact,
            found: actual,
            expected: PIPELINE_SCHEMA_VERSION,
        });
    }
    Ok(())
}

pub(crate) fn require_non_empty(value: &str, field: &'static str) -> Result<(), ModelError> {
    if value.trim().is_empty() {
        return Err(ModelError::MissingField(field));
    }
    Ok(())
}

/// Validates a portable, lexical relative path and returns its comparison key.
/// The relative bound excludes the installation root; transaction preflight
/// must check the combined absolute path length and filesystem target safety.
pub fn validate_safe_relative_path(path: &str) -> Result<String, ModelError> {
    if path.is_empty() {
        return Err(ModelError::InvalidRelativePath("empty path"));
    }
    if path.starts_with('/') {
        return Err(ModelError::InvalidRelativePath("absolute path"));
    }
    if path.contains('\\') {
        return Err(ModelError::InvalidRelativePath("backslash separator"));
    }
    if path.contains(':') {
        return Err(ModelError::InvalidRelativePath(
            "drive prefix or stream syntax",
        ));
    }
    if path.chars().any(|character| character.is_control()) {
        return Err(ModelError::InvalidRelativePath("control character"));
    }
    if path.encode_utf16().count() > MAX_RELATIVE_PATH_UTF16_UNITS {
        return Err(ModelError::InvalidRelativePath(
            "relative path exceeds the length limit",
        ));
    }

    for component in path.split('/') {
        if component.is_empty() {
            return Err(ModelError::InvalidRelativePath("empty path component"));
        }
        if component == "." || component == ".." {
            return Err(ModelError::InvalidRelativePath("dot path component"));
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return Err(ModelError::InvalidRelativePath(
                "component has a Windows-trimmed trailing dot or space",
            ));
        }
        if component.encode_utf16().count() > MAX_PATH_COMPONENT_UTF16_UNITS {
            return Err(ModelError::InvalidRelativePath(
                "component exceeds the length limit",
            ));
        }
        if component
            .chars()
            .any(|character| matches!(character, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return Err(ModelError::InvalidRelativePath(
                "Windows-invalid component character",
            ));
        }
        if is_reserved_windows_device_basename(component) {
            return Err(ModelError::InvalidRelativePath(
                "reserved Windows device basename",
            ));
        }
    }

    Ok(path.to_lowercase())
}

fn is_reserved_windows_device_basename(component: &str) -> bool {
    let basename = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(|character| character == ' ' || character == '.');
    let basename = basename.to_ascii_uppercase();

    if matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }

    ["COM", "LPT"].iter().copied().any(|prefix| {
        basename.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

fn is_lower_or_upper_hex_of_len(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn side_semantics_include_server_and_both_but_exclude_client() {
        assert!(!FileSide::Client.applies_to_server());
        assert!(FileSide::Server.applies_to_server());
        assert!(FileSide::Both.applies_to_server());
    }

    #[test]
    fn versioned_json_artifacts_round_trip() {
        let hashes = ContentHashes {
            sha1: "a".repeat(40),
            sha512: "b".repeat(128),
        };
        let archive = ArchiveFingerprint {
            hashes: hashes.clone(),
            size_bytes: 4096,
            verification: ArchiveVerification::ProviderMetadata,
        };
        let report = InstallReport {
            schema_version: PIPELINE_SCHEMA_VERSION,
            plan_id: "plan-1".into(),
            status: InstallStatus::Succeeded,
            validation: ValidationState::Passed,
            stages: vec![StageReport {
                stage: InstallStage::Download,
                status: StageStatus::Succeeded,
                message: None,
                warnings: Vec::new(),
            }],
            files: vec![InstallFileResult {
                decision: FileDecision {
                    path: "mods/example.jar".into(),
                    side: Some(FileSide::Both),
                    action: FileDecisionAction::Include,
                    reason: FileDecisionReason::Required,
                },
                outcome: FileOutcome::Included,
                hashes: Some(hashes.clone()),
                source: Some(ManagedFileSource::PackFile),
                message: None,
            }],
            warnings: Vec::new(),
            errors: Vec::new(),
        };
        let manifest = ManagedFilesManifest {
            schema_version: PIPELINE_SCHEMA_VERSION,
            server_id: "server-1".into(),
            files: vec![ManagedFileEntry {
                path: "mods/example.jar".into(),
                source: ManagedFileSource::PackFile,
                installed_hashes: hashes,
            }],
        };
        let pin = ProviderPin {
            source: ProviderSource::Modrinth,
            exact: ExactPackPin::ModrinthRemoteVersion {
                project_id: "project-id".into(),
                version_id: "version-id".into(),
                version_number: "1.2.3".into(),
                archive,
            },
        };
        let launch = LaunchConfig {
            schema_version: PIPELINE_SCHEMA_VERSION,
            server_id: "server-1".into(),
            provider_pin: Some(pin.clone()),
            loader_pin: Some(crate::modpacks::pipeline::plan::LoaderPin {
                kind: crate::modpacks::pipeline::plan::LoaderKind::Fabric,
                minecraft_version: "1.20.1".into(),
                loader_version: Some("0.15.11".into()),
            }),
            java_path: "java".into(),
            argv: vec!["-jar".into(), "server.jar".into()],
            working_directory: "servers/server-1".into(),
            source: LaunchConfigSource::LoaderArguments,
            source_precedence: vec![
                LaunchConfigSource::PackMetadata,
                LaunchConfigSource::LoaderArguments,
                LaunchConfigSource::DetectedConvention,
                LaunchConfigSource::Manual,
            ],
        };

        assert_eq!(round_trip(&pin), pin);
        assert_eq!(round_trip(&report), report);
        assert_eq!(round_trip(&manifest), manifest);
        assert_eq!(round_trip(&launch), launch);
        assert!(serde_json::to_value(&report)
            .unwrap()
            .get("schemaVersion")
            .is_some());
    }

    #[test]
    fn launch_config_requires_matching_pin_presence_and_ordered_sources() {
        let root = std::env::temp_dir();
        let mut config = LaunchConfig {
            schema_version: PIPELINE_SCHEMA_VERSION,
            server_id: "server-1".into(),
            provider_pin: Some(ProviderPin {
                source: ProviderSource::Modrinth,
                exact: ExactPackPin::ModrinthRemoteVersion {
                    project_id: "project-id".into(),
                    version_id: "version-id".into(),
                    version_number: "1.2.3".into(),
                    archive: fingerprint(ArchiveVerification::ProviderMetadata),
                },
            }),
            loader_pin: Some(crate::modpacks::pipeline::plan::LoaderPin {
                kind: crate::modpacks::pipeline::plan::LoaderKind::Fabric,
                minecraft_version: "1.20.1".into(),
                loader_version: Some("0.15.11".into()),
            }),
            java_path: root.join("java.exe").to_string_lossy().into_owned(),
            argv: vec!["-jar".into(), "server.jar".into()],
            working_directory: root.join("server-1").to_string_lossy().into_owned(),
            source: LaunchConfigSource::LoaderArguments,
            source_precedence: vec![
                LaunchConfigSource::PackMetadata,
                LaunchConfigSource::LoaderArguments,
                LaunchConfigSource::DetectedConvention,
                LaunchConfigSource::Manual,
            ],
        };
        assert!(config.validate().is_ok());

        config.loader_pin = None;
        assert!(config.validate().is_err());
        config.loader_pin = Some(crate::modpacks::pipeline::plan::LoaderPin {
            kind: crate::modpacks::pipeline::plan::LoaderKind::Fabric,
            minecraft_version: "1.20.1".into(),
            loader_version: Some("0.15.11".into()),
        });
        config.source_precedence.swap(0, 1);
        assert!(config.validate().is_err());
    }

    #[test]
    fn source_pin_rejects_mismatched_provider_and_archive_semantics() {
        let pin = ProviderPin {
            source: ProviderSource::CurseForge,
            exact: ExactPackPin::ModrinthRemoteVersion {
                project_id: "project".into(),
                version_id: "version".into(),
                version_number: "1.0".into(),
                archive: ArchiveFingerprint {
                    hashes: ContentHashes {
                        sha1: "a".repeat(40),
                        sha512: "b".repeat(128),
                    },
                    size_bytes: 1,
                    verification: ArchiveVerification::CalculatedFingerprint,
                },
            },
        };

        assert_eq!(pin.validate(), Err(ModelError::InvalidProviderPin));
    }

    #[test]
    fn local_modrinth_archive_keeps_required_version_id_display_only() {
        let pin = ProviderPin {
            source: ProviderSource::Modrinth,
            exact: ExactPackPin::ModrinthLocalArchive {
                display_version_id: "author-version".into(),
                archive: fingerprint(ArchiveVerification::CalculatedFingerprint),
            },
        };

        assert!(pin.validate().is_ok());
        assert_eq!(round_trip(&pin), pin);
        let json = serde_json::to_value(&pin).unwrap();
        assert!(json["exact"].get("projectId").is_none());
        assert!(json["exact"].get("versionId").is_none());
        assert_eq!(json["exact"]["displayVersionId"], "author-version");
    }

    #[test]
    fn modrinth_remote_and_local_archive_trust_modes_cannot_be_swapped() {
        let remote_with_fingerprint = ProviderPin {
            source: ProviderSource::Modrinth,
            exact: ExactPackPin::ModrinthRemoteVersion {
                project_id: "project".into(),
                version_id: "version".into(),
                version_number: "1.0".into(),
                archive: fingerprint(ArchiveVerification::CalculatedFingerprint),
            },
        };
        let local_with_provider_metadata = ProviderPin {
            source: ProviderSource::Modrinth,
            exact: ExactPackPin::ModrinthLocalArchive {
                display_version_id: "author-value".into(),
                archive: fingerprint(ArchiveVerification::ProviderMetadata),
            },
        };

        assert!(remote_with_fingerprint.validate().is_err());
        assert!(local_with_provider_metadata.validate().is_err());
        assert!(ProviderPin {
            source: ProviderSource::Modrinth,
            exact: ExactPackPin::ModrinthLocalArchive {
                display_version_id: "  ".into(),
                archive: fingerprint(ArchiveVerification::CalculatedFingerprint),
            },
        }
        .validate()
        .is_err());
        assert!(ProviderPin {
            source: ProviderSource::Modrinth,
            exact: ExactPackPin::ModrinthRemoteVersion {
                project_id: "project".into(),
                version_id: "version".into(),
                version_number: "1.0".into(),
                archive: fingerprint(ArchiveVerification::ProviderMetadata),
            },
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn decision_policy_rejects_selection_bypasses() {
        let cases = [
            (
                FileDecisionReason::Required,
                FileDecisionAction::Exclude,
                Some(FileSide::Server),
                false,
            ),
            (
                FileDecisionReason::MissingEnvironmentRetained,
                FileDecisionAction::Exclude,
                Some(FileSide::Server),
                false,
            ),
            (
                FileDecisionReason::MissingEnvironmentRetained,
                FileDecisionAction::Include,
                Some(FileSide::Server),
                false,
            ),
            (
                FileDecisionReason::ServerUnsupported,
                FileDecisionAction::Include,
                Some(FileSide::Client),
                false,
            ),
            (
                FileDecisionReason::OptionalDefaultKeep,
                FileDecisionAction::Exclude,
                Some(FileSide::Server),
                false,
            ),
            (
                FileDecisionReason::ConflictingSignals,
                FileDecisionAction::Include,
                Some(FileSide::Server),
                false,
            ),
            (
                FileDecisionReason::ConflictingSignals,
                FileDecisionAction::Exclude,
                Some(FileSide::Server),
                false,
            ),
            (
                FileDecisionReason::UserChoice,
                FileDecisionAction::AwaitingUserChoice,
                Some(FileSide::Server),
                false,
            ),
            (
                FileDecisionReason::UserChoice,
                FileDecisionAction::Include,
                Some(FileSide::Client),
                false,
            ),
        ];

        for (reason, action, side, should_validate) in cases {
            let decision = FileDecision {
                path: "mods/example.jar".into(),
                side,
                action,
                reason,
            };
            assert_eq!(decision.validate().is_ok(), should_validate, "{decision:?}");
        }

        for (reason, action) in [
            (FileDecisionReason::Required, FileDecisionAction::Include),
            (
                FileDecisionReason::ServerUnsupported,
                FileDecisionAction::Exclude,
            ),
            (
                FileDecisionReason::ConflictingSignals,
                FileDecisionAction::AwaitingUserChoice,
            ),
            (FileDecisionReason::UserChoice, FileDecisionAction::Include),
            (FileDecisionReason::UserChoice, FileDecisionAction::Exclude),
        ] {
            let decision = FileDecision {
                path: "mods/example.jar".into(),
                side: Some(FileSide::Server),
                action,
                reason,
            };
            assert!(decision.validate().is_ok(), "{decision:?}");
        }

        let missing_environment = FileDecision {
            path: "mods/example.jar".into(),
            side: None,
            action: FileDecisionAction::Include,
            reason: FileDecisionReason::MissingEnvironmentRetained,
        };
        assert!(missing_environment.validate().is_ok());
    }

    #[test]
    fn successful_report_cannot_bypass_unresolved_selection() {
        let report = InstallReport {
            schema_version: PIPELINE_SCHEMA_VERSION,
            plan_id: "plan-1".into(),
            status: InstallStatus::Succeeded,
            validation: ValidationState::Passed,
            stages: Vec::new(),
            files: vec![InstallFileResult {
                decision: FileDecision {
                    path: "mods/example.jar".into(),
                    side: Some(FileSide::Server),
                    action: FileDecisionAction::AwaitingUserChoice,
                    reason: FileDecisionReason::ConflictingSignals,
                },
                outcome: FileOutcome::Skipped,
                hashes: None,
                source: None,
                message: None,
            }],
            warnings: Vec::new(),
            errors: Vec::new(),
        };

        assert!(report.validate().is_err());
    }

    #[test]
    fn path_validation_rejects_unsafe_aliases_for_decisions_and_manifests() {
        let hashes = ContentHashes {
            sha1: "a".repeat(40),
            sha512: "b".repeat(128),
        };
        let unsafe_paths = [
            "",
            ".",
            "..",
            "./mods/example.jar",
            "mods/../example.jar",
            "mods/./example.jar",
            "mods//example.jar",
            "mods/example.jar/",
            "/mods/example.jar",
            "//server/share/example.jar",
            "C:mods/example.jar",
            "C:/mods/example.jar",
            r"C:\mods\example.jar",
            r"\server\share\example.jar",
            r"mods\example.jar",
            "mods/example.jar:stream",
            "mods/example\u{0007}.jar",
            "mods/example.jar.",
            "mods/example.jar ",
            "mods/bad<name.jar",
            "mods/bad>name.jar",
            "mods/bad\"name.jar",
            "mods/bad|name.jar",
            "mods/bad?name.jar",
            "mods/bad*name.jar",
        ];

        for path in unsafe_paths {
            assert!(validate_safe_relative_path(path).is_err(), "{path:?}");
            let decision = FileDecision {
                path: path.into(),
                side: Some(FileSide::Server),
                action: FileDecisionAction::Include,
                reason: FileDecisionReason::Required,
            };
            assert!(decision.validate().is_err(), "decision accepted {path:?}");

            let entry = ManagedFileEntry {
                path: path.into(),
                source: ManagedFileSource::PackFile,
                installed_hashes: hashes.clone(),
            };
            assert!(entry.validate().is_err(), "manifest accepted {path:?}");
        }

        assert_eq!(
            validate_safe_relative_path("Mods/Example.jar").unwrap(),
            "mods/example.jar"
        );
    }

    #[test]
    fn path_validation_rejects_reserved_windows_device_basenames() {
        let mut reserved_names = vec![
            "CON".to_string(),
            "con.txt".to_string(),
            "PRN.log".to_string(),
            "AUX".to_string(),
            "NUL.tar.gz".to_string(),
        ];
        for digit in '1'..='9' {
            reserved_names.push(format!("COM{digit}.txt"));
            reserved_names.push(format!("lpt{digit}.txt"));
        }
        for superscript in ['¹', '²', '³'] {
            reserved_names.push(format!("COM{superscript}.log"));
            reserved_names.push(format!("lpt{superscript}.txt"));
        }

        for name in reserved_names {
            assert!(
                validate_safe_relative_path(&format!("mods/{name}")).is_err(),
                "accepted reserved device name {name:?}"
            );
        }
        assert!(validate_safe_relative_path("CON/mods/example.jar").is_err());
        assert!(validate_safe_relative_path("mods/NUL .txt").is_err());
    }

    #[test]
    fn path_validation_enforces_relative_and_component_length_limits() {
        let max_component = "a".repeat(MAX_PATH_COMPONENT_UTF16_UNITS);
        assert!(validate_safe_relative_path(&max_component).is_ok());
        assert!(validate_safe_relative_path(&format!("{}a", max_component)).is_err());
        assert!(validate_safe_relative_path(&"😀".repeat(128)).is_err());

        let max_relative_path = vec!["a".repeat(MAX_PATH_COMPONENT_UTF16_UNITS); 16].join("/");
        assert_eq!(max_relative_path.encode_utf16().count(), 4095);
        assert!(validate_safe_relative_path(&max_relative_path).is_ok());

        let too_long_relative_path = vec!["a".repeat(MAX_PATH_COMPONENT_UTF16_UNITS); 17].join("/");
        assert!(too_long_relative_path.encode_utf16().count() > MAX_RELATIVE_PATH_UTF16_UNITS);
        assert!(validate_safe_relative_path(&too_long_relative_path).is_err());
    }

    #[test]
    fn managed_manifest_rejects_case_insensitive_duplicate_paths() {
        let hashes = ContentHashes {
            sha1: "a".repeat(40),
            sha512: "b".repeat(128),
        };
        let manifest = ManagedFilesManifest {
            schema_version: PIPELINE_SCHEMA_VERSION,
            server_id: "server-1".into(),
            files: vec![
                ManagedFileEntry {
                    path: "mods/Example.jar".into(),
                    source: ManagedFileSource::PackFile,
                    installed_hashes: hashes.clone(),
                },
                ManagedFileEntry {
                    path: "mods/example.jar".into(),
                    source: ManagedFileSource::ServerOverride,
                    installed_hashes: hashes,
                },
            ],
        };

        assert!(matches!(
            manifest.validate(),
            Err(ModelError::InvalidValue(message)) if message.contains("duplicate managed path")
        ));
    }
}

#[cfg(test)]
fn fingerprint(verification: ArchiveVerification) -> ArchiveFingerprint {
    ArchiveFingerprint {
        hashes: ContentHashes {
            sha1: "a".repeat(40),
            sha512: "b".repeat(128),
        },
        size_bytes: 1,
        verification,
    }
}

#[cfg(test)]
fn round_trip<T>(value: &T) -> T
where
    T: Serialize + for<'de> Deserialize<'de>,
{
    serde_json::from_value(serde_json::to_value(value).unwrap()).unwrap()
}
