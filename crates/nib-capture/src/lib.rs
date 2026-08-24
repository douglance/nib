//! Screen capture module
//!
//! Provides cross-platform screen capture functionality:
//! - Full screen capture
//! - Region selection capture
//! - Window capture (platform-specific)
//! - Tiled capture for large images

pub mod backend;
pub mod region;
pub mod screen;
pub mod tiled;
pub mod window;

pub use backend::{
    backend_not_available, default_backend, logical_to_physical_region, CaptureBackend,
    CaptureCapabilities, CaptureSession, CaptureTarget, CapturedFrame, PhysicalRegion, XcapBackend,
};
pub use tiled::{generate_tiles, TiledCapture};
pub use window::{capture_by_app, capture_by_title, list_windows, WindowInfo};

use nib_core::{CaptureError, NibImage};

/// Result type for capture operations
pub type CaptureResult<T> = std::result::Result<T, CaptureError>;

/// Capture the entire screen
pub fn capture_screen(display_id: u32) -> CaptureResult<NibImage> {
    default_backend()
        .capture(CaptureTarget::DisplayId(display_id))
        .map(CaptureSession::into_image)
}

/// Get list of available displays
pub fn list_displays() -> CaptureResult<Vec<DisplayInfo>> {
    default_backend().list_displays()
}

/// Information about a display
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub physical_width: u32,
    pub physical_height: u32,
    pub is_primary: bool,
}
