//! Select tool implementation

use std::any::Any;
use std::collections::HashMap;

use crate::core::types::{AnnotationId, Point, Region};

use crate::core::types::AnnotationType;

use super::{
    HandlePosition, MarqueeState, MouseButton, SelectDragState, Tool, ToolContext, ToolEvent,
    ToolId, ToolMode, ToolPreview, ToolResult,
};

/// Hit radius for resize handles in pixels (image space)
const HANDLE_HIT_RADIUS: f64 = 8.0;

/// Minimum annotation size when resizing (pixels in image space)
const MIN_RESIZE_SIZE: f64 = 10.0;

/// Maximum time between clicks to count as a double-click (milliseconds)
const DOUBLE_CLICK_THRESHOLD_MS: u128 = 400;

/// Tool for selecting and editing annotations
pub struct SelectTool {
    /// Currently selected annotation IDs (supports multi-selection)
    selected_ids: Vec<AnnotationId>,
    /// Annotation currently being hovered (for visual feedback)
    hover_id: Option<AnnotationId>,
    /// For double-click detection (Phase 6)
    last_click_time: Option<std::time::Instant>,
    last_click_id: Option<AnnotationId>,
    /// Marquee selection state
    marquee: MarqueeState,
    /// Drag state for move/resize operations
    drag: SelectDragState,
}

impl SelectTool {
    pub fn new() -> Self {
        Self {
            selected_ids: Vec::new(),
            hover_id: None,
            last_click_time: None,
            last_click_id: None,
            marquee: MarqueeState::default(),
            drag: SelectDragState::default(),
        }
    }

    /// Get the currently selected annotation IDs
    pub fn selected(&self) -> &[AnnotationId] {
        &self.selected_ids
    }

    /// Clear selection and select a single annotation
    fn select(&mut self, id: AnnotationId) {
        self.selected_ids.clear();
        self.selected_ids.push(id);
    }

    /// Toggle an annotation in the selection (add if not present, remove if present)
    fn toggle_selection(&mut self, id: AnnotationId) {
        if let Some(position) = self.selected_ids.iter().position(|&selected| selected == id) {
            self.selected_ids.remove(position);
        } else {
            self.selected_ids.push(id);
        }
    }

    /// Clear all selections
    fn clear_selection(&mut self) {
        self.selected_ids.clear();
    }

    /// Check if an annotation is currently selected
    pub fn is_selected(&self, id: AnnotationId) -> bool {
        self.selected_ids.contains(&id)
    }

    /// Generate resize handle positions for a given region
    fn generate_handles(&self, bounds: &Region) -> Vec<(Point, HandlePosition)> {
        let left = bounds.x;
        let right = bounds.x + bounds.width;
        let top = bounds.y;
        let bottom = bounds.y + bounds.height;
        let center_x = bounds.x + bounds.width / 2.0;
        let center_y = bounds.y + bounds.height / 2.0;

        vec![
            (Point::new(left, top), HandlePosition::TopLeft),
            (Point::new(center_x, top), HandlePosition::TopCenter),
            (Point::new(right, top), HandlePosition::TopRight),
            (Point::new(left, center_y), HandlePosition::MiddleLeft),
            (Point::new(right, center_y), HandlePosition::MiddleRight),
            (Point::new(left, bottom), HandlePosition::BottomLeft),
            (Point::new(center_x, bottom), HandlePosition::BottomCenter),
            (Point::new(right, bottom), HandlePosition::BottomRight),
        ]
    }

    /// Find all visible annotations whose bounds intersect the given region
    fn annotations_in_region(&self, region: &Region, ctx: &ToolContext) -> Vec<AnnotationId> {
        ctx.annotations
            .iter()
            .filter(|a| a.visible && region.intersects(&a.bounds()))
            .map(|a| a.id)
            .collect()
    }

    /// Get handle positions for a given bounds region
    fn handle_positions(bounds: &Region) -> [(HandlePosition, Point); 8] {
        let (x, y, w, h) = (bounds.x, bounds.y, bounds.width, bounds.height);
        [
            (HandlePosition::TopLeft, Point::new(x, y)),
            (HandlePosition::TopCenter, Point::new(x + w / 2.0, y)),
            (HandlePosition::TopRight, Point::new(x + w, y)),
            (HandlePosition::MiddleLeft, Point::new(x, y + h / 2.0)),
            (HandlePosition::MiddleRight, Point::new(x + w, y + h / 2.0)),
            (HandlePosition::BottomLeft, Point::new(x, y + h)),
            (HandlePosition::BottomCenter, Point::new(x + w / 2.0, y + h)),
            (HandlePosition::BottomRight, Point::new(x + w, y + h)),
        ]
    }

