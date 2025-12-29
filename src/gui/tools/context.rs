//! Context provided to tools during event handling

use crate::core::types::{Annotation, AnnotationType, Color, Point};

/// Shared context provided to all tools
pub struct ToolContext<'a> {
    // === Drawing Properties ===
    /// Current drawing color
    pub color: Color,
    /// Current stroke width
    pub stroke_width: f64,
    /// Whether fill is enabled for shapes
    pub fill_enabled: bool,

    // === Coordinate System ===
    /// Image dimensions in pixels
    pub image_size: (u32, u32),
    /// Current scale factor (canvas / image)
    pub scale: f32,
    /// Offset for centered image rendering
    pub offset: (f32, f32),

    // === Document State (read-only) ===
    /// All existing annotations
    pub annotations: &'a [Annotation],

    // === Configuration ===
    /// Minimum drag distance to create annotation (pixels in image space)
    pub min_drag_distance: f64,
}

impl<'a> ToolContext<'a> {
    /// Convert screen coordinates to image coordinates
    pub fn screen_to_image(&self, screen_x: f32, screen_y: f32) -> Point {
        let image_x = (screen_x - self.offset.0) / self.scale;
        let image_y = (screen_y - self.offset.1) / self.scale;
        Point::new(image_x as f64, image_y as f64)
    }

    /// Convert image coordinates to screen coordinates
    pub fn image_to_screen(&self, point: Point) -> (f32, f32) {
        let screen_x = (point.x as f32 * self.scale) + self.offset.0;
        let screen_y = (point.y as f32 * self.scale) + self.offset.1;
        (screen_x, screen_y)
    }

    /// Find annotation at point (for selection)
    pub fn annotation_at(&self, point: Point) -> Option<&'a Annotation> {
        self.annotations
            .iter()
            .rev() // Check top-most first (highest z-index)
            .filter(|a| a.visible)
            .find(|a| {
                let bounds = a.annotation_type.bounds();
                bounds.contains(point)
            })
    }

    /// Get next number value for Number tool
    pub fn next_number_value(&self) -> u32 {
        self.annotations
            .iter()
            .filter_map(|a| match &a.annotation_type {
                AnnotationType::Number { value, .. } => Some(*value),
                _ => None,
            })
            .max()
            .unwrap_or(0)
            + 1
    }
}
