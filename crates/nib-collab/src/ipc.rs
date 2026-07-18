//! IPC layer using Unix domain sockets (or named pipes on Windows)
//!
//! Provides low-latency communication between CLI and GUI instances
//! editing the same image.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{bounded, Receiver, Sender};
use interprocess::local_socket::traits::tokio::Stream as StreamTrait;
use parking_lot::RwLock;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::broadcast;

use super::log::OperationLog;
use super::types::*;

/// Configuration for the IPC server
#[derive(Debug, Clone)]
pub struct IpcConfig {
    /// Heartbeat interval
    pub heartbeat_interval: Duration,
    /// Client timeout (no heartbeat response)
    pub client_timeout: Duration,
    /// Max message size in bytes
    pub max_message_size: usize,
}

impl Default for IpcConfig {
    fn default() -> Self {
        Self {
            heartbeat_interval: Duration::from_secs(5),
            client_timeout: Duration::from_secs(15),
            max_message_size: 1024 * 1024, // 1MB
        }
    }
}

/// Handle for a collaboration session
pub struct CollabHandle {
    /// Our client ID
    pub client_id: ClientId,
    /// Client type
    pub client_type: ClientType,
    /// Channel to send operations
    pub sender: Sender<CollabMessage>,
    /// Channel to receive operations
    pub receiver: Receiver<CollabMessage>,
    /// Shared session state
    state: Arc<RwLock<SharedState>>,
    /// Direct broadcast channel for local handles (None for remote clients)
    broadcast_tx: Option<broadcast::Sender<CollabMessage>>,
}

impl CollabHandle {
    /// Send an operation to all connected clients
    pub fn send_operation(&self, op: AnnotationOp) -> Result<(), String> {
        let timestamp = {
            let mut state = self.state.write();
            state.clock.increment()
        };

        let collab_op = CollabOperation::new(timestamp, op);

        // For local handles, broadcast directly
        // For remote clients, send via socket channel
        if let Some(ref broadcast_tx) = self.broadcast_tx {
            // Local handle: broadcast directly to all clients
            broadcast_tx
                .send(CollabMessage::Operation(collab_op))
                .map_err(|e| format!("Failed to broadcast operation: {}", e))?;
            Ok(())
        } else {
            // Remote client: send via socket channel
            self.sender
                .send(CollabMessage::Operation(collab_op))
                .map_err(|e| format!("Failed to send operation: {}", e))
        }
    }

    /// Request a save to disk
    pub fn request_save(&self) -> Result<(), String> {
        self.sender
            .send(CollabMessage::SaveRequest {
                client_id: self.client_id,
            })
            .map_err(|e| format!("Failed to request save: {}", e))
    }

    /// Get list of connected clients
    pub fn connected_clients(&self) -> Vec<ClientInfo> {
        self.state.read().clients.clone()
    }

    /// Get current logical timestamp
    pub fn current_timestamp(&self) -> LogicalTimestamp {
        self.state.read().clock
    }

    /// Check if we're the session owner (first client)
    pub fn is_owner(&self) -> bool {
        let state = self.state.read();
        state
            .clients
            .first()
            .map(|c| c.client_id == self.client_id)
            .unwrap_or(false)
    }

    /// Disconnect from the session
    pub fn disconnect(&self) {
        let _ = self.sender.send(CollabMessage::Leave {
            client_id: self.client_id,
        });
    }
}

impl CollabServer {
    /// Subscribe to broadcast messages
    pub fn subscribe(&self) -> broadcast::Receiver<CollabMessage> {
        self.broadcast_tx.subscribe()
    }
}

/// Shared state between server and clients
#[derive(Debug)]
struct SharedState {
    clock: LogicalTimestamp,
    clients: Vec<ClientInfo>,
}

/// Collaboration server that manages a session
pub struct CollabServer {
    session_id: SessionId,
    socket_path: std::path::PathBuf,
    state: Arc<RwLock<SharedState>>,
    log: Arc<RwLock<OperationLog>>,
    broadcast_tx: broadcast::Sender<CollabMessage>,
    #[allow(dead_code)]
    config: IpcConfig,
}

