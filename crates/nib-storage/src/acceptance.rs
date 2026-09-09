//! Acceptance `.nib` packet storage.
//!
//! Acceptance packets use the `.nib` extension but are not image documents.
//! They carry an immutable acceptance manifest, its canonical hash, append-only
//! decision history, evidence asset hashes, and independent signatures.

use crate::StorageResult;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use nib_core::StorageError;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::TryInto;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ACCEPTANCE_CONTRACT: &str = "nib.acceptance/v1";
pub const ACCEPTANCE_PACKET_KIND: &str = "acceptance";
pub const ACCEPTANCE_RECEIPT_CONTRACT: &str = "nib.acceptance/receipt/v1";
pub const ACCEPTANCE_RECEIPT_ISSUER: &str = "nib.acceptance";
pub const ACCEPTANCE_RECEIPT_AUDIENCE: &str = "nib.acceptance/receipt";

const ACCEPTANCE_SCHEMA_VERSION: i32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceAsset {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceAssetBytes {
    pub sha256: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceDecision {
    pub actor_id: String,
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default)]
    pub criteria_ids: Vec<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceSignature {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    pub jws: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceReviewSnapshot {
    pub captured_at: String,
    pub review: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptancePacket {
    pub path: PathBuf,
    pub kind: String,
    pub contract: String,
    pub project_id: String,
    pub subject: String,
    pub gate: String,
    pub manifest: Value,
    pub manifest_hash: String,
    pub assets: Vec<AcceptanceAsset>,
    pub asset_bytes: Vec<AcceptanceAssetBytes>,
    pub decisions: Vec<AcceptanceDecision>,
    pub signatures: Vec<AcceptanceSignature>,
    pub review_snapshots: Vec<AcceptanceReviewSnapshot>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineVerification {
    pub satisfied: bool,
    pub historical: bool,
    pub current: bool,
    pub reason: String,
    pub manifest_hash: String,
    pub project_id: String,
    pub subject: String,
    pub gate: String,
    pub decisions: usize,
    pub signatures: usize,
}

pub fn create_packet(path: &Path, manifest: &Value) -> StorageResult<AcceptancePacket> {
    if path.exists() {
        return Err(StorageError::InvalidFormat(format!(
            "File already exists: {}",
            path.display()
        )));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    validate_manifest(manifest)?;
    let manifest_hash = manifest_hash(manifest)?;
    let assets = manifest_assets(manifest)?;
    let contract = required_string(manifest, "contract")?.to_string();
    let project_id = required_string(manifest, "projectId")?.to_string();
    let subject = required_string(manifest, "subject")?.to_string();
    let gate = required_string(manifest, "gate")?.to_string();
    let created_at = unix_timestamp().to_string();

    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    conn.execute(
        "INSERT INTO metadata (key, value) VALUES ('document_kind', ?1), ('acceptance_contract', ?2)",
        params![ACCEPTANCE_PACKET_KIND, ACCEPTANCE_CONTRACT],
    )?;
    conn.execute(
        r#"
        INSERT INTO acceptance_packet
            (id, kind, contract, project_id, subject, gate, manifest_json, manifest_hash, canonical_json, created_at)
        VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            ACCEPTANCE_PACKET_KIND,
            contract,
            project_id,
            subject,
            gate,
            serde_json::to_string(manifest).map_err(storage_json_error)?,
            manifest_hash,
            String::from_utf8(canonical_json(manifest)?).map_err(|error| {
                StorageError::InvalidFormat(format!("Canonical JSON was not UTF-8: {error}"))
            })?,
            created_at,
        ],
    )?;
    for asset in &assets {
        conn.execute(
            r#"
            INSERT INTO acceptance_assets (id, kind, label, url, sha256, content_type)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![
                asset.id,
                asset.kind,
                asset.label,
                asset.url,
                asset.sha256,
                asset.content_type
            ],
        )?;
    }

    open_packet(path)
}

pub fn open_packet(path: &Path) -> StorageResult<AcceptancePacket> {
    if !path.exists() {
        return Err(StorageError::NotFound(path.display().to_string()));
    }

    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let (kind, contract, project_id, subject, gate, manifest_json, stored_hash, created_at): (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    ) = conn
        .query_row(
            r#"
            SELECT kind, contract, project_id, subject, gate, manifest_json, manifest_hash, created_at
            FROM acceptance_packet WHERE id = 1
            "#,
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .map_err(|error| {
            StorageError::InvalidFormat(format!(
                "Not an acceptance .nib packet: missing acceptance_packet ({error})"
            ))
        })?;

    if kind != ACCEPTANCE_PACKET_KIND || contract != ACCEPTANCE_CONTRACT {
        return Err(StorageError::InvalidFormat(format!(
            "Unsupported acceptance packet kind '{kind}' and contract '{contract}'"
        )));
    }
    let manifest: Value = serde_json::from_str(&manifest_json).map_err(storage_json_error)?;
    let actual_hash = manifest_hash(&manifest)?;
    if actual_hash != stored_hash {
        return Err(StorageError::InvalidFormat(format!(
            "Acceptance manifest hash mismatch: stored {stored_hash}, actual {actual_hash}"
        )));
    }

    Ok(AcceptancePacket {
        path: path.to_path_buf(),
        kind,
        contract,
        project_id,
        subject,
        gate,
        manifest,
        manifest_hash: stored_hash,
        assets: read_assets(&conn)?,
        asset_bytes: read_asset_bytes(&conn)?,
        decisions: read_decisions(&conn)?,
        signatures: read_signatures(&conn)?,
        review_snapshots: read_review_snapshots(&conn)?,
        created_at,
    })
}

pub fn append_decision(path: &Path, decision: &AcceptanceDecision) -> StorageResult<()> {
    let conn = Connection::open(path)?;
    ensure_acceptance_packet(&conn)?;
    conn.execute(
        r#"
        INSERT INTO acceptance_decisions (actor_id, decision, comment, criteria_ids_json, created_at, receipt_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![
            decision.actor_id,
            decision.decision,
            decision.comment,
            serde_json::to_string(&decision.criteria_ids).map_err(storage_json_error)?,
            decision.created_at,
            decision
                .receipt
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(storage_json_error)?,
        ],
    )?;
    Ok(())
}

pub fn append_signature(path: &Path, signature: &AcceptanceSignature) -> StorageResult<()> {
    let conn = Connection::open(path)?;
    ensure_acceptance_packet(&conn)?;
    conn.execute(
        r#"
        INSERT INTO acceptance_signatures (kind, key_id, jws, created_at)
        VALUES (?1, ?2, ?3, ?4)
        "#,
        params![
            signature.kind,
            signature.key_id,
            signature.jws,
            signature.created_at
        ],
    )?;
    Ok(())
}

pub fn append_review_snapshot(path: &Path, review: &Value) -> StorageResult<()> {
    let conn = Connection::open(path)?;
    ensure_acceptance_packet(&conn)?;
    conn.execute(
        r#"
        INSERT INTO acceptance_review_snapshots (captured_at, review_json)
        VALUES (?1, ?2)
        "#,
        params![
            unix_timestamp().to_string(),
            serde_json::to_string(review).map_err(storage_json_error)?
        ],
    )?;
    Ok(())
}

pub fn append_asset_bytes(
    path: &Path,
    sha256: &str,
    content_type: &str,
    bytes: &[u8],
) -> StorageResult<()> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != sha256 {
        return Err(StorageError::InvalidFormat(format!(
            "Acceptance evidence hash mismatch: expected {sha256}, actual {actual}"
        )));
    }
    let conn = Connection::open(path)?;
    ensure_acceptance_packet(&conn)?;
    conn.execute(
        r#"
        INSERT OR REPLACE INTO acceptance_asset_bytes (sha256, content_type, bytes)
        VALUES (?1, ?2, ?3)
        "#,
        params![sha256, content_type, bytes],
    )?;
    Ok(())
}

pub fn verify_packet_offline(path: &Path) -> StorageResult<OfflineVerification> {
    let packet = open_packet(path)?;
    Ok(unsatisfied_verification(
        &packet,
        "trusted_jwks_required",
        "offline acceptance verification requires trusted JWKS input",
    ))
}

pub fn verify_packet_offline_with_jwks(
    path: &Path,
    jwks_path: &Path,
) -> StorageResult<OfflineVerification> {
    let packet = open_packet(path)?;
    let jwks_text = std::fs::read_to_string(jwks_path)?;
    let jwks: Value = serde_json::from_str(&jwks_text).map_err(storage_json_error)?;
    let keys = trusted_ed25519_keys(&jwks)?;
    let Some(signature) = packet.signatures.iter().find(|signature| {
        signature.kind == "receipt" || signature.kind == ACCEPTANCE_RECEIPT_CONTRACT
    }) else {
        return Ok(unsatisfied_verification(
            &packet,
            "missing_receipt_signature",
            "acceptance packet does not contain a receipt signature",
        ));
    };
    match verify_receipt_jws(&packet, &signature.jws, &keys) {
        Ok(payload) => Ok(OfflineVerification {
            satisfied: true,
            historical: true,
            current: false,
            reason: format!(
                "valid historical acceptance receipt for approved review {}",
                payload
                    .get("reviewId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown-review")
            ),
            manifest_hash: packet.manifest_hash,
            project_id: packet.project_id,
            subject: packet.subject,
            gate: packet.gate,
            decisions: packet.decisions.len(),
            signatures: packet.signatures.len(),
        }),
        Err(error) => Ok(unsatisfied_verification(
            &packet,
            "invalid_receipt_signature",
            &error,
        )),
    }
}

fn unsatisfied_verification(
    packet: &AcceptancePacket,
    code: &str,
    detail: &str,
) -> OfflineVerification {
    OfflineVerification {
        satisfied: false,
        historical: true,
        current: false,
        reason: format!("{code}: {detail}"),
        manifest_hash: packet.manifest_hash.clone(),
        project_id: packet.project_id.clone(),
        subject: packet.subject.clone(),
        gate: packet.gate.clone(),
        decisions: packet.decisions.len(),
        signatures: packet.signatures.len(),
    }
}

fn trusted_ed25519_keys(jwks: &Value) -> StorageResult<Vec<TrustedEd25519Key>> {
    let keys = jwks
        .get("keys")
        .and_then(Value::as_array)
        .ok_or_else(|| StorageError::InvalidFormat("JWKS must contain a keys array".into()))?;
    let mut trusted = Vec::new();
    for key in keys {
        if key.get("kty").and_then(Value::as_str) != Some("OKP")
            || key.get("crv").and_then(Value::as_str) != Some("Ed25519")
        {
            continue;
        }
        if let Some(use_) = key.get("use").and_then(Value::as_str) {
            if use_ != "sig" {
                continue;
            }
        }
        if let Some(alg) = key.get("alg").and_then(Value::as_str) {
            if alg != "EdDSA" {
                continue;
            }
        }
        let x = key.get("x").and_then(Value::as_str).ok_or_else(|| {
            StorageError::InvalidFormat("Ed25519 JWKS keys must include x".into())
        })?;
        let bytes = URL_SAFE_NO_PAD.decode(x).map_err(|error| {
            StorageError::InvalidFormat(format!("Invalid Ed25519 JWKS x value: {error}"))
        })?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
            StorageError::InvalidFormat("Ed25519 JWKS x value must decode to 32 bytes".into())
        })?;
        let verifying_key = VerifyingKey::from_bytes(&bytes).map_err(|error| {
            StorageError::InvalidFormat(format!("Invalid Ed25519 public key: {error}"))
        })?;
        trusted.push(TrustedEd25519Key {
            kid: key.get("kid").and_then(Value::as_str).map(str::to_string),
            verifying_key,
        });
    }
    if trusted.is_empty() {
        return Err(StorageError::InvalidFormat(
            "JWKS did not contain a trusted Ed25519 signing key".into(),
        ));
    }
    Ok(trusted)
}

#[derive(Clone)]
struct TrustedEd25519Key {
    kid: Option<String>,
    verifying_key: VerifyingKey,
}

fn verify_receipt_jws(
    packet: &AcceptancePacket,
    jws: &str,
    keys: &[TrustedEd25519Key],
) -> Result<Value, String> {
    let parts = jws.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("receipt must be a compact JWS with three non-empty parts".into());
    }
    let protected_bytes = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|error| format!("invalid receipt protected header: {error}"))?;
    let protected: Value = serde_json::from_slice(&protected_bytes)
        .map_err(|error| format!("invalid receipt protected header JSON: {error}"))?;
    if protected.get("alg").and_then(Value::as_str) != Some("EdDSA") {
        return Err("receipt alg must be EdDSA".into());
    }
    let kid = protected.get("kid").and_then(Value::as_str);
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|error| format!("invalid receipt signature encoding: {error}"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|error| format!("invalid Ed25519 receipt signature: {error}"))?;
    let candidates = keys
        .iter()
        .filter(|key| kid.is_none() || key.kid.as_deref() == kid)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Err("receipt kid is not present in trusted JWKS".into());
    }
    if !candidates.iter().any(|key| {
        key.verifying_key
            .verify(signing_input.as_bytes(), &signature)
            .is_ok()
    }) {
        return Err("receipt signature did not verify against trusted JWKS".into());
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|error| format!("invalid receipt payload encoding: {error}"))?;
    let payload: Value = serde_json::from_slice(&payload_bytes)
        .map_err(|error| format!("invalid receipt payload JSON: {error}"))?;
    validate_receipt_payload(packet, &payload)?;
    Ok(payload)
}

