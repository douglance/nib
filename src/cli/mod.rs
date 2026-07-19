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
pub mod fields;
mod incurs_commands;
pub mod sessions;

pub use args::*;
pub use commands::*;
pub use sessions::*;

/// Builds the incurs-based CLI command tree.
///
/// Under active migration from clap (see `~/.claude/plans/what-would-it-look-typed-kettle.md`):
/// commands are ported one at a time and registered here; nothing is
/// registered yet. This runs behind the temporary `nib2` binary
/// (`src/main_incurs.rs`) so the existing clap-based `nib` binary and its
/// full test suite are unaffected while the migration is in progress.
pub fn build_cli() -> incurs::cli::Cli {
    let cli = incurs::cli::Cli::create("nib")
        .description("Fast, native screenshot annotation tool with semantic visual communication")
        .version(env!("CARGO_PKG_VERSION"));
    incurs_commands::register(cli)
}
