//! Storage module
//!
//! Handles file I/O for Nib documents:
//! - QML file format
//! - PNG export with embedded QML
//! - SQLite index for search

pub mod export;
pub mod index;
pub mod qml_file;

pub use export::{export_image, export_to_clipboard, ExportFormat, ExportOptions};
pub use index::{ImageEntry, Index, SearchQuery};
pub use qml_file::{load_qml_file, load_qml_image, save_qml_file, save_qml_image};

use crate::core::StorageError;
use std::path::PathBuf;

/// Result type for storage operations
pub type StorageResult<T> = std::result::Result<T, StorageError>;

/// Get the default storage directory
pub fn storage_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("nib")
}

/// Get the captures directory
pub fn captures_dir() -> PathBuf {
    storage_dir().join("captures")
}

/// Get the database path
pub fn database_path() -> PathBuf {
    storage_dir().join("nib.db")
}

/// Initialize storage directories
pub fn init_storage() -> StorageResult<()> {
    let dirs = [storage_dir(), captures_dir()];

    for dir in &dirs {
        if !dir.exists() {
            std::fs::create_dir_all(dir)?;
        }
    }

    Ok(())
}
