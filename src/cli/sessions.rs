//! Collaboration session discovery output.

use super::args::OutputFormat;
use crate::collab::{log::SessionManager, types::SessionState};
use crate::core::{NibError, Result};
use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
struct SessionOutput {
    session_id: String,
    image_path: String,
    created_at: String,
    last_modified: String,
    operation_count: u64,
    client_count: usize,
    client_types: Vec<String>,
    socket_available: bool,
}

#[derive(Debug, Serialize)]
struct SessionsOutput {
    sessions: Vec<SessionOutput>,
    orphaned_records_hidden: usize,
    storage_path: String,
}

/// List stored collaboration sessions whose source image still exists.
pub fn run_sessions(format: &OutputFormat) -> Result<()> {
    tracing::info!("Running sessions");

    let storage_path = SessionManager::default_dir();
    let manager =
        SessionManager::new(&storage_path).map_err(|error| NibError::Other(error.to_string()))?;
    let (sessions, orphaned_records_hidden) = visible_sessions(&manager)?;

    match format {
        OutputFormat::Json => print_json(&sessions, orphaned_records_hidden, &storage_path),
        OutputFormat::Text => print_text(&sessions, orphaned_records_hidden, &storage_path),
    }
}

fn visible_sessions(manager: &SessionManager) -> Result<(Vec<SessionState>, usize)> {
    let all_sessions = manager
        .list_sessions()
        .map_err(|error| NibError::Other(error.to_string()))?;
    let orphaned_records_hidden = all_sessions
        .iter()
        .filter(|session| !session.image_path.exists())
        .count();
    let mut sessions: Vec<_> = all_sessions
        .into_iter()
        .filter(|session| session.image_path.exists())
        .collect();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.last_modified));
    Ok((sessions, orphaned_records_hidden))
}

fn print_json(sessions: &[SessionState], orphaned: usize, storage_path: &Path) -> Result<()> {
    let output = SessionsOutput {
        sessions: sessions.iter().map(SessionOutput::from).collect(),
        orphaned_records_hidden: orphaned,
        storage_path: storage_path.display().to_string(),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&output)
            .map_err(|error| NibError::Other(error.to_string()))?
    );
    Ok(())
}

fn print_text(sessions: &[SessionState], orphaned: usize, storage_path: &Path) -> Result<()> {
    if sessions.is_empty() {
        println!("No stored collaboration sessions.");
        if orphaned > 0 {
            println!("Hidden orphaned records: {orphaned}");
        }
        println!("\nStart a session with: nib gui <image.png>");
        return Ok(());
    }

    println!(
        "Stored collaboration sessions ({}; {} orphaned record(s) hidden):",
        sessions.len(),
        orphaned
    );
    println!("{}", "─".repeat(70));

    for session in sessions {
        let created = DateTime::<Local>::from(session.created_at);
        let modified = DateTime::<Local>::from(session.last_modified);
        let filename = session
            .image_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let socket_status = if session.socket_path.exists() {
            "socket available"
        } else {
            "no socket"
        };

        println!("  {} │ {}", filename, session.session_id);
        println!(
            "    Created: {} │ Modified: {}",
            created.format("%Y-%m-%d %H:%M"),
            modified.format("%H:%M:%S")
        );
        println!(
            "    Operations: {} │ Clients: {} │ {}",
            session.operation_count,
            session.connected_clients.len(),
            socket_status
        );
        println!("    Path: {}", session.image_path.display());
        println!();
    }

    println!("{}", "─".repeat(70));
    println!("Session storage: {}", storage_path.display());
    Ok(())
}

impl From<&SessionState> for SessionOutput {
    fn from(session: &SessionState) -> Self {
        Self {
            session_id: session.session_id.to_string(),
            image_path: session.image_path.display().to_string(),
            created_at: DateTime::<Utc>::from(session.created_at).to_rfc3339(),
            last_modified: DateTime::<Utc>::from(session.last_modified).to_rfc3339(),
            operation_count: session.operation_count,
            client_count: session.connected_clients.len(),
            client_types: session
                .connected_clients
                .iter()
                .map(|client| client.client_type.to_string())
                .collect(),
            socket_available: session.socket_path.exists(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::types::SessionId;
    use std::time::{Duration, SystemTime};
    use tempfile::tempdir;

    #[test]
    fn visible_sessions_hides_missing_images_and_sorts_newest_first() {
        let root = tempdir().unwrap();
        let manager = SessionManager::new(root.path().join("sessions")).unwrap();
        let first_image = root.path().join("first.png");
        let second_image = root.path().join("second.png");
        std::fs::write(&first_image, []).unwrap();
        std::fs::write(&second_image, []).unwrap();

        let mut first = SessionState::new(
            SessionId::from_file_path(&first_image),
            first_image.clone(),
            manager.session_path(&first_image).with_extension("sock"),
        );
        first.last_modified = SystemTime::UNIX_EPOCH;
        manager.save_session(&first).unwrap();
        let mut second = SessionState::new(
            SessionId::from_file_path(&second_image),
            second_image.clone(),
            manager.session_path(&second_image).with_extension("sock"),
        );
        second.last_modified = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
        manager.save_session(&second).unwrap();

        let missing_image = root.path().join("missing.png");
        let missing = SessionState::new(
            SessionId::from_file_path(&missing_image),
            missing_image.clone(),
            manager.session_path(&missing_image).with_extension("sock"),
        );
        manager.save_session(&missing).unwrap();

        let (visible, hidden) = visible_sessions(&manager).unwrap();
        assert_eq!(hidden, 1);
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[0].image_path, second_image);
        assert_eq!(visible[1].image_path, first_image);
    }

    #[test]
    fn json_output_has_stable_machine_fields() {
        let root = tempdir().unwrap();
        let image = root.path().join("review.png");
        std::fs::write(&image, []).unwrap();
        let state = SessionState::new(
            SessionId::from_file_path(&image),
            image.clone(),
            root.path().join("review.sock"),
        );
        let output = SessionOutput::from(&state);
        let value = serde_json::to_value(output).unwrap();

        assert_eq!(value["image_path"], image.display().to_string());
        assert_eq!(value["client_count"], 0);
        assert_eq!(value["socket_available"], false);
        assert!(value["created_at"].as_str().unwrap().ends_with("+00:00"));
    }
}
