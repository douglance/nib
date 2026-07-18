//! Eraser tool implementation
//!
//! Click or drag over an annotation to delete it. Deletes the topmost
//! unlocked annotation under the cursor on mouse-down and on every mouse-move
//! while the button is held, so a drag can erase several annotations in a pass.
//! No history record of its own -- it returns `ToolResult::Deleted`, which
//! `process_tool_result`'s existing history hook records for every caller.

use std::any::Any;

use super::{MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult};

/// Tool for deleting annotations by clicking or dragging over them
#[derive(Default)]
pub struct EraserTool {
    /// Whether the mouse button is currently held down
    erasing: bool,
}

impl EraserTool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Delete the topmost unlocked annotation at `position`, if any.
    fn erase_at(ctx: &ToolContext, position: nib_core::Point) -> ToolResult {
        match ctx.topmost_unlocked_at(position) {
            Some(annotation) => ToolResult::Deleted(annotation.id),
            None => ToolResult::Ignored,
        }
    }
}

impl Tool for EraserTool {
    fn id(&self) -> ToolId {
        ToolId::Eraser
    }

    fn name(&self) -> &'static str {
        "Eraser"
    }

    fn shortcut(&self) -> char {
        'x'
    }

    fn icon_path(&self) -> &'static str {
        "icons/eraser.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown {
                position,
                button: MouseButton::Left,
                ..
            } => {
                self.erasing = true;
                Self::erase_at(ctx, position)
            }
            ToolEvent::MouseMove { position, .. } if self.erasing => Self::erase_at(ctx, position),
            ToolEvent::MouseUp {
                button: MouseButton::Left,
                ..
            } => {
                self.erasing = false;
                ToolResult::Ignored
            }
            ToolEvent::Deactivated => {
                self.reset();
                ToolResult::Handled
            }
            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, _ctx: &ToolContext) -> ToolPreview {
        ToolPreview::None
    }

    fn reset(&mut self) {
        self.erasing = false;
    }

    fn is_active(&self) -> bool {
        self.erasing
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::super::Modifiers;
    use super::*;
    use nib_core::{Annotation, AnnotationStyle, AnnotationType, Color, Point, Region};

    fn ctx(annotations: &[Annotation]) -> ToolContext<'_> {
        ToolContext {
            style: AnnotationStyle::Custom,
            custom_color: Color::RED,
            stroke_width: 2.0,
            fill_enabled: false,
            stroke_style: nib_core::StrokeStyle::Solid,
            arrow_head: nib_core::ArrowHead::End,
            font_size: 32.0,
            blur_intensity: nib_core::BlurIntensity::Medium,
            opacity: 1.0,
            image_size: (1920, 1080),
            scale: 1.0,
            offset: (0.0, 0.0),
            annotations,
            min_drag_distance: 5.0,
        }
    }

    fn box_at(x: f64, y: f64) -> Annotation {
        Annotation::new(AnnotationType::Box {
            region: Region::new(x, y, 50.0, 50.0),
            stroke_width: 2.0,
            stroke_style: nib_core::StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })
    }

    #[test]
    fn click_deletes_topmost_annotation_under_cursor() {
        let ann = box_at(0.0, 0.0);
        let id = ann.id;
        let annotations = vec![ann];
        let mut tool = EraserTool::new();

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(10.0, 10.0),
                button: MouseButton::Left,
                modifiers: Modifiers::default(),
            },
            &ctx(&annotations),
        );

        match result {
            ToolResult::Deleted(deleted_id) => assert_eq!(deleted_id, id),
            other => panic!("expected Deleted, got {other:?}"),
        }
    }

    #[test]
    fn click_on_empty_space_is_ignored() {
        let annotations = vec![box_at(0.0, 0.0)];
        let mut tool = EraserTool::new();

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(500.0, 500.0),
                button: MouseButton::Left,
                modifiers: Modifiers::default(),
            },
            &ctx(&annotations),
        );

        assert!(matches!(result, ToolResult::Ignored));
    }

    #[test]
    fn drag_erases_multiple_annotations() {
        let annotations = vec![box_at(0.0, 0.0), box_at(100.0, 100.0)];
        let mut tool = EraserTool::new();

        let first = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(10.0, 10.0),
                button: MouseButton::Left,
                modifiers: Modifiers::default(),
            },
            &ctx(&annotations),
        );
        assert!(matches!(first, ToolResult::Deleted(_)));

        let second = tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(110.0, 110.0),
                modifiers: Modifiers::default(),
            },
            &ctx(&annotations),
        );
        assert!(matches!(second, ToolResult::Deleted(_)));
    }

    #[test]
    fn locked_annotation_is_skipped() {
        let mut locked = box_at(0.0, 0.0);
        locked.locked = true;
        let annotations = vec![locked];
        let mut tool = EraserTool::new();

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(10.0, 10.0),
                button: MouseButton::Left,
                modifiers: Modifiers::default(),
            },
            &ctx(&annotations),
        );

        assert!(matches!(result, ToolResult::Ignored));
    }

    #[test]
    fn mouse_up_stops_drag_erasing() {
        let mut tool = EraserTool::new();
        tool.erasing = true;
        tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(0.0, 0.0),
                button: MouseButton::Left,
            },
            &ctx(&[]),
        );
        assert!(!tool.is_active());
    }
}
