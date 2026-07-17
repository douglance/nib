//! Append-only operation log for persistence and crash recovery
//!
//! The operation log stores all operations in a JSONL file, allowing:
//! - Crash recovery: Replay log to reconstruct state
//! - Late joiners: Sync by replaying operations since last known timestamp
//! - Audit trail: Complete history of all changes

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use super::types::*;
use nib_core::Annotation;

/// Append-only operation log
pub struct OperationLog {
    path: PathBuf,
    operations: Vec<CollabOperation>,
    seen_ids: HashSet<uuid::Uuid>,
}

impl OperationLog {
    /// Create or open an operation log at the given path
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let mut operations = Vec::new();
        let mut seen_ids = HashSet::new();

        // Read existing operations if file exists
        if path.exists() {
            let file = File::open(&path)?;
            let reader = BufReader::new(file);

            for line in reader.lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }

                match serde_json::from_str::<CollabOperation>(&line) {
                    Ok(op) => {
                        if seen_ids.insert(op.op_id) {
                            operations.push(op);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse operation log line: {}", e);
                    }
                }
            }

            // Sort by timestamp for deterministic ordering
            operations.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        }

        Ok(Self {
            path,
            operations,
            seen_ids,
        })
    }

    /// Append an operation to the log
    pub fn append(&mut self, op: CollabOperation) -> std::io::Result<()> {
        // Skip duplicates
        if !self.seen_ids.insert(op.op_id) {
            return Ok(());
        }

        // Append to file
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;

        let mut writer = BufWriter::new(file);
        let json = serde_json::to_string(&op).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e)
        })?;
        writeln!(writer, "{}", json)?;
        writer.flush()?;

        // Update in-memory state
        self.operations.push(op);

        Ok(())
    }

    /// Get all operations in timestamp order
    pub fn operations(&self) -> &[CollabOperation] {
        &self.operations
    }

    /// Get operations since a given timestamp
    pub fn operations_since(&self, timestamp: Option<LogicalTimestamp>) -> Vec<&CollabOperation> {
        match timestamp {
            Some(ts) => self.operations.iter().filter(|op| op.timestamp > ts).collect(),
            None => self.operations.iter().collect(),
        }
    }

    /// Get the current (latest) timestamp
    pub fn current_timestamp(&self) -> Option<LogicalTimestamp> {
        self.operations.last().map(|op| op.timestamp)
    }

    /// Get operation count
    pub fn len(&self) -> usize {
        self.operations.len()
    }

    /// Check if log is empty
    pub fn is_empty(&self) -> bool {
        self.operations.is_empty()
    }

    /// Replay all operations to build annotation state
    pub fn replay(&self) -> Vec<Annotation> {
        let mut annotations = Vec::new();

        for op in &self.operations {
            super::operation::apply_operation(&mut annotations, &op.operation);
        }

        annotations
    }

    /// Compact the log by snapshotting current state
    ///
    /// This creates a new log with just Add operations for current annotations,
    /// reducing file size and replay time.
    pub fn compact(&mut self) -> std::io::Result<()> {
        if self.operations.len() < 100 {
            // Not worth compacting
            return Ok(());
        }

        let annotations = self.replay();

        // Create new log with just Add operations
        let temp_path = self.path.with_extension("log.new");
        let file = File::create(&temp_path)?;
        let mut writer = BufWriter::new(file);

        let client_id = ClientId::from_raw(0); // System client for compaction
        let mut timestamp = LogicalTimestamp::new(client_id);
        let mut new_operations = Vec::new();
        let mut new_seen_ids = HashSet::new();

        for annotation in annotations {
            let op = CollabOperation::new(
                timestamp.increment(),
                AnnotationOp::Add {
                    id: annotation.id.0,
                    data: super::operation::annotation_to_data(&annotation),
                },
            );

            let json = serde_json::to_string(&op).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, e)
            })?;
            writeln!(writer, "{}", json)?;

            new_seen_ids.insert(op.op_id);
            new_operations.push(op);
        }

        writer.flush()?;
        drop(writer);

        // Atomic rename
        std::fs::rename(&temp_path, &self.path)?;

        self.operations = new_operations;
        self.seen_ids = new_seen_ids;

        Ok(())
    }

    /// Delete the log file
    pub fn delete(&self) -> std::io::Result<()> {
        if self.path.exists() {
            std::fs::remove_file(&self.path)?;
        }
        Ok(())
    }

    /// Get the log file path
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Session file manager for discovering and managing sessions
pub struct SessionManager {
    base_dir: PathBuf,
}

