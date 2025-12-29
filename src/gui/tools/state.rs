//! State structs for tools

use crate::core::types::{AnnotationId, Point};

/// State for drag-based tools (Arrow, Rectangle, etc.)
#[derive(Debug, Clone, Default)]
pub struct DragState {
    /// Starting point in image coordinates
    pub start: Option<Point>,
    /// Current point in image coordinates
    pub current: Option<Point>,
}

impl DragState {
    /// Check if currently dragging
    pub fn is_dragging(&self) -> bool {
        self.start.is_some()
    }

    /// Start a new drag operation
    pub fn start_drag(&mut self, point: Point) {
        self.start = Some(point);
        self.current = Some(point);
    }

    /// Update the current drag position
    pub fn update(&mut self, point: Point) {
        self.current = Some(point);
    }

    /// End drag and return start/end points
    pub fn end_drag(&mut self) -> Option<(Point, Point)> {
        let result = self.start.zip(self.current);
        self.reset();
        result
    }

    /// Reset to initial state
    pub fn reset(&mut self) {
        self.start = None;
        self.current = None;
    }
}

/// State for text input tool
#[derive(Debug, Clone, Default)]
pub struct TextInputState {
    /// Whether in text input mode
    pub active: bool,
    /// Position where text started (image coordinates)
    pub position: Option<Point>,
    /// Current text content
    pub content: String,
    /// If editing existing annotation
    pub editing_id: Option<AnnotationId>,
}

impl TextInputState {
    /// Start new text input at position
    pub fn start_new(&mut self, image_pos: Point) {
        self.active = true;
        self.position = Some(image_pos);
        self.content.clear();
        self.editing_id = None;
    }

    /// Start editing existing text annotation
    pub fn start_edit(&mut self, id: AnnotationId, image_pos: Point, content: String) {
        self.active = true;
        self.position = Some(image_pos);
        self.content = content;
        self.editing_id = Some(id);
    }

    /// Append text to content
    pub fn append(&mut self, text: &str) {
        self.content.push_str(text);
    }

    /// Delete last character
    pub fn backspace(&mut self) {
        self.content.pop();
    }

    /// Reset to initial state
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// State for number tool (tracks placement)
#[derive(Debug, Clone, Default)]
pub struct NumberToolState {
    /// Last placed position (for visual feedback)
    pub last_placed: Option<Point>,
}