    /// Hit test handles for selected annotation (single selection only)
    fn hit_test_handles(
        &self,
        point: Point,
        ctx: &ToolContext,
    ) -> Option<(AnnotationId, HandlePosition)> {
        // Only check handles for single selection
        if self.selected_ids.len() != 1 {
            return None;
        }

        let id = self.selected_ids[0];
        let annotation = ctx.annotations.iter().find(|a| a.id == id)?;
        let bounds = annotation.bounds();

        for (handle, pos) in Self::handle_positions(&bounds) {
            if point.distance_to(pos) <= HANDLE_HIT_RADIUS {
                return Some((id, handle));
            }
        }
        None
    }

    /// Calculate new bounds after resizing with a handle drag
    fn calculate_resized_bounds(
        original: &Region,
        handle: HandlePosition,
        delta_x: f64,
        delta_y: f64,
    ) -> Region {
        let (mut x, mut y, mut w, mut h) =
            (original.x, original.y, original.width, original.height);

        match handle {
            HandlePosition::TopLeft => {
                x += delta_x;
                y += delta_y;
                w -= delta_x;
                h -= delta_y;
            }
            HandlePosition::TopCenter => {
                y += delta_y;
                h -= delta_y;
            }
            HandlePosition::TopRight => {
                y += delta_y;
                w += delta_x;
                h -= delta_y;
            }
            HandlePosition::MiddleLeft => {
                x += delta_x;
                w -= delta_x;
            }
            HandlePosition::MiddleRight => {
                w += delta_x;
            }
            HandlePosition::BottomLeft => {
                x += delta_x;
                w -= delta_x;
                h += delta_y;
            }
            HandlePosition::BottomCenter => {
                h += delta_y;
            }
            HandlePosition::BottomRight => {
                w += delta_x;
                h += delta_y;
            }
        }

        // Enforce minimum size
        if w < MIN_RESIZE_SIZE {
            w = MIN_RESIZE_SIZE;
        }
        if h < MIN_RESIZE_SIZE {
            h = MIN_RESIZE_SIZE;
        }

        Region::new(x, y, w, h)
    }
}

impl Default for SelectTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Tool for SelectTool {
    fn id(&self) -> ToolId {
        ToolId::Select
    }

