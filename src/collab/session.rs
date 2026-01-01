//! High-level session management for collaborative editing

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use tokio::sync::mpsc;

use super::ipc::{CollabHandle, CollabServer, IpcConfig};
use super::log::{OperationLog, SessionManager};
use super::operation::{annotation_to_data, apply_operation};
use super::types::*;
use crate::core::Annotation;

/// A collaborative editing session
pub struct Session {
    /// Session state
    state: SessionState,
    /// Session manager for persistence
    manager: SessionManager,
    /// The collaboration server (if we're the owner)
    server: Option<Arc<CollabServer>>,
    /// Our handle to the session
    handle: Option<CollabHandle>,
    /// Current annotations (reconstructed from operations)
    annotations: Arc<RwLock<Vec<Annotation>>>,
    /// Shutdown signal
    shutdown_tx: Option<mpsc::Sender<()>>,
}

impl Session {
    /// Connect to an existing session (client mode - never creates)
    ///
    /// Use this when you want to connect to a session created by another process.
    /// Returns an error if no session exists or connection fails.
    pub async fn connect(
        image_path: impl AsRef<Path>,
        client_type: ClientType,
    ) -> Result<Self, String> {
        let image_path = image_path.as_ref().to_path_buf();
        let manager = SessionManager::new(SessionManager::default_dir())
            .map_err(|e| format!("Failed to create session manager: {}", e))?;

        // Load existing session
        let existing_state = manager
            .load_session(&image_path)
            .map_err(|e| format!("Failed to load session: {}", e))?
            .ok_or_else(|| format!("No session exists for {}", image_path.display()))?;

        // Check socket exists
        if !existing_state.socket_path.exists() {
            return Err(format!(
                "Session socket not found: {}",
                existing_state.socket_path.display()
            ));
        }

        // Connect to existing session
        let handle =
            super::ipc::connect_to_session(&existing_state.socket_path, client_type).await?;

        Ok(Self {
            state: existing_state,
            manager,
            server: None,
            handle: Some(handle),
            annotations: Arc::new(RwLock::new(Vec::new())),
            shutdown_tx: None,
        })
    }

    /// Join or create a session for the given image (server mode)
    ///
    /// Use this when you want to create a session if none exists.
    pub async fn open(
        image_path: impl AsRef<Path>,
        client_type: ClientType,
    ) -> Result<Self, String> {
        let image_path = image_path.as_ref().to_path_buf();
        let manager = SessionManager::new(SessionManager::default_dir())
            .map_err(|e| format!("Failed to create session manager: {}", e))?;

        // Check if session already exists
        if let Some(existing_state) = manager
            .load_session(&image_path)
            .map_err(|e| format!("Failed to load session: {}", e))?
        {
            // Try to connect to existing session
            if existing_state.socket_path.exists() {
                match super::ipc::connect_to_session(&existing_state.socket_path, client_type).await
                {
                    Ok(handle) => {
                        return Ok(Self {
                            state: existing_state,
                            manager,
                            server: None,
                            handle: Some(handle),
                            annotations: Arc::new(RwLock::new(Vec::new())),
                            shutdown_tx: None,
                        });
                    }
                    Err(e) => {
                        tracing::warn!("Failed to connect to existing session, creating new: {}", e);
                        // Fall through to create new session
                    }
                }
            }
        }

        // Create new session
        let session_id = SessionId::from_file_path(&image_path);
        let socket_path = manager.socket_path(&image_path);
        let log_path = manager.log_path(&image_path);

        let log = OperationLog::open(&log_path)
            .map_err(|e| format!("Failed to open operation log: {}", e))?;

        // Replay log to get current annotations
        let annotations = log.replay();

        let state = SessionState::new(session_id, image_path.clone(), socket_path.clone());
        manager
            .save_session(&state)
            .map_err(|e| format!("Failed to save session: {}", e))?;

        let server = Arc::new(CollabServer::new(
            session_id,
            &socket_path,
            log,
            IpcConfig::default(),
        ));

        let handle = server.create_local_handle(client_type);

        // Start socket server in background
        let server_clone = Arc::clone(&server);
        let socket_path_clone = socket_path.clone();
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        tokio::spawn(async move {
            tokio::select! {
                result = super::ipc::start_socket_server(&socket_path_clone, server_clone) => {
                    if let Err(e) = result {
                        tracing::error!("Socket server error: {}", e);
                    }
                }
                _ = shutdown_rx.recv() => {
                    tracing::info!("Socket server shutting down");
                }
            }
        });

        Ok(Self {
            state,
            manager,
            server: Some(server),
            handle: Some(handle),
            annotations: Arc::new(RwLock::new(annotations)),
            shutdown_tx: Some(shutdown_tx),
        })
    }

