//! Error types for Quill operations

use std::io;
use thiserror::Error;

/// Errors that can occur during QML parsing/serialization
#[derive(Error, Debug)]
pub enum QmlError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("Parse error at line {line}: {message}")]
    Parse { line: usize, message: String },

    #[error("Invalid version: expected {expected}, got {got}")]
    InvalidVersion { expected: String, got: String },

    #[error("Unknown annotation type: {0}")]
    UnknownAnnotationType(String),

    #[error("Missing required field: {0}")]
    MissingField(String),

    #[error("Invalid value for field '{field}': {message}")]
    InvalidValue { field: String, message: String },
}

/// Errors that can occur during screen capture
#[derive(Error, Debug)]
pub enum CaptureError {
    #[error("Screen capture failed: {0}")]
    CaptureFailed(String),

    #[error("No display found with id {0}")]
    DisplayNotFound(u32),

    #[error("Window not found: {0}")]
    WindowNotFound(String),

    #[error("Permission denied for screen capture")]
    PermissionDenied,

    #[error("Capture cancelled by user")]
    Cancelled,

    #[error("Platform not supported: {0}")]
    PlatformNotSupported(String),
}

/// Errors that can occur during image processing
#[derive(Error, Debug)]
pub enum ImageError {
    #[error("Failed to load image: {0}")]
    LoadFailed(String),

    #[error("Failed to decode image: {0}")]
    DecodeError(String),

    #[error("Failed to encode image: {0}")]
    EncodeError(String),

    #[error("Failed to encode image: {0}")]
    EncodeFailed(String),

    #[error("Invalid image dimensions: {width}x{height}")]
    InvalidDimensions { width: u32, height: u32 },

    #[error("Unsupported format: {0}")]
    UnsupportedFormat(String),
}

/// Errors that can occur during storage operations
#[derive(Error, Debug)]
pub enum StorageError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("File not found: {0}")]
    NotFound(String),

    #[error("Invalid file format: {0}")]
    InvalidFormat(String),
}

impl From<rusqlite::Error> for StorageError {
    fn from(err: rusqlite::Error) -> Self {
        StorageError::Database(err.to_string())
    }
}

/// Top-level application error
#[derive(Error, Debug)]
pub enum QuillError {
    #[error("QML error: {0}")]
    Qml(#[from] QmlError),

    #[error("Capture error: {0}")]
    Capture(#[from] CaptureError),

    #[error("Image error: {0}")]
    Image(#[from] ImageError),

    #[error("Storage error: {0}")]
    Storage(#[from] StorageError),

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("Clipboard error: {0}")]
    Clipboard(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, QuillError>;