    fn name(&self) -> &'static str {
        "Select"
    }

    fn shortcut(&self) -> char {
        'v'
    }

    fn icon_path(&self) -> &'static str {
        "icons/select.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown {
                position,
                button: MouseButton::Left,
                modifiers,
            } => {
                // First, check for handle hit (if single selection exists)
                if let Some((annotation_id, handle)) = self.hit_test_handles(position, ctx) {
                    // Get the original bounds for the annotation
                    if let Some(annotation) = ctx.annotations.iter().find(|a| a.id == annotation_id)
                    {
                        let original_bounds = annotation.bounds();
                        self.drag
                            .start_resize(annotation_id, handle, original_bounds, position);
                        // Clear click tracking - resize handle hit, not a text edit
                        self.last_click_time = None;
                        self.last_click_id = None;
                        return ToolResult::Handled;
                    }
                }

                // Find annotation at click position
                if let Some(annotation) = ctx.annotation_at(position) {
                    let clicked_id = annotation.id;
                    let now = std::time::Instant::now();

                    // Check for double-click on the same annotation
                    let is_double_click = self.last_click_id == Some(clicked_id)
                        && self
                            .last_click_time
                            .map_or(false, |t| now.duration_since(t).as_millis() < DOUBLE_CLICK_THRESHOLD_MS);

                    // Update click tracking for next potential double-click
                    self.last_click_time = Some(now);
                    self.last_click_id = Some(clicked_id);

                    // Double-click on text annotation: enter edit mode
                    if is_double_click {
                        if let AnnotationType::Text {
                            position: text_pos,
                            content,
                            ..
                        } = &annotation.annotation_type
                        {
                            return ToolResult::EnterMode(ToolMode::TextInput {
                                position: *text_pos,
                                initial_content: content.clone(),
                                editing_annotation_id: Some(clicked_id),
                            });
                        }
                    }

                    // Single click behavior: handle selection
                    let was_already_selected = self.is_selected(clicked_id);

                    if modifiers.shift {
                        // Shift+click: toggle selection
                        self.toggle_selection(clicked_id);
                    } else if !was_already_selected {
                        // Regular click on unselected annotation: select only this one
                        self.select(clicked_id);
                    }
                    // If already selected without shift, keep current selection (for multi-drag)

                    // Start move drag if we have a selection
                    if !self.selected_ids.is_empty() {
                        let original_bounds: HashMap<AnnotationId, Region> = self
                            .selected_ids
                            .iter()
                            .filter_map(|id| {
                                ctx.annotations
                                    .iter()
                                    .find(|a| a.id == *id)
                                    .map(|a| (*id, a.bounds()))
                            })
                            .collect();
                        self.drag.start_move(position, original_bounds);
                    }

                    ToolResult::Handled
                } else {
                    // Click on empty space - start marquee selection
                    // Clear click tracking since we're not clicking an annotation
                    self.last_click_time = None;
                    self.last_click_id = None;

                    let original_selection = if modifiers.shift {
                        self.selected_ids.clone()
                    } else {
                        self.clear_selection();
                        vec![]
                    };
                    self.marquee.start_marquee(position, original_selection);
                    ToolResult::Handled
                }
            }
            ToolEvent::MouseMove { position, modifiers: _ } => {
                // If resize drag is active, update the drag position
                if self.drag.is_resizing() {
                    self.drag.update(position);
                    return ToolResult::Handled;
                }

                // If move drag is active, update the drag position
                if self.drag.is_moving() {
                    self.drag.update(position);
                    return ToolResult::Handled;
                }

                // If marquee is active, update it and select intersecting annotations
                if self.marquee.is_active() {
                    self.marquee.update(position);

                    // Select all annotations that intersect the marquee region
                    if let Some(region) = self.marquee.region() {
                        let intersecting_ids = self.annotations_in_region(&region, ctx);

                        // Combine with original selection if shift was held when starting marquee
                        self.selected_ids = self.marquee.original_selection.clone();
                        for id in intersecting_ids {
                            if !self.selected_ids.contains(&id) {
                                self.selected_ids.push(id);
                            }
                        }
                    }

                    return ToolResult::Handled;
                }

                // Update hover state for visual feedback
                let new_hover = ctx.annotation_at(position).map(|a| a.id);
                if new_hover != self.hover_id {
                    self.hover_id = new_hover;
                    return ToolResult::Handled;
                }
                ToolResult::Ignored
            }
            ToolEvent::MouseUp { position, button: MouseButton::Left } => {
                // If resize drag is active, commit the resize
                if self.drag.is_resizing() {
                    self.drag.update(position);

                    // Get resize info and calculate final bounds
                    if let Some((annotation_id, handle, original_bounds)) = self.drag.resize_info() {
                        if let Some((delta_x, delta_y)) = self.drag.delta() {
                            // Only emit resize if there was actual movement
                            if delta_x.abs() > 0.5 || delta_y.abs() > 0.5 {
                                let new_bounds = Self::calculate_resized_bounds(
                                    original_bounds,
                                    handle,
                                    delta_x,
                                    delta_y,
                                );
                                let id = annotation_id;
                                self.drag.reset();
                                return ToolResult::Resized { id, new_bounds };
                            }
                        }
                    }
                    self.drag.reset();
                    return ToolResult::Handled;
                }

                // If move drag is active, commit the move
                if self.drag.is_moving() {
                    self.drag.update(position);

                    // Calculate final delta and return move result
                    if let Some((delta_x, delta_y)) = self.drag.delta() {
                        // Only emit move if there was actual movement
                        let moved_ids = self.selected_ids.clone();
                        self.drag.reset();

                        if delta_x.abs() > 0.5 || delta_y.abs() > 0.5 {
                            return ToolResult::Moved {
                                ids: moved_ids,
                                delta_x,
                                delta_y,
                            };
                        }
                    } else {
                        self.drag.reset();
                    }

                    return ToolResult::Handled;
                }

                // If marquee is active, finalize selection
                if self.marquee.is_active() {
                    // Final update before ending
                    self.marquee.update(position);

                    // Select all annotations that intersect the final marquee region
                    if let Some(region) = self.marquee.region() {
                        let intersecting_ids = self.annotations_in_region(&region, ctx);

                        // Combine with original selection if shift was held when starting marquee
                        self.selected_ids = self.marquee.original_selection.clone();
                        for id in intersecting_ids {
                            if !self.selected_ids.contains(&id) {
                                self.selected_ids.push(id);
                            }
                        }
                    }

                    self.marquee.end_marquee();
                    return ToolResult::Handled;
                }
                ToolResult::Ignored
            }
            ToolEvent::Deactivated => {
                self.reset();
                ToolResult::Handled
            }
            ToolEvent::KeyDown { key, modifiers, .. } => {
                // Delete selected annotations with Delete or Backspace
                if (key == "backspace" || key == "delete") && !self.selected_ids.is_empty() {
                    let deleted_ids = self.selected_ids.clone();
                    self.clear_selection();
                    return ToolResult::Batch(
                        deleted_ids.into_iter().map(ToolResult::Deleted).collect(),
                    );
                }

                // Escape - clear selection
                if key == "escape" {
                    self.clear_selection();
                    return ToolResult::Handled;
                }

                // Arrow keys - nudge selected annotations
                if !self.selected_ids.is_empty() {
                    let nudge_amount = if modifiers.shift { 10.0 } else { 1.0 };
                    let (delta_x, delta_y) = match key.as_str() {
                        "left" => (-nudge_amount, 0.0),
                        "right" => (nudge_amount, 0.0),
                        "up" => (0.0, -nudge_amount),
                        "down" => (0.0, nudge_amount),
                        _ => return ToolResult::Ignored,
                    };

                    return ToolResult::Moved {
                        ids: self.selected_ids.clone(),
                        delta_x,
                        delta_y,
                    };
                }

                ToolResult::Ignored
            }
            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, ctx: &ToolContext) -> ToolPreview {
        // If marquee selection is active, show the marquee rectangle
        if let Some(region) = self.marquee.region() {
            return ToolPreview::Marquee { region };
        }

        if self.selected_ids.is_empty() {
            return ToolPreview::None;
        }

        // If resizing, show the preview at new bounds
        if let Some((_annotation_id, handle, original_bounds)) = self.drag.resize_info() {
            if let Some((delta_x, delta_y)) = self.drag.delta() {
                let new_bounds =
                    Self::calculate_resized_bounds(original_bounds, handle, delta_x, delta_y);
                // Show selection preview with resized bounds and handles at new positions
                let handles = Some(self.generate_handles(&new_bounds));
                return ToolPreview::Selection {
                    bounds: vec![new_bounds],
                    handles,
                };
            } else {
                // No delta yet, show original bounds
                let bounds = vec![*original_bounds];
                let handles = Some(self.generate_handles(original_bounds));
                return ToolPreview::Selection { bounds, handles };
            }
        }

        // Get the drag delta (if any) for offsetting bounds
        let drag_delta = self.drag.delta();

        // Collect bounds for all selected annotations (offset by drag delta if moving)
        let bounds: Vec<Region> = self
            .selected_ids
            .iter()
            .filter_map(|&id| {
                ctx.annotations
                    .iter()
                    .find(|a| a.id == id)
                    .map(|a| {
                        let base_bounds = a.bounds();
                        // Apply drag delta if we're moving
                        if let Some((delta_x, delta_y)) = drag_delta {
                            Region::new(
                                base_bounds.x + delta_x,
                                base_bounds.y + delta_y,
                                base_bounds.width,
                                base_bounds.height,
                            )
                        } else {
                            base_bounds
                        }
                    })
            })
            .collect();

        if bounds.is_empty() {
            return ToolPreview::None;
        }

        // Only show resize handles if exactly one annotation is selected and not currently moving
        let handles = if self.selected_ids.len() == 1 && !self.drag.is_moving() {
            bounds.first().map(|b| self.generate_handles(b))
        } else {
            None
        };

        ToolPreview::Selection { bounds, handles }
    }

    fn reset(&mut self) {
        self.selected_ids.clear();
        self.hover_id = None;
        self.last_click_time = None;
        self.last_click_id = None;
        self.marquee.reset();
        self.drag.reset();
    }

    fn is_active(&self) -> bool {
        self.marquee.is_active() || self.drag.is_moving() || self.drag.is_resizing()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
