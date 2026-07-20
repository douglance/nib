//! Core types for real-time collaboration

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::SystemTime;

/// Unique identifier for a collaboration session
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub uuid::Uuid);

impl SessionId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    /// Generate deterministic session ID from file path (for reconnection)
    pub fn from_file_path(path: &PathBuf) -> Self {
        use std::collections::hash_map::DefaultHasher;
        let mut hasher = DefaultHasher::new();
        path.hash(&mut hasher);
        let hash = hasher.finish();
        Self(uuid::Uuid::from_u64_pair(hash, 0))
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Unique identifier for a connected client
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ClientId(pub u64);

impl ClientId {
    pub fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        Self(COUNTER.fetch_add(1, AtomicOrdering::Relaxed))
    }

    /// Create a ClientId from a specific value (for deserialization)
    pub fn from_raw(id: u64) -> Self {
        Self(id)
    }
}

impl Default for ClientId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ClientId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "client-{}", self.0)
    }
}

/// Lamport logical timestamp for ordering operations
///
/// Provides a total ordering of events across distributed clients.
/// Uses (counter, client_id) to break ties deterministically.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LogicalTimestamp {
    pub counter: u64,
    pub client_id: ClientId,
}

impl LogicalTimestamp {
    pub fn new(client_id: ClientId) -> Self {
        Self {
            counter: 0,
            client_id,
        }
    }

    /// Increment and return new timestamp
    pub fn increment(&mut self) -> LogicalTimestamp {
        self.counter += 1;
        *self
    }

    /// Merge with received timestamp (Lamport clock rule)
    pub fn merge(&mut self, other: LogicalTimestamp) {
        self.counter = self.counter.max(other.counter) + 1;
    }
}

impl PartialEq for LogicalTimestamp {
    fn eq(&self, other: &Self) -> bool {
        self.counter == other.counter && self.client_id == other.client_id
    }
}

impl Eq for LogicalTimestamp {}

impl PartialOrd for LogicalTimestamp {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for LogicalTimestamp {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.counter.cmp(&other.counter) {
            Ordering::Equal => self.client_id.0.cmp(&other.client_id.0),
            other => other,
        }
    }
}

impl Hash for LogicalTimestamp {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.counter.hash(state);
        self.client_id.hash(state);
    }
}

/// Type of client (CLI or GUI)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientType {
    Cli,
    Gui,
    Tui,
}

impl std::fmt::Display for ClientType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientType::Cli => write!(f, "CLI"),
            ClientType::Gui => write!(f, "GUI"),
            ClientType::Tui => write!(f, "TUI"),
        }
    }
}

/// Information about a connected client
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub client_id: ClientId,
    pub client_type: ClientType,
    pub connected_at: SystemTime,
    pub last_seen: SystemTime,
}

impl ClientInfo {
    pub fn new(client_id: ClientId, client_type: ClientType) -> Self {
        let now = SystemTime::now();
        Self {
            client_id,
            client_type,
            connected_at: now,
            last_seen: now,
        }
    }

    pub fn touch(&mut self) {
        self.last_seen = SystemTime::now();
    }
}

/// Session state persisted to disk
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: SessionId,
    pub image_path: PathBuf,
    pub created_at: SystemTime,
    pub last_modified: SystemTime,
    pub connected_clients: Vec<ClientInfo>,
    pub operation_count: u64,
    pub socket_path: PathBuf,
}

impl SessionState {
    pub fn new(session_id: SessionId, image_path: PathBuf, socket_path: PathBuf) -> Self {
        let now = SystemTime::now();
        Self {
            session_id,
            image_path,
            created_at: now,
            last_modified: now,
            connected_clients: Vec::new(),
            operation_count: 0,
            socket_path,
        }
    }

    pub fn touch(&mut self) {
        self.last_modified = SystemTime::now();
    }

    pub fn add_client(&mut self, info: ClientInfo) {
        self.connected_clients.push(info);
        self.touch();
    }

    pub fn remove_client(&mut self, client_id: ClientId) {
        self.connected_clients.retain(|c| c.client_id != client_id);
        self.touch();
    }

    pub fn client_count(&self) -> usize {
        self.connected_clients.len()
    }
}

/// Message types for IPC communication between clients
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CollabMessage {
    /// Client joining session
    Join {
        client_id: ClientId,
        client_type: ClientType,
    },

    /// Client leaving session
    Leave { client_id: ClientId },

    /// New operation from a client
    Operation(CollabOperation),

    /// Request full state sync (on connect or after disconnect)
    SyncRequest {
        client_id: ClientId,
        last_known_timestamp: Option<LogicalTimestamp>,
    },

    /// Full state response with all operations since timestamp
    SyncResponse {
        operations: Vec<CollabOperation>,
        current_timestamp: LogicalTimestamp,
    },

    /// Acknowledge operation received
    Ack { timestamp: LogicalTimestamp },

    /// Heartbeat for connection health
    Ping { client_id: ClientId },

    /// Heartbeat response with client list
    Pong { connected_clients: Vec<ClientInfo> },

    /// Request to save image to disk
    SaveRequest { client_id: ClientId },

    /// Save completed notification
    SaveComplete { timestamp: LogicalTimestamp },

    /// Error message
    Error { message: String },

    /// Display a message/question to the user in the GUI
    ShowMessage { message: String, source: String },

    /// Add multiple annotations at once (for batch Claude annotations)
    AddAnnotations {
        annotations: Vec<AnnotationData>,
        client_id: ClientId,
    },

    /// Request that the GUI quit gracefully
    RequestQuit { client_id: ClientId },
}