fn validate_receipt_payload(packet: &AcceptancePacket, payload: &Value) -> Result<(), String> {
    require_payload_string(payload, "iss", ACCEPTANCE_RECEIPT_ISSUER)?;
    require_payload_audience(payload)?;
    require_payload_string(payload, "contract", ACCEPTANCE_RECEIPT_CONTRACT)?;
    require_payload_string(payload, "state", "approved")?;
    require_payload_string(payload, "projectId", &packet.project_id)?;
    require_payload_string(payload, "subject", &packet.subject)?;
    require_payload_string(payload, "gate", &packet.gate)?;
    require_payload_string(payload, "manifestHash", &packet.manifest_hash)?;
    let signed_manifest = payload
        .get("manifest")
        .ok_or_else(|| "receipt payload missing manifest".to_string())?;
    if manifest_hash(signed_manifest).map_err(|error| error.to_string())? != packet.manifest_hash {
        return Err("receipt manifest hash does not match packet manifest".into());
    }
    if canonical_json(signed_manifest).map_err(|error| error.to_string())?
        != canonical_json(&packet.manifest).map_err(|error| error.to_string())?
    {
        return Err("receipt manifest payload does not match packet manifest".into());
    }
    let now = Utc::now().timestamp();
    let iat = required_numeric_date(payload, "iat")?;
    let nbf = required_numeric_date(payload, "nbf")?;
    let exp = required_numeric_date(payload, "exp")?;
    if now < nbf {
        return Err("receipt is not valid yet".into());
    }
    if now >= exp {
        return Err("receipt is expired".into());
    }
    if nbf > iat || iat >= exp {
        return Err("receipt iat/nbf/exp ordering is invalid".into());
    }
    let approved_at = required_datetime_string(payload, "approvedAt")?;
    if approved_at.timestamp() != iat {
        return Err("receipt approvedAt must match JWT iat".into());
    }
    let expires_at = required_datetime_string(payload, "expiresAt")?;
    if expires_at.timestamp() != exp {
        return Err("receipt expiresAt must match JWT exp".into());
    }
    validate_policy_quorum(packet, payload, approved_at)?;
    Ok(())
}

