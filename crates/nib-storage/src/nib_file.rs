//! .nib SQLite file format implementation
//!
//! A .nib file is a self-contained SQLite database containing:
//! - Source image data (BLOB)
//! - Annotations (with type-specific JSON data)
//! - OCR cache, grid cache, render cache
//! - Session metadata for CLI/GUI coordination
//!
//! This format enables visual communication between humans (GUI) and LLM agents (CLI).

use crate::StorageResult;
use nib_core::{
    Annotation, AnnotationId, AnnotationType, ArrowHead, AssetData, BlurIntensity, Color, Point,
    Region, Severity, StorageError, StrokeStyle, TextAlign,
};
use nib_protocol::{ArtifactSource, Decision, Event, Feedback, NibRequest};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Current schema version - increment when schema changes
/// v2: added the `assets` table (out-of-band bytes for Image annotations)
/// v3: added annotation groups
/// v4: added portable requests, general artifact blobs, decisions, feedback, and events
const CURRENT_SCHEMA_VERSION: i32 = 4;

const PROTOCOL_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS protocol_documents (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, id, revision)
);

CREATE TABLE IF NOT EXISTS artifact_blobs (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
    mime_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    bytes BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (length(bytes) = byte_length)
);

CREATE TABLE IF NOT EXISTS protocol_artifacts (
    request_id TEXT NOT NULL,
    request_revision INTEGER NOT NULL,
    artifact_id TEXT NOT NULL,
    type TEXT NOT NULL,
    mime_type TEXT,
    source_type TEXT NOT NULL,
    source_url TEXT,
    source_path TEXT,
    blob_sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (request_id, request_revision, artifact_id)
);

CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    request_revision INTEGER NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_request
    ON decisions(request_id, request_revision, created_at);

CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    request_revision INTEGER NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_request
    ON feedback(request_id, request_revision, created_at);

CREATE TABLE IF NOT EXISTS protocol_events (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    request_revision INTEGER NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    type TEXT NOT NULL,
    json TEXT NOT NULL,
    prev_hash TEXT,
    hash TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (request_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_protocol_events_request
    ON protocol_events(request_id, sequence);
"#;

/// Image metadata returned alongside image data
#[derive(Debug, Clone)]
pub struct ImageInfo {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub imported_at: SystemTime,
    pub original_path: Option<String>,
}

/// A cached OCR result entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrCacheEntry {
    pub text: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub confidence: f64,
}

/// Raw content-addressed bytes stored without media recompression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolBlob {
    pub sha256: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub bytes: Vec<u8>,
}

/// A .nib file handle
pub struct NibFile {
    conn: Connection,
    path: std::path::PathBuf,
}

impl NibFile {
    /// Create a request-only .nib file without requiring a source image.
    pub fn create_request(path: &Path, request: &NibRequest) -> StorageResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if path.exists() {
            return Err(StorageError::InvalidFormat(format!(
                "File already exists: {}",
                path.display()
            )));
        }