    /// Create a session from existing annotations (for CLI use)
    pub fn from_annotations(
        image_path: impl AsRef<Path>,
        annotations: Vec<Annotation>,
        client_type: ClientType,
    ) -> Result<Self, String> {
        let image_path = image_path.as_ref().to_path_buf();
        let manager = SessionManager::new(SessionManager::default_dir())
            .map_err(|e| format!("Failed to create session manager: {}", e))?;

        let session_id = SessionId::from_file_path(&image_path);
        let socket_path = manager.socket_path(&image_path);
        let log_path = manager.log_path(&image_path);

        let mut log = OperationLog::open(&log_path)
            .map_err(|e| format!("Failed to open operation log: {}", e))?;

        // If log is empty, populate with initial annotations
        if log.is_empty() {
            let client_id = ClientId::from_raw(0);
            let mut timestamp = LogicalTimestamp::new(client_id);

            for annotation in &annotations {
                let op = CollabOperation::new(
                    timestamp.increment(),
                    AnnotationOp::Add {
                        id: annotation.id.0,
                        data: annotation_to_data(annotation),
                    },
                );
                log.append(op)
                    .map_err(|e| format!("Failed to append to log: {}", e))?;
            }
        }

        let state = SessionState::new(session_id, image_path.clone(), socket_path.clone());
        manager
            .save_session(&state)
            .map_err(|e| format!("Failed to save session: {}", e))?;

        let server = Arc::new(CollabServer::new(
            session_id,
            &socket_path,
            log,
            IpcConfig::default(),
        ));

        let handle = server.create_local_handle(client_type);

        Ok(Self {
            state,
            manager,
            server: Some(server),
            handle: Some(handle),
            annotations: Arc::new(RwLock::new(annotations)),
            shutdown_tx: None,
        })
    }

    /// Get session ID
    pub fn session_id(&self) -> SessionId {
        self.state.session_id
    }

    /// Get image path
    pub fn image_path(&self) -> &Path {
        &self.state.image_path
    }

    /// Get current annotations
    pub fn annotations(&self) -> Vec<Annotation> {
        self.annotations.read().clone()
    }

    /// Add an annotation
    pub fn add_annotation(&self, annotation: Annotation) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;

        let op = AnnotationOp::Add {
            id: annotation.id.0,
            data: annotation_to_data(&annotation),
        };

        handle.send_operation(op)?;

        // Apply locally
        self.annotations.write().push(annotation);

