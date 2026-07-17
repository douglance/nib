//! Core types and business logic for Nib
//!
//! This module contains the fundamental types and pure business logic
//! with no I/O dependencies.

pub mod blur;
pub mod dash;
pub mod errors;
pub mod operations;
pub mod qml;
pub mod tile;
pub mod tile_error;
pub mod types;

pub use dash::dash_segments;
pub use errors::{CaptureError, ImageError, QmlError, NibError, Result, StorageError};
pub use tile::{
    calculate_zoom_levels, global_to_tile, tile_global_bounds, tile_to_global, TileBounds,
    TileConfig, TileEntry, TileFormat, TileId, TiledCaptureManifest, TiledImageSource,
    TiledOcrConfig, ZoomLevel,
};
pub use tile_error::{TileError, TileResult};
pub use types::*;