impl CollabServer {
    /// Create a new collaboration server
    pub fn new(
        session_id: SessionId,
        socket_path: impl AsRef<Path>,
        log: OperationLog,
        config: IpcConfig,
    ) -> Self {
        let (broadcast_tx, _) = broadcast::channel(256);

        let initial_timestamp = log
            .current_timestamp()
            .unwrap_or_else(|| LogicalTimestamp::new(ClientId::from_raw(0)));

        Self {
            session_id,
            socket_path: socket_path.as_ref().to_path_buf(),
            state: Arc::new(RwLock::new(SharedState {
                clock: initial_timestamp,
                clients: Vec::new(),
            })),
            log: Arc::new(RwLock::new(log)),
            broadcast_tx,
            config,
        }
    }

    /// Get the session ID
    pub fn session_id(&self) -> SessionId {
        self.session_id
    }

    /// Get socket path
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Create a local handle for in-process communication (no socket)
    pub fn create_local_handle(&self, client_type: ClientType) -> CollabHandle {
        let client_id = ClientId::new();
        let (tx, rx) = bounded(256);

        // Add client to state
        {
            let mut state = self.state.write();
            state.clients.push(ClientInfo::new(client_id, client_type));
        }

        // Subscribe to broadcasts
        let mut broadcast_rx = self.broadcast_tx.subscribe();
        let tx_clone = tx.clone();

        // Forward broadcasts to channel
        tokio::spawn(async move {
            while let Ok(msg) = broadcast_rx.recv().await {
                if tx_clone.send(msg).is_err() {
                    break;
                }
            }
        });

        CollabHandle {
            client_id,
            client_type,
            sender: tx,
            receiver: rx,
            state: Arc::clone(&self.state),
            broadcast_tx: Some(self.broadcast_tx.clone()),
        }
    }

    /// Process a message from a client
    pub fn process_message(&self, msg: CollabMessage) -> Option<CollabMessage> {
        match msg {
            CollabMessage::Join {
                client_id,
                client_type,
            } => {
                let mut state = self.state.write();
                state.clients.push(ClientInfo::new(client_id, client_type));

                // Return all operations for sync
                let log = self.log.read();
                let operations: Vec<CollabOperation> = log.operations().to_vec();
                let current_timestamp = state.clock;

                Some(CollabMessage::SyncResponse {
                    operations,
                    current_timestamp,
                })
            }

            CollabMessage::Leave { client_id } => {
                let mut state = self.state.write();
                state.clients.retain(|c| c.client_id != client_id);
                None
            }

            CollabMessage::Operation(op) => {
                // Update clock
                {
                    let mut state = self.state.write();
                    state.clock.merge(op.timestamp);
                }

                // Persist to log
                {
                    let mut log = self.log.write();
                    if let Err(e) = log.append(op.clone()) {
                        tracing::error!("Failed to persist operation: {}", e);
                    }
                }

                // Broadcast to all clients
                let _ = self.broadcast_tx.send(CollabMessage::Operation(op.clone()));

                Some(CollabMessage::Ack {
                    timestamp: op.timestamp,
                })
            }

            CollabMessage::SyncRequest {
                client_id: _,
                last_known_timestamp,
            } => {
                let log = self.log.read();
                let state = self.state.read();

                let operations: Vec<CollabOperation> = log
                    .operations_since(last_known_timestamp)
                    .into_iter()
                    .cloned()
                    .collect();

                Some(CollabMessage::SyncResponse {
                    operations,
                    current_timestamp: state.clock,
                })
            }

            CollabMessage::Ping { client_id } => {
                // Update last_seen for client
                {
                    let mut state = self.state.write();
                    if let Some(client) =
                        state.clients.iter_mut().find(|c| c.client_id == client_id)
                    {
                        client.touch();
                    }
                }

                let state = self.state.read();
                Some(CollabMessage::Pong {
                    connected_clients: state.clients.clone(),
                })
            }

            CollabMessage::SaveRequest { client_id: _ } => {
                // TODO: Trigger save to PNG
                let state = self.state.read();
                Some(CollabMessage::SaveComplete {
                    timestamp: state.clock,
                })
            }

            CollabMessage::ShowMessage { message, source } => {
                // Broadcast to all clients (especially GUI)
                let _ = self
                    .broadcast_tx
                    .send(CollabMessage::ShowMessage { message, source });
                None
            }

            CollabMessage::AddAnnotations {
                annotations,
                client_id: _,
            } => {
                // Generate IDs and create operations for each annotation
                static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

                for data in annotations {
                    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let timestamp = {
                        let mut state = self.state.write();
                        state.clock.increment()
                    };

                    let op = CollabOperation::new(timestamp, AnnotationOp::Add { id, data });

                    // Persist to log
                    {
                        let mut log = self.log.write();
                        if let Err(e) = log.append(op.clone()) {
                            tracing::error!("Failed to persist annotation: {}", e);
                        }
                    }

                    // Broadcast to all clients
                    let _ = self.broadcast_tx.send(CollabMessage::Operation(op));
                }

                Some(CollabMessage::Ack {
                    timestamp: self.state.read().clock,
                })
            }

            CollabMessage::RequestQuit { client_id } => {
                // Broadcast quit request to all clients (GUI will handle it)
                let _ = self
                    .broadcast_tx
                    .send(CollabMessage::RequestQuit { client_id });
                None
            }

            _ => None,
        }
    }

