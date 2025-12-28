//! Full screen capture

use super::CaptureResult;
use crate::core::{CaptureError, QuillImage};

/// Capture the primary display
pub fn capture_primary() -> CaptureResult<QuillImage> {
    let screens = screenshots::Screen::all()
        .map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;

    let primary = screens
        .into_iter()
        .find(|s| s.display_info.is_primary)
        .ok_or_else(|| CaptureError::CaptureFailed("No primary display found".to_string()))?;

    capture_display(primary.display_info.id)
}

/// Capture a specific display by ID
pub fn capture_display(display_id: u32) -> CaptureResult<QuillImage> {
    super::capture_screen(display_id)
}

/// Capture all displays and stitch into single image
pub fn capture_all() -> CaptureResult<QuillImage> {
    let screens = screenshots::Screen::all()
        .map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;

    if screens.is_empty() {
        return Err(CaptureError::CaptureFailed("No displays found".to_string()));
    }

    // For now, just capture the first display
    // TODO: Implement multi-display stitching
    let screen = &screens[0];
    capture_display(screen.display_info.id)
}
