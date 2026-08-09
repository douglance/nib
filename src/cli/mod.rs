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
//! - --mcp: Nib and Incurs Code Mode integration

pub mod annotation_json;
pub mod args;
pub mod auth;
pub mod commands;
pub mod fields;
mod incurs_commands;
pub mod protocol_commands;
pub mod sessions;
#[doc(hidden)]
pub mod web_feedback;

pub use args::*;
pub use commands::*;
pub use sessions::*;

/// Builds the canonical Incurs command tree used by the CLI, MCP discovery,
/// generated skills, and Code Mode.
pub fn build_cli() -> incurs::cli::Cli {
    let cli = incurs::cli::Cli::create("nib")
        .description("Fast, native screenshot annotation tool with semantic visual communication")
        .version(env!("CARGO_PKG_VERSION"))
        .globals::<incurs_commands::GlobalOptions>()
        .env_fields(<incurs_commands::NibEnv as incurs::schema::IncurSchema>::fields());
    incurs_commands::register(cli)
}
