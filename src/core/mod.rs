//! Core types and business logic for Quill
//!
//! This module contains the fundamental types and pure business logic
//! with no I/O dependencies.

pub mod errors;
pub mod operations;
pub mod qml;
pub mod types;

pub use errors::{CaptureError, ImageError, QmlError, QuillError, Result, StorageError};
pub use types::*;
