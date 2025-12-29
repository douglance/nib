//! Main window management

use crate::core::{NibImage, Result};
use std::path::PathBuf;

/// State for the main editor window
pub struct EditorWindow {
    /// Current document being edited
    pub document: Option<NibImage>,
    /// File path if saved
    pub file_path: Option<PathBuf>,
    /// Whether document has unsaved changes
    pub dirty: bool,
}

impl EditorWindow {
    pub fn new() -> Self {
        Self {
            document: None,
            file_path: None,
            dirty: false,
        }
    }

    pub fn open_file(&mut self, _path: PathBuf) -> Result<()> {
        // TODO: Load image and QML from file
        Ok(())
    }

    pub fn save(&mut self) -> Result<()> {
        // TODO: Save current document
        self.dirty = false;
        Ok(())
    }

    pub fn save_as(&mut self, _path: PathBuf) -> Result<()> {
        // TODO: Save to new path
        self.dirty = false;
        Ok(())
    }
}

impl Default for EditorWindow {
    fn default() -> Self {
        Self::new()
    }
}
