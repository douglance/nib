//! Portable protocol types for human decisions requested by software.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const FORMAT_NAME: &str = "nib";
pub const FORMAT_VERSION: &str = "1.0";
pub const SUPPORTED_MAJOR_VERSION: u64 = 1;

pub type Extensions = BTreeMap<String, Value>;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("Nib protocol major version {major} is not supported")]
    UnsupportedMajor { major: u64 },
    #[error("invalid Nib protocol document: {0}")]
    Invalid(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NibRequest {
    pub id: String,
    pub format_version: String,
    pub revision: u64,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: Source,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<Subject>,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    pub decision: DecisionRequirement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<RoutingPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<ApprovalPolicy>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation: Option<Continuation>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

impl NibRequest {
    pub fn from_value(value: Value) -> Result<Self, ProtocolError> {
        let version = value
            .get("formatVersion")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtocolError::Invalid("formatVersion is required".into()))?;
        validate_version(version)?;
        Ok(serde_json::from_value(value)?)
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        validate_version(&self.format_version)?;
        require_nonempty("id", &self.id)?;
        require_nonempty("title", &self.title)?;
        require_nonempty("source.type", &self.source.source_type)?;
        require_nonempty("decision.type", &self.decision.decision_type)?;
        if self.revision == 0 {
            return Err(ProtocolError::Invalid(
                "revision must be greater than zero".into(),
            ));
        }

        let mut artifact_ids = BTreeSet::new();
        for artifact in &self.artifacts {
            require_nonempty("artifact.id", &artifact.id)?;
            require_nonempty("artifact.type", &artifact.artifact_type)?;
            if !artifact_ids.insert(artifact.id.as_str()) {
                return Err(ProtocolError::Invalid(format!(
                    "artifact id '{}' is duplicated",
                    artifact.id
                )));
            }
            artifact.source.validate()?;
        }
        Ok(())
    }
}

fn validate_version(version: &str) -> Result<(), ProtocolError> {
    let major = version
        .split('.')
        .next()
        .and_then(|part| part.parse::<u64>().ok())
        .ok_or_else(|| ProtocolError::Invalid("formatVersion must be MAJOR.MINOR".into()))?;
    if major != SUPPORTED_MAJOR_VERSION {
        return Err(ProtocolError::UnsupportedMajor { major });
    }
    Ok(())
}

fn require_nonempty(field: &str, value: &str) -> Result<(), ProtocolError> {
    if value.trim().is_empty() {
        return Err(ProtocolError::Invalid(format!("{field} cannot be empty")));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), ProtocolError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProtocolError::Invalid(
            "artifact sha256 must be 64 lowercase hexadecimal characters".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    #[serde(rename = "type")]
    pub source_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<ReviewerIdentity>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    #[serde(rename = "type")]
    pub subject_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    #[serde(rename = "type")]
    pub artifact_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub source: ArtifactSource,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relationships: Vec<ArtifactRelationship>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ArtifactSource {
    Embedded {
        path: String,
        sha256: String,
        byte_length: u64,
        #[serde(flatten)]
        extensions: Extensions,
    },
    External {
        url: String,
        sha256: String,
        byte_length: u64,
        #[serde(flatten)]
        extensions: Extensions,
    },
}

impl ArtifactSource {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Embedded {
                path,
                sha256,
                byte_length,
                ..
            } => {
                require_nonempty("artifact.source.path", path)?;
                validate_sha256(sha256)?;
                if *byte_length == 0 {
                    return Err(ProtocolError::Invalid(
                        "artifact byteLength must be greater than zero".into(),
                    ));
                }
            }
            Self::External {
                url,
                sha256,
                byte_length,
                ..
            } => {
                if !(url.starts_with("https://") || url.starts_with("http://")) {
                    return Err(ProtocolError::Invalid(
                        "external artifact url must use http or https".into(),
                    ));
                }
                validate_sha256(sha256)?;
                if *byte_length == 0 {
                    return Err(ProtocolError::Invalid(
                        "artifact byteLength must be greater than zero".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRelationship {
    #[serde(rename = "type")]
    pub relationship_type: String,
    pub artifact_id: String,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRequirement {
    #[serde(rename = "type")]
    pub decision_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<DecisionOption>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoutingPolicy {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reviewers: Vec<ReviewerTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escalation: Option<EscalationPolicy>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerTarget {
    #[serde(rename = "type")]
    pub target_type: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EscalationPolicy {
    pub after_seconds: u64,
    pub to: ReviewerTarget,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalPolicy {
    All {
        requirements: Vec<ApprovalRequirement>,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Any {
        requirements: Vec<ApprovalRequirement>,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Quorum {
        reviewers: u64,
        threshold: f64,
        #[serde(flatten)]
        extensions: Extensions,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalRequirement {
    Human {
        count: u64,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Agent {
        agent_type: String,
        verdict: String,
        #[serde(flatten)]
        extensions: Extensions,
    },
    User {
        user_id: String,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Team {
        team_id: String,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Audience {
        count: u64,
        #[serde(flatten)]
        extensions: Extensions,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEvaluation {
    pub satisfied: bool,
    pub matched_decision_ids: Vec<String>,
    pub unmet_requirements: Vec<String>,
}

/// Evaluate a declarative policy using decisions from one request revision.
pub fn evaluate_policy(
    policy: &ApprovalPolicy,
    decisions: &[Decision],
    request_revision: u64,
) -> PolicyEvaluation {
    let current = latest_decisions_by_reviewer(decisions, request_revision);
    match policy {
        ApprovalPolicy::All { requirements, .. } => {
            let results: Vec<_> = requirements
                .iter()
                .map(|requirement| evaluate_requirement(requirement, &current))
                .collect();
            let satisfied = results.iter().all(|result| result.satisfied);
            PolicyEvaluation {
                satisfied,
                matched_decision_ids: if satisfied {
                    ordered_unique_ids(results.iter().flat_map(|result| result.matched.iter()))
                } else {
                    Vec::new()
                },
                unmet_requirements: results
                    .into_iter()
                    .filter(|result| !result.satisfied)
                    .map(|result| result.label)
                    .collect(),
            }
        }
        ApprovalPolicy::Any { requirements, .. } => {
            let results: Vec<_> = requirements
                .iter()
                .map(|requirement| evaluate_requirement(requirement, &current))
                .collect();
            let satisfied = results.iter().any(|result| result.satisfied);
            PolicyEvaluation {
                satisfied,
                matched_decision_ids: ordered_unique_ids(
                    results
                        .iter()
                        .filter(|result| result.satisfied)
                        .flat_map(|result| result.matched.iter()),
                ),
                unmet_requirements: if satisfied {
                    Vec::new()
                } else {
                    results.into_iter().map(|result| result.label).collect()
                },
            }
        }
        ApprovalPolicy::Quorum {
            reviewers,
            threshold,
            ..
        } => {
            let approvals: Vec<_> = current
                .iter()
                .copied()
                .filter(|decision| decision.outcome == DecisionOutcome::Approved)
                .collect();
            let ratio = if current.is_empty() {
                0.0
            } else {
                approvals.len() as f64 / current.len() as f64
            };
            let satisfied = current.len() as u64 >= *reviewers && ratio >= *threshold;
            PolicyEvaluation {
                satisfied,
                matched_decision_ids: if satisfied {
                    approvals
                        .into_iter()
                        .map(|decision| decision.id.clone())
                        .collect()
                } else {
                    Vec::new()
                },
                unmet_requirements: if satisfied {
                    Vec::new()
                } else {
                    vec![format!(
                        "quorum requires {reviewers} reviewers and approval ratio {threshold}"
                    )]
                },
            }
        }
    }
}

struct RequirementEvaluation<'a> {
    satisfied: bool,
    label: String,
    matched: Vec<&'a Decision>,
}

fn evaluate_requirement<'a>(
    requirement: &ApprovalRequirement,
    decisions: &[&'a Decision],
) -> RequirementEvaluation<'a> {
    let approved = |decision: &&Decision| decision.outcome == DecisionOutcome::Approved;
    let (label, required, matched): (String, u64, Vec<&Decision>) = match requirement {
        ApprovalRequirement::Human { count, .. } => (
            format!("human approvals: {count}"),
            *count,
            decisions
                .iter()
                .copied()
                .filter(|decision| approved(decision) && decision.reviewer.reviewer_type == "human")
                .collect(),
        ),
        ApprovalRequirement::Agent {
            agent_type,
            verdict,
            ..
        } => (
            format!("agent {agent_type} verdict {verdict}"),
            1,
            decisions
                .iter()
                .copied()
                .filter(|decision| {
                    approved(decision)
                        && decision.reviewer.reviewer_type == "agent"
                        && extension_string(&decision.reviewer.extensions, "agentType")
                            == Some(agent_type.as_str())
                        && extension_string(&decision.reviewer.extensions, "verdict")
                            == Some(verdict.as_str())
                })
                .collect(),
        ),
        ApprovalRequirement::User { user_id, .. } => (
            format!("user {user_id}"),
            1,
            decisions
                .iter()
                .copied()
                .filter(|decision| approved(decision) && decision.reviewer.id == *user_id)
                .collect(),
        ),
        ApprovalRequirement::Team { team_id, .. } => (
            format!("team {team_id}"),
            1,
            decisions
                .iter()
                .copied()
                .filter(|decision| {
                    approved(decision)
                        && extension_string(&decision.reviewer.extensions, "teamId")
                            == Some(team_id.as_str())
                })
                .collect(),
        ),
        ApprovalRequirement::Audience { count, .. } => (
            format!("audience approvals: {count}"),
            *count,
            decisions
                .iter()
                .copied()
                .filter(|decision| {
                    approved(decision)
                        && matches!(
                            decision.reviewer.reviewer_type.as_str(),
                            "audience" | "guest" | "public"
                        )
                })
                .collect(),
        ),
    };
    RequirementEvaluation {
        satisfied: matched.len() as u64 >= required,
        label,
        matched,
    }
}

fn latest_decisions_by_reviewer(decisions: &[Decision], revision: u64) -> Vec<&Decision> {
    let mut latest = BTreeMap::<&str, &Decision>::new();
    for decision in decisions
        .iter()
        .filter(|decision| decision.request_revision == revision)
    {
        latest.insert(decision.reviewer.id.as_str(), decision);
    }
    decisions
        .iter()
        .filter(|decision| {
            latest
                .get(decision.reviewer.id.as_str())
                .is_some_and(|latest| latest.id == decision.id)
        })
        .collect()
}

fn extension_string<'a>(extensions: &'a Extensions, key: &str) -> Option<&'a str> {
    extensions.get(key).and_then(Value::as_str)
}

fn ordered_unique_ids<'a>(decisions: impl Iterator<Item = &'a &'a Decision>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    decisions
        .filter_map(|decision| {
            if seen.insert(decision.id.as_str()) {
                Some(decision.id.clone())
            } else {
                None
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Continuation {
    Webhook {
        url: String,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Polling {
        #[serde(flatten)]
        extensions: Extensions,
    },
    SdkWait {
        #[serde(flatten)]
        extensions: Extensions,
    },
    GithubEvent {
        repository: String,
        #[serde(flatten)]
        extensions: Extensions,
    },
    Queue {
        adapter: String,
        destination: String,
        #[serde(flatten)]
        extensions: Extensions,
    },
    CliWait {
        #[serde(flatten)]
        extensions: Extensions,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    Pending,
    Approved,
    Rejected,
    ChangesRequested,
    Expired,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecisionOutcome {
    Approved,
    Rejected,
    ChangesRequested,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    pub request_id: String,
    pub request_revision: u64,
    pub outcome: DecisionOutcome,
    pub reviewer: ReviewerIdentity,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feedback: Vec<Feedback>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes_decision_id: Option<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerIdentity {
    pub id: String,
    #[serde(rename = "type")]
    pub reviewer_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub id: String,
    pub request_id: String,
    pub request_revision: u64,
    pub author: ReviewerIdentity,
    #[serde(flatten)]
    pub content: FeedbackContent,
    pub created_at: String,
    #[serde(flatten)]
    pub extensions: Extensions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FeedbackContent {
    Comment {
        text: String,
    },
    Annotation {
        artifact_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        anchor: Option<Value>,
    },
    Selection {
        option_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Rating {
        value: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale: Option<f64>,
    },
    StructuredAnswer {
        answer: Value,
    },
    Timestamp {
        artifact_id: String,
        seconds: f64,
        text: String,
    },
    Region {
        artifact_id: String,
        bounds: RegionBounds,
        text: String,
    },
    Attachment {
        artifact_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegionBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub request_id: String,
    pub request_revision: u64,
    pub sequence: u64,
    pub timestamp: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(flatten)]
    pub extensions: Extensions,
}

/// Returns the versioned JSON Schema documents published by the protocol crate.
pub fn schema_documents() -> BTreeMap<&'static str, Value> {
    let mut documents = BTreeMap::new();
    documents.insert(
        "nib-request.schema.json",
        schema_document::<NibRequest>("nib-request.schema.json"),
    );
    documents.insert(
        "decision.schema.json",
        schema_document::<Decision>("decision.schema.json"),
    );
    documents.insert(
        "feedback.schema.json",
        schema_document::<Feedback>("feedback.schema.json"),
    );
    documents.insert(
        "event.schema.json",
        schema_document::<Event>("event.schema.json"),
    );
    documents.insert(
        "approval-policy.schema.json",
        schema_document::<ApprovalPolicy>("approval-policy.schema.json"),
    );
    documents
}

fn schema_document<T: JsonSchema>(file_name: &str) -> Value {
    let mut document = serde_json::to_value(schemars::schema_for!(T))
        .expect("JSON Schema generated by schemars must serialize");
    if let Some(object) = document.as_object_mut() {
        object.insert(
            "$id".into(),
            Value::String(format!("https://nibtool.com/schemas/v1/{file_name}")),
        );
    }
    document
}
