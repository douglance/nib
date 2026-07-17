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

/// Break `content` into lines that roughly fit within `max_width` at `font_size`,
/// using the same 0.6x-per-character width heuristic as `estimated_width`. Wraps
/// on whitespace boundaries; a single word longer than `max_width` is kept on
/// its own (overflowing) line rather than split mid-word. Returns `content`
/// unchanged as a single line if `max_width` is `None`.
pub fn wrap_text(content: &str, font_size: f64, max_width: Option<f64>) -> Vec<String> {
    let Some(max_width) = max_width else {
        return vec![content.to_string()];
    };

    let char_width = font_size * 0.6;
    let max_chars = ((max_width / char_width).floor() as usize).max(1);

    let mut lines = Vec::new();
    let mut current = String::new();
    for word in content.split_whitespace() {
        let candidate_len = if current.is_empty() {
            word.len()
        } else {
            current.len() + 1 + word.len()
        };
        if current.is_empty() || candidate_len <= max_chars {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        } else {
            lines.push(std::mem::take(&mut current));
            current.push_str(word);
        }
    }
    if !current.is_empty() || lines.is_empty() {
        lines.push(current);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_max_width_returns_single_unwrapped_line() {
        assert_eq!(wrap_text("hello world", 16.0, None), vec!["hello world"]);
    }

    #[test]
    fn short_content_stays_on_one_line() {
        assert_eq!(wrap_text("hi", 16.0, Some(200.0)), vec!["hi"]);
    }

    #[test]
    fn long_content_wraps_into_multiple_lines() {
        let lines = wrap_text("one two three four five six seven eight", 16.0, Some(60.0));
        assert!(lines.len() > 1, "expected multiple lines, got {lines:?}");
        for line in &lines {
            // char_width = 16*0.6 = 9.6, max_chars = floor(60/9.6) = 6
            assert!(line.len() <= 6 || !line.contains(' '), "line exceeds wrap width: {line:?}");
        }
    }

    #[test]
    fn single_word_longer_than_max_width_is_not_split() {
        let lines = wrap_text("supercalifragilisticexpialidocious", 16.0, Some(10.0));
        assert_eq!(lines, vec!["supercalifragilisticexpialidocious"]);
    }

    #[test]
    fn empty_content_returns_one_empty_line() {
        assert_eq!(wrap_text("", 16.0, Some(100.0)), vec![""]);
    }
}
