//! Region selection capture
//!
//! Allows user to select a rectangular region of the screen to capture.

use super::CaptureResult;
use crate::core::{CaptureError, ImageSource, Point, NibImage, Region};
use std::time::SystemTime;

/// State for region selection
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SelectionState {
    /// Waiting for user to start selection
    Idle,
    /// User is dragging to select region
    Selecting { start: Point },
    /// Selection complete
    Complete { region: Region },
    /// User cancelled
    Cancelled,
}

/// Region selector interface
pub struct RegionSelector {
    state: SelectionState,
    #[allow(dead_code)]
    display_id: u32,
}

impl RegionSelector {
    pub fn new(display_id: u32) -> Self {
        Self {
            state: SelectionState::Idle,
            display_id,
        }
    }

    pub fn state(&self) -> SelectionState {
        self.state
    }

    pub fn start(&mut self, point: Point) {
        self.state = SelectionState::Selecting { start: point };
    }

    pub fn update(&mut self, current: Point) -> Option<Region> {
        if let SelectionState::Selecting { start } = self.state {
            Some(Region::from_points(start, current))
        } else {
            None
        }
    }

    pub fn finish(&mut self, end: Point) -> Option<Region> {
        if let SelectionState::Selecting { start } = self.state {
            let region = Region::from_points(start, end);
            if region.width > 10.0 && region.height > 10.0 {
                self.state = SelectionState::Complete { region };
                Some(region)
            } else {
                self.state = SelectionState::Cancelled;
                None
            }
        } else {
            None
        }
    }

    pub fn cancel(&mut self) {
        self.state = SelectionState::Cancelled;
    }
}

/// Capture a specific region of the screen
pub fn capture_region(display_id: u32, region: Region) -> CaptureResult<NibImage> {
    let screens = screenshots::Screen::all()
        .map_err(|e| CaptureError::CaptureFailed(e.to_string()))?;

    let screen = screens
        .into_iter()
        .find(|s| s.display_info.id == display_id)
        .ok_or(CaptureError::DisplayNotFound(display_id))?;

    let image = screen
        .capture_area(
            region.x as i32,
            region.y as i32,
            region.width as u32,
            region.height as u32,
        )
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
