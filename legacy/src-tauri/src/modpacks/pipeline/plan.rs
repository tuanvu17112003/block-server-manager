use serde::{Deserialize, Serialize};

use super::model::{
    require_non_empty, validate_safe_relative_path, validate_schema_version, FileDecision,
    FileDecisionAction, ModelError, ProviderPin,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoaderKind {
    Vanilla,
    Fabric,
    Forge,
    NeoForge,
    Quilt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoaderPin {
    pub kind: LoaderKind,
    pub minecraft_version: String,
    pub loader_version: Option<String>,
}

impl LoaderPin {
    pub(crate) fn validate(&self) -> Result<(), ModelError> {
        require_non_empty(&self.minecraft_version, "minecraftVersion")?;
        match self.kind {
            LoaderKind::Quilt => Err(ModelError::InvalidValue(
                "Quilt is a disabled placeholder for new modpack installs".into(),
            )),
            LoaderKind::Vanilla if self.loader_version.is_some() => Err(ModelError::InvalidValue(
                "Vanilla must not carry a loader version".into(),
            )),
            LoaderKind::Vanilla => Ok(()),
            LoaderKind::Fabric | LoaderKind::Forge | LoaderKind::NeoForge => {
                let version = self.loader_version.as_deref().unwrap_or_default();
                require_non_empty(version, "loaderVersion")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallTarget {
    pub server_id: String,
    pub server_name: String,
    pub directory: String,
}

impl InstallTarget {
    pub(crate) fn validate(&self) -> Result<(), ModelError> {
        require_non_empty(&self.server_id, "serverId")?;
        require_non_empty(&self.server_name, "serverName")?;
        validate_safe_relative_path(&self.server_id)?;
        if self.server_id.contains('/') {
            return Err(ModelError::InvalidValue(
                "serverId must be one path component".into(),
            ));
        }
        validate_safe_relative_path(&self.directory)?;
        let expected_directory = format!("servers/{}", self.server_id);
        if self.directory != expected_directory {
            return Err(ModelError::InvalidValue(format!(
                "install target directory must be {expected_directory}"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallPlan {
    pub schema_version: u32,
    pub plan_id: String,
    pub created_at: String,
    pub target: InstallTarget,
    pub source_pin: ProviderPin,
    pub loader: LoaderPin,
    pub file_decisions: Vec<FileDecision>,
}

impl InstallPlan {
    pub fn validate(&self) -> Result<(), ModelError> {
        validate_schema_version("installPlan", self.schema_version)?;
        require_non_empty(&self.plan_id, "planId")?;
        require_non_empty(&self.created_at, "createdAt")?;
        self.target.validate()?;
        self.source_pin.validate()?;
        self.loader.validate()?;

        let mut paths = std::collections::HashSet::with_capacity(self.file_decisions.len());
        for decision in &self.file_decisions {
            decision.validate()?;
            let path_key = validate_safe_relative_path(&decision.path)?;
            if !paths.insert(path_key) {
                return Err(ModelError::InvalidValue(format!(
                    "duplicate file decision path: {}",
                    decision.path
                )));
            }
        }
        Ok(())
    }

    pub fn validate_ready_to_install(&self) -> Result<(), ModelError> {
        self.validate()?;
        if self
            .file_decisions
            .iter()
            .any(|decision| decision.action == FileDecisionAction::AwaitingUserChoice)
        {
            return Err(ModelError::InvalidValue(
                "file decisions are waiting for user input".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modpacks::pipeline::model::{
        ArchiveFingerprint, ArchiveVerification, ContentHashes, ExactPackPin, FileDecisionReason,
        FileSide, ProviderSource, PIPELINE_SCHEMA_VERSION,
    };

    fn valid_plan(loader: LoaderPin) -> InstallPlan {
        InstallPlan {
            schema_version: PIPELINE_SCHEMA_VERSION,
            plan_id: "plan-1".into(),
            created_at: "2026-10-11T00:00:00Z".into(),
            target: InstallTarget {
                server_id: "server-1".into(),
                server_name: "Test server".into(),
                directory: "servers/server-1".into(),
            },
            source_pin: ProviderPin {
                source: ProviderSource::CurseForge,
                exact: ExactPackPin::CurseForgeServerArchive {
                    file_name: "server-pack.zip".into(),
                    archive: ArchiveFingerprint {
                        hashes: ContentHashes {
                            sha1: "a".repeat(40),
                            sha512: "b".repeat(128),
                        },
                        size_bytes: 256,
                        verification: ArchiveVerification::CalculatedFingerprint,
                    },
                },
            },
            loader,
            file_decisions: vec![FileDecision {
                path: "mods/example.jar".into(),
                side: Some(FileSide::Server),
                action: FileDecisionAction::Include,
                reason: FileDecisionReason::Required,
            }],
        }
    }

    #[test]
    fn plan_rejects_quilt_for_new_modpack_install() {
        let plan = valid_plan(LoaderPin {
            kind: LoaderKind::Quilt,
            minecraft_version: "1.20.1".into(),
            loader_version: Some("0.24.0".into()),
        });

        assert!(matches!(
            plan.validate(),
            Err(ModelError::InvalidValue(message)) if message.contains("Quilt is a disabled placeholder")
        ));
    }

    #[test]
    fn plan_must_resolve_conflicting_file_choices_before_install() {
        let mut plan = valid_plan(LoaderPin {
            kind: LoaderKind::Fabric,
            minecraft_version: "1.20.1".into(),
            loader_version: Some("0.15.11".into()),
        });
        plan.file_decisions[0].action = FileDecisionAction::AwaitingUserChoice;
        plan.file_decisions[0].reason = FileDecisionReason::ConflictingSignals;

        assert!(plan.validate().is_ok());
        assert!(matches!(
            plan.validate_ready_to_install(),
            Err(ModelError::InvalidValue(message)) if message.contains("waiting for user input")
        ));
    }

    #[test]
    fn plan_rejects_case_insensitive_file_decision_aliases() {
        let mut plan = valid_plan(LoaderPin {
            kind: LoaderKind::Fabric,
            minecraft_version: "1.20.1".into(),
            loader_version: Some("0.15.11".into()),
        });
        plan.file_decisions.push(FileDecision {
            path: "mods/Example.jar".into(),
            side: Some(FileSide::Server),
            action: FileDecisionAction::Include,
            reason: FileDecisionReason::Required,
        });

        assert!(matches!(
            plan.validate(),
            Err(ModelError::InvalidValue(message)) if message.contains("duplicate file decision path")
        ));
    }

    #[test]
    fn plan_target_must_stay_in_its_app_managed_server_directory() {
        let mut plan = valid_plan(LoaderPin {
            kind: LoaderKind::Fabric,
            minecraft_version: "1.20.1".into(),
            loader_version: Some("0.15.11".into()),
        });
        assert!(plan.validate().is_ok());

        for directory in [
            "servers/another-server",
            "data/server-1",
            "../server-1",
            "C:/outside/server-1",
        ] {
            plan.target.directory = directory.into();
            assert!(
                plan.validate().is_err(),
                "accepted target directory {directory:?}"
            );
        }

        plan.target.server_id = "nested/server-1".into();
        plan.target.directory = "servers/nested/server-1".into();
        assert!(plan.validate().is_err());

        plan.target.server_id = "../outside".into();
        plan.target.directory = "servers/../outside".into();
        assert!(plan.validate().is_err());
    }

    #[test]
    fn install_plan_json_round_trip_keeps_schema_version() {
        let plan = valid_plan(LoaderPin {
            kind: LoaderKind::Forge,
            minecraft_version: "1.20.1".into(),
            loader_version: Some("47.2.0".into()),
        });
        let value = serde_json::to_value(&plan).unwrap();

        assert_eq!(value["schemaVersion"], PIPELINE_SCHEMA_VERSION);
        assert_eq!(serde_json::from_value::<InstallPlan>(value).unwrap(), plan);
    }
}
