//! Line tool implementation

use std::any::Any;

use nib_core::{Annotation, AnnotationType};

use super::{DragState, MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult};

/// Tool for drawing line annotations
pub struct LineTool {
    drag: DragState,
}

impl LineTool {
    pub fn new() -> Self {
        Self {
            drag: DragState::default(),
        }
    }
}

impl Default for LineTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Tool for LineTool {
    fn id(&self) -> ToolId {
        ToolId::Line
    }

    fn name(&self) -> &'static str {
        "Line"
    }

    fn shortcut(&self) -> char {
        'l'
    }

    fn icon_path(&self) -> &'static str {
        "icons/line.svg"
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

                    let annotation = Annotation::new(AnnotationType::Line {
                        start,
                        end: position,
                        stroke_width: ctx.stroke_width,
                        stroke_style: ctx.stroke_style,
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
            ToolPreview::Line {
                start,
                end: current,
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
