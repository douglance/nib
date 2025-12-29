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

    /// Calculate ellipse parameters from drag points
    /// Start point becomes center, drag distance determines radii
    fn calculate_ellipse(start: Point, current: Point) -> (Point, f64, f64) {
        let center = start;
        let radius_x = (current.x - start.x).abs();
        let radius_y = (current.y - start.y).abs();
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

                    let annotation = Annotation::new(AnnotationType::Ellipse {
                        center,
                        radius_x,
                        radius_y,
                        stroke_width: ctx.stroke_width,
                        filled: ctx.fill_enabled,
                    })
                    .with_color(ctx.color);

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
                color: ctx.color,
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
