//! Image canvas with pan/zoom support

use crate::core::{Point, Region};

/// Canvas viewport state
pub struct Canvas {
    /// Current zoom level (1.0 = 100%)
    pub zoom: f64,
    /// Pan offset in screen coordinates
    pub offset: Point,
    /// Visible region in image coordinates
    pub viewport: Region,
}

impl Canvas {
    pub fn new() -> Self {
        Self {
            zoom: 1.0,
            offset: Point::new(0.0, 0.0),
            viewport: Region::new(0.0, 0.0, 800.0, 600.0),
        }
    }

    /// Convert screen coordinates to image coordinates
    pub fn screen_to_image(&self, screen_point: Point) -> Point {
        Point::new(
            (screen_point.x - self.offset.x) / self.zoom,
            (screen_point.y - self.offset.y) / self.zoom,
        )
    }

    /// Convert image coordinates to screen coordinates
    pub fn image_to_screen(&self, image_point: Point) -> Point {
        Point::new(
            image_point.x * self.zoom + self.offset.x,
            image_point.y * self.zoom + self.offset.y,
        )
    }

    /// Zoom in/out centered on a point
    pub fn zoom_at(&mut self, center: Point, factor: f64) {
        let old_image_point = self.screen_to_image(center);
        self.zoom *= factor;
        self.zoom = self.zoom.clamp(0.1, 10.0);
        let new_screen_point = self.image_to_screen(old_image_point);
        self.offset.x += center.x - new_screen_point.x;
        self.offset.y += center.y - new_screen_point.y;
    }

    /// Pan by delta
    pub fn pan(&mut self, delta_x: f64, delta_y: f64) {
        self.offset.x += delta_x;
        self.offset.y += delta_y;
    }

    /// Fit image to viewport
    pub fn fit_to_view(&mut self, image_width: f64, image_height: f64) {
        let scale_x = self.viewport.width / image_width;
        let scale_y = self.viewport.height / image_height;
        self.zoom = scale_x.min(scale_y) * 0.9; // 90% to leave margin
        self.offset = Point::new(
            (self.viewport.width - image_width * self.zoom) / 2.0,
            (self.viewport.height - image_height * self.zoom) / 2.0,
        );
    }

    /// Reset to 100% zoom
    pub fn reset_zoom(&mut self) {
        self.zoom = 1.0;
        self.offset = Point::new(0.0, 0.0);
    }
}

impl Default for Canvas {
    fn default() -> Self {
        Self::new()
    }
}
