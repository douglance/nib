//! Rectangle/box annotation rendering

use nib_core::{Color, Region, StrokeStyle};

/// Render parameters for a rectangle
pub struct BoxRender {
    pub region: Region,
    pub color: Color,
    pub stroke_width: f64,
    pub stroke_style: StrokeStyle,
    pub filled: bool,
    pub corner_radius: f64,
}

impl BoxRender {
    pub fn new(region: Region, color: Color, stroke_width: f64) -> Self {
        Self {
            region,
            color,
            stroke_width,
            stroke_style: StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        }
    }

    pub fn with_fill(mut self) -> Self {
        self.filled = true;
        self
    }

    pub fn with_corner_radius(mut self, radius: f64) -> Self {
        self.corner_radius = radius;
        self
    }

    /// Get dash pattern for stroke style
    pub fn dash_pattern(&self) -> Option<(f64, f64)> {
        match self.stroke_style {
            StrokeStyle::Solid => None,
            StrokeStyle::Dashed => Some((8.0, 4.0)),
            StrokeStyle::Dotted => Some((2.0, 2.0)),
        }
    }
}
