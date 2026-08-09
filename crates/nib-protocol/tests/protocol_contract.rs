use nib_protocol::{
    evaluate_policy, schema_documents, ApprovalPolicy, ArtifactSource, Decision, DecisionOutcome,
    NibRequest, ProtocolError,
};
use serde_json::json;

fn request_json() -> serde_json::Value {
    json!({
        "id": "req_checkout",
        "formatVersion": "1.0",
        "revision": 1,
        "title": "Approve checkout redesign",
        "source": {
            "type": "agent",
            "system": "codex",
            "futureSourceField": true
        },
        "artifacts": [{
            "id": "walkthrough",
            "type": "video",
            "title": "Checkout walkthrough",
            "mimeType": "video/mp4",
            "source": {
                "type": "external",
                "url": "https://cdn.example.test/walkthrough.mp4",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "byteLength": 2048
            },
            "metadata": { "durationSeconds": 8.2 },
            "futureArtifactField": "preserved"
        }],
        "decision": {
            "type": "approval",
            "prompt": "Ship this change?"
        },
        "policy": {
            "type": "all",
            "requirements": [{ "type": "human", "count": 1 }]
        },
        "createdAt": "2026-08-09T15:04:00Z",
        "futureRequestField": { "kept": true }
    })
}

#[test]
fn request_round_trip_preserves_same_major_extensions() {
    let request = NibRequest::from_value(request_json()).expect("valid request");
    request.validate().expect("request contract");

    let encoded = serde_json::to_value(request).expect("serialize request");
    assert_eq!(encoded["futureRequestField"], json!({ "kept": true }));
    assert_eq!(encoded["source"]["futureSourceField"], json!(true));
    assert_eq!(
        encoded["artifacts"][0]["futureArtifactField"],
        json!("preserved")
    );
}

#[test]
fn unsupported_major_versions_are_rejected() {
    let mut value = request_json();
    value["formatVersion"] = json!("2.0");

    assert!(matches!(
        NibRequest::from_value(value),
        Err(ProtocolError::UnsupportedMajor { major: 2 })
    ));
}

#[test]
fn external_assets_are_content_addressed() {
    let request = NibRequest::from_value(request_json()).expect("valid request");
    match &request.artifacts[0].source {
        ArtifactSource::External {
            url,
            sha256,
            byte_length,
            ..
        } => {
            assert_eq!(url, "https://cdn.example.test/walkthrough.mp4");
            assert_eq!(sha256.len(), 64);
            assert_eq!(*byte_length, 2048);
        }
        source => panic!("expected external source, got {source:?}"),
    }
}

#[test]
fn decisions_use_stable_machine_readable_outcomes() {
    assert_eq!(
        serde_json::to_value(DecisionOutcome::ChangesRequested).unwrap(),
        json!("changes_requested")
    );
}

#[test]
fn schema_documents_are_versioned_and_addressable() {
    let schemas = schema_documents();
    let request = schemas
        .get("nib-request.schema.json")
        .expect("request schema");

    assert_eq!(
        request["$id"],
        json!("https://nibtool.com/schemas/v1/nib-request.schema.json")
    );
    assert_eq!(request["title"], json!("NibRequest"));
    assert!(schemas.contains_key("decision.schema.json"));
    assert!(schemas.contains_key("feedback.schema.json"));
    assert!(schemas.contains_key("event.schema.json"));
    assert!(schemas.contains_key("approval-policy.schema.json"));
}

#[test]
fn committed_schema_documents_match_the_rust_source() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schemas/protocol");
    for (file_name, expected) in schema_documents() {
        let actual: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(directory.join(file_name)).expect("committed schema"),
        )
        .expect("valid JSON Schema");
        assert_eq!(actual, expected, "schema drift in {file_name}");
    }
}

#[test]
fn approval_policy_counts_unique_approved_reviewers_on_current_revision() {
    let policy: ApprovalPolicy = serde_json::from_value(json!({
        "type": "all",
        "requirements": [
            { "type": "human", "count": 1 },
            { "type": "agent", "agentType": "security", "verdict": "pass" }
        ]
    }))
    .unwrap();
    let decisions: Vec<Decision> = serde_json::from_value(json!([
        {
            "id": "dec_old",
            "requestId": "req_checkout",
            "requestRevision": 1,
            "outcome": "approved",
            "reviewer": { "id": "old_human", "type": "human" },
            "createdAt": "2026-08-09T15:00:00Z"
        },
        {
            "id": "dec_human",
            "requestId": "req_checkout",
            "requestRevision": 2,
            "outcome": "approved",
            "reviewer": { "id": "alice", "type": "human" },
            "createdAt": "2026-08-09T15:01:00Z"
        },
        {
            "id": "dec_security",
            "requestId": "req_checkout",
            "requestRevision": 2,
            "outcome": "approved",
            "reviewer": {
                "id": "security_agent",
                "type": "agent",
                "agentType": "security",
                "verdict": "pass"
            },
            "createdAt": "2026-08-09T15:02:00Z"
        }
    ]))
    .unwrap();

    let evaluation = evaluate_policy(&policy, &decisions, 2);
    assert!(evaluation.satisfied);
    assert_eq!(
        evaluation.matched_decision_ids,
        vec!["dec_human", "dec_security"]
    );
}
