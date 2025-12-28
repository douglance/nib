//! Real-time collaboration between CLI and GUI
//!
//! This module enables multiple Quill instances (CLI and GUI) to work on
//! the same image simultaneously with sub-millisecond synchronization.
//!
//! # Architecture
//!
//! - **Session**: A collaborative editing session for a single image
//! - **IPC**: Unix domain sockets for real-time message passing
//! - **Operation Log**: Append-only log for persistence and crash recovery
//! - **Lamport Clocks**: Logical timestamps for deterministic ordering

pub mod types;
pub mod operation;
pub mod session;
pub mod log;
pub mod ipc;

pub use types::*;
pub use operation::*;
pub use session::*;
