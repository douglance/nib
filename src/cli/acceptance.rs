use super::{FeedbackArgs, RequestExportArgs, RequestGetArgs, RequestVerifyArgs, RequestWaitArgs};
use crate::storage::{
    self, AcceptanceDecision, AcceptancePacket, AcceptanceSignature, ACCEPTANCE_CONTRACT,
};
use serde_json::{json, Value};
use std::fmt;
use std::path::Path;
use std::time::{Duration, Instant};

const DEFAULT_PORTAL_URL: &str = "https://nibtool.com";

#[derive(Debug)]
pub struct AcceptanceCliError {
    message: String,
}

impl AcceptanceCliError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for AcceptanceCliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<AcceptanceCliError> for crate::core::NibError {
    fn from(error: AcceptanceCliError) -> Self {
        crate::core::NibError::Other(error.to_string())
    }
}

pub(crate) async fn run_feedback_packet_value(
    args: &FeedbackArgs,
) -> Result<Value, AcceptanceCliError> {
    let packet_path = args
        .packet
        .as_deref()
        .ok_or_else(|| AcceptanceCliError::new("feedback --packet requires a packet path"))?;
    let packet = storage::open_packet(packet_path)
        .map_err(|error| AcceptanceCliError::new(error.to_string()))?;
    let project_id = selected_project(args.project.as_deref(), Some(&packet))?;
    let response = publish_packet(&project_id, &packet)?;
    if args.detach {
        return Ok(response);
    }
    let review_id = response
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AcceptanceCliError::new("Acceptance publish response missing review id"))?;
    wait_for_acceptance_review(&project_id, review_id, args.timeout).await
}

pub fn run_request_get(args: &RequestGetArgs) -> crate::core::Result<()> {
    let project_id = required_project(args.project.as_deref(), None)?;
    let value = get_review(&project_id, &args.review_id)?;
    print_json(&value)
}

pub async fn run_request_wait(args: &RequestWaitArgs) -> crate::core::Result<()> {
    let project_id = required_project(args.project.as_deref(), None)?;
    let value = wait_for_acceptance_review(&project_id, &args.request_id, args.timeout).await?;
    print_json(&value)
}

pub fn run_request_export(args: &RequestExportArgs) -> crate::core::Result<()> {
    let project_id = required_project(args.project.as_deref(), None)?;
    let value = export_review(&project_id, &args.review_id)?;
    if let Some(output) = &args.output {
        export_packet_envelope(&value, output)?;
        download_export_evidence(&project_id, output, &value)?;
        print_json(&json!({
            "status": "exported",
            "file": output,
            "reviewId": args.review_id,
            "projectId": project_id
        }))
    } else {
        print_json(&value)
    }
}

pub fn run_request_verify(args: &RequestVerifyArgs) -> crate::core::Result<()> {
    if args.offline {
        let packet = args.packet.as_deref().ok_or_else(|| {
            crate::core::NibError::Other("request verify --offline requires --packet".into())
        })?;
        let jwks = args.jwks.as_deref().ok_or_else(|| {
            crate::core::NibError::Other("request verify --offline requires --jwks PATH".into())
        })?;
        let value = storage::verify_packet_offline_with_jwks(packet, jwks)?;
        return print_json_and_gate(&value);
    }

    let packet = args
        .packet
        .as_deref()
        .map(storage::open_packet)
        .transpose()?;
    let project_id = required_project(args.project.as_deref(), packet.as_ref())?;
    let manifest_hash = args
        .manifest_hash
        .clone()
        .or_else(|| packet.as_ref().map(|packet| packet.manifest_hash.clone()))
        .ok_or_else(|| {
            crate::core::NibError::Other(
                "request verify requires --manifest-hash or --packet for live verification".into(),
            )
        })?;
    let value = verify_review(
        &project_id,
        &args.review_id,
        &json!({
            "manifestHash": manifest_hash,
            "commit": args.commit,
            "subject": args.subject,
            "gate": args.gate
        }),
    )?;
    print_json_and_gate(&value)
}

fn publish_packet(
    project_id: &str,
    packet: &AcceptancePacket,
) -> Result<Value, AcceptanceCliError> {
    let agent = portal_agent();
    let base_url = portal_url();
    let manifest = manifest_with_uploaded_evidence(&agent, &base_url, project_id, packet)?;
    let manifest_hash = storage::manifest_hash(&manifest)
        .map_err(|error| AcceptanceCliError::new(error.to_string()))?;
    let body = json!({"manifest": manifest});
    send_json(
        authorize(
            agent
                .post(&format!(
                    "{base_url}/api/acceptance/v1/projects/{}/reviews",
                    path_segment(project_id)?
                ))
                .set(
                    "Idempotency-Key",
                    &format!("acceptance:publish:{manifest_hash}"),
                ),
        ),
        &body,
    )
}

