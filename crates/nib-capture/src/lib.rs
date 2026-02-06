//! Screen capture module
//!
//! Provides cross-platform screen capture functionality:
//! - Full screen capture
//! - Region selection capture
//! - Window capture (platform-specific)
//! - Tiled capture for large images

pub mod region;
pub mod screen;
pub mod tiled;
pub mod window;

pub use tiled::{generate_tiles, TiledCapture};
pub use window::{capture_by_app, capture_by_title, list_windows, WindowInfo};

use nib_core::{CaptureError, ImageSource, NibImage};
use std::time::SystemTime;

/// Result type for capture operations
pub type CaptureResult<T> = std::result::Result<T, CaptureError>;

/// Capture the entire screen
pub fn capture_screen(display_id: u32) -> CaptureResult<NibImage> {
    let screens = screenshots::Screen::all()
        .map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;

    let screen = screens
        .into_iter()
        .find(|s| s.display_info.id == display_id)
        .ok_or(CaptureError::DisplayNotFound(display_id))?;

    let image = screen
        .capture()
        .map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;

    let width = image.width();
    let height = image.height();

    // Convert to PNG bytes
    let mut png_data = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        width,
        height,
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;

    Ok(NibImage::new(
        png_data,
        width,
        height,
        ImageSource::ScreenCapture {
            display_id,
            captured_at: SystemTime::now(),
        },
    ))
}

/// Get list of available displays
pub fn list_displays() -> CaptureResult<Vec<DisplayInfo>> {
    let screens = screenshots::Screen::all()
        .map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;

    Ok(screens
        .into_iter()
        .map(|s| DisplayInfo {
            id: s.display_info.id,
            name: format!("Display {}", s.display_info.id),
            x: s.display_info.x,
            y: s.display_info.y,
            width: s.display_info.width,
            height: s.display_info.height,
            is_primary: s.display_info.is_primary,
        })
        .collect())
}

/// Information about a display
#[derive(Debug, Clone)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}
