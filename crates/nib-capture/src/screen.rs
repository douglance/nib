//! Full screen capture

use super::CaptureResult;
use crate::{default_backend, CaptureBackend, CaptureSession, CaptureTarget};

/// Capture the primary display
pub fn capture_primary() -> CaptureResult<nib_core::NibImage> {
    default_backend()
        .capture(CaptureTarget::Primary)
        .map(CaptureSession::into_image)
}

/// Capture a specific display by ID
pub fn capture_display(display_id: u32) -> CaptureResult<nib_core::NibImage> {
    super::capture_screen(display_id)
}

/// Capture all displays and stitch into single image
pub fn capture_all() -> CaptureResult<nib_core::NibImage> {
    default_backend()
        .capture(CaptureTarget::AllDisplays)
        .map(CaptureSession::into_image)
}
