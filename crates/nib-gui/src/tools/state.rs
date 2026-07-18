//! State structs for tools

use std::collections::HashMap;

use nib_core::{AnnotationId, Point, Region};

/// Handle position for resize handles on selected annotations
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandlePosition {
    TopLeft,
    TopCenter,
    TopRight,
    MiddleLeft,
    MiddleRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

/// What part of an annotation was hit during selection
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitZone {
    /// The body/content area of the annotation
    Body,
    /// A resize handle at the given position
    Handle(HandlePosition),
}

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

/// State for marquee (box) selection
#[derive(Debug, Clone, Default)]
pub struct MarqueeState {
    /// Starting point in image coordinates
    pub start: Option<Point>,
    /// Current point in image coordinates
    pub current: Option<Point>,
    /// Annotations that were selected before marquee started (for Shift+marquee)
    pub original_selection: Vec<AnnotationId>,
}

impl MarqueeState {
    /// Check if a marquee selection is currently active
    pub fn is_active(&self) -> bool {
        self.start.is_some()
    }

    /// Start a new marquee selection at the given point
    pub fn start_marquee(&mut self, point: Point, original_selection: Vec<AnnotationId>) {
        self.start = Some(point);
        self.current = Some(point);
        self.original_selection = original_selection;
    }

    /// Update the current marquee position
    pub fn update(&mut self, point: Point) {
        self.current = Some(point);
    }

    /// End the marquee selection and return the final region
    pub fn end_marquee(&mut self) -> Option<Region> {
        let result = self
            .start
            .zip(self.current)
            .map(|(s, c)| Region::from_points(s, c));
        self.reset();
        result
    }

    /// Reset marquee state to default
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Get the current marquee region if active
    pub fn region(&self) -> Option<Region> {
        self.start
            .zip(self.current)
            .map(|(s, c)| Region::from_points(s, c))
    }
}

/// Drag operation state for move/resize
#[derive(Debug, Clone)]
pub enum SelectDragOperation {
    /// Moving selected annotations
    Move {
        /// Starting drag point in image coordinates
        start_point: Point,
        /// Original bounds of each selected annotation
        original_bounds: HashMap<AnnotationId, Region>,
    },
    /// Resizing a single annotation via handle
    Resize {
        /// The annotation being resized
        annotation_id: AnnotationId,
        /// Which handle is being dragged
        handle: HandlePosition,
        /// Original bounds before resize
        original_bounds: Region,
        /// Start drag point
        start_point: Point,
    },
}

/// State for drag operations in Select tool
#[derive(Debug, Clone, Default)]
pub struct SelectDragState {
    /// The current drag operation (if any)
    pub operation: Option<SelectDragOperation>,
    /// Current point during drag (image coordinates)
    pub current_point: Option<Point>,
}

impl SelectDragState {
    /// Start a move operation with the given starting point and original bounds
    pub fn start_move(
        &mut self,
        start_point: Point,
        original_bounds: HashMap<AnnotationId, Region>,
    ) {
        self.operation = Some(SelectDragOperation::Move {
            start_point,
            original_bounds,
        });
        self.current_point = Some(start_point);
    }

    /// Start a resize operation for a single annotation
    pub fn start_resize(
        &mut self,
        annotation_id: AnnotationId,
        handle: HandlePosition,
        original_bounds: Region,
        start_point: Point,
    ) {
        self.operation = Some(SelectDragOperation::Resize {
            annotation_id,
            handle,
            original_bounds,
            start_point,
        });
        self.current_point = Some(start_point);
    }

    /// Update the current drag position
    pub fn update(&mut self, point: Point) {
        self.current_point = Some(point);
    }

    /// Check if currently performing a move operation
    pub fn is_moving(&self) -> bool {
        matches!(self.operation, Some(SelectDragOperation::Move { .. }))
    }

    /// Check if currently performing a resize operation
    pub fn is_resizing(&self) -> bool {
        matches!(self.operation, Some(SelectDragOperation::Resize { .. }))
    }

    /// Calculate the delta from start to current position
    pub fn delta(&self) -> Option<(f64, f64)> {
        let start_point = match &self.operation {
            Some(SelectDragOperation::Move { start_point, .. }) => start_point,
            Some(SelectDragOperation::Resize { start_point, .. }) => start_point,
            None => return None,
        };
        self.current_point
            .map(|current| (current.x - start_point.x, current.y - start_point.y))
    }

    /// Get the original bounds for a specific annotation (during move operation)
    pub fn original_bounds_for(&self, id: AnnotationId) -> Option<&Region> {
        match &self.operation {
            Some(SelectDragOperation::Move {
                original_bounds, ..
            }) => original_bounds.get(&id),
            _ => None,
        }
    }

    /// Get the resize operation details if currently resizing
    pub fn resize_info(&self) -> Option<(AnnotationId, HandlePosition, &Region)> {
        match &self.operation {
            Some(SelectDragOperation::Resize {
                annotation_id,
                handle,
                original_bounds,
                ..
            }) => Some((*annotation_id, *handle, original_bounds)),
            _ => None,
        }
    }

    /// Reset drag state to default
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}
