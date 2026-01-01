//! Rectangle tool implementation

use std::any::Any;

use nib_core::{Annotation, AnnotationType, Region, StrokeStyle};

use super::{DragState, MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult};

/// Tool for drawing rectangle annotations
pub struct RectangleTool {
    drag: DragState,
}

impl RectangleTool {
    pub fn new() -> Self {
        Self {
            drag: DragState::default(),
        }
    }
}

impl Default for RectangleTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Tool for RectangleTool {
    fn id(&self) -> ToolId {
        ToolId::Rectangle
    }

    fn name(&self) -> &'static str {
        "Rectangle"
    }

    fn shortcut(&self) -> char {
        'r'
    }

    fn icon_path(&self) -> &'static str {
        "icons/rectangle.svg"
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

                    let region = Region::from_points(start, position);

                    // Reject degenerate shapes where both dimensions are too small
                    if region.width < ctx.min_drag_distance && region.height < ctx.min_drag_distance {
                        return ToolResult::Ignored;
                    }

                    let annotation = Annotation::new(AnnotationType::Box {
                        region,
                        stroke_width: ctx.stroke_width,
                        stroke_style: StrokeStyle::Solid,
                        filled: ctx.fill_enabled,
                        corner_radius: 0.0,
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
            ToolPreview::Rectangle {
                region: Region::from_points(start, current),
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
