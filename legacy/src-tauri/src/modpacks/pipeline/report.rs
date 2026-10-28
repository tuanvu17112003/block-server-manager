use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::modpacks::pipeline::{
    loader::{LoaderCompletenessEvidence, LoaderInstallMethod, LoaderLaunchMode},
    model::{ContentHashes, PIPELINE_SCHEMA_VERSION},
    plan::{InstallPlan, LoaderPin},
};

pub const INSTALL_REPORT_FILE: &str = "install-report.json";
pub const INSTALL_PLAN_FILE: &str = "install-plan.json";
pub const MANAGED_FILES_FILE: &str = "managed-files.json";
pub const LAUNCH_CONFIG_FILE: &str = "launch-config.json";
pub const MANAGED_FILES_SCHEMA_VERSION: u32 = 1;
pub const MAX_MANAGED_FILES_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_LAUNCH_CONFIG_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallStatus {
    Preparing,
    Complete,
    Failed,
    Cancelled,
    NeedsAttention,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileOutcome {
    Verified,
    Installed,
    RemovedAsStale,
    PreservedUserFile,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReportEntry {
    pub path: String,
    pub outcome: FileOutcome,
    pub size_bytes: Option<u64>,
    pub hashes: Option<ContentHashes>,
    pub source_host: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageReportEntry {
    pub stage: String,
    pub outcome: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeFileEvidence {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode", deny_unknown_fields)]
pub enum LaunchModeEvidence {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoaderRuntimeEvidence {
    pub resolved_version: Option<String>,
    pub installer_coordinate: Option<String>,
    pub forge_artifact: Option<String>,
    pub metadata_source: String,
    pub artifact_host: String,
    pub install_method: String,
    pub launch_mode: LaunchModeEvidence,
    pub required_files: Vec<RuntimeFileEvidence>,
    pub complete: bool,
}

/// A durable report assembled from verified in-memory inputs and transaction evidence.
/// The serialized report is diagnostic output and is never used as install authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallReport {
    pub schema_version: u32,
    pub plan_id: String,
    pub server_id: String,
    pub created_at: String,
    pub status: InstallStatus,
    pub source_pin: crate::modpacks::pipeline::model::ProviderPin,
    pub loader: LoaderPin,
    pub loader_evidence: Option<LoaderRuntimeEvidence>,
    pub files: Vec<FileReportEntry>,
    pub stages: Vec<StageReportEntry>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl InstallReport {
    pub fn preparing(plan: &InstallPlan) -> Self {
        Self {
            schema_version: PIPELINE_SCHEMA_VERSION,
            plan_id: plan.plan_id.clone(),
            server_id: plan.target.server_id.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            status: InstallStatus::Preparing,
            source_pin: plan.source_pin.clone(),
            loader: plan.loader.clone(),
            loader_evidence: None,
            files: Vec::new(),
            stages: Vec::new(),
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    }

    pub fn set_loader_evidence(&mut self, evidence: &LoaderCompletenessEvidence) {
        let launch_mode = match &evidence.launch_mode {
            LoaderLaunchMode::ServerJar { file_name } => LaunchModeEvidence::ServerJar {
                file_name: file_name.clone(),
            },
            LoaderLaunchMode::LegacyForgeJars {
                forge_jar,
                minecraft_jar,
            } => LaunchModeEvidence::LegacyForgeJars {
                forge_jar: forge_jar.clone(),
                minecraft_jar: minecraft_jar.clone(),
            },
            LoaderLaunchMode::ArgumentFiles {
                user_jvm_args,
                loader_args,
            } => LaunchModeEvidence::ArgumentFiles {
                user_jvm_args: user_jvm_args.clone(),
                loader_args: loader_args.clone(),
            },
        };
        let install_method = match evidence.coordinate.install_method {
            LoaderInstallMethod::MojangServerJar => "mojangServerJar",
            LoaderInstallMethod::FabricServerJar => "fabricServerJar",
            LoaderInstallMethod::ForgeServerInstaller => "forgeServerInstaller",
            LoaderInstallMethod::NeoForgeServerInstaller => "neoForgeServerInstaller",
        };
        self.loader_evidence = Some(LoaderRuntimeEvidence {
            resolved_version: evidence.coordinate.resolved_version.clone(),
            installer_coordinate: evidence.coordinate.installer_loader_version.clone(),
            forge_artifact: evidence.coordinate.forge_artifact.clone(),
            metadata_source: evidence.coordinate.metadata_source.clone(),
            artifact_host: https_host(&evidence.coordinate.artifact_url)
                .unwrap_or_default()
                .to_string(),
            install_method: install_method.into(),
            launch_mode,
            required_files: evidence
                .required_files
                .iter()
                .map(|file| RuntimeFileEvidence {
                    path: file.relative_path.clone(),
                    size_bytes: file.size_bytes,
                })
                .collect(),
            complete: evidence.complete,
        });
    }

    pub fn record_stage(
        &mut self,
        stage: impl Into<String>,
        outcome: impl Into<String>,
        detail: Option<String>,
    ) {
        self.stages.push(StageReportEntry {
            stage: stage.into(),
            outcome: outcome.into(),
            detail,
        });
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != PIPELINE_SCHEMA_VERSION
            || self.plan_id.trim().is_empty()
            || self.server_id.trim().is_empty()
            || self.created_at.trim().is_empty()
        {
            return Err("install report has an unsupported schema or missing identity".into());
        }
        self.source_pin
            .validate()
            .map_err(|error| format!("install report source pin is invalid: {error}"))?;
        self.loader
            .validate()
            .map_err(|error| format!("install report loader pin is invalid: {error}"))?;
        if let Some(evidence) = &self.loader_evidence {
            if !evidence.complete
                || evidence.metadata_source.trim().is_empty()
                || evidence.artifact_host.trim().is_empty()
            {
                return Err("install report loader completeness evidence is incomplete".into());
            }
            for file in &evidence.required_files {
                validate_relative_report_path(&file.path)?;
                if file.size_bytes == 0 {
                    return Err(format!(
                        "install report loader file {} has zero size",
                        file.path
                    ));
                }
            }
        }
        for file in &self.files {
            validate_relative_report_path(&file.path)?;
            if let Some(hashes) = &file.hashes {
                hashes
                    .validate()
                    .map_err(|error| format!("install report file hash is invalid: {error}"))?;
            }
        }
        Ok(())
    }
}

fn https_host(url: &str) -> Option<&str> {
    let authority = url
        .strip_prefix("https://")?
        .split(['/', '?', '#'])
        .next()?;
    if authority.is_empty() || authority.contains(['@', ':', '\\']) {
        return None;
    }
    Some(authority)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedFileRecord {
    pub path: String,
    pub size_bytes: u64,
    pub hashes: ContentHashes,
    pub plan_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedFilesManifest {
    pub schema_version: u32,
    pub server_id: String,
    /// Exact canonical app-data root used when the ownership rows were written.
    pub canonical_app_data_dir: String,
    pub files: Vec<ManagedFileRecord>,
}

impl ManagedFilesManifest {
    pub fn new(server_id: &str, canonical_app_data_dir: &Path) -> Self {
        Self {
            schema_version: MANAGED_FILES_SCHEMA_VERSION,
            server_id: server_id.to_string(),
            canonical_app_data_dir: canonical_app_data_dir.to_string_lossy().into_owned(),
            files: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != MANAGED_FILES_SCHEMA_VERSION
            || self.server_id.trim().is_empty()
            || self.canonical_app_data_dir.trim().is_empty()
            || !Path::new(&self.canonical_app_data_dir).is_absolute()
        {
            return Err("managed-file manifest has an invalid schema or root binding".into());
        }
        let mut paths = std::collections::HashSet::with_capacity(self.files.len());
        for file in &self.files {
            let key = validate_relative_report_path(&file.path)?;
            if !paths.insert(key) {
                return Err(format!("managed-file manifest repeats {}", file.path));
            }
            if file.size_bytes == 0
                || file.plan_id.trim().is_empty()
                || file.updated_at.trim().is_empty()
            {
                return Err(format!(
                    "managed-file record for {} is incomplete",
                    file.path
                ));
            }
            file.hashes.validate().map_err(|error| {
                format!("managed-file hash for {} is invalid: {error}", file.path)
            })?;
        }
        Ok(())
    }
}

pub fn encode_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value)
        .map_err(|error| format!("could not encode install artifact: {error}"))
}

pub(crate) fn validate_relative_report_path(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('/')
        || value.contains(['\\', ':', '\0'])
        || value.chars().any(char::is_control)
    {
        return Err(format!("unsafe install artifact path: {value}"));
    }
    let mut normalized = Vec::new();
    for component in value.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with(' ')
            || component.ends_with('.')
        {
            return Err(format!("unsafe install artifact path: {value}"));
        }
        normalized.push(component.to_ascii_lowercase());
    }
    Ok(normalized.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modpacks::pipeline::model::{
        ArchiveFingerprint, ArchiveVerification, ExactPackPin, ProviderSource,
    };
    use crate::modpacks::pipeline::plan::{InstallTarget, LoaderKind};

    fn plan() -> InstallPlan {
        InstallPlan {
            schema_version: PIPELINE_SCHEMA_VERSION,
            plan_id: "test-plan".into(),
            created_at: "2026-10-12T00:00:00Z".into(),
            target: InstallTarget {
                server_id: "server-test".into(),
                server_name: "Test".into(),
                directory: "servers/server-test".into(),
            },
            source_pin: crate::modpacks::pipeline::model::ProviderPin {
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
            },
            loader: LoaderPin {
                kind: LoaderKind::Fabric,
                minecraft_version: "1.20.1".into(),
                loader_version: Some("0.15.11".into()),
            },
            file_decisions: Vec::new(),
        }
    }

    #[test]
    fn managed_manifest_rejects_duplicate_paths_and_bad_root_binding() {
        let root = std::env::temp_dir();
        let mut manifest = ManagedFilesManifest::new("server-test", &root);
        let record = ManagedFileRecord {
            path: "mods/example.jar".into(),
            size_bytes: 3,
            hashes: ContentHashes {
                sha1: "a".repeat(40),
                sha512: "b".repeat(128),
            },
            plan_id: "test-plan".into(),
            updated_at: "2026-10-12T00:00:00Z".into(),
        };
        manifest.files = vec![
            record.clone(),
            ManagedFileRecord {
                path: "MODS/example.jar".into(),
                ..record
            },
        ];
        assert!(manifest.validate().unwrap_err().contains("repeats"));
        manifest.files.clear();
        manifest.canonical_app_data_dir = "relative-root".into();
        assert!(manifest.validate().unwrap_err().contains("root binding"));
    }

    #[test]
    fn install_report_round_trip_keeps_provider_and_loader_pins() {
        let plan = plan();
        let report = InstallReport::preparing(&plan);
        let encoded = encode_json(&report).unwrap();
        let decoded: InstallReport = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.source_pin, plan.source_pin);
        assert_eq!(decoded.loader, plan.loader);
        assert_eq!(decoded.status, InstallStatus::Preparing);
        decoded.validate().unwrap();
    }
}
