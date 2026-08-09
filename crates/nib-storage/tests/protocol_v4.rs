use nib_protocol::{Decision, Event, NibRequest};
use nib_storage::NibFile;
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::tempdir;

fn request() -> NibRequest {
    NibRequest::from_value(json!({
        "id": "req_checkout",
        "formatVersion": "1.0",
        "revision": 1,
        "title": "Approve checkout redesign",
        "source": { "type": "agent", "system": "codex" },
        "artifacts": [{
            "id": "walkthrough",
            "type": "video",
            "mimeType": "video/mp4",
            "source": {
                "type": "embedded",
                "path": "artifacts/walkthrough.mp4",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "byteLength": 8
            }
        }],
        "decision": { "type": "approval" },
        "createdAt": "2026-08-09T15:04:00Z"
    }))
    .unwrap()
}

#[test]
fn request_only_nib_stores_protocol_and_raw_media_bytes() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("checkout.nib");
    let request = request();
    let nib = NibFile::create_request(&path, &request).unwrap();

    let video = [0, 0, 0, 4, b'f', b't', b'y', b'p'];
    let hash = format!("{:x}", Sha256::digest(video));
    nib.put_artifact_blob(&hash, "video/mp4", &video).unwrap();

    assert_eq!(
        nib.get_request("req_checkout", 1).unwrap(),
        Some(request.clone())
    );
    assert!(nib.put_request(&request).is_err());
    assert_eq!(nib.get_artifact_blob(&hash).unwrap().unwrap().bytes, video);
}

#[test]
fn decisions_and_events_are_append_only() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("decision.nib");
    let nib = NibFile::create_request(&path, &request()).unwrap();
    let decision: Decision = serde_json::from_value(json!({
        "id": "dec_1",
        "requestId": "req_checkout",
        "requestRevision": 1,
        "outcome": "approved",
        "reviewer": { "id": "usr_1", "type": "human", "name": "Alice" },
        "createdAt": "2026-08-09T15:05:00Z"
    }))
    .unwrap();
    let event: Event = serde_json::from_value(json!({
        "id": "evt_1",
        "type": "decision.approved",
        "requestId": "req_checkout",
        "requestRevision": 1,
        "sequence": 1,
        "timestamp": "2026-08-09T15:05:00Z",
        "data": { "decisionId": "dec_1" }
    }))
    .unwrap();

    nib.append_decision(&decision).unwrap();
    nib.append_event(&event).unwrap();

    assert!(nib.append_decision(&decision).is_err());
    assert!(nib.append_event(&event).is_err());
    assert_eq!(nib.list_decisions("req_checkout").unwrap(), vec![decision]);
    assert_eq!(nib.list_events("req_checkout", 0).unwrap(), vec![event]);
}

#[test]
fn legacy_file_upgrades_only_on_first_protocol_write() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("legacy-v3.nib");
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY)",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO schema_version VALUES (3)", [])
        .unwrap();
    drop(conn);

    let nib = NibFile::open(&path).unwrap();
    let version = || {
        Connection::open(&path)
            .unwrap()
            .query_row("SELECT version FROM schema_version", [], |row| {
                row.get::<_, i32>(0)
            })
            .unwrap()
    };
    assert_eq!(version(), 3);

    nib.put_request(&request()).unwrap();

    assert_eq!(version(), 4);
    assert_eq!(nib.get_request("req_checkout", 1).unwrap(), Some(request()));
}
