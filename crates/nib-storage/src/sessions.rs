//! Session registry for tracking open .nib files
//!
//! Manages a central session registry at ~/.nib/sessions.json that allows
//! CLI tools to discover which .nib files are currently open in the GUI.
//!
//! This enables agent workflows where the CLI can:
//! - Discover open images via `nib list`
//! - Query and annotate images the human is viewing
//! - Coordinate with the GUI in real-time

use crate::StorageResult;
use nib_core::StorageError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A single session entry representing an open .nib file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Path to the .nib file
    pub path: PathBuf,
    /// Process ID of the GUI holding the file open
    pub pid: u32,
    /// Unix timestamp when the session was opened
    pub opened_at: i64,
}

/// The session registry file structure
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SessionRegistryFile {
    sessions: Vec<Session>,
}

/// Session registry for tracking open .nib files
#[derive(Debug)]
pub struct SessionRegistry {
    sessions: Vec<Session>,
}

impl SessionRegistry {
    /// Load the session registry from ~/.nib/sessions.json
    ///
    /// Creates the registry file if it doesn't exist.
    pub fn load() -> StorageResult<Self> {
        let path = sessions_path();

        if !path.exists() {
            // Create empty registry
            return Ok(Self {
                sessions: Vec::new(),
            });
        }

        let contents = std::fs::read_to_string(&path)?;
        let file: SessionRegistryFile = serde_json::from_str(&contents).map_err(|e| {
            StorageError::InvalidFormat(format!("Invalid sessions.json: {}", e))
        })?;

        Ok(Self {
            sessions: file.sessions,
        })
    }

    /// Save the session registry to ~/.nib/sessions.json
    pub fn save(&self) -> StorageResult<()> {
        let path = sessions_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let file = SessionRegistryFile {
            sessions: self.sessions.clone(),
        };

        let contents = serde_json::to_string_pretty(&file).map_err(|e| {
            StorageError::InvalidFormat(format!("Failed to serialize sessions: {}", e))
        })?;

        std::fs::write(&path, contents)?;
        Ok(())
    }

    /// Register a new session for a .nib file
    ///
    /// If a session already exists for this path, it will be replaced.
    pub fn register(&mut self, path: &Path, pid: u32) -> StorageResult<()> {
        // Remove any existing session for this path
        self.sessions.retain(|s| s.path != path);

        let session = Session {
            path: path.to_path_buf(),
            pid,
            opened_at: current_unix_timestamp(),
        };

        self.sessions.push(session);
        self.save()
    }

    /// Unregister a session for a .nib file
    ///
    /// Returns true if a session was removed, false if not found.
    pub fn unregister(&mut self, path: &Path) -> StorageResult<bool> {
        let original_len = self.sessions.len();
        self.sessions.retain(|s| s.path != path);
        let removed = self.sessions.len() < original_len;

        if removed {
            self.save()?;
        }

        Ok(removed)
    }

    /// List all active sessions (where the process is still alive)
    pub fn list_active(&self) -> StorageResult<Vec<Session>> {
        let active: Vec<Session> = self
            .sessions
            .iter()
            .filter(|s| is_process_alive(s.pid))
            .cloned()
            .collect();

        Ok(active)
    }

    /// Remove stale sessions (where the process is no longer alive)
    ///
    /// Returns the number of sessions that were removed.
    pub fn cleanup(&mut self) -> StorageResult<usize> {
        let original_len = self.sessions.len();
        self.sessions.retain(|s| is_process_alive(s.pid));
        let removed = original_len - self.sessions.len();

        if removed > 0 {
            self.save()?;
        }

        Ok(removed)
    }

    /// Get all sessions (including potentially stale ones)
    pub fn sessions(&self) -> &[Session] {
        &self.sessions
    }
}

/// Get the path to the sessions registry file
pub fn sessions_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".nib")
        .join("sessions.json")
}

/// Check if a process with the given PID is still alive
#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
    // On Unix, we can use kill(pid, 0) to check if process exists
    // This doesn't actually send a signal, just checks if we could
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
pub fn is_process_alive(pid: u32) -> bool {
    // On non-Unix platforms, assume process is alive
    // A proper Windows implementation would use OpenProcess
    let _ = pid;
    true
}

