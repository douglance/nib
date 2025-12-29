//! Select tool implementation

use std::any::Any;

use crate::core::types::{AnnotationId, AnnotationType};

use super::{MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolMode, ToolPreview, ToolResult};

/// Tool for selecting and editing annotations
pub struct SelectTool {
    selected_id: Option<AnnotationId>,
}

impl SelectTool {
    pub fn new() -> Self {
        Self { selected_id: None }
    }

    /// Get the currently selected annotation ID
    pub fn selected(&self) -> Option<AnnotationId> {
        self.selected_id
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
                ..
            } => {
                // Find annotation at click position
                if let Some(annotation) = ctx.annotation_at(position) {
                    self.selected_id = Some(annotation.id);

                    // For text annotations, enter edit mode
                    if let AnnotationType::Text {
                        position: text_pos,
                        content,
                        ..
                    } = &annotation.annotation_type
                    {
                        return ToolResult::EnterMode(ToolMode::TextInput {
                            position: *text_pos,
                            initial_content: content.clone(),
                            editing_annotation_id: Some(annotation.id),
                        });
                    }

                    ToolResult::Handled
                } else {
                    // Click on empty space - deselect
                    self.selected_id = None;
                    ToolResult::Handled
                }
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
        self.selected_id = None;
    }

    fn is_active(&self) -> bool {
        false
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