        Ok(())
    }

    /// Remove an annotation
    pub fn remove_annotation(&self, id: u64) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;

        handle.send_operation(AnnotationOp::Remove { id })?;

        // Apply locally
        self.annotations.write().retain(|a| a.id.0 != id);

        Ok(())
    }

    /// Move an annotation
    pub fn move_annotation(&self, id: u64, delta_x: f64, delta_y: f64) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;

        let op = AnnotationOp::Move {
            id,
            delta_x,
            delta_y,
        };

        handle.send_operation(op.clone())?;

        // Apply locally
        apply_operation(&mut self.annotations.write(), &op);

        Ok(())
    }

    /// Update annotation properties
    pub fn update_annotation(&self, id: u64, changes: Vec<PropertyChange>) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;

        let op = AnnotationOp::Update { id, changes };

        handle.send_operation(op.clone())?;

        // Apply locally
        apply_operation(&mut self.annotations.write(), &op);

        Ok(())
    }

    /// Get connected clients
    pub fn connected_clients(&self) -> Vec<ClientInfo> {
        self.handle
            .as_ref()
            .map(|h| h.connected_clients())
            .unwrap_or_default()
    }

    /// Check if we're the session owner
    pub fn is_owner(&self) -> bool {
        self.handle.as_ref().map(|h| h.is_owner()).unwrap_or(false)
    }

    /// Process incoming messages (call periodically)
    pub fn process_messages(&self) -> Result<usize, String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;
        let mut count = 0;

        while let Ok(msg) = handle.receiver.try_recv() {
            match msg {
                CollabMessage::Operation(op) => {
                    apply_operation(&mut self.annotations.write(), &op.operation);
                    count += 1;
                }
                CollabMessage::Pong { connected_clients: _ } => {
                    // Update client list if needed
                }
                _ => {}
            }
        }

        Ok(count)
    }

    /// Request save to disk
    pub fn request_save(&self) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;
        handle.request_save()
    }

    /// Get a reference to the collab handle for direct message access
    pub fn handle(&self) -> Option<&CollabHandle> {
        self.handle.as_ref()
    }

    /// Send annotation deltas to waiting CLI agents
    /// Used by GUI when user clicks "Send to Claude"
    pub fn send_to_agent(&self, payload: String) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;
        handle.send_operation(AnnotationOp::SendToAgent { payload })
    }

    /// Send a message to be displayed in the GUI
    /// Used by CLI to show questions/prompts to the user
    pub fn send_message(&self, message: String, source: &str) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;
        handle
            .sender
            .send(CollabMessage::ShowMessage {
                message,
                source: source.to_string(),
            })
            .map_err(|e| format!("Failed to send message: {}", e))
    }

    /// Send multiple annotations to be added in the GUI
    /// Used by CLI to batch-add annotations
    pub fn send_annotations(&self, annotations: Vec<AnnotationData>) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;
        handle
            .sender
            .send(CollabMessage::AddAnnotations {
                annotations,
                client_id: handle.client_id,
            })
            .map_err(|e| format!("Failed to send annotations: {}", e))
    }

    /// Request the GUI to quit gracefully
    /// Used by CLI to signal the GUI should exit after responding
    pub fn request_quit(&self) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("No session handle")?;
        handle
            .sender
            .send(CollabMessage::RequestQuit {
                client_id: handle.client_id,
            })
            .map_err(|e| format!("Failed to request quit: {}", e))
    }

    /// Block waiting for a SendToAgent message from GUI
    /// Returns the JSON payload when received
    /// Used by CLI feedback command to wait for user to click "Send"
    pub fn wait_for_send(&self, timeout: Duration) -> Result<String, String> {
        use super::types::CollabMessage;

        let handle = self.handle.as_ref().ok_or("No session handle")?;
        let deadline = std::time::Instant::now() + timeout;

        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err("Timeout waiting for send".to_string());
            }

            // Try to receive with timeout
            match handle.receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
                Ok(CollabMessage::Operation(op)) => {
                    // Check if this is a SendToAgent operation
                    if let AnnotationOp::SendToAgent { payload } = op.operation {
                        return Ok(payload);
                    }
                    // Other operations: apply to local state and continue waiting
                    apply_operation(&mut self.annotations.write(), &op.operation);
                }
                Ok(CollabMessage::Pong { .. }) => {
                    // Keepalive, continue waiting
                }
                Ok(_) => {
                    // Other messages, continue waiting
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    // Continue waiting
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    return Err("Session disconnected".to_string());
                }
            }
        }
    }

    /// Close the session
    pub fn close(mut self) -> Result<(), String> {
        if let Some(handle) = self.handle.take() {
            handle.disconnect();
        }

        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.blocking_send(());
        }

        if let Some(server) = self.server.take() {
            server.cleanup().map_err(|e| format!("Cleanup failed: {}", e))?;
        }

        // Only delete session files if we're the last client and owner
        if self.is_owner() && self.connected_clients().len() <= 1 {
            self.manager
                .delete_session(&self.state.image_path)
                .map_err(|e| format!("Failed to delete session: {}", e))?;
        }

        Ok(())
    }
}

/// Watch for file changes and sync with session
pub struct FileWatcher {
    session: Arc<Session>,
    _watcher: notify::RecommendedWatcher,
}

impl FileWatcher {
    /// Start watching for changes
    pub fn new(session: Arc<Session>) -> Result<Self, String> {
        use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

        let _session_clone = Arc::clone(&session);

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    if event.kind.is_modify() {
                        // File was modified externally, might need to reload
                        tracing::debug!("File changed: {:?}", event.paths);
                    }
                }
            },
            Config::default().with_poll_interval(Duration::from_millis(100)),
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        watcher
            .watch(session.image_path(), RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch file: {}", e))?;

        Ok(Self {
            session,
            _watcher: watcher,
        })
    }

    /// Get session reference
    pub fn session(&self) -> &Session {
        &self.session
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{AnnotationType, Point};

    #[tokio::test]
    async fn test_session_creation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let image_path = temp_dir.path().join("test.png");

        // Create empty image file
        std::fs::write(&image_path, &[]).unwrap();

        let session = Session::from_annotations(
            &image_path,
            vec![],
            ClientType::Cli,
        )
        .unwrap();

        assert!(session.is_owner());
        assert_eq!(session.annotations().len(), 0);
    }

    #[tokio::test]
    async fn test_add_annotation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let image_path = temp_dir.path().join("test.png");
        std::fs::write(&image_path, &[]).unwrap();

        let session = Session::from_annotations(
            &image_path,
            vec![],
            ClientType::Cli,
        )
        .unwrap();

        let annotation = Annotation::new(AnnotationType::Number {
            position: Point::new(100.0, 100.0),
            value: 1,
            radius: 15.0,
        });
        let id = annotation.id.0;

        session.add_annotation(annotation).unwrap();
        assert_eq!(session.annotations().len(), 1);

        session.remove_annotation(id).unwrap();
        assert_eq!(session.annotations().len(), 0);
    }
}
