//! Window capture using xcap

use nib_core::{CaptureError, ImageSource, NibImage};
use std::time::SystemTime;

/// Information about a capturable window
#[derive(Debug, Clone)]
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
}

/// List all capturable windows (excludes minimized and tiny helper windows)
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    let windows = xcap::Window::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to list windows: {}", e)))?;

    Ok(windows
        .into_iter()
        .filter_map(|w| {
            let is_minimized = w.is_minimized().unwrap_or(true);
            let title = w.title().unwrap_or_default();
            let app_name = w.app_name().unwrap_or_default();

            // Skip minimized windows and windows with no title/app
            if is_minimized || (title.is_empty() && app_name.is_empty()) {
                return None;
            }

            // Skip macOS system UI elements (menu bars, control center, etc.)
            const SYSTEM_APPS: &[&str] = &[
                "Window Server",
                "Control Center",
                "Notification Center",
                "SystemUIServer",
            ];
            if SYSTEM_APPS.iter().any(|&s| app_name == s) {
                return None;
            }

            // Skip very small windows (likely invisible helper windows)
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);
            if width < 50 || height < 50 {
                return None;
            }

            Some(WindowInfo {
                id: w.id().unwrap_or(0),
                app_name,
                title,
                x: w.x().unwrap_or(0),
                y: w.y().unwrap_or(0),
                width,
                height,
                is_minimized,
                is_focused: w.is_focused().unwrap_or(false),
            })
        })
        .collect())
}

/// Capture a specific window by app name (case-insensitive substring match)
pub fn capture_by_app(app_name: &str) -> Result<NibImage, CaptureError> {
    let windows = xcap::Window::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to list windows: {}", e)))?;

    let app_lower = app_name.to_lowercase();

    let window = windows
        .into_iter()
        .find(|w| {
            let name = w.app_name().unwrap_or_default().to_lowercase();
            let minimized = w.is_minimized().unwrap_or(true);
            !minimized && name.contains(&app_lower)
        })
        .ok_or_else(|| CaptureError::WindowNotFound(app_name.to_string()))?;

    capture_window(&window)
}

/// Capture a specific window by title (case-insensitive substring match)
pub fn capture_by_title(title: &str) -> Result<NibImage, CaptureError> {
    let windows = xcap::Window::all()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to list windows: {}", e)))?;

    let title_lower = title.to_lowercase();

    let window = windows
        .into_iter()
        .find(|w| {
            let t = w.title().unwrap_or_default().to_lowercase();
            let minimized = w.is_minimized().unwrap_or(true);
            !minimized && t.contains(&title_lower)
        })
        .ok_or_else(|| CaptureError::WindowNotFound(title.to_string()))?;

    capture_window(&window)
}

fn capture_window(window: &xcap::Window) -> Result<NibImage, CaptureError> {
    let image = window
        .capture_image()
        .map_err(|e| CaptureError::CaptureFailed(format!("Failed to capture window: {}", e)))?;

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
    .map_err(|e| CaptureError::CaptureFailed(format!("Failed to encode PNG: {}", e)))?;

    Ok(NibImage::new(
        png_data,
        width,
        height,
        ImageSource::ScreenCapture {
            display_id: 0,
            captured_at: SystemTime::now(),
        },
    ))
}
