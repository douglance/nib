//! Text tool implementation

use std::any::Any;

use crate::core::types::{Annotation, AnnotationType, TextAlign};

use super::{
    MouseButton, TextInputState, Tool, ToolContext, ToolEvent, ToolId, ToolMode, ToolPreview,
    ToolResult,
};

/// Tool for creating text annotations
pub struct TextTool {
    state: TextInputState,
}

impl TextTool {
    pub fn new() -> Self {
        Self {
            state: TextInputState::default(),
        }
    }

    /// Get the current text input state (for external rendering)
    pub fn text_state(&self) -> &TextInputState {
        &self.state
    }

    /// Confirm the current text and create/update annotation
    fn confirm_text(&mut self, ctx: &ToolContext) -> ToolResult {
        if self.state.content.trim().is_empty() {
            self.state.reset();
            return ToolResult::ExitMode;
        }

        let position = match self.state.position {
            Some(pos) => pos,
            None => {
                self.state.reset();
                return ToolResult::ExitMode;
            }
        };

        // Clone content before reset to preserve it for the result
        let content = self.state.content.clone();
        let editing_id = self.state.editing_id;
        self.state.reset();

        if let Some(id) = editing_id {
            // Return update result with content - EditorView handles the actual update
            ToolResult::Batch(vec![ToolResult::UpdatedText(id, content), ToolResult::ExitMode])
        } else {
            let annotation = Annotation::new(AnnotationType::Text {
                position,
                content,
                font_size: 16.0,
                align: TextAlign::Left,
                background: None,
                max_width: None,
            })
            .with_color(ctx.color);

            ToolResult::Batch(vec![ToolResult::Created(annotation), ToolResult::ExitMode])
        }
    }
}

impl Default for TextTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Tool for TextTool {
    fn id(&self) -> ToolId {
        ToolId::Text
    }

    fn name(&self) -> &'static str {
        "Text"
    }

    fn shortcut(&self) -> char {
        't'
    }

    fn icon_path(&self) -> &'static str {
        "icons/text.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown {
                position,
                button: MouseButton::Left,
                ..
            } => {
                if self.state.active {
                    // Clicking away confirms text
                    return self.confirm_text(ctx);
                }

                // Start new text input
                self.state.start_new(position);
                ToolResult::EnterMode(ToolMode::TextInput {
                    position,
                    initial_content: String::new(),
                    editing_annotation_id: None,
                })
            }
            ToolEvent::KeyDown { key, key_char, .. } if self.state.active => {
                match key.as_str() {
                    "Enter" | "Return" => self.confirm_text(ctx),
                    "Escape" => {
                        self.state.reset();
                        ToolResult::ExitMode
                    }
                    "Backspace" => {
                        self.state.backspace();
                        ToolResult::Handled
                    }
                    _ => {
                        if let Some(ch) = key_char {
                            self.state.content.push(ch);
                            ToolResult::Handled
                        } else if key.len() == 1 {
                            self.state.content.push_str(&key);
                            ToolResult::Handled
                        } else {
                            ToolResult::Ignored
                        }
                    }
                }
            }
            ToolEvent::Deactivated => {
                if self.state.active && !self.state.content.is_empty() {
                    return self.confirm_text(ctx);
                }
                self.reset();
                ToolResult::Handled
            }
            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, _ctx: &ToolContext) -> ToolPreview {
        // Text preview is handled specially by EditorView using text_state()
        ToolPreview::None
    }

    fn reset(&mut self) {
        self.state.reset();
    }

    fn is_active(&self) -> bool {
        self.state.active
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
