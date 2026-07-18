//! Number tool implementation

use std::any::Any;

use nib_core::{Annotation, AnnotationType};

use super::{
    MouseButton, NumberToolState, Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult,
};

/// Tool for placing numbered callout annotations
pub struct NumberTool {
    state: NumberToolState,
}

impl NumberTool {
    pub fn new() -> Self {
        Self {
            state: NumberToolState::default(),
        }
    }
}

impl Default for NumberTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Tool for NumberTool {
    fn id(&self) -> ToolId {
        ToolId::Number
    }

    fn name(&self) -> &'static str {
        "Number"
    }

    fn shortcut(&self) -> char {
        'n'
    }

    fn icon_path(&self) -> &'static str {
        "icons/number.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown {
                position,
                button: MouseButton::Left,
                ..
            } => {
                let next_value = ctx.next_number_value();
                self.state.last_placed = Some(position);

                let annotation = Annotation::new(AnnotationType::Number {
                    position,
                    value: next_value,
                    radius: 14.0,
                })
                .with_color(ctx.effective_color());

                ToolResult::Created(annotation)
            }
            ToolEvent::Deactivated => {
                self.reset();
                ToolResult::Handled
            }
            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, _ctx: &ToolContext) -> ToolPreview {
        // Number tool has no drag preview - immediate creation
        ToolPreview::None
    }

    fn reset(&mut self) {
        self.state.last_placed = None;
    }

    fn is_active(&self) -> bool {
        // Number tool completes instantly, never in active state
        false
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
