//! Error types for tiled capture operations

use std::path::PathBuf;
use thiserror::Error;

/// Errors that can occur during tiled capture operations
#[derive(Error, Debug)]
pub enum TileError {
    #[error("Tile not found: z{zoom}/{x}_{y}")]
    TileNotFound { zoom: u8, x: u32, y: u32 },

    #[error("Invalid zoom level {0} (max: {1})")]
    InvalidZoomLevel(u8, u8),

    #[error("Manifest not found at {0}")]
    ManifestNotFound(PathBuf),

    #[error("Invalid manifest format: {0}")]
    InvalidManifest(String),

    #[error("Spatial index corrupted: {0}")]
    SpatialIndexCorrupted(String),

    #[error("Region out of bounds: ({x}, {y}) is outside image ({width}x{height})")]
    RegionOutOfBounds {
        x: f64,
        y: f64,
        width: u32,
        height: u32,
    },

    #[error("Tile generation failed for z{zoom}/{x}_{y}: {reason}")]
    TileGenerationFailed {
        zoom: u8,
        x: u32,
        y: u32,
        reason: String,
    },

    #[error("OCR failed for tile z{zoom}/{x}_{y}: {reason}")]
    OcrFailed {
        zoom: u8,
        x: u32,
        y: u32,
        reason: String,
    },

    #[error("Invalid tile config: {0}")]
    InvalidConfig(String),

    #[error("Capture directory already exists: {0}")]
    DirectoryExists(PathBuf),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Result type alias for tile operations
pub type TileResult<T> = Result<T, TileError>;

impl TileError {
    /// Create a TileNotFound error from a tile ID
    pub fn tile_not_found(zoom: u8, x: u32, y: u32) -> Self {
        Self::TileNotFound { zoom, x, y }
    }

    /// Create a TileGenerationFailed error
    pub fn generation_failed(zoom: u8, x: u32, y: u32, reason: impl Into<String>) -> Self {
        Self::TileGenerationFailed {
            zoom,
            x,
            y,
            reason: reason.into(),
        }
    }

    /// Create an OcrFailed error
    pub fn ocr_failed(zoom: u8, x: u32, y: u32, reason: impl Into<String>) -> Self {
        Self::OcrFailed {
            zoom,
            x,
            y,
            reason: reason.into(),
        }
    }

    /// Check if this is a "not found" type error
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::TileNotFound { .. } | Self::ManifestNotFound(_))
    }

    /// Check if this is a validation/format error
    pub fn is_validation_error(&self) -> bool {
        matches!(
            self,
            Self::InvalidZoomLevel(_, _)
                | Self::InvalidManifest(_)
                | Self::InvalidConfig(_)
                | Self::RegionOutOfBounds { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tile_not_found_display() {
        let err = TileError::tile_not_found(2, 3, 1);
        assert_eq!(format!("{}", err), "Tile not found: z2/3_1");
    }

    #[test]
    fn test_is_not_found() {
        let err = TileError::tile_not_found(2, 3, 1);
        assert!(err.is_not_found());

        let err = TileError::ManifestNotFound(PathBuf::from("/test"));
        assert!(err.is_not_found());

        let err = TileError::InvalidZoomLevel(5, 3);
        assert!(!err.is_not_found());
    }

    #[test]
    fn test_is_validation_error() {
        let err = TileError::InvalidZoomLevel(5, 3);
        assert!(err.is_validation_error());

        let err = TileError::InvalidConfig("bad config".to_string());
        assert!(err.is_validation_error());

        let err = TileError::tile_not_found(2, 3, 1);
        assert!(!err.is_validation_error());
    }

    #[test]
    fn test_generation_failed() {
        let err = TileError::generation_failed(2, 3, 1, "scaling error");
        match err {
            TileError::TileGenerationFailed { zoom, x, y, reason } => {
                assert_eq!(zoom, 2);
                assert_eq!(x, 3);
                assert_eq!(y, 1);
                assert_eq!(reason, "scaling error");
            }
            _ => panic!("Expected TileGenerationFailed"),
        }
    }
}
