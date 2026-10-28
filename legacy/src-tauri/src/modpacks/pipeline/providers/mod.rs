pub mod curseforge;
pub mod modrinth;
pub(crate) mod snapshot;

use crate::modpacks::pipeline::{
    model::{
        require_non_empty, ContentHashes, FileDecision, ModelError, ProviderPin,
        PIPELINE_SCHEMA_VERSION,
    },
    plan::{InstallPlan, InstallTarget, LoaderPin},
};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanContext {
    pub plan_id: String,
    pub created_at: String,
    pub target: InstallTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFileDownload {
    pub path: String,
    pub urls: Vec<String>,
    pub size_bytes: u64,
    pub hashes: ContentHashes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionCheckpoint {
    SnapshotCopy,
    SnapshotReady,
    NestedArchiveCopy,
    ArchiveClassified,
    IndexParsed,
    MetadataCrossChecked,
    FilePolicy,
    BeforePlan,
    PlanValidated,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProviderResolutionError {
    Malformed(String),
    Unsupported(String),
    Io(String),
    InsufficientSpace {
        required_bytes: u64,
        available_bytes: u64,
    },
    Cancelled,
    InvalidModel(ModelError),
}

impl std::fmt::Display for ProviderResolutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(message) => write!(formatter, "malformed provider input: {message}"),
            Self::Unsupported(message) => write!(formatter, "unsupported provider input: {message}"),
            Self::Io(message) => write!(formatter, "could not inspect provider input: {message}"),
            Self::InsufficientSpace {
                required_bytes,
                available_bytes,
            } => write!(
                formatter,
                "not enough temporary-volume space for archive snapshot (need {required_bytes} bytes including headroom; have {available_bytes})"
            ),
            Self::Cancelled => formatter.write_str("archive snapshot was cancelled"),
            Self::InvalidModel(error) => write!(formatter, "invalid install plan: {error}"),
        }
    }
}

impl std::error::Error for ProviderResolutionError {}

impl From<ModelError> for ProviderResolutionError {
    fn from(value: ModelError) -> Self {
        Self::InvalidModel(value)
    }
}

pub(crate) fn make_plan(
    context: PlanContext,
    source_pin: ProviderPin,
    loader: LoaderPin,
    file_decisions: Vec<FileDecision>,
) -> Result<InstallPlan, ProviderResolutionError> {
    validate_plan_context(&context)?;
    loader
        .validate()
        .map_err(ProviderResolutionError::InvalidModel)?;
    let plan = InstallPlan {
        schema_version: PIPELINE_SCHEMA_VERSION,
        plan_id: context.plan_id,
        created_at: context.created_at,
        target: context.target,
        source_pin,
        loader,
        file_decisions,
    };
    plan.validate()?;
    Ok(plan)
}

pub(crate) fn validate_plan_context(context: &PlanContext) -> Result<(), ProviderResolutionError> {
    require_non_empty(&context.plan_id, "planId")?;
    require_non_empty(&context.created_at, "createdAt")?;
    context
        .target
        .validate()
        .map_err(ProviderResolutionError::InvalidModel)
}

pub(crate) fn ensure_not_cancelled<F>(
    is_cancelled: &mut F,
    checkpoint: ResolutionCheckpoint,
    path: &Path,
) -> Result<(), ProviderResolutionError>
where
    F: FnMut(ResolutionCheckpoint, &Path) -> bool,
{
    if is_cancelled(checkpoint, path) {
        Err(ProviderResolutionError::Cancelled)
    } else {
        Ok(())
    }
}
