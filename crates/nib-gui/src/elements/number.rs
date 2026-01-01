//! Numbered callout rendering

use nib_core::{Color, Point};

/// Render parameters for numbered callout
pub struct NumberRender {
    pub position: Point,
    pub value: u32,
    pub color: Color,
    pub radius: f64,
    pub text_color: Color,
    pub font_size: f64,
}

impl NumberRender {
    pub fn new(position: Point, value: u32, color: Color, radius: f64) -> Self {
        Self {
            position,
            value,
            color,
            radius,
            text_color: Color::WHITE,
            font_size: radius * 1.2,
        }
    }

    /// Get the display text
    pub fn text(&self) -> String {
        self.value.to_string()
    }

    /// Calculate appropriate font size based on number of digits
    pub fn auto_font_size(&self) -> f64 {
        let digits = self.value.to_string().len();
        let base_size = self.radius * 1.4;
        base_size / (1.0 + (digits as f64 - 1.0) * 0.3)
    }
}