        let conn = Connection::open(path)?;
        let nib_file = Self {
            conn,
            path: path.to_path_buf(),
        };
        nib_file.init_schema()?;
        nib_file.set_pragmas()?;
        nib_file.put_request(request)?;
        Ok(nib_file)
    }

    /// Create a new .nib file with the given image data
    ///
    /// # Arguments
    /// * `path` - Path to create the .nib file at
    /// * `image_data` - Raw image bytes (PNG, JPEG, or WebP)
    /// * `format` - Image format string ("png", "jpg", "webp")
    /// * `width` - Image width in pixels
    /// * `height` - Image height in pixels
    pub fn create(
        path: &Path,
        image_data: &[u8],
        format: &str,
        width: u32,
        height: u32,
    ) -> StorageResult<Self> {
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Create new database (fail if exists)
        if path.exists() {
            return Err(StorageError::InvalidFormat(format!(
                "File already exists: {}",
                path.display()
            )));
        }

        let conn = Connection::open(path)?;
        let nib_file = Self {
            conn,
            path: path.to_path_buf(),
        };

        nib_file.init_schema()?;
        nib_file.set_pragmas()?;

        // Insert the image
        let now = system_time_to_unix(SystemTime::now());
        nib_file.conn.execute(
            r#"
            INSERT INTO image (id, data, format, width, height, imported_at)
            VALUES (1, ?1, ?2, ?3, ?4, ?5)
            "#,
            params![image_data, format, width, height, now],
        )?;

        Ok(nib_file)
    }

    /// Open an existing .nib file
    pub fn open(path: &Path) -> StorageResult<Self> {
        if !path.exists() {
            return Err(StorageError::NotFound(path.display().to_string()));
        }

        let conn = Connection::open(path)?;
        let nib_file = Self {
            conn,
            path: path.to_path_buf(),
        };

        nib_file.set_pragmas()?;
        nib_file.validate_schema()?;
        nib_file.migrate()?;

        Ok(nib_file)
    }

    /// Flush any pending changes to disk
    ///
    /// With WAL mode, most writes are already durable. This performs a checkpoint.
    pub fn save(&self) -> StorageResult<()> {
        self.conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(())
    }

    /// Get the image data and metadata
    pub fn get_image(&self) -> StorageResult<(Vec<u8>, ImageInfo)> {
        let row = self.conn.query_row(
            "SELECT data, format, width, height, imported_at, original_path FROM image WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )?;

        let info = ImageInfo {
            format: row.1,
            width: row.2,
            height: row.3,
            imported_at: unix_to_system_time(row.4),
            original_path: row.5,
        };

        Ok((row.0, info))
    }

    /// Store one immutable request revision and its artifact index.
    pub fn put_request(&self, request: &NibRequest) -> StorageResult<()> {
        request
            .validate()
            .map_err(|error| StorageError::InvalidFormat(error.to_string()))?;
        self.ensure_protocol_schema()?;

        let json = serde_json::to_string(request)
            .map_err(|error| StorageError::InvalidFormat(error.to_string()))?;
        let now = system_time_to_unix(SystemTime::now());
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> StorageResult<()> {
            self.conn.execute(
                "INSERT INTO protocol_documents (kind, id, revision, json, created_at) VALUES ('request', ?1, ?2, ?3, ?4)",
                params![request.id, request.revision, json, now],
            )?;
            self.conn.execute(
                "DELETE FROM protocol_artifacts WHERE request_id = ?1 AND request_revision = ?2",
                params![request.id, request.revision],
            )?;
            for artifact in &request.artifacts {
                let (source_type, source_url, source_path, sha256, byte_length) =
                    match &artifact.source {
                        ArtifactSource::Embedded {
                            path,
                            sha256,
                            byte_length,
                            ..
                        } => ("embedded", None, Some(path.as_str()), sha256, *byte_length),
                        ArtifactSource::External {
                            url,
                            sha256,
                            byte_length,
                            ..
                        } => ("external", Some(url.as_str()), None, sha256, *byte_length),
                    };
                let metadata = serde_json::to_string(&artifact.metadata)
                    .map_err(|error| StorageError::InvalidFormat(error.to_string()))?;
                self.conn.execute(
                    r#"INSERT INTO protocol_artifacts
                       (request_id, request_revision, artifact_id, type, mime_type, source_type,
                        source_url, source_path, blob_sha256, byte_length, metadata_json)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"#,
                    params![
                        request.id,
                        request.revision,
                        artifact.id,
                        artifact.artifact_type,
                        artifact.mime_type,
                        source_type,
                        source_url,
                        source_path,
                        sha256,
                        byte_length,
                        metadata,
                    ],
                )?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => self.conn.execute_batch("COMMIT")?,
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
        Ok(())
    }

    /// Load one request revision. Reading an old file does not migrate it.
    pub fn get_request(&self, id: &str, revision: u64) -> StorageResult<Option<NibRequest>> {
        if !self.has_table("protocol_documents") {
            return Ok(None);
        }
        let json = self
            .conn
            .query_row(
                "SELECT json FROM protocol_documents WHERE kind = 'request' AND id = ?1 AND revision = ?2",
                params![id, revision],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        json.map(|document| {
            serde_json::from_str(&document)
                .map_err(|error| StorageError::InvalidFormat(error.to_string()))
        })
        .transpose()
    }

    /// Store raw artifact bytes after verifying their SHA-256 digest.
    pub fn put_artifact_blob(
        &self,
        sha256: &str,
        mime_type: &str,
        bytes: &[u8],
    ) -> StorageResult<()> {
        let actual = format!("{:x}", Sha256::digest(bytes));
        if actual != sha256 {
            return Err(StorageError::InvalidFormat(format!(
                "artifact hash mismatch: expected {sha256}, got {actual}"
            )));
        }
        self.ensure_protocol_schema()?;
        self.conn.execute(
            "INSERT OR IGNORE INTO artifact_blobs (sha256, mime_type, byte_length, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![sha256, mime_type, bytes.len() as u64, bytes, system_time_to_unix(SystemTime::now())],
        )?;
        Ok(())
    }

    /// Load raw artifact bytes by content hash.
    pub fn get_artifact_blob(&self, sha256: &str) -> StorageResult<Option<ProtocolBlob>> {
        if !self.has_table("artifact_blobs") {
            return Ok(None);
        }
        self.conn
            .query_row(
                "SELECT sha256, mime_type, byte_length, bytes FROM artifact_blobs WHERE sha256 = ?1",
                params![sha256],
                |row| {
                    Ok(ProtocolBlob {
                        sha256: row.get(0)?,
                        mime_type: row.get(1)?,
                        byte_length: row.get(2)?,
                        bytes: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn append_decision(&self, decision: &Decision) -> StorageResult<()> {
        self.ensure_protocol_schema()?;
        let json = serde_json::to_string(decision)
            .map_err(|error| StorageError::InvalidFormat(error.to_string()))?;
        self.conn.execute(
            "INSERT INTO decisions (id, request_id, request_revision, json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![decision.id, decision.request_id, decision.request_revision, json, decision.created_at],
        )?;
        Ok(())
    }

    pub fn list_decisions(&self, request_id: &str) -> StorageResult<Vec<Decision>> {
        self.read_protocol_rows(
            "decisions",
            "SELECT json FROM decisions WHERE request_id = ?1 ORDER BY created_at, id",
            request_id,
        )
    }

    pub fn append_feedback(&self, feedback: &Feedback) -> StorageResult<()> {
        self.ensure_protocol_schema()?;
        let json = serde_json::to_string(feedback)
            .map_err(|error| StorageError::InvalidFormat(error.to_string()))?;
        self.conn.execute(
            "INSERT INTO feedback (id, request_id, request_revision, json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![feedback.id, feedback.request_id, feedback.request_revision, json, feedback.created_at],
        )?;
        Ok(())
    }

    pub fn list_feedback(&self, request_id: &str) -> StorageResult<Vec<Feedback>> {
        self.read_protocol_rows(
            "feedback",
            "SELECT json FROM feedback WHERE request_id = ?1 ORDER BY created_at, id",
            request_id,
        )
    }

    pub fn append_event(&self, event: &Event) -> StorageResult<()> {
        self.ensure_protocol_schema()?;
        let json = serde_json::to_string(event)
            .map_err(|error| StorageError::InvalidFormat(error.to_string()))?;
        self.conn.execute(
            r#"INSERT INTO protocol_events
               (id, request_id, request_revision, sequence, type, json, prev_hash, hash, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            params![
                event.id,
                event.request_id,
                event.request_revision,
                event.sequence,
                event.event_type,
                json,
                event.prev_hash,
                event.hash,
                event.timestamp,
            ],
        )?;
        Ok(())
    }

    pub fn list_events(&self, request_id: &str, after: u64) -> StorageResult<Vec<Event>> {
        if !self.has_table("protocol_events") {
            return Ok(Vec::new());
        }
        let mut statement = self.conn.prepare(
            "SELECT json FROM protocol_events WHERE request_id = ?1 AND sequence > ?2 ORDER BY sequence",
        )?;
        let documents = statement
            .query_map(params![request_id, after], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        documents
            .into_iter()
            .map(|document| {
                serde_json::from_str(&document)
                    .map_err(|error| StorageError::InvalidFormat(error.to_string()))
            })
            .collect()
    }

    /// Add an annotation and return its ID (e.g., "a1", "a2")
    pub fn add_annotation(&self, annotation: &Annotation) -> StorageResult<String> {
        // Get next annotation number
        let max_num: Option<i64> = self
            .conn
            .query_row(
                "SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) FROM annotations",
                [],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let next_num = max_num.unwrap_or(0) + 1;
        let id = format!("a{}", next_num);

        let type_name = annotation.annotation_type.type_name();
        let data_json = serialize_annotation_data(&annotation.annotation_type)?;
        let color_hex = color_to_hex(&annotation.color);
        let source = "human"; // Default source; could be parameterized
        let z_index = annotation.z_index;
        let visible = annotation.visible as i32;
        let locked = annotation.locked as i32;
        let group_id = annotation.group_id.map(|g| g as i64);
        let created_at = system_time_to_unix(annotation.created_at);
        let modified_at = system_time_to_unix(annotation.modified_at);

        self.conn.execute(
            r#"
            INSERT INTO annotations (id, type, data, color, source, z_index, visible, locked, group_id, created_at, modified_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
            params![id, type_name, data_json, color_hex, source, z_index, visible, locked, group_id, created_at, modified_at],
        )?;

        Ok(id)
    }

    /// Get a single annotation by ID
    pub fn get_annotation(&self, id: &str) -> StorageResult<Option<Annotation>> {
        let result = self
            .conn
            .query_row(
                r#"
            SELECT id, type, data, color, source, z_index, visible, locked, created_at, modified_at, group_id
            FROM annotations
            WHERE id = ?1
            "#,
                params![id],
                |row| {
                    Ok(AnnotationRow {
                        id: row.get(0)?,
                        annotation_type: row.get(1)?,
                        data: row.get(2)?,
                        color: row.get(3)?,
                        source: row.get(4)?,
                        z_index: row.get(5)?,
                        visible: row.get(6)?,
                        locked: row.get(7)?,
                        created_at: row.get(8)?,
                        modified_at: row.get(9)?,
                        group_id: row.get(10)?,
                    })
                },
            )
            .optional()?;

        match result {
            Some(row) => Ok(Some(row_to_annotation(row)?)),
            None => Ok(None),
        }
    }

    /// List all annotations
    pub fn list_annotations(&self) -> StorageResult<Vec<Annotation>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, type, data, color, source, z_index, visible, locked, created_at, modified_at, group_id
            FROM annotations
            ORDER BY z_index ASC, created_at ASC
            "#,
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(AnnotationRow {
                id: row.get(0)?,
                annotation_type: row.get(1)?,
                data: row.get(2)?,
                color: row.get(3)?,
                source: row.get(4)?,
                z_index: row.get(5)?,
                visible: row.get(6)?,
                locked: row.get(7)?,
                created_at: row.get(8)?,
                modified_at: row.get(9)?,
                group_id: row.get(10)?,
            })
        })?;

        let mut annotations = Vec::new();
        for row_result in rows {
            let row = row_result?;
            annotations.push(row_to_annotation(row)?);
        }

        Ok(annotations)
    }

    /// List annotations modified after the given Unix timestamp
    ///
    /// Used for watching file changes in real-time sync.
    pub fn list_annotations_since(&self, since_unix: i64) -> StorageResult<Vec<Annotation>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT id, type, data, color, source, z_index, visible, locked, created_at, modified_at, group_id
            FROM annotations
            WHERE modified_at > ?1
            ORDER BY modified_at ASC
            "#,
        )?;

        let rows = stmt.query_map(params![since_unix], |row| {
            Ok(AnnotationRow {
                id: row.get(0)?,
                annotation_type: row.get(1)?,
                data: row.get(2)?,
                color: row.get(3)?,
                source: row.get(4)?,
                z_index: row.get(5)?,
                visible: row.get(6)?,
                locked: row.get(7)?,
                created_at: row.get(8)?,
                modified_at: row.get(9)?,
                group_id: row.get(10)?,
            })
        })?;

        let mut annotations = Vec::new();
        for row_result in rows {
            let row = row_result?;
            annotations.push(row_to_annotation(row)?);
        }

        Ok(annotations)
    }

    /// Get the latest modification timestamp across all annotations
    pub fn latest_annotation_modified_at(&self) -> StorageResult<Option<i64>> {
        let result: Option<i64> = self
            .conn
            .query_row("SELECT MAX(modified_at) FROM annotations", [], |row| {
                row.get(0)
            })
            .optional()?
            .flatten();
        Ok(result)
    }

    /// Get session info
    pub fn get_session(&self) -> StorageResult<Option<(Option<u32>, i64, i64)>> {
        let result = self
            .conn
            .query_row(
                "SELECT gui_pid, opened_at, last_activity FROM session WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        Ok(result)
    }

    /// Update an existing annotation
    pub fn update_annotation(&self, id: &str, annotation: &Annotation) -> StorageResult<()> {
        let type_name = annotation.annotation_type.type_name();
        let data_json = serialize_annotation_data(&annotation.annotation_type)?;
        let color_hex = color_to_hex(&annotation.color);
        let z_index = annotation.z_index;
        let visible = annotation.visible as i32;
        let locked = annotation.locked as i32;
        let group_id = annotation.group_id.map(|g| g as i64);
        let modified_at = system_time_to_unix(SystemTime::now());

        let rows_affected = self.conn.execute(
            r#"
            UPDATE annotations
            SET type = ?1, data = ?2, color = ?3, z_index = ?4, visible = ?5, locked = ?6, group_id = ?7, modified_at = ?8
            WHERE id = ?9
            "#,
            params![type_name, data_json, color_hex, z_index, visible, locked, group_id, modified_at, id],
        )?;

        if rows_affected == 0 {
            return Err(StorageError::NotFound(format!("Annotation {}", id)));
        }

        Ok(())
    }

    /// Delete an annotation by ID
    ///
    /// Returns true if the annotation was deleted, false if it didn't exist
    pub fn delete_annotation(&self, id: &str) -> StorageResult<bool> {
        let rows_affected = self
            .conn
            .execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
        Ok(rows_affected > 0)
    }

    /// Get annotation count
    pub fn annotation_count(&self) -> StorageResult<usize> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM annotations", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    /// Set the original path metadata
    pub fn set_original_path(&self, path: &str) -> StorageResult<()> {
        self.conn.execute(
            "UPDATE image SET original_path = ?1 WHERE id = 1",
            params![path],
        )?;
        Ok(())
    }

    /// Get a metadata value by key
    pub fn get_metadata(&self, key: &str) -> StorageResult<Option<String>> {
        let result = self
            .conn
            .query_row(
                "SELECT value FROM metadata WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(result)
    }

    /// Set a metadata value
    pub fn set_metadata(&self, key: &str, value: &str) -> StorageResult<()> {
        self.conn.execute(
            r#"
            INSERT INTO metadata (key, value) VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            "#,
            params![key, value],
        )?;
        Ok(())
    }

    /// Update session information (for GUI/CLI coordination)
    pub fn update_session(&self, gui_pid: Option<u32>) -> StorageResult<()> {
        let now = system_time_to_unix(SystemTime::now());

        self.conn.execute(
            r#"
            INSERT INTO session (id, gui_pid, opened_at, last_activity)
            VALUES (1, ?1, ?2, ?2)
            ON CONFLICT(id) DO UPDATE SET
                gui_pid = excluded.gui_pid,
                last_activity = excluded.last_activity
            "#,
            params![gui_pid, now],
        )?;
        Ok(())
    }

    /// Clear session (GUI closed)
    pub fn clear_session(&self) -> StorageResult<()> {
        self.conn.execute("DELETE FROM session WHERE id = 1", [])?;
        Ok(())
    }

    /// Check if GUI has this file open
    pub fn is_gui_open(&self) -> StorageResult<bool> {
        let result: Option<i64> = self
            .conn
            .query_row("SELECT gui_pid FROM session WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(result.is_some())
    }

    /// Get the file path
    pub fn path(&self) -> &Path {
        &self.path
    }

    // --- OCR Cache Methods ---

    /// Cache OCR results for a region (None = full image)
    pub fn cache_ocr(&self, region: Option<&str>, entries: &[OcrCacheEntry]) -> StorageResult<()> {
        // Clear existing cache for this region first
        self.clear_ocr_cache(region)?;

        let now = system_time_to_unix(SystemTime::now());

        for entry in entries {
            let bounds_json = serde_json::json!({
                "x": entry.x,
                "y": entry.y,
                "width": entry.width,
                "height": entry.height
            });

            self.conn.execute(
                r#"
                INSERT INTO ocr_cache (region, text, bounds, confidence, engine, cached_at)
                VALUES (?1, ?2, ?3, ?4, 'ocrs', ?5)
                "#,
                params![
                    region,
                    entry.text,
                    bounds_json.to_string(),
                    entry.confidence,
                    now
                ],
            )?;
        }

        Ok(())
    }

    /// Get cached OCR results for a region
    pub fn get_cached_ocr(
        &self,
        region: Option<&str>,
    ) -> StorageResult<Option<Vec<OcrCacheEntry>>> {
        let mut stmt = self.conn.prepare(
            r#"
            SELECT text, bounds, confidence
            FROM ocr_cache
            WHERE region IS ?1
            "#,
        )?;

        let rows = stmt.query_map(params![region], |row| {
            let text: String = row.get(0)?;
            let bounds_json: String = row.get(1)?;
            let confidence: f64 = row.get(2)?;
            Ok((text, bounds_json, confidence))
        })?;

        let mut entries = Vec::new();
        for row_result in rows {
            let (text, bounds_json, confidence) = row_result?;

            let bounds: serde_json::Value = serde_json::from_str(&bounds_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid bounds JSON: {}", e)))?;

            entries.push(OcrCacheEntry {
                text,
                x: bounds["x"].as_i64().unwrap_or(0) as i32,
                y: bounds["y"].as_i64().unwrap_or(0) as i32,
                width: bounds["width"].as_i64().unwrap_or(0) as i32,
                height: bounds["height"].as_i64().unwrap_or(0) as i32,
                confidence,
            });
        }

        if entries.is_empty() {
            Ok(None)
        } else {
            Ok(Some(entries))
        }
    }

    /// Clear OCR cache (all or specific region)
    pub fn clear_ocr_cache(&self, region: Option<&str>) -> StorageResult<()> {
        match region {
            Some(r) => {
                self.conn
                    .execute("DELETE FROM ocr_cache WHERE region = ?1", params![r])?;
            }
            None => {
                self.conn
                    .execute("DELETE FROM ocr_cache WHERE region IS NULL", [])?;
            }
        }
        Ok(())
    }

    /// Clear all OCR cache entries
    pub fn clear_all_ocr_cache(&self) -> StorageResult<()> {
        self.conn.execute("DELETE FROM ocr_cache", [])?;
        Ok(())
    }

    /// Check if OCR cache exists and is fresh (within max_age seconds)
    pub fn is_ocr_cached(&self, region: Option<&str>, max_age: i64) -> StorageResult<bool> {
        let now = system_time_to_unix(SystemTime::now());
        let min_cached_at = now - max_age;

        let count: i64 = self.conn.query_row(
            r#"
            SELECT COUNT(*)
            FROM ocr_cache
            WHERE region IS ?1 AND cached_at >= ?2
            "#,
            params![region, min_cached_at],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    // --- Grid Cache Methods ---

    /// Cache grid metadata
    pub fn cache_grid(
        &self,
        spacing: u32,
        region: Option<&str>,
        metadata: &serde_json::Value,
    ) -> StorageResult<()> {
        // Clear existing cache for this spacing/region first
        self.conn.execute(
            r#"
            DELETE FROM grid_cache
            WHERE spacing = ?1 AND region IS ?2
            "#,
            params![spacing, region],
        )?;

        let now = system_time_to_unix(SystemTime::now());
        let metadata_json = metadata.to_string();

        self.conn.execute(
            r#"
            INSERT INTO grid_cache (spacing, region, metadata, cached_at)
            VALUES (?1, ?2, ?3, ?4)
            "#,
            params![spacing, region, metadata_json, now],
        )?;

        Ok(())
    }

    /// Get cached grid metadata
    pub fn get_cached_grid(
        &self,
        spacing: u32,
        region: Option<&str>,
    ) -> StorageResult<Option<serde_json::Value>> {
        let result: Option<String> = self
            .conn
            .query_row(
                r#"
                SELECT metadata
                FROM grid_cache
                WHERE spacing = ?1 AND region IS ?2
                "#,
                params![spacing, region],
                |row| row.get(0),
            )
            .optional()?;

        match result {
            Some(json_str) => {
                let value: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| {
                    StorageError::InvalidFormat(format!("Invalid grid metadata JSON: {}", e))
                })?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    }

    /// Clear grid cache
    pub fn clear_grid_cache(&self) -> StorageResult<()> {
        self.conn.execute("DELETE FROM grid_cache", [])?;
        Ok(())
    }

    // --- Render Cache Methods ---

    /// Cache rendered image
    pub fn cache_render(&self, data: &[u8], annotations_hash: &str) -> StorageResult<()> {
        let now = system_time_to_unix(SystemTime::now());

        self.conn.execute(
            r#"
            INSERT INTO render_cache (id, data, annotations_hash, rendered_at)
            VALUES (1, ?1, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET
                data = excluded.data,
                annotations_hash = excluded.annotations_hash,
                rendered_at = excluded.rendered_at
            "#,
            params![data, annotations_hash, now],
        )?;

        Ok(())
    }

    /// Get cached render if hash matches
    pub fn get_cached_render(&self, annotations_hash: &str) -> StorageResult<Option<Vec<u8>>> {
        let result: Option<Vec<u8>> = self
            .conn
            .query_row(
                r#"
                SELECT data
                FROM render_cache
                WHERE id = 1 AND annotations_hash = ?1
                "#,
                params![annotations_hash],
                |row| row.get(0),
            )
            .optional()?;

        Ok(result)
    }

    /// Calculate hash of current annotations state
    pub fn annotations_hash(&self) -> StorageResult<String> {
        let annotations = self.list_annotations()?;

        // Serialize annotations to JSON for hashing
        let annotations_json: Vec<serde_json::Value> = annotations
            .iter()
            .map(|ann| {
                let type_name = ann.annotation_type.type_name();
                let data_json = serialize_annotation_data(&ann.annotation_type)
                    .unwrap_or_else(|_| "{}".to_string());
                let color_hex = color_to_hex(&ann.color);

                serde_json::json!({
                    "id": ann.id.0,
                    "type": type_name,
                    "data": data_json,
                    "color": color_hex,
                    "z_index": ann.z_index,
                    "visible": ann.visible,
                    "locked": ann.locked
                })
            })
            .collect();

        let json_str = serde_json::to_string(&annotations_json).map_err(|e| {
            StorageError::InvalidFormat(format!("Failed to serialize annotations for hash: {}", e))
        })?;

        // Compute SHA256 hash
        let mut hasher = Sha256::new();
        hasher.update(json_str.as_bytes());
        let result = hasher.finalize();

        // Convert to hex string
        Ok(format!("{:x}", result))
    }

    /// Clear render cache
    pub fn clear_render_cache(&self) -> StorageResult<()> {
        self.conn.execute("DELETE FROM render_cache", [])?;
        Ok(())
    }

    // --- Private methods ---

    /// Set SQLite pragmas for optimal performance
    fn set_pragmas(&self) -> StorageResult<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA cache_size = -2000;
            "#,
        )?;
        self.conn.execute_batch(PROTOCOL_SCHEMA_SQL)?;
        Ok(())
    }

    /// Initialize the database schema
    fn init_schema(&self) -> StorageResult<()> {
        // Create schema_version table and insert current version
        self.conn.execute(
            "CREATE TABLE schema_version (version INTEGER PRIMARY KEY)",
            [],
        )?;
        self.conn.execute(
            "INSERT INTO schema_version VALUES (?1)",
            params![CURRENT_SCHEMA_VERSION],
        )?;

        self.conn.execute_batch(
            r#"

            -- Source image data
            CREATE TABLE image (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data BLOB NOT NULL,
                format TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                imported_at INTEGER NOT NULL,
                original_path TEXT
            );

            -- Annotations (shared by human and agent)
            CREATE TABLE annotations (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                data JSON NOT NULL,
                color TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'human',
                z_index INTEGER DEFAULT 0,
                visible INTEGER DEFAULT 1,
                locked INTEGER DEFAULT 0,
                group_id INTEGER,
                created_at INTEGER NOT NULL,
                modified_at INTEGER NOT NULL
            );

            -- OCR cache (expensive to recompute)
            CREATE TABLE ocr_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                region TEXT,
                text TEXT NOT NULL,
                bounds JSON NOT NULL,
                confidence REAL,
                engine TEXT DEFAULT 'tesseract',
                cached_at INTEGER NOT NULL
            );
            CREATE INDEX idx_ocr_region ON ocr_cache(region);

            -- Grid cache
            CREATE TABLE grid_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                spacing INTEGER NOT NULL,
                region TEXT,
                metadata JSON NOT NULL,
                cached_at INTEGER NOT NULL
            );

            -- Rendered image cache
            CREATE TABLE render_cache (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data BLOB,
                annotations_hash TEXT,
                rendered_at INTEGER
            );

            -- Document metadata
            CREATE TABLE metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            -- Session management (for GUI/CLI coordination)
            CREATE TABLE session (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                gui_pid INTEGER,
                opened_at INTEGER,
                last_activity INTEGER
            );

            -- Messages for GUI/CLI communication (toasts)
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'agent',
                read INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            -- Out-of-band asset bytes (e.g. inserted images), keyed by content
            -- hash; Image annotations reference a row here by hash instead of
            -- inlining bytes in their own `data` JSON.
            CREATE TABLE assets (
                hash TEXT PRIMARY KEY,
                bytes BLOB NOT NULL,
                format TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    /// Validate that this is a valid .nib file
    fn validate_schema(&self) -> StorageResult<()> {
        // Check schema_version table exists and has a valid version
        let version: i32 = self
            .conn
            .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
            .map_err(|_| {
                StorageError::InvalidFormat(
                    "Not a valid .nib file: missing schema_version".to_string(),
                )
            })?;

        if version < 1 {
            return Err(StorageError::InvalidFormat(format!(
                "Invalid schema version: {}",
                version
            )));
        }
        if version > CURRENT_SCHEMA_VERSION {
            return Err(StorageError::InvalidFormat(format!(
                "Unsupported schema version: {version}"
            )));
        }

        Ok(())
    }

    fn has_table(&self, table: &str) -> bool {
        self.conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .unwrap_or(false)
    }

    fn ensure_protocol_schema(&self) -> StorageResult<()> {
        let version: i32 =
            self.conn
                .query_row("SELECT version FROM schema_version", [], |row| row.get(0))?;
        if version >= CURRENT_SCHEMA_VERSION && self.has_table("protocol_documents") {
            return Ok(());
        }

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> StorageResult<()> {
            self.conn.execute_batch(PROTOCOL_SCHEMA_SQL)?;
            self.conn.execute(
                "UPDATE schema_version SET version = ?1",
                params![CURRENT_SCHEMA_VERSION],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => self.conn.execute_batch("COMMIT")?,
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
        Ok(())
    }

    fn read_protocol_rows<T: DeserializeOwned>(
        &self,
        table: &str,
        sql: &str,
        request_id: &str,
    ) -> StorageResult<Vec<T>> {
        if !self.has_table(table) {
            return Ok(Vec::new());
        }
        let mut statement = self.conn.prepare(sql)?;
        let documents = statement
            .query_map(params![request_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        documents
            .into_iter()
            .map(|document| {
                serde_json::from_str(&document)
                    .map_err(|error| StorageError::InvalidFormat(error.to_string()))
            })
            .collect()
    }

    /// Migrate schema to latest version
    fn migrate(&self) -> StorageResult<()> {
        let _version: i32 =
            self.conn
                .query_row("SELECT version FROM schema_version", [], |row| row.get(0))?;

        // Add messages table if not exists (for files created before messages feature)
        let has_messages: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='messages'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_messages {
            self.conn.execute(
                r#"CREATE TABLE messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'agent',
                    read INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL
                )"#,
                [],
            )?;
        }

        // Add assets table if not exists (files created before Image annotations)
        let has_assets: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='assets'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_assets {
            self.conn.execute(
                r#"CREATE TABLE assets (
                    hash TEXT PRIMARY KEY,
                    bytes BLOB NOT NULL,
                    format TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                )"#,
                [],
            )?;
        }

        // Add group_id column if not exists (files created before grouping).
        // Guarded on the table itself existing: some pre-v1 synthetic/test
        // databases have no `annotations` table yet, and `ALTER TABLE` on a
        // missing table would error.
        let has_annotations: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='annotations'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if has_annotations {
            let has_group_id: bool = self
                .conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('annotations') WHERE name='group_id'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if !has_group_id {
                self.conn
                    .execute("ALTER TABLE annotations ADD COLUMN group_id INTEGER", [])?;
            }
        }

        Ok(())
    }

    // --- Asset Methods (out-of-band bytes for Image annotations) ---

    /// Store an asset's bytes, keyed by content hash. Idempotent: storing the
    /// same hash again (identical bytes, by construction) overwrites in place.
    pub fn add_asset(&self, hash: &str, data: &AssetData) -> StorageResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO assets (hash, bytes, format, width, height) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hash, data.bytes, data.format, data.width, data.height],
        )?;
        Ok(())
    }

    /// Look up an asset's bytes by content hash.
    pub fn get_asset(&self, hash: &str) -> StorageResult<Option<AssetData>> {
        let result = self.conn.query_row(
            "SELECT bytes, format, width, height FROM assets WHERE hash = ?1",
            params![hash],
            |row| {
                Ok(AssetData {
                    bytes: row.get(0)?,
                    format: row.get(1)?,
                    width: row.get(2)?,
                    height: row.get(3)?,
                })
            },
        );
        match result {
            Ok(data) => Ok(Some(data)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Load every asset referenced by this file's annotations, keyed by hash
    /// (for building a `NibImage.assets` map, e.g. before export).
    pub fn get_all_assets(&self) -> StorageResult<std::collections::HashMap<String, AssetData>> {
        let mut stmt = self
            .conn
            .prepare("SELECT hash, bytes, format, width, height FROM assets")?;
        let assets = stmt
            .query_map([], |row| {
                let hash: String = row.get(0)?;
                Ok((
                    hash,
                    AssetData {
                        bytes: row.get(1)?,
                        format: row.get(2)?,
                        width: row.get(3)?,
                        height: row.get(4)?,
                    },
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(assets)
    }

    // --- Message Methods (for GUI/CLI communication) ---

    /// Add a message (for toast display in GUI)
    pub fn add_message(&self, content: &str, source: &str) -> StorageResult<i64> {
        let now = system_time_to_unix(SystemTime::now());
        self.conn.execute(
            "INSERT INTO messages (content, source, created_at) VALUES (?1, ?2, ?3)",
            params![content, source, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Get unread messages and mark them as read
    pub fn get_and_mark_messages_read(&self) -> StorageResult<Vec<(i64, String, String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, content, source, created_at FROM messages WHERE read = 0 ORDER BY created_at",
        )?;
        let messages: Vec<_> = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        self.conn
            .execute("UPDATE messages SET read = 1 WHERE read = 0", [])?;
        Ok(messages)
    }
}

// --- Internal types for row mapping ---

struct AnnotationRow {
    id: String,
    annotation_type: String,
    data: String,
    color: String,
    #[allow(dead_code)]
    source: String,
    z_index: i32,
    visible: i32,
    locked: i32,
    created_at: i64,
    modified_at: i64,
    group_id: Option<i64>,
}

// --- JSON serialization structures for annotation data ---

#[derive(Serialize, Deserialize)]
struct ArrowData {
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    stroke_width: f64,
    head_style: String,
}

#[derive(Serialize, Deserialize)]
struct BoxData {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    stroke_width: f64,
    corner_radius: f64,
    filled: bool,
    stroke_style: String,
}

#[derive(Serialize, Deserialize)]
struct TextData {
    x: f64,
    y: f64,
    content: String,
    font_size: f64,
    align: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_width: Option<f64>,
}

#[derive(Serialize, Deserialize)]
struct NumberData {
    x: f64,
    y: f64,
    value: u32,
    radius: f64,
}

#[derive(Serialize, Deserialize)]
struct HighlightData {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    corner_radius: f64,
}

#[derive(Serialize, Deserialize)]
struct BlurData {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    intensity: String,
}

#[derive(Serialize, Deserialize)]
struct LineData {
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    stroke_width: f64,
    stroke_style: String,
}

#[derive(Serialize, Deserialize)]
struct EllipseData {
    center_x: f64,
    center_y: f64,
    radius_x: f64,
    radius_y: f64,
    stroke_width: f64,
    filled: bool,
}

#[derive(Serialize, Deserialize)]
struct CropData {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize, Deserialize)]
struct PathData {
    points: Vec<PointData>,
    stroke_width: f64,
    stroke_style: String,
}

#[derive(Serialize, Deserialize)]
struct PointData {
    x: f64,
    y: f64,
}

#[derive(Serialize, Deserialize)]
struct ImageData {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// Content-hash reference; the actual bytes live in the `assets` table.
    asset_hash: String,
    opacity: f64,
}

// --- Helper functions ---

fn serialize_annotation_data(annotation_type: &AnnotationType) -> StorageResult<String> {
    let json = match annotation_type {
        AnnotationType::Arrow {
            start,
            end,
            head,
            stroke_width,
        } => {
            let data = ArrowData {
                start_x: start.x,
                start_y: start.y,
                end_x: end.x,
                end_y: end.y,
                stroke_width: *stroke_width,
                head_style: arrow_head_to_string(head),
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Box {
            region,
            stroke_width,
            stroke_style,
            filled,
            corner_radius,
        } => {
            let data = BoxData {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
                stroke_width: *stroke_width,
                corner_radius: *corner_radius,
                filled: *filled,
                stroke_style: stroke_style_to_string(stroke_style),
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Text {
            position,
            content,
            font_size,
            align,
            background,
            max_width,
        } => {
            let data = TextData {
                x: position.x,
                y: position.y,
                content: content.clone(),
                font_size: *font_size,
                align: text_align_to_string(align),
                background: background.map(|c| color_to_hex(&c)),
                max_width: *max_width,
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Number {
            position,
            value,
            radius,
        } => {
            let data = NumberData {
                x: position.x,
                y: position.y,
                value: *value,
                radius: *radius,
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Highlight {
            region,
            corner_radius,
        } => {
            let data = HighlightData {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
                corner_radius: *corner_radius,
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Blur { region, intensity } => {
            let data = BlurData {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
                intensity: blur_intensity_to_string(intensity),
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Line {
            start,
            end,
            stroke_width,
            stroke_style,
        } => {
            let data = LineData {
                start_x: start.x,
                start_y: start.y,
                end_x: end.x,
                end_y: end.y,
                stroke_width: *stroke_width,
                stroke_style: stroke_style_to_string(stroke_style),
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Ellipse {
            center,
            radius_x,
            radius_y,
            stroke_width,
            filled,
        } => {
            let data = EllipseData {
                center_x: center.x,
                center_y: center.y,
                radius_x: *radius_x,
                radius_y: *radius_y,
                stroke_width: *stroke_width,
                filled: *filled,
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Crop { region } => {
            let data = CropData {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Path {
            points,
            stroke_width,
            stroke_style,
        } => {
            let data = PathData {
                points: points
                    .iter()
                    .map(|p| PointData { x: p.x, y: p.y })
                    .collect(),
                stroke_width: *stroke_width,
                stroke_style: stroke_style_to_string(stroke_style),
            };
            serde_json::to_string(&data)
        }
        AnnotationType::Image {
            region,
            asset,
            opacity,
        } => {
            let data = ImageData {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
                asset_hash: asset.0.clone(),
                opacity: *opacity,
            };
            serde_json::to_string(&data)
        }
    }
    .map_err(|e| StorageError::InvalidFormat(format!("Failed to serialize annotation: {}", e)))?;

    Ok(json)
}

fn deserialize_annotation_data(type_name: &str, data_json: &str) -> StorageResult<AnnotationType> {
    let annotation_type = match type_name {
        "arrow" => {
            let data: ArrowData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid arrow data: {}", e)))?;
            AnnotationType::Arrow {
                start: Point::new(data.start_x, data.start_y),
                end: Point::new(data.end_x, data.end_y),
                head: string_to_arrow_head(&data.head_style),
                stroke_width: data.stroke_width,
            }
        }
        "box" | "rectangle" => {
            let data: BoxData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid box data: {}", e)))?;
            AnnotationType::Box {
                region: Region::new(data.x, data.y, data.width, data.height),
                stroke_width: data.stroke_width,
                stroke_style: string_to_stroke_style(&data.stroke_style),
                filled: data.filled,
                corner_radius: data.corner_radius,
            }
        }
        "text" => {
            let data: TextData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid text data: {}", e)))?;
            AnnotationType::Text {
                position: Point::new(data.x, data.y),
                content: data.content,
                font_size: data.font_size,
                align: string_to_text_align(&data.align),
                background: data.background.as_ref().map(|s| hex_to_color(s)),
                max_width: data.max_width,
            }
        }
        "number" => {
            let data: NumberData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid number data: {}", e)))?;
            AnnotationType::Number {
                position: Point::new(data.x, data.y),
                value: data.value,
                radius: data.radius,
            }
        }
        "highlight" => {
            let data: HighlightData = serde_json::from_str(data_json).map_err(|e| {
                StorageError::InvalidFormat(format!("Invalid highlight data: {}", e))
            })?;
            AnnotationType::Highlight {
                region: Region::new(data.x, data.y, data.width, data.height),
                corner_radius: data.corner_radius,
            }
        }
        "blur" => {
            let data: BlurData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid blur data: {}", e)))?;
            AnnotationType::Blur {
                region: Region::new(data.x, data.y, data.width, data.height),
                intensity: string_to_blur_intensity(&data.intensity),
            }
        }
        "line" => {
            let data: LineData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid line data: {}", e)))?;
            AnnotationType::Line {
                start: Point::new(data.start_x, data.start_y),
                end: Point::new(data.end_x, data.end_y),
                stroke_width: data.stroke_width,
                stroke_style: string_to_stroke_style(&data.stroke_style),
            }
        }
        "ellipse" => {
            let data: EllipseData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid ellipse data: {}", e)))?;
            AnnotationType::Ellipse {
                center: Point::new(data.center_x, data.center_y),
                radius_x: data.radius_x,
                radius_y: data.radius_y,
                stroke_width: data.stroke_width,
                filled: data.filled,
            }
        }
        "crop" => {
            let data: CropData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid crop data: {}", e)))?;
            AnnotationType::Crop {
                region: Region::new(data.x, data.y, data.width, data.height),
            }
        }
        "path" => {
            let data: PathData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid path data: {}", e)))?;
            AnnotationType::Path {
                points: data.points.iter().map(|p| Point::new(p.x, p.y)).collect(),
                stroke_width: data.stroke_width,
                stroke_style: string_to_stroke_style(&data.stroke_style),
            }
        }
        "image" => {
            let data: ImageData = serde_json::from_str(data_json)
                .map_err(|e| StorageError::InvalidFormat(format!("Invalid image data: {}", e)))?;
            AnnotationType::Image {
                region: Region::new(data.x, data.y, data.width, data.height),
                asset: nib_core::AssetRef(data.asset_hash),
                opacity: data.opacity,
            }
        }
        _ => {
            return Err(StorageError::InvalidFormat(format!(
                "Unknown annotation type: {}",
                type_name
            )));
        }
    };

    Ok(annotation_type)
}

fn row_to_annotation(row: AnnotationRow) -> StorageResult<Annotation> {
    let annotation_type = deserialize_annotation_data(&row.annotation_type, &row.data)?;
    let color = hex_to_color(&row.color);

    // Parse the numeric ID from "a1", "a2", etc.
    let id_num: u64 = row
        .id
        .strip_prefix('a')
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    Ok(Annotation {
        id: AnnotationId(id_num),
        owner: "human".to_string(), // Default to human for existing annotations
        annotation_type,
        color,
        severity: Severity::None, // Not stored in DB; could be derived from color
        label: None,              // Not stored separately; embedded in Text annotations
        visible: row.visible != 0,
        locked: row.locked != 0,
        z_index: row.z_index,
        group_id: row.group_id.map(|g| g as u64),
        created_at: unix_to_system_time(row.created_at),
        modified_at: unix_to_system_time(row.modified_at),
    })
}

fn color_to_hex(color: &Color) -> String {
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        color.r, color.g, color.b, color.a
    )
}

fn hex_to_color(hex: &str) -> Color {
    let hex = hex.trim_start_matches('#');

    // Parse RGBA or RGB
    if hex.len() >= 8 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
        let a = u8::from_str_radix(&hex[6..8], 16).unwrap_or(255);
        Color::rgba(r, g, b, a)
    } else if hex.len() >= 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
        Color::rgb(r, g, b)
    } else {
        Color::RED // Fallback
    }
}

fn arrow_head_to_string(head: &ArrowHead) -> String {
    match head {
        ArrowHead::End => "end".to_string(),
        ArrowHead::Start => "start".to_string(),
        ArrowHead::Both => "both".to_string(),
        ArrowHead::None => "none".to_string(),
    }
}

fn string_to_arrow_head(s: &str) -> ArrowHead {
    match s {
        "start" => ArrowHead::Start,
        "both" => ArrowHead::Both,
        "none" => ArrowHead::None,
        _ => ArrowHead::End,
    }
}

fn stroke_style_to_string(style: &StrokeStyle) -> String {
    match style {
        StrokeStyle::Solid => "solid".to_string(),
        StrokeStyle::Dashed => "dashed".to_string(),
        StrokeStyle::Dotted => "dotted".to_string(),
    }
}

fn string_to_stroke_style(s: &str) -> StrokeStyle {
    match s {
        "dashed" => StrokeStyle::Dashed,
        "dotted" => StrokeStyle::Dotted,
        _ => StrokeStyle::Solid,
    }
}

fn text_align_to_string(align: &TextAlign) -> String {
    match align {
        TextAlign::Left => "left".to_string(),
        TextAlign::Center => "center".to_string(),
        TextAlign::Right => "right".to_string(),
    }
}

fn string_to_text_align(s: &str) -> TextAlign {
    match s {
        "center" => TextAlign::Center,
        "right" => TextAlign::Right,
        _ => TextAlign::Left,
    }
}

fn blur_intensity_to_string(intensity: &BlurIntensity) -> String {
    match intensity {
        BlurIntensity::Light => "light".to_string(),
        BlurIntensity::Medium => "medium".to_string(),
        BlurIntensity::Heavy => "heavy".to_string(),
        BlurIntensity::Pixelate => "pixelate".to_string(),
    }
}

fn string_to_blur_intensity(s: &str) -> BlurIntensity {
    match s {
        "light" => BlurIntensity::Light,
        "heavy" => BlurIntensity::Heavy,
        "pixelate" => BlurIntensity::Pixelate,
        _ => BlurIntensity::Medium,
    }
}

fn system_time_to_unix(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64
}

fn unix_to_system_time(unix: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(unix as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_image() -> Vec<u8> {
        // Minimal valid PNG (1x1 red pixel)
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x18, 0xDD,
            0x8D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }

    #[test]
    fn test_create_and_open() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.nib");
        let image_data = create_test_image();

        // Create new file
        let nib = NibFile::create(&path, &image_data, "png", 1, 1).unwrap();
        drop(nib);

        // Reopen
        let nib = NibFile::open(&path).unwrap();
        let (data, info) = nib.get_image().unwrap();

        assert_eq!(data, image_data);
        assert_eq!(info.format, "png");
        assert_eq!(info.width, 1);
        assert_eq!(info.height, 1);
    }

    #[test]
    fn test_add_and_get_annotation() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.nib");
        let image_data = create_test_image();

        let nib = NibFile::create(&path, &image_data, "png", 100, 100).unwrap();

        // Add a box annotation
        let annotation = Annotation::new(AnnotationType::Box {
            region: Region::new(10.0, 20.0, 50.0, 30.0),
            stroke_width: 2.0,
            stroke_style: StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })
        .with_color(Color::RED);

        let id = nib.add_annotation(&annotation).unwrap();
        assert_eq!(id, "a1");

        // Retrieve it
        let retrieved = nib.get_annotation("a1").unwrap().unwrap();
        assert!(matches!(
            retrieved.annotation_type,
            AnnotationType::Box { .. }
        ));
        assert_eq!(retrieved.color.r, Color::RED.r);
    }

    #[test]
    fn test_sticky_note_round_trip_through_sqlite() {
        // A sticky note is a Text annotation with background/max_width set --
        // not a new AnnotationType -- so it round-trips through the existing
        // Text (de)serialization with no special-casing needed.
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.nib");
        let image_data = create_test_image();

        let nib = NibFile::create(&path, &image_data, "png", 100, 100).unwrap();

        let annotation = Annotation::new(AnnotationType::Text {
            position: Point::new(10.0, 20.0),
            content: "Sticky note text".to_string(),
            font_size: 16.0,
            align: TextAlign::Left,
            background: Some(Color::rgb(255, 220, 130)),
            max_width: Some(200.0),
        })
        .with_color(Color::rgb(0, 0, 0));

        let id = nib.add_annotation(&annotation).unwrap();
        let retrieved = nib.get_annotation(&id).unwrap().unwrap();

        match retrieved.annotation_type {
            AnnotationType::Text {
                background,
                max_width,
                content,
                ..
            } => {
                assert_eq!(background, Some(Color::rgb(255, 220, 130)));
                assert_eq!(max_width, Some(200.0));
                assert_eq!(content, "Sticky note text");
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn test_add_asset_and_get_asset_round_trip_byte_identical() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.nib");
        let nib = NibFile::create(&path, &create_test_image(), "png", 100, 100).unwrap();

        let bytes = vec![1u8, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255];
        let data = AssetData {
            bytes: bytes.clone(),
            format: "png".to_string(),
            width: 4,
            height: 4,
        };
        nib.add_asset("deadbeef", &data).unwrap();

        let retrieved = nib.get_asset("deadbeef").unwrap().unwrap();
        assert_eq!(
            retrieved.bytes, bytes,
            "asset bytes must round-trip byte-identical"
        );
        assert_eq!(retrieved.format, "png");
        assert_eq!(retrieved.width, 4);
        assert_eq!(retrieved.height, 4);

        assert!(nib.get_asset("not-a-real-hash").unwrap().is_none());
    }

    #[test]
    fn test_image_annotation_round_trip_through_sqlite() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.nib");
        let nib = NibFile::create(&path, &create_test_image(), "png", 100, 100).unwrap();

        let asset_bytes = vec![10u8, 20, 30, 40, 50, 60, 70, 80];
        let asset = nib_core::AssetRef::from_bytes(&asset_bytes);
        nib.add_asset(
            &asset.0,
            &AssetData {
                bytes: asset_bytes.clone(),
                format: "png".to_string(),
                width: 2,
                height: 2,
            },
        )
        .unwrap();

        let annotation = Annotation::new(AnnotationType::Image {
            region: Region::new(5.0, 6.0, 40.0, 40.0),
            asset: asset.clone(),
            opacity: 0.75,
        });
        let id = nib.add_annotation(&annotation).unwrap();
        let retrieved = nib.get_annotation(&id).unwrap().unwrap();

        match retrieved.annotation_type {
            AnnotationType::Image {
                region,
                asset: retrieved_asset,
                opacity,
            } => {
                assert_eq!(region, Region::new(5.0, 6.0, 40.0, 40.0));
                assert_eq!(retrieved_asset, asset);
                assert_eq!(opacity, 0.75);
            }
            other => panic!("expected Image, got {other:?}"),
        }

        let retrieved_bytes = nib.get_asset(&asset.0).unwrap().unwrap();
        assert_eq!(
            retrieved_bytes.bytes, asset_bytes,
            "asset bytes must be byte-identical"
        );
    }

    #[test]
    fn test_pre_assets_schema_file_still_opens_and_migrates() {
        // Simulate a .nib file written before the `assets` table existed:
        // only `schema_version` (v1) -- `NibFile::open` must still succeed
        // and the migration must add `assets` so add_asset/get_asset work.
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("pre_assets.nib");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE schema_version (version INTEGER PRIMARY KEY)",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO schema_version VALUES (1)", [])
                .unwrap();
        }

        let nib = NibFile::open(&path).expect("pre-assets .nib file must still open");

        let has_assets: bool = nib
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='assets'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_assets,
            "migrate() must add the assets table to old files"
        );

        // And the table is actually usable post-migration.
        nib.add_asset(
            "h",
            &AssetData {
                bytes: vec![1, 2, 3],
                format: "png".to_string(),
                width: 1,
                height: 1,
            },
        )
        .unwrap();
        assert!(nib.get_asset("h").unwrap().is_some());
    }

    #[test]
    fn test_pre_group_id_schema_file_still_opens_and_migrates() {
        // Simulate a .nib file written before grouping existed: an `annotations`
        // table with every pre-Phase-5 column but no `group_id`. `NibFile::open`
        // must still succeed, migrate() must add the column, and reading back an
        // existing row must yield `group_id: None` rather than erroring.
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("pre_group_id.nib");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE schema_version (version INTEGER PRIMARY KEY)",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO schema_version VALUES (2)", [])
                .unwrap();
            conn.execute(
                r#"CREATE TABLE annotations (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    data JSON NOT NULL,
                    color TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'human',
                    z_index INTEGER DEFAULT 0,
                    visible INTEGER DEFAULT 1,
                    locked INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    modified_at INTEGER NOT NULL
                )"#,
                [],
            )
            .unwrap();
            conn.execute(
                r#"INSERT INTO annotations (id, type, data, color, source, z_index, visible, locked, created_at, modified_at)
                   VALUES ('a1', 'box', '{"x":0,"y":0,"width":1,"height":1,"stroke_width":2.0,"stroke_style":"solid","filled":false,"corner_radius":0.0}', '#ff0000', 'human', 0, 1, 0, 0, 0)"#,
                [],
            )
            .unwrap();
        }

        let nib = NibFile::open(&path).expect("pre-group_id .nib file must still open");

        let has_group_id: bool = nib
            .conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('annotations') WHERE name='group_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_group_id,
            "migrate() must add the group_id column to old files"
        );

        // Existing pre-migration row reads back with group_id defaulted to None.
        let existing = nib
            .get_annotation("a1")
            .unwrap()
            .expect("existing annotation must still be readable");
        assert_eq!(existing.group_id, None);

        // And the column is actually usable post-migration.
        let mut grouped = Annotation::new(AnnotationType::Box {
            region: Region::new(0.0, 0.0, 1.0, 1.0),
            stroke_width: 2.0,
            stroke_style: StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        });
        grouped.group_id = Some(42);
        let new_id = nib.add_annotation(&grouped).unwrap();
        let retrieved = nib.get_annotation(&new_id).unwrap().unwrap();
        assert_eq!(retrieved.group_id, Some(42));
    }

    #[test]
    fn test_color_conversion() {
        // Test full RGBA
        let color = Color::rgba(255, 128, 0, 200);
        let hex = color_to_hex(&color);
        assert_eq!(hex, "#ff8000c8");

        let parsed = hex_to_color(&hex);
        assert_eq!(parsed.r, 255);
        assert_eq!(parsed.g, 128);
        assert_eq!(parsed.b, 0);
        assert_eq!(parsed.a, 200);

        // Test RGB (no alpha)
        let parsed_rgb = hex_to_color("#ff0000");
        assert_eq!(parsed_rgb.r, 255);
        assert_eq!(parsed_rgb.g, 0);
        assert_eq!(parsed_rgb.b, 0);
        assert_eq!(parsed_rgb.a, 255); // Default alpha
    }
}
