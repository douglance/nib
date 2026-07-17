//! Pencil tool implementation for freeform path drawing

use std::any::Any;

use nib_core::{Annotation, AnnotationType, Point};

use super::{MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult};

/// Tool for drawing freeform paths
pub struct PencilTool {
    points: Vec<Point>,
    is_drawing: bool,
}

impl PencilTool {
    pub fn new() -> Self {
        Self {
            points: Vec::new(),
            is_drawing: false,
        }
    }
}

impl Default for PencilTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Tool for PencilTool {
    fn id(&self) -> ToolId {
        ToolId::Pencil
    }

    fn name(&self) -> &'static str {
        "Pencil"
    }

    fn shortcut(&self) -> char {
        'p'
    }

    fn icon_path(&self) -> &'static str {
        "icons/pencil.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown {
                position,
                button: MouseButton::Left,
                ..
            } => {
                self.points.clear();
                self.points.push(position);
                self.is_drawing = true;
                ToolResult::Handled
            }

            ToolEvent::MouseMove { position, .. } if self.is_drawing => {
                // Only add point if it's far enough from the last point
                // This prevents too many points when moving slowly
                if let Some(last) = self.points.last() {
                    if last.distance_to(position) >= 2.0 {
                        self.points.push(position);
                    }
                }
                ToolResult::Handled
            }

            ToolEvent::MouseUp {
                button: MouseButton::Left,
                ..
            } if self.is_drawing => {
                self.is_drawing = false;

                // Need at least 2 points to create a path
                if self.points.len() < 2 {
                    self.points.clear();
                    return ToolResult::Ignored;
                }

                let annotation = Annotation::new(AnnotationType::Path {
                    points: self.points.clone(),
                    stroke_width: ctx.stroke_width,
                    stroke_style: ctx.stroke_style,
                })
                .with_color(ctx.effective_color());

                self.points.clear();
                ToolResult::Created(annotation)
            }

            ToolEvent::Deactivated => {
                self.reset();
                ToolResult::Handled
            }

            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, ctx: &ToolContext) -> ToolPreview {
        if self.is_drawing && !self.points.is_empty() {
            ToolPreview::Path {
                points: self.points.clone(),
                color: ctx.effective_color(),
                stroke_width: ctx.stroke_width,
            }
        } else {
            ToolPreview::None
        }
    }

    fn reset(&mut self) {
        self.points.clear();
        self.is_drawing = false;
    }

    fn is_active(&self) -> bool {
        self.is_drawing
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
