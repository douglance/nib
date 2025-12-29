//! CLI module - command-line interface for Nib
//!
//! Provides subcommands for headless operations:
//! - capture: Screen/region capture
//! - annotate: Open editor or add annotations headlessly
//! - read: Extract QML from image
//! - validate: Check QML validity
//! - list: List recent captures
//! - folder: Open storage directory

pub mod args;
pub mod commands;

pub use args::*;
pub use commands::*;