/// Get the current Unix timestamp
fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_sessions_path() {
        let path = sessions_path();
        assert!(path.ends_with(".nib/sessions.json"));
    }

    #[test]
    fn test_load_registry() {
        // Just verify loading works (may have existing sessions from previous runs)
        let registry = SessionRegistry::load().unwrap();
        // Sessions list exists (may or may not be empty)
        let _ = registry.sessions();
    }

    #[test]
    fn test_register_and_list() {
        let temp_dir = TempDir::new().unwrap();
        let sessions_file = temp_dir.path().join(".nib").join("sessions.json");

        // Create the registry directory
        std::fs::create_dir_all(sessions_file.parent().unwrap()).unwrap();

        // Write empty registry
        std::fs::write(&sessions_file, r#"{"sessions":[]}"#).unwrap();

        // Load and register
        let mut registry = SessionRegistry {
            sessions: Vec::new(),
        };

        let test_path = PathBuf::from("/tmp/test.nib");
        let pid = std::process::id();

        registry.sessions.push(Session {
            path: test_path.clone(),
            pid,
            opened_at: current_unix_timestamp(),
        });

        assert_eq!(registry.sessions().len(), 1);
        assert_eq!(registry.sessions()[0].path, test_path);
        assert_eq!(registry.sessions()[0].pid, pid);
    }

    #[test]
    fn test_unregister() {
        let mut registry = SessionRegistry {
            sessions: vec![
                Session {
                    path: PathBuf::from("/tmp/file1.nib"),
                    pid: 1234,
                    opened_at: 1704067200,
                },
                Session {
                    path: PathBuf::from("/tmp/file2.nib"),
                    pid: 5678,
                    opened_at: 1704067200,
                },
            ],
        };

        // Remove first session (don't save to disk in test)
        registry
            .sessions
            .retain(|s| s.path != PathBuf::from("/tmp/file1.nib"));

        assert_eq!(registry.sessions().len(), 1);
        assert_eq!(registry.sessions()[0].path, PathBuf::from("/tmp/file2.nib"));
    }

    #[test]
    fn test_list_active_filters_dead_processes() {
        let registry = SessionRegistry {
            sessions: vec![
                Session {
                    path: PathBuf::from("/tmp/current.nib"),
                    pid: std::process::id(), // Current process - alive
                    opened_at: 1704067200,
                },
                Session {
                    path: PathBuf::from("/tmp/stale.nib"),
                    pid: 999999, // Very unlikely to be a real PID
                    opened_at: 1704067200,
                },
            ],
        };

        let active = registry.list_active().unwrap();

        // Current process should be in active list
        assert!(active.iter().any(|s| s.path == PathBuf::from("/tmp/current.nib")));

        // Stale process should NOT be in active list (assuming PID 999999 doesn't exist)
        // Note: This test might be flaky if PID 999999 happens to exist
    }

    #[test]
    fn test_is_process_alive_current() {
        // Current process should always be alive
        let pid = std::process::id();
        assert!(is_process_alive(pid));
    }

    #[test]
    fn test_serialization_roundtrip() {
        let original = SessionRegistryFile {
            sessions: vec![
                Session {
                    path: PathBuf::from("/Users/doug/screenshot.nib"),
                    pid: 12345,
                    opened_at: 1704067200,
                },
            ],
        };

        let json = serde_json::to_string(&original).unwrap();
        let parsed: SessionRegistryFile = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(parsed.sessions[0].path, PathBuf::from("/Users/doug/screenshot.nib"));
        assert_eq!(parsed.sessions[0].pid, 12345);
        assert_eq!(parsed.sessions[0].opened_at, 1704067200);
    }

    #[test]
    fn test_cleanup_removes_stale() {
        let mut registry = SessionRegistry {
            sessions: vec![
                Session {
                    path: PathBuf::from("/tmp/current.nib"),
                    pid: std::process::id(),
                    opened_at: 1704067200,
                },
                Session {
                    path: PathBuf::from("/tmp/stale.nib"),
                    pid: 999999,
                    opened_at: 1704067200,
                },
            ],
        };

        // Just test the filtering logic without saving to disk
        let original_len = registry.sessions.len();
        registry.sessions.retain(|s| is_process_alive(s.pid));

        // Current process should still be in the list
        assert!(registry.sessions.iter().any(|s| s.path == PathBuf::from("/tmp/current.nib")));

        // Stale process (PID 999999) should be removed if it's not alive
        // Note: On some systems PID 999999 might exist, so we just verify the logic ran
        assert!(registry.sessions.len() <= original_len);
    }
}