fn manifest_with_uploaded_evidence(
    agent: &ureq::Agent,
    base_url: &str,
    project_id: &str,
    packet: &AcceptancePacket,
) -> Result<Value, AcceptanceCliError> {
    if packet.asset_bytes.is_empty() {
        return Ok(packet.manifest.clone());
    }
    let mut manifest = packet.manifest.clone();
    let Some(evidence) = manifest.get_mut("evidence").and_then(Value::as_array_mut) else {
        return Ok(manifest);
    };
    for item in evidence.iter_mut() {
        let Some(sha256) = item.get("sha256").and_then(Value::as_str) else {
            continue;
        };
        let Some(stored) = packet
            .asset_bytes
            .iter()
            .find(|asset| asset.sha256 == sha256)
        else {
            continue;
        };
        let uploaded = upload_evidence_bytes(agent, base_url, project_id, item, stored)?;
        if let Some(url) = uploaded.get("url").and_then(Value::as_str) {
            item["url"] = Value::String(url.to_string());
        }
        if let Some(content_type) = uploaded.get("contentType").and_then(Value::as_str) {
            item["contentType"] = Value::String(content_type.to_string());
        }
    }
    Ok(manifest)
}

fn upload_evidence_bytes(
    agent: &ureq::Agent,
    base_url: &str,
    project_id: &str,
    descriptor: &Value,
    stored: &storage::AcceptanceAssetBytes,
) -> Result<Value, AcceptanceCliError> {
    let sha256 = &stored.sha256;
    let label = descriptor
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("evidence");
    authorize(
        agent
            .post(&format!(
                "{base_url}/api/acceptance/v1/projects/{}/evidence",
                path_segment(project_id)?
            ))
            .set("content-type", &stored.content_type)
            .set("x-nib-filename", label)
            .set(
                "Idempotency-Key",
                &format!("acceptance:evidence:{project_id}:{sha256}"),
            ),
    )
    .send_bytes(&stored.bytes)
    .map_err(http_error)?
    .into_json()
    .map_err(|error| AcceptanceCliError::new(format!("Invalid evidence upload response: {error}")))
}

pub(crate) fn get_review(project_id: &str, review_id: &str) -> Result<Value, AcceptanceCliError> {
    let agent = portal_agent();
    let base_url = portal_url();
    authorize(agent.get(&format!(
        "{base_url}/api/acceptance/v1/projects/{}/reviews/{}",
        path_segment(project_id)?,
        path_segment(review_id)?
    )))
    .call()
    .map_err(http_error)?
    .into_json()
    .map_err(|error| AcceptanceCliError::new(format!("Invalid acceptance response: {error}")))
}

pub(crate) fn export_review(
    project_id: &str,
    review_id: &str,
) -> Result<Value, AcceptanceCliError> {
    let agent = portal_agent();
    let base_url = portal_url();
    authorize(agent.get(&format!(
        "{base_url}/api/acceptance/v1/projects/{}/reviews/{}/export",
        path_segment(project_id)?,
        path_segment(review_id)?
    )))
    .call()
    .map_err(http_error)?
    .into_json()
    .map_err(|error| AcceptanceCliError::new(format!("Invalid acceptance export: {error}")))
}

pub(crate) fn verify_review(
    project_id: &str,
    review_id: &str,
    expected: &Value,
) -> Result<Value, AcceptanceCliError> {
    let agent = portal_agent();
    let base_url = portal_url();
    send_json(
        authorize(
            agent
                .post(&format!(
                    "{base_url}/api/acceptance/v1/projects/{}/reviews/{}/verify",
                    path_segment(project_id)?,
                    path_segment(review_id)?
                ))
                .set(
                    "Idempotency-Key",
                    &format!(
                        "acceptance:verify:{review_id}:{}",
                        expected
                            .get("manifestHash")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                    ),
                ),
        ),
        expected,
    )
}

