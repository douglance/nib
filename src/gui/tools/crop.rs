//! Crop tool implementation

use std::any::Any;

use crate::core::types::{Annotation, AnnotationType, Region};

use super::{DragState, MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult};

/// Tool for defining crop regions
pub struct CropTool {
    drag: DragState,
}

impl CropTool {
    pub fn new() -> Self {
        Self {
            drag: DragState::default(),
        }
    }
}

impl Default for CropTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Tool for CropTool {
    fn id(&self) -> ToolId {
        ToolId::Crop
    }

    fn name(&self) -> &'static str {
        "Crop"
    }

    fn shortcut(&self) -> char {
        'c'
    }

    fn icon_path(&self) -> &'static str {
        "icons/crop.svg"
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

                    let annotation =
                        Annotation::new(AnnotationType::Crop { region }).with_color(ctx.color);

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
