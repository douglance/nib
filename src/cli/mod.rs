//! CLI module - command-line interface for Nib
//!
//! Commands for Claude-human collaboration:
//! - gui: Launch GUI editor (human's entry point)
//! - capture: Screen/region capture
//! - ask-human: Request human feedback via GUI
//! - await-submit: Wait for annotation submit events
//! - annotation: Manage annotations (add/remove/clear/list)
//! - tile: Manage tiled captures (query/extract/list)
//! - render: Bake annotations onto image
//! - import/export: Convert between formats
//! - grid: Coordinate overlay for positioning
//! - find-text: OCR text search
//! - validate: Check QML syntax
//! - list: Recent captures
//! - sessions: Active collaboration sessions
//! - mcp-server: Claude Code integration

pub mod annotation_json;
pub mod args;
pub mod commands;

pub use args::*;
pub use commands::*;
