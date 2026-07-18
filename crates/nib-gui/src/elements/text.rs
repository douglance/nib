//! Text annotation rendering

use nib_core::{Color, Point, TextAlign};

/// Render parameters for text
pub struct TextRender {
    pub position: Point,
    pub content: String,
    pub color: Color,
    pub font_size: f64,
    pub font_family: String,
    pub align: TextAlign,
    pub background: Option<Color>,
    pub padding: f64,
    pub max_width: Option<f64>,
}

impl TextRender {
    pub fn new(position: Point, content: impl Into<String>, color: Color, font_size: f64) -> Self {
        Self {
            position,
            content: content.into(),
            color,
            font_size,
            font_family: "SF Pro Display".to_string(),
            align: TextAlign::Left,
            background: Some(Color::rgba(0, 0, 0, 200)),
            padding: 4.0,
            max_width: None,
        }
    }

    pub fn with_background(mut self, color: Color) -> Self {
        self.background = Some(color);
        self
    }

    pub fn without_background(mut self) -> Self {
        self.background = None;
        self
    }

    pub fn with_align(mut self, align: TextAlign) -> Self {
        self.align = align;
        self
    }

    /// Estimate width of text (rough calculation)
    pub fn estimated_width(&self) -> f64 {
        // Approximate: each character is about 0.6x font size
        let char_width = self.font_size * 0.6;
        let text_width = self.content.len() as f64 * char_width;

        if let Some(max) = self.max_width {
            text_width.min(max)
        } else {
            text_width
        }
    }

    /// Estimate height of text
    pub fn estimated_height(&self) -> f64 {
        self.font_size * 1.2
    }
}

/// Break `content` into lines that fit within `max_width` at `font_size`.
/// Moved to `nib_core::wrap_text` so nib-storage's flattened export wraps
/// identically to the live GUI rendering that calls this; kept re-exported
/// here since call sites already reference `elements::text::wrap_text`.
pub use nib_core::wrap_text;
