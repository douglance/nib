//! MCP (Model Context Protocol) server for Nib
//!
//! Enables real-time bidirectional communication between Claude and Nib.
//! Claude can add/read/modify annotations and receive push notifications
//! when humans create annotations in the GUI.
//!
//! # Usage
//!
//! ```bash
//! nib mcp-server --image /path/to/image.png
//! ```
//!
//! # Tools
//!
//! - `add_annotation` - Add annotation to image
//! - `read_annotations` - Read current annotations
//! - `remove_annotation` - Remove annotation by ID
//! - `clear_annotations` - Clear all annotations
//! - `render` - Render annotations onto image
//! - `wait_for_events` - Block until human adds annotations or timeout

mod server;
mod tools;
mod watcher;

pub use server::{run_mcp_server, NibMcpServer};
pub use watcher::AnnotationWatcher;