/// A collaborative operation with metadata for sync
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollabOperation {
    /// Unique operation ID for deduplication
    pub op_id: uuid::Uuid,
    /// Logical timestamp for ordering
    pub timestamp: LogicalTimestamp,
    /// The actual annotation operation
    pub operation: AnnotationOp,
    /// Wall-clock time (for debugging/display)
    pub created_at: SystemTime,
}

impl CollabOperation {
    pub fn new(timestamp: LogicalTimestamp, operation: AnnotationOp) -> Self {
        Self {
            op_id: uuid::Uuid::new_v4(),
            timestamp,
            operation,
            created_at: SystemTime::now(),
        }
    }
}

impl PartialEq for CollabOperation {
    fn eq(&self, other: &Self) -> bool {
        self.op_id == other.op_id
    }
}

impl Eq for CollabOperation {}

impl Hash for CollabOperation {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.op_id.hash(state);
    }
}

/// Annotation-specific operations for collaboration
///
/// These are designed to be:
/// - Serializable (for network/disk)
/// - Composable (for conflict resolution)
/// - Invertible (for undo)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AnnotationOp {
    /// Add a new annotation
    Add { id: u64, data: AnnotationData },

    /// Remove an annotation
    Remove { id: u64 },

    /// Update specific properties
    Update {
        id: u64,
        changes: Vec<PropertyChange>,
    },

    /// Move annotation by delta
    Move { id: u64, delta_x: f64, delta_y: f64 },

    /// Change z-index
    Reorder { id: u64, new_z: i32 },

    /// Set visibility
    SetVisible { id: u64, visible: bool },

    /// Set lock state
    SetLocked { id: u64, locked: bool },

    /// Signal from GUI that user wants to send annotations to agent
    /// Contains JSON payload of annotation deltas (new/changed since last send)
    SendToAgent {
        /// Serialized annotation deltas as JSON
        payload: String,
    },
}

/// Serializable annotation data for network transfer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationData {
    pub annotation_type: AnnotationTypeData,
    pub color: [u8; 4],
    pub severity: String,
    pub label: Option<String>,
    pub z_index: i32,
    /// Owner of the annotation: "claude", "human", or "system"
    #[serde(default = "default_owner")]
    pub owner: String,
    /// Flat group membership (⌘G). Absent from old wire messages, which
    /// default to `None` (ungrouped).
    #[serde(default)]
    pub group_id: Option<u64>,
}

fn default_owner() -> String {
    "human".to_string()
}

/// Serializable annotation type variants
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AnnotationTypeData {
    Arrow {
        start_x: f64,
        start_y: f64,
        end_x: f64,
        end_y: f64,
        head: String,
        stroke_width: f64,
    },
    Box {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        stroke_width: f64,
        stroke_style: String,
        filled: bool,
        corner_radius: f64,
    },
    Text {
        x: f64,
        y: f64,
        content: String,
        font_size: f64,
        align: String,
        background: Option<[u8; 4]>,
        max_width: Option<f64>,
    },
    Number {
        x: f64,
        y: f64,
        value: u32,
        radius: f64,
    },
    Blur {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        intensity: String,
    },
    Highlight {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        corner_radius: f64,
    },
    Line {
        start_x: f64,
        start_y: f64,
        end_x: f64,
        end_y: f64,
        stroke_width: f64,
        stroke_style: String,
    },
    Ellipse {
        center_x: f64,
        center_y: f64,
        radius_x: f64,
        radius_y: f64,
        stroke_width: f64,
        filled: bool,
    },
    Crop {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Path {
        points: Vec<(f64, f64)>,
        stroke_width: f64,
        stroke_style: String,
    },
    /// Inserted image. Bytes are inlined as base64 (screenshot scale, so
    /// simplest wins over a separate asset-fetch protocol); `asset_hash` is
    /// carried too so a receiver can de-duplicate by content hash.
    Image {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        asset_hash: String,
        asset_base64: String,
        opacity: f64,
    },
}

/// A single property change for partial updates
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyChange {
    pub property: String,
    pub old_value: serde_json::Value,
    pub new_value: serde_json::Value,
}

impl PropertyChange {
    pub fn new(
        property: impl Into<String>,
        old_value: serde_json::Value,
        new_value: serde_json::Value,
    ) -> Self {
        Self {
            property: property.into(),
            old_value,
            new_value,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_logical_timestamp_ordering() {
        let client_a = ClientId::from_raw(1);
        let client_b = ClientId::from_raw(2);

        let ts_a = LogicalTimestamp {
            counter: 5,
            client_id: client_a,
        };
        let ts_b = LogicalTimestamp {
            counter: 5,
            client_id: client_b,
        };
        let ts_c = LogicalTimestamp {
            counter: 6,
            client_id: client_a,
        };

        // Same counter: client_id breaks tie
        assert!(ts_a < ts_b);

        // Higher counter always wins
        assert!(ts_a < ts_c);
        assert!(ts_b < ts_c);
    }

    #[test]
    fn test_lamport_clock_merge() {
        let client = ClientId::from_raw(1);
        let mut clock = LogicalTimestamp::new(client);

        // Local increment
        clock.increment();
        assert_eq!(clock.counter, 1);

        // Merge with higher remote timestamp
        let remote = LogicalTimestamp {
            counter: 10,
            client_id: ClientId::from_raw(2),
        };
        clock.merge(remote);
        assert_eq!(clock.counter, 11);
    }

    #[test]
    fn test_session_id_deterministic() {
        let path = PathBuf::from("/tmp/test.png");
        let id1 = SessionId::from_file_path(&path);
        let id2 = SessionId::from_file_path(&path);
        assert_eq!(id1, id2);
    }
}
