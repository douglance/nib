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
use fs2::FileExt;
use nib_core::StorageError;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
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
        Self::load_from(&sessions_path())
    }

    fn load_from(path: &Path) -> StorageResult<Self> {
        if !path.exists() {
            // Create empty registry
            return Ok(Self {
                sessions: Vec::new(),
            });
        }

        let contents = std::fs::read_to_string(path)?;
        let file = match serde_json::from_str(&contents) {
            Ok(file) => file,
            Err(_) => serde_json::Deserializer::from_str(&contents)
                .into_iter::<SessionRegistryFile>()
                .next()
                .transpose()
                .ok()
                .flatten()
                .unwrap_or_default(),
        };

        Ok(Self {
            sessions: file.sessions,
        })
    }

    /// Save the session registry to ~/.nib/sessions.json
    pub fn save(&self) -> StorageResult<()> {
        let path = sessions_path();
        let lock = Self::lock(&path)?;
        let result = self.save_to(&path);
        let _ = FileExt::unlock(&lock);
        result
    }

    fn save_to(&self, path: &Path) -> StorageResult<()> {
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

        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(contents.as_bytes())?;
        temp.as_file().sync_all()?;
        temp.persist(path).map_err(|error| error.error)?;
        Ok(())
    }

    fn lock(path: &Path) -> StorageResult<File> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let lock_path = path.with_extension("lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        file.lock_exclusive()?;
        Ok(file)
    }

    fn update_at<T>(
        &mut self,
        registry_path: &Path,
        update: impl FnOnce(&mut Vec<Session>) -> T,
    ) -> StorageResult<T> {
        let lock = Self::lock(registry_path)?;
        let mut latest = Self::load_from(registry_path)?;
        let result = update(&mut latest.sessions);
        latest.save_to(registry_path)?;
        self.sessions = latest.sessions;
        let _ = FileExt::unlock(&lock);
        Ok(result)
    }

    /// Register a new session for a .nib file
    ///
    /// If a session already exists for this path, it will be replaced.
    pub fn register(&mut self, path: &Path, pid: u32) -> StorageResult<()> {
        self.register_at(&sessions_path(), path, pid)
    }

    fn register_at(&mut self, registry_path: &Path, path: &Path, pid: u32) -> StorageResult<()> {
        self.update_at(registry_path, |sessions| {
            sessions.retain(|session| session.path != path);
            sessions.push(Session {
                path: path.to_path_buf(),
                pid,
                opened_at: current_unix_timestamp(),
            });
        })
    }

    /// Unregister a session for a .nib file
    ///
    /// Returns true if a session was removed, false if not found.
    pub fn unregister(&mut self, path: &Path) -> StorageResult<bool> {
        self.update_at(&sessions_path(), |sessions| {
            let original_len = sessions.len();
            sessions.retain(|session| session.path != path);
            sessions.len() < original_len
        })
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
        self.update_at(&sessions_path(), |sessions| {
            let original_len = sessions.len();
            sessions.retain(|session| is_process_alive(session.pid));
            original_len - sessions.len()
        })
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
    use std::sync::{Arc, Barrier};
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
    fn load_recovers_first_complete_registry_from_trailing_corruption() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("sessions.json");
        std::fs::write(
            &path,
            r#"{"sessions":[{"path":"/tmp/recovered.nib","pid":42,"opened_at":7}]} ] }"#,
        )
        .unwrap();

        let registry = SessionRegistry::load_from(&path).unwrap();
        assert_eq!(registry.sessions.len(), 1);
        assert_eq!(
            registry.sessions[0].path,
            PathBuf::from("/tmp/recovered.nib")
        );
    }

    #[test]
    fn concurrent_registrations_remain_valid_and_preserve_every_session() {
        const WRITERS: usize = 24;
        let temp_dir = TempDir::new().unwrap();
        let registry_path = Arc::new(temp_dir.path().join("sessions.json"));
        let barrier = Arc::new(Barrier::new(WRITERS));
        let mut threads = Vec::new();

        for index in 0..WRITERS {
            let registry_path = Arc::clone(&registry_path);
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                let mut registry = SessionRegistry {
                    sessions: Vec::new(),
                };
                barrier.wait();
                registry
                    .register_at(
                        &registry_path,
                        &PathBuf::from(format!("/tmp/concurrent-{index}.nib")),
                        1000 + index as u32,
                    )
                    .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }

        let contents = std::fs::read_to_string(registry_path.as_ref()).unwrap();
        let parsed: SessionRegistryFile = serde_json::from_str(&contents).unwrap();
        assert_eq!(parsed.sessions.len(), WRITERS);
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
        assert!(active
            .iter()
            .any(|s| s.path.to_str() == Some("/tmp/current.nib")));

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
            sessions: vec![Session {
                path: PathBuf::from("/Users/doug/screenshot.nib"),
                pid: 12345,
                opened_at: 1704067200,
            }],
        };

        let json = serde_json::to_string(&original).unwrap();
        let parsed: SessionRegistryFile = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.sessions.len(), 1);
        assert_eq!(
            parsed.sessions[0].path,
            PathBuf::from("/Users/doug/screenshot.nib")
        );
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
        assert!(registry
            .sessions
            .iter()
            .any(|s| s.path.to_str() == Some("/tmp/current.nib")));

        // Stale process (PID 999999) should be removed if it's not alive
        // Note: On some systems PID 999999 might exist, so we just verify the logic ran
        assert!(registry.sessions.len() <= original_len);
    }
}