impl SessionManager {
    /// Create a session manager with the given base directory
    pub fn new(base_dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let base_dir = base_dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&base_dir)?;
        Ok(Self { base_dir })
    }

    /// Get the default session directory
    pub fn default_dir() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("nib")
            .join("sessions")
    }

    /// Get session file path for an image
    pub fn session_path(&self, image_path: &Path) -> PathBuf {
        let session_id = SessionId::from_file_path(&image_path.to_path_buf());
        self.base_dir.join(format!("{}.session", session_id))
    }

    /// Get operation log path for an image
    pub fn log_path(&self, image_path: &Path) -> PathBuf {
        let session_id = SessionId::from_file_path(&image_path.to_path_buf());
        self.base_dir.join(format!("{}.ops.jsonl", session_id))
    }

    /// Get socket path for an image
    pub fn socket_path(&self, image_path: &Path) -> PathBuf {
        let session_id = SessionId::from_file_path(&image_path.to_path_buf());
        self.base_dir.join(format!("{}.sock", session_id))
    }

    /// Check if a session exists for an image
    pub fn session_exists(&self, image_path: &Path) -> bool {
        self.session_path(image_path).exists()
    }

    /// Load session state
    pub fn load_session(&self, image_path: &Path) -> std::io::Result<Option<SessionState>> {
        let path = self.session_path(image_path);
        if !path.exists() {
            return Ok(None);
        }

        let contents = std::fs::read_to_string(&path)?;
        let state: SessionState = serde_json::from_str(&contents).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e)
        })?;

        Ok(Some(state))
    }

    /// Save session state
    pub fn save_session(&self, state: &SessionState) -> std::io::Result<()> {
        let path = self.session_path(&state.image_path);
        let contents = serde_json::to_string_pretty(state).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e)
        })?;

        // Write to temp file first for atomic update
        let temp_path = path.with_extension("session.tmp");
        std::fs::write(&temp_path, contents)?;
        std::fs::rename(&temp_path, &path)?;

        Ok(())
    }

    /// Delete session files
    pub fn delete_session(&self, image_path: &Path) -> std::io::Result<()> {
        let session_path = self.session_path(image_path);
        let log_path = self.log_path(image_path);
        let socket_path = self.socket_path(image_path);

        if session_path.exists() {
            std::fs::remove_file(&session_path)?;
        }
        if log_path.exists() {
            std::fs::remove_file(&log_path)?;
        }
        if socket_path.exists() {
            std::fs::remove_file(&socket_path)?;
        }

        Ok(())
    }

    /// List all active sessions
    pub fn list_sessions(&self) -> std::io::Result<Vec<SessionState>> {
        let mut sessions = Vec::new();

        if !self.base_dir.exists() {
            return Ok(sessions);
        }

        for entry in std::fs::read_dir(&self.base_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.extension().is_some_and(|ext| ext == "session") {
                if let Ok(contents) = std::fs::read_to_string(&path) {
                    if let Ok(state) = serde_json::from_str::<SessionState>(&contents) {
                        sessions.push(state);
                    }
                }
            }
        }

        Ok(sessions)
    }

    /// Clean up stale sessions (no connected clients, older than threshold)
    pub fn cleanup_stale_sessions(&self, max_age_secs: u64) -> std::io::Result<usize> {
        let mut cleaned = 0;
        let threshold = std::time::SystemTime::now()
            - std::time::Duration::from_secs(max_age_secs);

        for session in self.list_sessions()? {
            if session.connected_clients.is_empty() && session.last_modified < threshold {
                self.delete_session(&session.image_path)?;
                cleaned += 1;
            }
        }

        Ok(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_operation_log_roundtrip() {
        let temp_dir = tempfile::tempdir().unwrap();
        let log_path = temp_dir.path().join("test.ops.jsonl");

        let client = ClientId::from_raw(1);
        let mut timestamp = LogicalTimestamp::new(client);

        // Create and append
        {
            let mut log = OperationLog::open(&log_path).unwrap();

            let op1 = CollabOperation::new(
                timestamp.increment(),
                AnnotationOp::Add {
                    id: 1,
                    data: AnnotationData {
                        annotation_type: AnnotationTypeData::Number {
                            x: 100.0,
                            y: 100.0,
                            value: 1,
                            radius: 15.0,
                        },
                        color: [255, 0, 0, 255],
                        severity: "error".to_string(),
                        label: None,
                        z_index: 0,
                        owner: "human".to_string(),
                        group_id: None,
                    },
                },
            );

            log.append(op1).unwrap();
            assert_eq!(log.len(), 1);
        }

        // Reopen and verify
        {
            let log = OperationLog::open(&log_path).unwrap();
            assert_eq!(log.len(), 1);

            let annotations = log.replay();
            assert_eq!(annotations.len(), 1);
            assert_eq!(annotations[0].id.0, 1);
        }
    }

    #[test]
    fn test_session_manager() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = SessionManager::new(temp_dir.path()).unwrap();

        let image_path = PathBuf::from("/tmp/test.png");

        // No session initially
        assert!(!manager.session_exists(&image_path));

        // Create session
        let session_id = SessionId::from_file_path(&image_path);
        let socket_path = manager.socket_path(&image_path);
        let state = SessionState::new(session_id, image_path.clone(), socket_path);

        manager.save_session(&state).unwrap();
        assert!(manager.session_exists(&image_path));

        // Load session
        let loaded = manager.load_session(&image_path).unwrap().unwrap();
        assert_eq!(loaded.session_id, session_id);

        // Delete session
        manager.delete_session(&image_path).unwrap();
        assert!(!manager.session_exists(&image_path));
    }

    #[test]
    fn test_deduplication() {
        let temp_dir = tempfile::tempdir().unwrap();
        let log_path = temp_dir.path().join("test.ops.jsonl");

        let client = ClientId::from_raw(1);
        let mut timestamp = LogicalTimestamp::new(client);

        let mut log = OperationLog::open(&log_path).unwrap();

        let op = CollabOperation::new(
            timestamp.increment(),
            AnnotationOp::Add {
                id: 1,
                data: AnnotationData {
                    annotation_type: AnnotationTypeData::Number {
                        x: 100.0,
                        y: 100.0,
                        value: 1,
                        radius: 15.0,
                    },
                    color: [255, 0, 0, 255],
                    severity: "error".to_string(),
                    label: None,
                    z_index: 0,
                    owner: "human".to_string(),
                    group_id: None,
                },
            },
        );

        // Append same operation twice
        log.append(op.clone()).unwrap();
        log.append(op).unwrap();

        // Should only have one
        assert_eq!(log.len(), 1);
    }
}