pub(crate) async fn wait_for_acceptance_review(
    project_id: &str,
    review_id: &str,
    timeout_seconds: u64,
) -> Result<Value, AcceptanceCliError> {
    let started = Instant::now();
    loop {
        let read_project_id = project_id.to_string();
        let read_review_id = review_id.to_string();
        let read =
            tokio::task::spawn_blocking(move || get_review(&read_project_id, &read_review_id))
                .await
                .map_err(|error| {
                    AcceptanceCliError::new(format!("Acceptance wait task failed: {error}"))
                })??;
        if read
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(is_terminal_acceptance_state)
        {
            return Ok(read);
        }
        if timeout_seconds > 0 && started.elapsed() >= Duration::from_secs(timeout_seconds) {
            return Err(AcceptanceCliError::new(format!(
                "acceptance review {review_id} did not settle within {timeout_seconds}s; resume with: nib request wait {review_id} --project {project_id}"
            )));
        }
        tokio::time::sleep(capped_delay(started, timeout_seconds)).await;
    }
}

fn is_terminal_acceptance_state(state: &str) -> bool {
    matches!(
        state,
        "approved" | "rejected" | "revision_requested" | "expired" | "superseded" | "invalidated"
    )
}

fn capped_delay(started: Instant, timeout_seconds: u64) -> Duration {
    if timeout_seconds == 0 {
        return Duration::from_millis(500);
    }
    Duration::from_secs(timeout_seconds)
        .saturating_sub(started.elapsed())
        .min(Duration::from_millis(500))
}

pub(crate) fn export_packet_envelope(envelope: &Value, output: &Path) -> crate::core::Result<()> {
    let review = envelope.get("review").unwrap_or(envelope);
    let manifest = review.get("manifest").ok_or_else(|| {
        crate::core::NibError::Other("acceptance export missing review.manifest".into())
    })?;
    if manifest.get("contract").and_then(Value::as_str) != Some(ACCEPTANCE_CONTRACT) {
        return Err(crate::core::NibError::Other(
            "acceptance export contains unsupported manifest contract".into(),
        ));
    }
    if let Some(server_hash) = review.get("manifestHash").and_then(Value::as_str) {
        let local_hash = storage::manifest_hash(manifest)?;
        if local_hash != server_hash {
            return Err(crate::core::NibError::Other(format!(
                "acceptance export manifest hash mismatch: server {server_hash}, local {local_hash}"
            )));
        }
    }
    storage::create_packet(output, manifest)?;
    storage::append_review_snapshot(output, review)?;
    append_review_history(output, review)?;
    Ok(())
}

pub(crate) fn download_export_evidence(
    project_id: &str,
    output: &Path,
    envelope: &Value,
) -> crate::core::Result<()> {
    let Some(evidence) = envelope.get("evidence").and_then(Value::as_array) else {
        return Ok(());
    };
    let agent = portal_agent();
    let base_url = portal_url();
    for descriptor in evidence {
        let Some(sha256) = descriptor.get("sha256").and_then(Value::as_str) else {
            continue;
        };
        let content_type = descriptor
            .get("contentType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream");
        let bytes = download_evidence_bytes(&agent, &base_url, project_id, sha256)?;
        storage::append_asset_bytes(output, sha256, content_type, &bytes)?;
    }
    Ok(())
}

fn download_evidence_bytes(
    agent: &ureq::Agent,
    base_url: &str,
    project_id: &str,
    sha256: &str,
) -> Result<Vec<u8>, AcceptanceCliError> {
    let response = authorize(agent.get(&format!(
        "{base_url}/api/acceptance/v1/projects/{}/evidence/{}",
        path_segment(project_id)?,
        path_segment(sha256)?
    )))
    .call()
    .map_err(http_error)?;
    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    std::io::copy(&mut reader, &mut bytes).map_err(|error| {
        AcceptanceCliError::new(format!("Failed to download acceptance evidence: {error}"))
    })?;
    Ok(bytes)
}