fn require_payload_string(payload: &Value, key: &str, expected: &str) -> Result<(), String> {
    let actual = payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("receipt payload missing {key}"))?;
    if actual != expected {
        return Err(format!(
            "receipt payload {key} mismatch: expected {expected}, actual {actual}"
        ));
    }
    Ok(())
}

fn require_payload_audience(payload: &Value) -> Result<(), String> {
    match payload.get("aud") {
        Some(Value::String(value)) if value == ACCEPTANCE_RECEIPT_AUDIENCE => Ok(()),
        Some(Value::Array(values))
            if values
                .iter()
                .any(|value| value.as_str() == Some(ACCEPTANCE_RECEIPT_AUDIENCE)) =>
        {
            Ok(())
        }
        _ => Err("receipt audience must include nib.acceptance/receipt".into()),
    }
}

fn required_numeric_date(payload: &Value, key: &str) -> Result<i64, String> {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("receipt payload missing numeric {key}"))
}

fn required_datetime_string(payload: &Value, key: &str) -> Result<DateTime<Utc>, String> {
    let value = payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("receipt payload missing {key}"))?;
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc))
        .map_err(|error| format!("receipt payload {key} is not RFC3339: {error}"))
}

fn validate_policy_quorum(
    packet: &AcceptancePacket,
    payload: &Value,
    approved_at: DateTime<Utc>,
) -> Result<(), String> {
    let policy = payload
        .get("policy")
        .and_then(Value::as_object)
        .ok_or_else(|| "receipt payload missing policy".to_string())?;
    let quorum = policy
        .get("quorum")
        .and_then(Value::as_u64)
        .ok_or_else(|| "receipt policy missing quorum".to_string())?;
    if quorum == 0 {
        return Err("receipt policy quorum must be positive".into());
    }
    let ttl_seconds = policy
        .get("ttlSeconds")
        .and_then(Value::as_u64)
        .ok_or_else(|| "receipt policy missing ttlSeconds".to_string())?;
    if ttl_seconds == 0 {
        return Err("receipt policy ttlSeconds must be positive".into());
    }
    let criteria_ids = packet
        .manifest
        .get("criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| "packet manifest missing criteria".to_string())?
        .iter()
        .map(|criterion| {
            criterion
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "packet manifest criterion missing id".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let approvals = payload
        .get("approvals")
        .and_then(Value::as_array)
        .ok_or_else(|| "receipt payload missing approvals".to_string())?;
    let mut sorted = approvals
        .iter()
        .map(|approval| {
            let created_at = approval
                .get("createdAt")
                .and_then(Value::as_str)
                .ok_or_else(|| "receipt approval missing createdAt".to_string())?;
            let created_at = DateTime::parse_from_rfc3339(created_at)
                .map(|date| date.with_timezone(&Utc))
                .map_err(|error| format!("receipt approval createdAt is invalid: {error}"))?;
            let criteria = approval
                .get("criteriaIds")
                .and_then(Value::as_array)
                .ok_or_else(|| "receipt approval missing criteriaIds".to_string())?
                .iter()
                .map(|criterion| {
                    criterion
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "receipt approval criteriaIds must be strings".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok((created_at, criteria))
        })
        .collect::<Result<Vec<_>, String>>()?;
    sorted.sort_by_key(|(created_at, _)| *created_at);
    for (candidate_at, _) in &sorted {
        let mut counts = HashMap::<String, u64>::new();
        for (created_at, criteria) in sorted
            .iter()
            .filter(|(created_at, _)| created_at <= candidate_at)
        {
            let _ = created_at;
            for criterion in criteria {
                *counts.entry(criterion.clone()).or_default() += 1;
            }
        }
        if criteria_ids
            .iter()
            .all(|criterion| counts.get(criterion).copied().unwrap_or(0) >= quorum)
        {
            if *candidate_at != approved_at {
                return Err(
                    "receipt approvedAt does not match quorum-reaching approval time".into(),
                );
            }
            return Ok(());
        }
    }
    Err("receipt approvals do not satisfy policy quorum for every criterion".into())
}

pub fn manifest_hash(manifest: &Value) -> StorageResult<String> {
    Ok(format!("{:x}", Sha256::digest(canonical_json(manifest)?)))
}

pub fn canonical_json(manifest: &Value) -> StorageResult<Vec<u8>> {
    let normalized = canonical_value(manifest)?;
    serde_json::to_vec(&normalized).map_err(storage_json_error)
}

fn init_schema(conn: &Connection) -> StorageResult<()> {
    conn.execute(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY)",
        [],
    )?;
    conn.execute(
        "INSERT INTO schema_version VALUES (?1)",
        params![ACCEPTANCE_SCHEMA_VERSION],
    )?;
    conn.execute_batch(
        r#"
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE acceptance_packet (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            kind TEXT NOT NULL CHECK (kind = 'acceptance'),
            contract TEXT NOT NULL CHECK (contract = 'nib.acceptance/v1'),
            project_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            gate TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            manifest_hash TEXT NOT NULL,
            canonical_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE acceptance_assets (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            label TEXT NOT NULL,
            url TEXT,
            sha256 TEXT NOT NULL,
            content_type TEXT
        );
        CREATE TABLE acceptance_asset_bytes (
            sha256 TEXT PRIMARY KEY,
            content_type TEXT NOT NULL,
            bytes BLOB NOT NULL
        );
        CREATE TABLE acceptance_decisions (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            comment TEXT,
            criteria_ids_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            receipt_json TEXT
        );
        CREATE TABLE acceptance_signatures (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            key_id TEXT,
            jws TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE acceptance_review_snapshots (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            captured_at TEXT NOT NULL,
            review_json TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

fn ensure_acceptance_packet(conn: &Connection) -> StorageResult<()> {
    let kind: String = conn
        .query_row(
            "SELECT kind FROM acceptance_packet WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            StorageError::InvalidFormat(format!(
                "Not an acceptance .nib packet: missing acceptance_packet ({error})"
            ))
        })?;
    if kind != ACCEPTANCE_PACKET_KIND {
        return Err(StorageError::InvalidFormat(format!(
            "Unsupported acceptance packet kind '{kind}'"
        )));
    }
    Ok(())
}

fn read_assets(conn: &Connection) -> StorageResult<Vec<AcceptanceAsset>> {
    let mut statement = conn.prepare(
        "SELECT id, kind, label, url, sha256, content_type FROM acceptance_assets ORDER BY id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(AcceptanceAsset {
            id: row.get(0)?,
            kind: row.get(1)?,
            label: row.get(2)?,
            url: row.get(3)?,
            sha256: row.get(4)?,
            content_type: row.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn read_asset_bytes(conn: &Connection) -> StorageResult<Vec<AcceptanceAssetBytes>> {
    let mut statement = conn.prepare(
        "SELECT sha256, content_type, bytes FROM acceptance_asset_bytes ORDER BY sha256",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(AcceptanceAssetBytes {
            sha256: row.get(0)?,
            content_type: row.get(1)?,
            bytes: row.get(2)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn read_decisions(conn: &Connection) -> StorageResult<Vec<AcceptanceDecision>> {
    let mut statement = conn.prepare(
        r#"
        SELECT actor_id, decision, comment, criteria_ids_json, created_at, receipt_json
        FROM acceptance_decisions ORDER BY sequence
        "#,
    )?;
    let rows = statement.query_map([], |row| {
        let criteria_json: String = row.get(3)?;
        let receipt_json: Option<String> = row.get(5)?;
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            criteria_json,
            row.get::<_, String>(4)?,
            receipt_json,
        ))
    })?;
    let mut decisions = Vec::new();
    for row in rows {
        let (actor_id, decision, comment, criteria_json, created_at, receipt_json) = row?;
        decisions.push(AcceptanceDecision {
            actor_id,
            decision,
            comment,
            criteria_ids: serde_json::from_str(&criteria_json).map_err(storage_json_error)?,
            created_at,
            receipt: receipt_json
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(storage_json_error)?,
        });
    }
    Ok(decisions)
}

fn read_signatures(conn: &Connection) -> StorageResult<Vec<AcceptanceSignature>> {
    let mut statement = conn.prepare(
        "SELECT kind, key_id, jws, created_at FROM acceptance_signatures ORDER BY sequence",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(AcceptanceSignature {
            kind: row.get(0)?,
            key_id: row.get(1)?,
            jws: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn read_review_snapshots(conn: &Connection) -> StorageResult<Vec<AcceptanceReviewSnapshot>> {
    let mut statement = conn.prepare(
        "SELECT captured_at, review_json FROM acceptance_review_snapshots ORDER BY sequence",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut snapshots = Vec::new();
    for row in rows {
        let (captured_at, review_json) = row?;
        snapshots.push(AcceptanceReviewSnapshot {
            captured_at,
            review: serde_json::from_str(&review_json).map_err(storage_json_error)?,
        });
    }
    Ok(snapshots)
}

fn validate_manifest(manifest: &Value) -> StorageResult<()> {
    if required_string(manifest, "contract")? != ACCEPTANCE_CONTRACT {
        return Err(StorageError::InvalidFormat(format!(
            "Acceptance manifest contract must be {ACCEPTANCE_CONTRACT}"
        )));
    }
    for key in ["projectId", "subject", "gate", "title", "request", "change"] {
        required_string(manifest, key)?;
    }
    required_array(manifest, "criteria")?;
    required_array(manifest, "evidence")?;
    let build = manifest
        .get("build")
        .and_then(Value::as_object)
        .ok_or_else(|| StorageError::InvalidFormat("Acceptance manifest missing build".into()))?;
    for key in ["commit", "provider", "previewUrl"] {
        non_empty_object_string(build, key)?;
    }
    if !build.contains_key("deployment") {
        return Err(StorageError::InvalidFormat(
            "Acceptance manifest missing build.deployment".into(),
        ));
    }
    Ok(())
}

fn manifest_assets(manifest: &Value) -> StorageResult<Vec<AcceptanceAsset>> {
    let evidence = required_array(manifest, "evidence")?;
    let mut assets = Vec::new();
    for item in evidence {
        let object = item.as_object().ok_or_else(|| {
            StorageError::InvalidFormat(
                "Acceptance manifest evidence entries must be objects".into(),
            )
        })?;
        let sha256 = object
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|value| is_sha256(value))
            .ok_or_else(|| {
                StorageError::InvalidFormat(
                    "Acceptance manifest evidence entries must include sha256".into(),
                )
            })?;
        assets.push(AcceptanceAsset {
            id: non_empty_object_string(object, "id")?.to_string(),
            kind: non_empty_object_string(object, "kind")?.to_string(),
            label: non_empty_object_string(object, "label")?.to_string(),
            url: object
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string),
            sha256: sha256.to_string(),
            content_type: object
                .get("contentType")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    Ok(assets)
}

fn canonical_value(value: &Value) -> StorageResult<Value> {
    match value {
        Value::Object(object) => {
            let mut normalized = Map::new();
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                normalized.insert(key.clone(), canonical_value(&object[key])?);
            }
            Ok(Value::Object(normalized))
        }
        Value::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(canonical_value)
                .collect::<StorageResult<Vec<_>>>()?,
        )),
        Value::Number(number) if !number.is_i64() && !number.is_u64() && !number.is_f64() => {
            Err(StorageError::InvalidFormat(format!(
                "Unsupported JSON number in acceptance manifest: {number}"
            )))
        }
        value => Ok(value.clone()),
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> StorageResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            StorageError::InvalidFormat(format!("Acceptance manifest missing non-empty {key}"))
        })
}

fn required_array<'a>(value: &'a Value, key: &str) -> StorageResult<&'a Vec<Value>> {
    value.get(key).and_then(Value::as_array).ok_or_else(|| {
        StorageError::InvalidFormat(format!("Acceptance manifest missing array {key}"))
    })
}

fn non_empty_object_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> StorageResult<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            StorageError::InvalidFormat(format!("Acceptance manifest missing non-empty {key}"))
        })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn storage_json_error(error: serde_json::Error) -> StorageError {
    StorageError::InvalidFormat(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn canonical_manifest_hash_is_order_independent() {
        let first = json!({
            "contract":"nib.acceptance/v1",
            "projectId":"project-1",
            "subject":"checkout",
            "gate":"ship",
            "title":"Ship checkout",
            "request":"Can this ship?",
            "change":"Checkout flow",
            "criteria":[{"id":"c1","text":"Flow passes"}],
            "build":{"provider":"cloudflare","commit":"abc","previewUrl":"https://example.com","deployment":{"id":"dep","components":[]}},
            "evidence":[{"id":"e1","kind":"test","label":"cargo test","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]
        });
        let second = json!({
            "evidence":[{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","label":"cargo test","kind":"test","id":"e1"}],
            "build":{"deployment":{"components":[],"id":"dep"},"previewUrl":"https://example.com","commit":"abc","provider":"cloudflare"},
            "criteria":[{"text":"Flow passes","id":"c1"}],
            "change":"Checkout flow",
            "request":"Can this ship?",
            "title":"Ship checkout",
            "gate":"ship",
            "subject":"checkout",
            "projectId":"project-1",
            "contract":"nib.acceptance/v1"
        });

        assert_eq!(
            manifest_hash(&first).unwrap(),
            manifest_hash(&second).unwrap()
        );
        assert_eq!(
            String::from_utf8(canonical_json(&first).unwrap()).unwrap(),
            String::from_utf8(canonical_json(&second).unwrap()).unwrap()
        );
    }

    #[test]
    fn packet_has_acceptance_kind_without_fabricated_image() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("acceptance.nib");
        let manifest = sample_manifest();

        let packet = create_packet(&path, &manifest).unwrap();

        assert_eq!(packet.kind, "acceptance");
        assert_eq!(packet.project_id, "project-1");
        assert_eq!(
            packet.assets[0].sha256,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );

        let conn = Connection::open(&path).unwrap();
        let has_image: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='image'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !has_image,
            "acceptance packets must not fabricate image rows"
        );
    }

    #[test]
    fn decisions_and_signatures_append_without_changing_manifest_hash() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("history.nib");
        let original = create_packet(&path, &sample_manifest()).unwrap();

        append_decision(
            &path,
            &AcceptanceDecision {
                actor_id: "acct-1".into(),
                decision: "approve".into(),
                comment: Some("Looks good".into()),
                criteria_ids: vec!["c1".into()],
                created_at: "2026-09-09T00:00:00Z".into(),
                receipt: Some(json!({"jws":"receipt"})),
            },
        )
        .unwrap();
        append_signature(
            &path,
            &AcceptanceSignature {
                kind: "receipt".into(),
                key_id: Some("key-1".into()),
                jws: "signed".into(),
                created_at: "2026-09-09T00:00:01Z".into(),
            },
        )
        .unwrap();

        let packet = open_packet(&path).unwrap();
        assert_eq!(packet.manifest_hash, original.manifest_hash);
        assert_eq!(packet.decisions.len(), 1);
        assert_eq!(packet.signatures.len(), 1);
        assert_eq!(packet.decisions[0].criteria_ids, vec!["c1"]);
    }

    #[test]
    fn asset_bytes_are_stored_separately_and_hash_checked() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("assets.nib");
        create_packet(&path, &sample_manifest()).unwrap();
        let bytes = b"test output";
        let hash = format!("{:x}", Sha256::digest(bytes));

        append_asset_bytes(&path, &hash, "text/plain", bytes).unwrap();

        let packet = open_packet(&path).unwrap();
        assert_eq!(packet.asset_bytes.len(), 1);
        assert_eq!(packet.asset_bytes[0].bytes, bytes);
        assert!(append_asset_bytes(
            &path,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "text/plain",
            bytes
        )
        .unwrap_err()
        .to_string()
        .contains("hash mismatch"));
    }

    #[test]
    fn offline_verification_requires_trusted_jwks() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("offline.nib");
        create_packet(&path, &sample_manifest()).unwrap();

        let verification = verify_packet_offline(&path).unwrap();

        assert!(!verification.satisfied);
        assert!(verification.historical);
        assert!(!verification.current);
        assert!(verification.reason.contains("trusted_jwks_required"));
    }

    #[test]
    fn offline_verification_fails_without_receipt_signature() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("unsigned.nib");
        let jwks = temp_dir.path().join("trusted.jwks.json");
        std::fs::write(
            &jwks,
            include_str!("../tests/fixtures/acceptance_ed25519.jwks.json"),
        )
        .unwrap();
        create_packet(&path, &sample_manifest()).unwrap();

        let verification = verify_packet_offline_with_jwks(&path, &jwks).unwrap();

        assert!(!verification.satisfied);
        assert!(verification.reason.contains("missing_receipt_signature"));
    }

    #[test]
    fn offline_verification_accepts_trusted_ed25519_receipt() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("signed.nib");
        let jwks = temp_dir.path().join("trusted.jwks.json");
        std::fs::write(
            &jwks,
            include_str!("../tests/fixtures/acceptance_ed25519.jwks.json"),
        )
        .unwrap();
        create_packet(&path, &sample_manifest()).unwrap();
        append_signature(
            &path,
            &receipt_signature(include_str!(
                "../tests/fixtures/acceptance_ed25519.receipt.jwt"
            )),
        )
        .unwrap();

        let verification = verify_packet_offline_with_jwks(&path, &jwks).unwrap();

        assert!(verification.satisfied, "{}", verification.reason);
        assert!(verification.historical);
        assert!(!verification.current);
        assert!(verification.reason.contains("approved review review-1"));
    }

    #[test]
    fn offline_verification_rejects_tampered_receipt() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("tampered.nib");
        let jwks = temp_dir.path().join("trusted.jwks.json");
        std::fs::write(
            &jwks,
            include_str!("../tests/fixtures/acceptance_ed25519.jwks.json"),
        )
        .unwrap();
        create_packet(&path, &sample_manifest()).unwrap();
        let mut token = include_str!("../tests/fixtures/acceptance_ed25519.receipt.jwt")
            .trim()
            .to_string();
        token.pop();
        token.push('A');
        append_signature(&path, &receipt_signature(&token)).unwrap();

        let verification = verify_packet_offline_with_jwks(&path, &jwks).unwrap();

        assert!(!verification.satisfied);
        assert!(verification.reason.contains("signature"));
    }

    #[test]
    fn offline_verification_rejects_expired_receipt() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("expired.nib");
        let jwks = temp_dir.path().join("trusted.jwks.json");
        std::fs::write(
            &jwks,
            include_str!("../tests/fixtures/acceptance_ed25519.jwks.json"),
        )
        .unwrap();
        create_packet(&path, &sample_manifest()).unwrap();
        append_signature(
            &path,
            &receipt_signature(include_str!(
                "../tests/fixtures/acceptance_ed25519_expired.receipt.jwt"
            )),
        )
        .unwrap();

        let verification = verify_packet_offline_with_jwks(&path, &jwks).unwrap();

        assert!(!verification.satisfied);
        assert!(verification.reason.contains("expired"));
    }

    #[test]
    fn rust_hash_matches_cross_language_acceptance_fixture() {
        assert_eq!(
            manifest_hash(&sample_manifest()).unwrap(),
            include_str!("../tests/fixtures/acceptance_manifest.sha256").trim()
        );
        assert_eq!(
            String::from_utf8(canonical_json(&sample_manifest()).unwrap()).unwrap(),
            include_str!("../tests/fixtures/acceptance_manifest.canonical.json").trim()
        );
    }

    #[test]
    fn rust_hash_matches_cross_language_unknown_numeric_unicode_fixture() {
        let value: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/acceptance_canonical_probe.json"
        ))
        .unwrap();
        assert_eq!(
            manifest_hash(&value).unwrap(),
            include_str!("../tests/fixtures/acceptance_canonical_probe.sha256").trim()
        );
        assert_eq!(
            String::from_utf8(canonical_json(&value).unwrap()).unwrap(),
            include_str!("../tests/fixtures/acceptance_canonical_probe.canonical.json").trim()
        );
    }

    fn receipt_signature(jws: &str) -> AcceptanceSignature {
        AcceptanceSignature {
            kind: "receipt".into(),
            key_id: Some("rust-ed25519-test-key".into()),
            jws: jws.trim().into(),
            created_at: "2026-09-09T00:00:05.000Z".into(),
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
            "criteria":[{"id":"c1","text":"Flow passes","verification":"cargo test"}],
            "build":{"repository":{"id":"repo-1","owner":"doug","name":"nib"},"commit":"abc","provider":"cloudflare","previewUrl":"https://example.com","deployment":{"id":"dep","components":[{"name":"worker","versionId":"v1"}]},"assumptions":[]},
            "evidence":[{"id":"e1","kind":"test","label":"cargo test","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contentType":"text/plain"}]
        })
    }
}