    /// Get current annotations by replaying the log
    pub fn get_annotations(&self) -> Vec<nib_core::Annotation> {
        self.log.read().replay()
    }

    /// Get client count
    pub fn client_count(&self) -> usize {
        self.state.read().clients.len()
    }

    /// Cleanup: remove socket file
    pub fn cleanup(&self) -> std::io::Result<()> {
        if self.socket_path.exists() {
            std::fs::remove_file(&self.socket_path)?;
        }
        Ok(())
    }
}

/// Connect to an existing session via socket
pub async fn connect_to_session(
    socket_path: impl AsRef<Path>,
    client_type: ClientType,
) -> Result<CollabHandle, String> {
    use interprocess::local_socket::tokio::prelude::*;
    use interprocess::local_socket::GenericFilePath;

    let socket_path = socket_path.as_ref();
    let name = socket_path
        .to_str()
        .ok_or("Invalid socket path")?
        .to_fs_name::<GenericFilePath>()
        .map_err(|e| format!("Failed to create socket name: {}", e))?;

    let stream = interprocess::local_socket::tokio::Stream::connect(name)
        .await
        .map_err(|e| format!("Failed to connect to session: {}", e))?;

    let (reader, mut writer) = stream.split();
    let mut reader = BufReader::new(reader);

    let client_id = ClientId::new();

    // Send join message
    let join_msg = CollabMessage::Join {
        client_id,
        client_type,
    };
    let json = serde_json::to_string(&join_msg).map_err(|e| e.to_string())?;
    writer
        .write_all(format!("{}\n", json).as_bytes())
        .await
        .map_err(|e| format!("Failed to send join: {}", e))?;

    // Read sync response
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("Failed to read sync response: {}", e))?;

    let sync_response: CollabMessage =
        serde_json::from_str(&line).map_err(|e| format!("Invalid sync response: {}", e))?;

    let current_timestamp = match sync_response {
        CollabMessage::SyncResponse {
            current_timestamp, ..
        } => current_timestamp,
        _ => return Err("Unexpected response to join".to_string()),
    };

    let (tx, rx) = bounded(256);
    let tx_clone = tx.clone();

    // Spawn reader task
    tokio::spawn(async move {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    if let Ok(msg) = serde_json::from_str::<CollabMessage>(&line) {
                        if tx_clone.send(msg).is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Spawn writer task
    let (write_tx, write_rx) = bounded::<CollabMessage>(256);
    tokio::spawn(async move {
        while let Ok(msg) = write_rx.recv() {
            if let Ok(json) = serde_json::to_string(&msg) {
                if writer
                    .write_all(format!("{}\n", json).as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    });

    Ok(CollabHandle {
        client_id,
        client_type,
        sender: write_tx,
        receiver: rx,
        state: Arc::new(RwLock::new(SharedState {
            clock: current_timestamp,
            clients: Vec::new(),
        })),
        broadcast_tx: None, // Remote clients don't broadcast directly
    })
}

/// Start a socket server for remote clients
pub async fn start_socket_server(
    socket_path: impl AsRef<Path>,
    server: Arc<CollabServer>,
) -> Result<(), String> {
    use interprocess::local_socket::tokio::prelude::*;
    use interprocess::local_socket::GenericFilePath;
    use interprocess::local_socket::ListenerOptions;

    let socket_path = socket_path.as_ref();

    // Remove existing socket file
    if socket_path.exists() {
        std::fs::remove_file(socket_path)
            .map_err(|e| format!("Failed to remove old socket: {}", e))?;
    }

    let name = socket_path
        .to_str()
        .ok_or("Invalid socket path")?
        .to_fs_name::<GenericFilePath>()
        .map_err(|e| format!("Failed to create socket name: {}", e))?;

    let listener = ListenerOptions::new()
        .name(name)
        .create_tokio()
        .map_err(|e| format!("Failed to bind socket: {}", e))?;

    tracing::info!("Collaboration server listening on {:?}", socket_path);

    loop {
        match listener.accept().await {
            Ok(stream) => {
                let server = Arc::clone(&server);
                tokio::spawn(async move {
                    if let Err(e) = handle_client(stream, server).await {
                        tracing::warn!("Client error: {}", e);
                    }
                });
            }
            Err(e) => {
                tracing::error!("Accept error: {}", e);
            }
        }
    }
}

async fn handle_client(
    stream: interprocess::local_socket::tokio::Stream,
    server: Arc<CollabServer>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;

    let (reader, writer) = stream.split();
    let mut reader = BufReader::new(reader);
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    // Subscribe to broadcasts for this client
    let mut broadcast_rx = server.subscribe();

    // Spawn task to forward broadcasts to client socket
    let writer_clone = Arc::clone(&writer);
    let broadcast_task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Ok(msg) = broadcast_rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                let mut w = writer_clone.lock().await;
                if w.write_all(format!("{}\n", json).as_bytes()).await.is_err() {
                    break;
                }
                // Flush immediately so CLI receives the message
                if w.flush().await.is_err() {
                    break;
                }
            }
        }
    });

    // Read messages from client
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                let msg: CollabMessage =
                    serde_json::from_str(&line).map_err(|e| format!("Invalid message: {}", e))?;

                if let Some(response) = server.process_message(msg) {
                    use tokio::io::AsyncWriteExt;
                    let json = serde_json::to_string(&response).map_err(|e| e.to_string())?;
                    let mut w = writer.lock().await;
                    w.write_all(format!("{}\n", json).as_bytes())
                        .await
                        .map_err(|e| format!("Write error: {}", e))?;
                    w.flush().await.map_err(|e| format!("Flush error: {}", e))?;
                }
            }
            Err(e) => {
                broadcast_task.abort();
                return Err(format!("Read error: {}", e));
            }
        }
    }

    broadcast_task.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_local_handle() {
        let temp_dir = tempfile::tempdir().unwrap();
        let log_path = temp_dir.path().join("test.ops.jsonl");
        let socket_path = temp_dir.path().join("test.sock");

        let log = OperationLog::open(&log_path).unwrap();
        let session_id = SessionId::new();
        let server = CollabServer::new(session_id, &socket_path, log, IpcConfig::default());

        // Create two handles
        let handle1 = server.create_local_handle(ClientType::Cli);
        let handle2 = server.create_local_handle(ClientType::Gui);

        assert_eq!(server.client_count(), 2);
        assert!(handle1.is_owner());
        assert!(!handle2.is_owner());
    }
}
