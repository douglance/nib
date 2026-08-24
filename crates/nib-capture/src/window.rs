//! Window capture using xcap

use crate::{
    default_backend, CaptureBackend, CaptureResult, CaptureSession, CaptureTarget, DisplayInfo,
};
use nib_core::{CaptureError, NibImage};

/// Information about a capturable window
#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub app_name: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_minimized: bool,
    pub is_focused: bool,
    pub display_id: Option<u32>,
}

/// List all capturable windows (excludes minimized and tiny helper windows)
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    default_backend().list_windows()
}

/// Capture a specific window by app name (case-insensitive substring match)
pub fn capture_by_app(app_name: &str) -> Result<NibImage, CaptureError> {
    let app_lower = app_name.to_lowercase();
    let window = list_windows()?
        .into_iter()
        .find(|window| window.app_name.to_lowercase().contains(&app_lower))
        .ok_or_else(|| CaptureError::WindowNotFound(app_name.to_string()))?;

    capture_by_id(window.id)
}

/// Capture a specific window by title (case-insensitive substring match)
pub fn capture_by_title(title: &str) -> Result<NibImage, CaptureError> {
    let title_lower = title.to_lowercase();
    let window = list_windows()?
        .into_iter()
        .find(|window| window.title.to_lowercase().contains(&title_lower))
        .ok_or_else(|| CaptureError::WindowNotFound(title.to_string()))?;

    capture_by_id(window.id)
}

pub fn capture_by_id(window_id: u32) -> CaptureResult<NibImage> {
    default_backend()
        .capture(CaptureTarget::WindowId(window_id))
        .map(CaptureSession::into_image)
}

pub fn windows_on_display(display_id: u32) -> Result<Vec<WindowInfo>, CaptureError> {
    Ok(list_windows()?
        .into_iter()
        .filter(|window| window.display_id == Some(display_id))
        .collect())
}

pub fn displays_for_windows() -> CaptureResult<Vec<DisplayInfo>> {
    default_backend().list_displays()
}
