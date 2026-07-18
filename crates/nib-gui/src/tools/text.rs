//! Text tool implementation

use std::any::Any;

use nib_core::{Annotation, AnnotationId, AnnotationType, Point, TextAlign};

use super::{
    MouseButton, StickyStyle, TextInputState, Tool, ToolContext, ToolEvent, ToolId, ToolMode,
    ToolPreview, ToolResult,
};

/// Default font size for text annotations (in image pixels)
pub const TEXT_FONT_SIZE: f64 = 32.0;

/// Tool for creating text annotations
pub struct TextTool {
    state: TextInputState,
    drag_start: Option<Point>,
    pending_max_width: Option<f64>,
    /// Set by `begin_sticky` (called by EditorView when the Sticky tool hands
    /// off) so the next `confirm_text` produces a Text annotation with a
    /// background/max_width instead of the plain default. Consumed (taken)
    /// on confirm, so it never leaks into a later ordinary text entry.
    pending_sticky: Option<StickyStyle>,
}

impl TextTool {
    pub fn new() -> Self {
        Self {
            state: TextInputState::default(),
            drag_start: None,
            pending_max_width: None,
            pending_sticky: None,
        }
    }

    /// Get the current text input state (for external rendering)
    pub fn text_state(&self) -> &TextInputState {
        &self.state
    }

    /// Width chosen by horizontally dragging after pressing T. `None` keeps
    /// the original click-to-autosize behavior.
    pub fn max_width(&self) -> Option<f64> {
        self.pending_max_width
    }

    /// Start a new text entry that will produce a sticky note (background +
    /// max_width) on confirm, reusing the same typing/backspace/confirm flow
    /// as ordinary text entry. Called by EditorView after switching the
    /// active tool to Text in response to the Sticky tool's click.
    pub fn begin_sticky(&mut self, position: Point, style: StickyStyle) {
        self.state.start_new(position);
        self.drag_start = None;
        self.pending_max_width = None;
        self.pending_sticky = Some(style);
    }

    /// Start editing an EXISTING text/sticky annotation's content, reusing the
    /// same typing/backspace/confirm flow as ordinary text entry. Called by
    /// EditorView after switching the active tool to Text in response to a
    /// double-click on an existing Text annotation via SelectTool.
    pub fn begin_edit(&mut self, id: AnnotationId, position: Point, content: String) {
        self.state.start_edit(id, position, content);
        self.drag_start = None;
        self.pending_max_width = None;
    }

    /// Confirm the current text and create/update annotation
    pub fn confirm_text(&mut self, ctx: &ToolContext) -> ToolResult {
        if self.state.content.trim().is_empty() {
            self.state.reset();
            self.pending_sticky = None;
            return ToolResult::ExitMode;
        }

        let position = match self.state.position {
            Some(pos) => pos,
            None => {
                self.state.reset();
                self.pending_sticky = None;
                return ToolResult::ExitMode;
            }
        };

        // Clone content before reset to preserve it for the result
        let content = self.state.content.clone();
        let editing_id = self.state.editing_id;
        let sticky_style = self.pending_sticky.take();
        let dragged_max_width = self.pending_max_width.take();
        self.drag_start = None;
        self.state.reset();

        if let Some(id) = editing_id {
            // Return update result with content - EditorView handles the actual update
            ToolResult::Batch(vec![
                ToolResult::UpdatedText(id, content),
                ToolResult::ExitMode,
            ])
        } else {
            let (background, max_width, color) = match sticky_style {
                Some(style) => (
                    Some(style.background),
                    Some(style.max_width),
                    style.text_color,
                ),
                None => (None, dragged_max_width, ctx.effective_color()),
            };
            let annotation = Annotation::new(AnnotationType::Text {
                position,
                content,
                font_size: ctx.font_size,
                align: TextAlign::Left,
                background,
                max_width,
            })
            .with_color(color);

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
                self.drag_start = Some(position);
                self.pending_max_width = None;
                ToolResult::EnterMode(ToolMode::TextInput {
                    position,
                    initial_content: String::new(),
                    editing_annotation_id: None,
                    sticky_style: None,
                })
            }
            ToolEvent::MouseMove { position, .. } if self.state.active => {
                if let Some(start) = self.drag_start {
                    let width = (position.x - start.x).abs();
                    self.pending_max_width =
                        (width >= ctx.min_drag_distance * 6.0).then_some(width);
                    ToolResult::Handled
                } else {
                    ToolResult::Ignored
                }
            }
            ToolEvent::MouseUp {
                button: MouseButton::Left,
                ..
            } if self.state.active => {
                self.drag_start = None;
                ToolResult::Handled
            }
            ToolEvent::KeyDown { key, key_char, .. } if self.state.active => match key.as_str() {
                "enter" | "return" => self.confirm_text(ctx),
                "escape" => {
                    self.state.reset();
                    ToolResult::ExitMode
                }
                "backspace" => {
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
            },
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
        self.drag_start = None;
        self.pending_max_width = None;
        self.pending_sticky = None;
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