fn append_review_history(output: &Path, review: &Value) -> crate::core::Result<()> {
    if let Some(votes) = review.get("votes").and_then(Value::as_array) {
        for vote in votes {
            let decision = AcceptanceDecision {
                actor_id: string_field(vote, "actorId")
                    .unwrap_or("unknown")
                    .to_string(),
                decision: string_field(vote, "decision")
                    .unwrap_or("comment")
                    .to_string(),
                comment: string_field(vote, "comment").map(str::to_string),
                criteria_ids: vote
                    .get("criteriaIds")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                created_at: string_field(vote, "createdAt")
                    .or_else(|| string_field(review, "createdAt"))
                    .unwrap_or("unknown")
                    .to_string(),
                receipt: None,
            };
            storage::append_decision(output, &decision)?;
        }
    }
    if let Some(receipt) = review.get("receipt").filter(|value| !value.is_null()) {
        let signature = AcceptanceSignature {
            kind: "receipt".into(),
            key_id: receipt
                .pointer("/protected/kid")
                .and_then(Value::as_str)
                .or_else(|| receipt.get("keyId").and_then(Value::as_str))
                .map(str::to_string),
            jws: receipt
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    receipt
                        .get("jws")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| receipt.to_string()),
            created_at: string_field(review, "createdAt")
                .unwrap_or("unknown")
                .to_string(),
        };
        storage::append_signature(output, &signature)?;
    }
    Ok(())
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn selected_project(
    supplied: Option<&str>,
    packet: Option<&AcceptancePacket>,
) -> Result<String, AcceptanceCliError> {
    let project_id = required_project(supplied, packet)
        .map_err(|error| AcceptanceCliError::new(error.to_string()))?;
    if let (Some(supplied), Some(packet)) = (supplied, packet) {
        if supplied != packet.project_id {
            return Err(AcceptanceCliError::new(format!(
                "Selected project '{supplied}' does not match packet project '{}'",
                packet.project_id
            )));
        }
    }
    Ok(project_id)
}

fn required_project(
    supplied: Option<&str>,
    packet: Option<&AcceptancePacket>,
) -> crate::core::Result<String> {
    supplied
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| packet.map(|packet| packet.project_id.clone()))
        .ok_or_else(|| {
            crate::core::NibError::Other(
                "acceptance request commands require --project PROJECT_ID".into(),
            )
        })
}

fn path_segment(value: &str) -> Result<String, AcceptanceCliError> {
    if value.trim().is_empty() {
        return Err(AcceptanceCliError::new(format!(
            "Invalid acceptance path segment: {value}"
        )));
    }
    Ok(percent_encode_path_segment(value))
}

fn print_json(value: &impl serde::Serialize) -> crate::core::Result<()> {
    println!(
        "{}",
        serde_json::to_string(value)
            .map_err(|error| crate::core::NibError::Other(error.to_string()))?
    );
    Ok(())
}

fn print_json_and_gate(value: &impl serde::Serialize) -> crate::core::Result<()> {
    let value = serde_json::to_value(value)
        .map_err(|error| crate::core::NibError::Other(error.to_string()))?;
    print_json(&value)?;
    if value.get("satisfied").and_then(Value::as_bool) == Some(false) {
        return Err(crate::core::NibError::Other(
            "acceptance verification was not satisfied".into(),
        ));
    }
    Ok(())
}

