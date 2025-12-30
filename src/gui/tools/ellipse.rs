//! Ellipse tool implementation

use std::any::Any;

use crate::core::types::{Annotation, AnnotationType, Point};

use super::{DragState, MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult};

/// Tool for drawing ellipse annotations
pub struct EllipseTool {
    drag: DragState,
}

impl EllipseTool {
    pub fn new() -> Self {
        Self {
            drag: DragState::default(),
        }
    }

    /// Calculate ellipse parameters from drag points using bounding-box model
    /// Center is midpoint, radii are half the width/height of bounding box
    fn calculate_ellipse(start: Point, end: Point) -> (Point, f64, f64) {
        let center = Point::new(
            (start.x + end.x) / 2.0,
            (start.y + end.y) / 2.0,
        );
        let radius_x = (end.x - start.x).abs() / 2.0;
        let radius_y = (end.y - start.y).abs() / 2.0;
        (center, radius_x, radius_y)
    }
}

impl Default for EllipseTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Tool for EllipseTool {
    fn id(&self) -> ToolId {
        ToolId::Ellipse
    }

    fn name(&self) -> &'static str {
        "Ellipse"
    }

    fn shortcut(&self) -> char {
        'e'
    }

    fn icon_path(&self) -> &'static str {
        "icons/ellipse.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown {
                position,
                button: MouseButton::Left,
                ..
            } => {
                self.drag.start_drag(position);
                ToolResult::Handled
            }
            ToolEvent::MouseMove { position, .. } if self.drag.is_dragging() => {
                self.drag.update(position);
                ToolResult::Handled
            }
            ToolEvent::MouseUp {
                position,
                button: MouseButton::Left,
            } => {
                if let Some((start, _)) = self.drag.end_drag() {
                    // Check minimum drag distance
                    let distance = start.distance_to(position);

                    if distance < ctx.min_drag_distance {
                        return ToolResult::Ignored;
                    }

                    let (center, radius_x, radius_y) = Self::calculate_ellipse(start, position);

                    // Reject degenerate ellipses where both radii are too small
                    let min_radius = ctx.min_drag_distance / 2.0;
                    if radius_x < min_radius && radius_y < min_radius {
                        return ToolResult::Ignored;
                    }

                    let annotation = Annotation::new(AnnotationType::Ellipse {
                        center,
                        radius_x,
                        radius_y,
                        stroke_width: ctx.stroke_width,
                        filled: ctx.fill_enabled,
                    })
                    .with_color(ctx.effective_color());

                    return ToolResult::Created(annotation);
                }
                ToolResult::Ignored
            }
            ToolEvent::Deactivated => {
                self.reset();
                ToolResult::Handled
            }
            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, ctx: &ToolContext) -> ToolPreview {
        if let (Some(start), Some(current)) = (self.drag.start, self.drag.current) {
            let (center, radius_x, radius_y) = Self::calculate_ellipse(start, current);
            ToolPreview::Ellipse {
                center,
                radius_x,
                radius_y,
                color: ctx.effective_color(),
            }
        } else {
            ToolPreview::None
        }
    }

    fn reset(&mut self) {
        self.drag.reset();
    }

    fn is_active(&self) -> bool {
        self.drag.is_dragging()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
