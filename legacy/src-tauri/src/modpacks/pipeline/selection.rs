use super::model::{FileDecision, FileDecisionAction, FileDecisionReason, FileSide, ModelError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvironmentPolicy {
    Required,
    Optional,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserFileChoice {
    Include,
    Exclude,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePolicyEvidence {
    pub path: String,
    /// Multiple server signals can come from independent metadata sources.
    pub server: Vec<EnvironmentPolicy>,
    pub client: Vec<EnvironmentPolicy>,
    pub server_metadata_missing: bool,
    pub choice: Option<UserFileChoice>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSelection {
    pub decision: FileDecision,
    pub warnings: Vec<String>,
}

pub fn select_file(evidence: FilePolicyEvidence) -> Result<FileSelection, ModelError> {
    let server_required = evidence.server.contains(&EnvironmentPolicy::Required);
    let server_optional = evidence.server.contains(&EnvironmentPolicy::Optional);
    let server_unsupported = evidence.server.contains(&EnvironmentPolicy::Unsupported);
    let client_required = evidence.client.contains(&EnvironmentPolicy::Required);
    let client_optional = evidence.client.contains(&EnvironmentPolicy::Optional);
    let client_unsupported = evidence.client.contains(&EnvironmentPolicy::Unsupported);

    if evidence.server.is_empty() && !evidence.server_metadata_missing {
        return Err(ModelError::InvalidValue(
            "file policy has no server-side evidence".into(),
        ));
    }

    let conflict = (server_unsupported && (server_required || server_optional))
        || (client_unsupported && (client_required || client_optional));
    let client_supported = client_required || client_optional;
    let mut warnings = Vec::new();

    let (side, action, reason) = if conflict {
        match evidence.choice {
            Some(choice) => (None, action_for(choice), FileDecisionReason::UserChoice),
            None => (
                None,
                FileDecisionAction::AwaitingUserChoice,
                FileDecisionReason::ConflictingSignals,
            ),
        }
    } else if evidence.server_metadata_missing && evidence.server.is_empty() {
        if evidence.choice.is_some() {
            return Err(ModelError::InvalidValue(
                "a file with missing server metadata has no optional choice to override".into(),
            ));
        }
        warnings.push(format!(
            "{}: server environment metadata is missing; included by default",
            evidence.path
        ));
        (
            None,
            FileDecisionAction::Include,
            FileDecisionReason::MissingEnvironmentRetained,
        )
    } else if server_unsupported {
        if evidence.choice.is_some() {
            return Err(ModelError::InvalidValue(
                "server-unsupported files cannot be included by user choice".into(),
            ));
        }
        (
            Some(if client_supported {
                FileSide::Client
            } else if client_unsupported {
                FileSide::Both
            } else {
                FileSide::Server
            }),
            FileDecisionAction::Exclude,
            FileDecisionReason::ServerUnsupported,
        )
    } else if server_required {
        if evidence.choice.is_some() {
            return Err(ModelError::InvalidValue(
                "required files do not accept an overriding user choice".into(),
            ));
        }
        (
            Some(if client_unsupported {
                FileSide::Server
            } else if client_required || client_optional {
                FileSide::Both
            } else {
                FileSide::Server
            }),
            FileDecisionAction::Include,
            FileDecisionReason::Required,
        )
    } else if server_optional {
        let side = if client_unsupported {
            FileSide::Server
        } else if client_required || client_optional {
            FileSide::Both
        } else {
            FileSide::Server
        };
        match evidence.choice {
            Some(choice) => (
                Some(side),
                action_for(choice),
                FileDecisionReason::UserChoice,
            ),
            None => (
                Some(side),
                FileDecisionAction::Include,
                FileDecisionReason::OptionalDefaultKeep,
            ),
        }
    } else {
        return Err(ModelError::InvalidValue(
            "file policy has no actionable server-side evidence".into(),
        ));
    };

    let decision = FileDecision {
        path: evidence.path,
        side,
        action,
        reason,
    };
    decision.validate()?;
    Ok(FileSelection { decision, warnings })
}

fn action_for(choice: UserFileChoice) -> FileDecisionAction {
    match choice {
        UserFileChoice::Include => FileDecisionAction::Include,
        UserFileChoice::Exclude => FileDecisionAction::Exclude,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence(server: Vec<EnvironmentPolicy>) -> FilePolicyEvidence {
        FilePolicyEvidence {
            path: "mods/example.jar".into(),
            server,
            client: Vec::new(),
            server_metadata_missing: false,
            choice: None,
        }
    }

    #[test]
    fn required_and_optional_files_are_included_by_default() {
        let required = select_file(evidence(vec![EnvironmentPolicy::Required])).unwrap();
        assert_eq!(required.decision.action, FileDecisionAction::Include);
        assert_eq!(required.decision.reason, FileDecisionReason::Required);

        let optional = select_file(evidence(vec![EnvironmentPolicy::Optional])).unwrap();
        assert_eq!(optional.decision.action, FileDecisionAction::Include);
        assert_eq!(
            optional.decision.reason,
            FileDecisionReason::OptionalDefaultKeep
        );
    }

    #[test]
    fn optional_files_accept_only_explicit_include_or_exclude_choices() {
        for (choice, action) in [
            (UserFileChoice::Include, FileDecisionAction::Include),
            (UserFileChoice::Exclude, FileDecisionAction::Exclude),
        ] {
            let mut input = evidence(vec![EnvironmentPolicy::Optional]);
            input.choice = Some(choice);
            let result = select_file(input).unwrap();
            assert_eq!(result.decision.action, action);
            assert_eq!(result.decision.reason, FileDecisionReason::UserChoice);
        }
    }

    #[test]
    fn unsupported_and_client_only_files_are_excluded() {
        let unsupported = select_file(evidence(vec![EnvironmentPolicy::Unsupported])).unwrap();
        assert_eq!(unsupported.decision.action, FileDecisionAction::Exclude);
        assert_eq!(
            unsupported.decision.reason,
            FileDecisionReason::ServerUnsupported
        );

        let mut client_only = evidence(vec![EnvironmentPolicy::Unsupported]);
        client_only.client.push(EnvironmentPolicy::Required);
        let result = select_file(client_only).unwrap();
        assert_eq!(result.decision.side, Some(FileSide::Client));
        assert_eq!(result.decision.action, FileDecisionAction::Exclude);
        assert_eq!(
            result.decision.reason,
            FileDecisionReason::ServerUnsupported
        );
    }

    #[test]
    fn missing_server_environment_is_included_with_side_none_and_warning() {
        let input = FilePolicyEvidence {
            path: "mods/unknown.jar".into(),
            server: Vec::new(),
            client: vec![EnvironmentPolicy::Unsupported],
            server_metadata_missing: true,
            choice: None,
        };
        let result = select_file(input).unwrap();
        assert_eq!(result.decision.side, None);
        assert_eq!(result.decision.action, FileDecisionAction::Include);
        assert_eq!(
            result.decision.reason,
            FileDecisionReason::MissingEnvironmentRetained
        );
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn conflicting_server_signals_wait_and_choices_are_recorded_explicitly() {
        let unresolved = select_file(evidence(vec![
            EnvironmentPolicy::Required,
            EnvironmentPolicy::Unsupported,
        ]))
        .unwrap();
        assert_eq!(
            unresolved.decision.action,
            FileDecisionAction::AwaitingUserChoice
        );
        assert_eq!(
            unresolved.decision.reason,
            FileDecisionReason::ConflictingSignals
        );

        for (choice, action) in [
            (UserFileChoice::Include, FileDecisionAction::Include),
            (UserFileChoice::Exclude, FileDecisionAction::Exclude),
        ] {
            let mut resolved = evidence(vec![
                EnvironmentPolicy::Required,
                EnvironmentPolicy::Unsupported,
            ]);
            resolved.choice = Some(choice);
            let resolved = select_file(resolved).unwrap();
            assert_eq!(resolved.decision.action, action);
            assert_eq!(resolved.decision.reason, FileDecisionReason::UserChoice);
            assert_eq!(resolved.decision.side, None);
        }
    }

    #[test]
    fn choices_cannot_bypass_required_or_unsupported_policy() {
        let mut required = evidence(vec![EnvironmentPolicy::Required]);
        required.choice = Some(UserFileChoice::Exclude);
        assert!(select_file(required).is_err());

        let mut unsupported = evidence(vec![EnvironmentPolicy::Unsupported]);
        unsupported.choice = Some(UserFileChoice::Include);
        assert!(select_file(unsupported).is_err());

        let mut client_only = evidence(vec![EnvironmentPolicy::Unsupported]);
        client_only.client.push(EnvironmentPolicy::Required);
        client_only.choice = Some(UserFileChoice::Include);
        assert!(select_file(client_only).is_err());
    }
}
