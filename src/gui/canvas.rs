//! Image canvas with pan/zoom support (Figma-like mechanics)

use crate::core::Point;

/// Minimum zoom level (10%)
pub const MIN_ZOOM: f64 = 0.1;
/// Maximum zoom level (1000%)
pub const MAX_ZOOM: f64 = 10.0;
/// Zoom factor per scroll tick (1.1 = 10% per tick)
pub const ZOOM_FACTOR: f64 = 1.1;

/// Canvas viewport state with Figma-like zoom/pan
#[derive(Debug, Clone)]
pub struct Canvas {
    /// Current zoom level (1.0 = 100%)
    pub zoom: f64,
    /// Pan offset in screen coordinates (where top-left of image appears)
    pub offset: Point,
    /// Canvas viewport size in screen pixels
    pub viewport_width: f64,
    pub viewport_height: f64,
    /// Image dimensions in pixels
    pub image_width: f64,
    pub image_height: f64,
    /// Whether the canvas has been manually zoomed/panned (vs fit-to-view)
    pub is_user_transformed: bool,
}

impl Canvas {
    /// Create a new canvas with given image and viewport dimensions
    pub fn new(image_width: u32, image_height: u32) -> Self {
        Self {
            zoom: 1.0,
            offset: Point::new(0.0, 0.0),
            viewport_width: 800.0,
            viewport_height: 600.0,
            image_width: image_width as f64,
            image_height: image_height as f64,
            is_user_transformed: false,
        }
    }

    /// Update viewport dimensions (call on window resize)
    pub fn set_viewport(&mut self, width: f64, height: f64) {
        let old_width = self.viewport_width;
        let old_height = self.viewport_height;
        self.viewport_width = width;
        self.viewport_height = height;

        // If not user-transformed, re-fit to view
        if !self.is_user_transformed {
            self.fit_to_view();
        } else {
            // Keep image centered when viewport changes
            self.offset.x += (width - old_width) / 2.0;
            self.offset.y += (height - old_height) / 2.0;
        }
    }

    /// Get the current scale factor (same as zoom)
    pub fn scale(&self) -> f32 {
        self.zoom as f32
    }

    /// Get the current offset as (x, y) tuple
    pub fn offset_tuple(&self) -> (f32, f32) {
        (self.offset.x as f32, self.offset.y as f32)
    }

    /// Convert screen coordinates to image coordinates
    pub fn screen_to_image(&self, screen_x: f32, screen_y: f32) -> (f64, f64) {
        (
            (screen_x as f64 - self.offset.x) / self.zoom,
            (screen_y as f64 - self.offset.y) / self.zoom,
        )
    }

    /// Convert image coordinates to screen coordinates
    pub fn image_to_screen(&self, image_x: f64, image_y: f64) -> (f32, f32) {
        (
            (image_x * self.zoom + self.offset.x) as f32,
            (image_y * self.zoom + self.offset.y) as f32,
        )
    }

    /// Scale image coordinates to screen coordinates for rendering
    /// Takes (x, y, w, h) in image pixels and returns (sx, sy, sw, sh) in screen pixels
    pub fn scale_coords(&self, x: f64, y: f64, w: f64, h: f64) -> (f32, f32, f32, f32) {
        (
            (x * self.zoom + self.offset.x) as f32,
            (y * self.zoom + self.offset.y) as f32,
            (w * self.zoom) as f32,
            (h * self.zoom) as f32,
        )
    }

    /// Zoom in/out centered on a screen point (Figma behavior)
    pub fn zoom_at(&mut self, screen_x: f32, screen_y: f32, factor: f64) {
        // Convert screen point to image coords before zoom
        let (img_x, img_y) = self.screen_to_image(screen_x, screen_y);

        // Apply zoom
        let old_zoom = self.zoom;
        self.zoom *= factor;
        self.zoom = self.zoom.clamp(MIN_ZOOM, MAX_ZOOM);

        // If zoom didn't change (at limits), don't adjust offset
        if (self.zoom - old_zoom).abs() < 0.0001 {
            return;
        }

        // Adjust offset so the image point stays under the cursor
        self.offset.x = screen_x as f64 - img_x * self.zoom;
        self.offset.y = screen_y as f64 - img_y * self.zoom;

        self.is_user_transformed = true;
    }

    /// Zoom by a factor centered on viewport center
    pub fn zoom_center(&mut self, factor: f64) {
        let center_x = (self.viewport_width / 2.0) as f32;
        let center_y = (self.viewport_height / 2.0) as f32;
        self.zoom_at(center_x, center_y, factor);
    }

    /// Pan by delta in screen pixels
    pub fn pan(&mut self, delta_x: f64, delta_y: f64) {
        self.offset.x += delta_x;
        self.offset.y += delta_y;
        self.is_user_transformed = true;
    }

    /// Fit image to viewport (centered, with small margin)
    pub fn fit_to_view(&mut self) {
        if self.image_width <= 0.0 || self.image_height <= 0.0 {
            return;
        }

        let scale_x = self.viewport_width / self.image_width;
        let scale_y = self.viewport_height / self.image_height;
        self.zoom = scale_x.min(scale_y);

        // Center the image
        let scaled_width = self.image_width * self.zoom;
        let scaled_height = self.image_height * self.zoom;
        self.offset = Point::new(
            (self.viewport_width - scaled_width) / 2.0,
            (self.viewport_height - scaled_height) / 2.0,
        );

        self.is_user_transformed = false;
    }

    /// Reset to 100% zoom, centered
    pub fn reset_zoom(&mut self) {
        self.zoom = 1.0;
        // Center the image at 100%
        let scaled_width = self.image_width * self.zoom;
        let scaled_height = self.image_height * self.zoom;
        self.offset = Point::new(
            (self.viewport_width - scaled_width) / 2.0,
            (self.viewport_height - scaled_height) / 2.0,
        );
        self.is_user_transformed = true;
    }

    /// Get zoom as a percentage (e.g., 100 for 100%)
    pub fn zoom_percent(&self) -> u32 {
        (self.zoom * 100.0).round() as u32
    }
}

impl Default for Canvas {
    fn default() -> Self {
        Self::new(1920, 1080)
    }
}