fn percent_encode_path_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~'
        ) {
            encoded.push(*byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

fn portal_url() -> String {
    std::env::var("NIB_PORTAL_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PORTAL_URL.to_string())
}

fn portal_agent() -> ureq::Agent {
    let connect_timeout = std::env::var("NIB_CLOUD_CONNECT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1500);
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(connect_timeout))
        .timeout_read(Duration::from_secs(10))
        .timeout_write(Duration::from_secs(10))
        .build()
}

fn authorize(request: ureq::Request) -> ureq::Request {
    match super::auth::resolved_access_token().ok() {
        Some(token) => request.set("authorization", &format!("Bearer {token}")),
        None => request,
    }
}

fn send_json(request: ureq::Request, body: &Value) -> Result<Value, AcceptanceCliError> {
    request
        .send_json(body)
        .map_err(http_error)?
        .into_json()
        .map_err(|error| AcceptanceCliError::new(format!("Invalid acceptance response: {error}")))
}

fn http_error(error: ureq::Error) -> AcceptanceCliError {
    match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            AcceptanceCliError::new(format!("Nib acceptance API returned HTTP {status}: {body}"))
        }
        ureq::Error::Transport(error) => {
            AcceptanceCliError::new(format!("Nib acceptance API is unavailable: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Mutex, OnceLock};
    use std::thread;

    #[test]
    fn terminal_states_match_acceptance_contract() {
        for state in [
            "approved",
            "rejected",
            "revision_requested",
            "expired",
            "superseded",
            "invalidated",
        ] {
            assert!(is_terminal_acceptance_state(state), "{state}");
        }
        assert!(!is_terminal_acceptance_state("pending"));
    }

    #[test]
    fn exported_packet_preserves_server_manifest_hash_and_history() {
        let temp_dir = tempfile::tempdir().unwrap();
        let output = temp_dir.path().join("review.nib");
        let manifest = sample_manifest();
        let manifest_hash = storage::manifest_hash(&manifest).unwrap();
        let envelope = json!({
            "contract":"nib.acceptance.export/v1",
            "review":{
                "id":"review-1",
                "projectId":"project-1",
                "manifest":manifest,
                "manifestHash":manifest_hash,
                "createdAt":"2026-09-09T00:00:00Z",
                "votes":[{
                    "actorId":"acct-1",
                    "decision":"approve",
                    "comment":"ok",
                    "criteriaIds":["c1"],
                    "createdAt":"2026-09-09T00:00:01Z"
                }],
                "comments":[{
                    "actorId":"acct-2",
                    "text":"private discussion survives export",
                    "createdAt":"2026-09-09T00:00:02Z"
                }],
                "policy":{"quorum":1,"ttlSeconds":604800},
                "eligibleReviewers":["acct-1","acct-2"],
                "state":"invalidated",
                "invalidatedBy":"acct-admin",
                "invalidatedAt":"2026-09-09T00:00:03Z",
                "invalidationReason":"deployment rolled back",
                "supersededBy":"review-2",
                "receipt":{"jws":"signed","keyId":"key-1"}
            },
            "evidence":[]
        });

        export_packet_envelope(&envelope, &output).unwrap();

        let packet = storage::open_packet(&output).unwrap();
        assert_eq!(packet.manifest_hash, manifest_hash);
        assert_eq!(packet.decisions.len(), 1);
        assert_eq!(packet.signatures[0].jws, "signed");
        assert_eq!(packet.review_snapshots.len(), 1);
        assert_eq!(
            packet.review_snapshots[0].review["comments"][0]["text"],
            "private discussion survives export"
        );
        assert_eq!(
            packet.review_snapshots[0].review["policy"],
            json!({"quorum":1,"ttlSeconds":604800})
        );
        assert_eq!(
            packet.review_snapshots[0].review["eligibleReviewers"],
            json!(["acct-1", "acct-2"])
        );
        assert_eq!(packet.review_snapshots[0].review["state"], "invalidated");
        assert_eq!(
            packet.review_snapshots[0].review["invalidationReason"],
            "deployment rolled back"
        );
        assert_eq!(
            packet.review_snapshots[0].review["supersededBy"],
            "review-2"
        );
    }

    #[test]
    fn exported_packet_rejects_hash_mismatch_before_writing() {
        let temp_dir = tempfile::tempdir().unwrap();
        let output = temp_dir.path().join("bad.nib");
        let envelope = json!({
            "review":{
                "manifest":sample_manifest(),
                "manifestHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            }
        });

        let error = export_packet_envelope(&envelope, &output).unwrap_err();

        assert!(error.to_string().contains("manifest hash mismatch"));
        assert!(!output.exists());
    }

    #[test]
    fn live_verify_uses_auth_idempotency_and_encoded_paths() {
        let _guard = env_lock().lock().unwrap();
        let server = MockServer::start(vec![MockResponse {
            status: 200,
            body: r#"{"satisfied":true}"#.into(),
        }]);
        std::env::set_var("NIB_PORTAL_URL", server.url());
        std::env::set_var("NIB_AUTH_TOKEN", "secret-token");

        let response = verify_review(
            "project id/with space",
            "review id/2",
            &json!({"manifestHash":"a".repeat(64)}),
        )
        .unwrap();

        assert_eq!(response["satisfied"], true);
        let requests = server.join();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].request_line,
            "POST /api/acceptance/v1/projects/project%20id%2Fwith%20space/reviews/review%20id%2F2/verify HTTP/1.1"
        );
        assert_eq!(
            requests[0].headers.get("authorization").map(String::as_str),
            Some("Bearer secret-token")
        );
        assert_eq!(
            requests[0].headers.get("idempotency-key").map(String::as_str),
            Some("acceptance:verify:review id/2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert!(requests[0].body.contains("\"manifestHash\""));
        std::env::remove_var("NIB_PORTAL_URL");
        std::env::remove_var("NIB_AUTH_TOKEN");
    }

    #[test]
    fn verification_gate_errors_when_structured_response_is_unsatisfied() {
        let value = json!({"satisfied":false,"reason":"missing_receipt"});

        let error = print_json_and_gate(&value).unwrap_err();

        assert!(error.to_string().contains("not satisfied"));
    }

    #[test]
    fn publish_packet_uploads_packaged_evidence_before_review_publish() {
        let _guard = env_lock().lock().unwrap();
        let evidence_bytes = b"test output";
        let evidence_hash = format!("{:x}", Sha256::digest(evidence_bytes));
        let server = MockServer::start(vec![
            MockResponse {
                status: 201,
                body: format!(
                    r#"{{"id":"{evidence_hash}","url":"http://127.0.0.1/evidence/{evidence_hash}","sha256":"{evidence_hash}","contentType":"text/plain"}}"#
                ),
            },
            MockResponse {
                status: 201,
                body: r#"{"id":"review-1"}"#.into(),
            },
        ]);
        std::env::set_var("NIB_PORTAL_URL", server.url());
        std::env::set_var("NIB_AUTH_TOKEN", "secret-token");
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("packet.nib");
        let mut manifest = sample_manifest();
        manifest["evidence"][0]["sha256"] = Value::String(evidence_hash.clone());
        storage::create_packet(&path, &manifest).unwrap();
        storage::append_asset_bytes(&path, &evidence_hash, "text/plain", evidence_bytes).unwrap();
        let packet = storage::open_packet(&path).unwrap();

        publish_packet("project-1", &packet).unwrap();

        let requests = server.join();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].request_line,
            "POST /api/acceptance/v1/projects/project-1/evidence HTTP/1.1"
        );
        assert_eq!(requests[0].body.as_bytes(), evidence_bytes);
        assert_eq!(
            requests[0]
                .headers
                .get("idempotency-key")
                .map(String::as_str),
            Some(format!("acceptance:evidence:project-1:{evidence_hash}").as_str())
        );
        assert_eq!(
            requests[1].request_line,
            "POST /api/acceptance/v1/projects/project-1/reviews HTTP/1.1"
        );
        let published: Value = serde_json::from_str(&requests[1].body).unwrap();
        assert_eq!(
            published["manifest"]["evidence"][0]["url"],
            format!("http://127.0.0.1/evidence/{evidence_hash}")
        );
        assert!(packet.manifest["evidence"][0].get("url").is_none());
        std::env::remove_var("NIB_PORTAL_URL");
        std::env::remove_var("NIB_AUTH_TOKEN");
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct MockResponse {
        status: u16,
        body: String,
    }

    struct MockRequest {
        request_line: String,
        headers: std::collections::HashMap<String, String>,
        body: String,
    }

    struct MockServer {
        url: String,
        handle: thread::JoinHandle<Vec<MockRequest>>,
    }

    impl MockServer {
        fn start(responses: Vec<MockResponse>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let handle = thread::spawn(move || {
                let mut requests = Vec::new();
                for response in responses {
                    let (mut stream, _) = listener.accept().unwrap();
                    let request = read_http_request(&mut stream);
                    let response_text = format!(
                        "HTTP/1.1 {} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        response.status,
                        response.body.len(),
                        response.body
                    );
                    stream.write_all(response_text.as_bytes()).unwrap();
                    requests.push(request);
                }
                requests
            });
            Self { url, handle }
        }

        fn url(&self) -> String {
            self.url.clone()
        }

        fn join(self) -> Vec<MockRequest> {
            self.handle.join().unwrap()
        }
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> MockRequest {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let read = stream.read(&mut chunk).unwrap();
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let header_end = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap()
            + 4;
        let headers_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let mut lines = headers_text.split("\r\n");
        let request_line = lines.next().unwrap_or_default().to_string();
        let mut headers = std::collections::HashMap::new();
        for line in lines.filter(|line| !line.is_empty()) {
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        let content_length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        while buffer.len() < header_end + content_length {
            let read = stream.read(&mut chunk).unwrap();
            buffer.extend_from_slice(&chunk[..read]);
        }
        let body =
            String::from_utf8_lossy(&buffer[header_end..header_end + content_length]).to_string();
        MockRequest {
            request_line,
            headers,
            body,
        }
    }

    fn sample_manifest() -> Value {
        json!({
            "contract":"nib.acceptance/v1",
            "projectId":"project-1",
            "subject":"checkout",
            "gate":"ship",
            "title":"Ship checkout",
            "request":"Can this ship?",
            "change":"Checkout flow",
            "criteria":[{"id":"c1","text":"Flow passes"}],
            "build":{"commit":"abc","provider":"cloudflare","previewUrl":"https://example.com","deployment":{"id":"dep","components":[]}},
            "evidence":[{"id":"e1","kind":"test","label":"cargo test","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
        })
    }
}
