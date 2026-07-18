//! Sticky note tool implementation
//!
//! A sticky note is NOT a new `AnnotationType` -- it's a `Text` annotation
//! with `background`/`max_width` set (already full-fidelity across the wire
//! protocol, SQLite storage, and the sidecar JSON's style block). This tool
//! is a one-shot trigger: on click it hands off to the Text tool's existing
//! typing/backspace/confirm flow (see `EditorView`'s `ToolResult::EnterMode`
//! handling and `TextTool::begin_sticky`) rather than duplicating it, so it
//! never itself receives `KeyDown` events.

use std::any::Any;

use nib_core::Color;

use super::{
    MouseButton, StickyStyle, Tool, ToolContext, ToolEvent, ToolId, ToolMode, ToolPreview,
    ToolResult,
};

/// Fixed wrap width for sticky notes (image pixels).
pub const STICKY_MAX_WIDTH: f64 = 200.0;

/// Pick black or white text for readability against `background`, using
/// perceptual (ITU-R BT.601) luminance.
pub fn contrasting_text_color(background: Color) -> Color {
    let luminance =
        0.299 * background.r as f64 + 0.587 * background.g as f64 + 0.114 * background.b as f64;
    if luminance > 140.0 {
        Color::rgb(0, 0, 0)
    } else {
        Color::rgb(255, 255, 255)
    }
}

/// Tool that places a sticky note (a background+max_width Text annotation)
#[derive(Default)]
pub struct StickyTool;

impl StickyTool {
    pub fn new() -> Self {
        Self
    }
}

impl Tool for StickyTool {
    fn id(&self) -> ToolId {
        ToolId::Sticky
    }

    fn name(&self) -> &'static str {
        "Sticky"
    }

    fn shortcut(&self) -> char {
        'k'
    }

    fn icon_path(&self) -> &'static str {
        "icons/sticky.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown {
                position,
                button: MouseButton::Left,
                ..
            } => {
                let background = ctx.effective_color();
                let text_color = contrasting_text_color(background);
                ToolResult::EnterMode(ToolMode::TextInput {
                    position,
                    initial_content: String::new(),
                    editing_annotation_id: None,
                    sticky_style: Some(StickyStyle {
                        background,
                        text_color,
                        max_width: STICKY_MAX_WIDTH,
                    }),
                })
            }
            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, _ctx: &ToolContext) -> ToolPreview {
        ToolPreview::None
    }

    fn reset(&mut self) {}

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

#[cfg(test)]
mod tests {
    use super::*;
    use nib_core::{AnnotationStyle, Point, StrokeStyle};

    fn ctx() -> ToolContext<'static> {
        static EMPTY: Vec<nib_core::Annotation> = Vec::new();
        ToolContext {
            style: AnnotationStyle::Custom,
            custom_color: Color::rgb(245, 200, 20),
            stroke_width: 2.0,
            fill_enabled: false,
            stroke_style: StrokeStyle::Solid,
            arrow_head: nib_core::ArrowHead::End,
            font_size: 32.0,
            blur_intensity: nib_core::BlurIntensity::Medium,
            opacity: 1.0,
            image_size: (1920, 1080),
            scale: 1.0,
            offset: (0.0, 0.0),
            annotations: &EMPTY,
            min_drag_distance: 5.0,
        }
    }

    #[test]
    fn click_enters_text_mode_with_sticky_style() {
        let mut tool = StickyTool::new();
        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(10.0, 20.0),
                button: MouseButton::Left,
                modifiers: super::super::Modifiers::default(),
            },
            &ctx(),
        );

        match result {
            ToolResult::EnterMode(ToolMode::TextInput {
                position,
                sticky_style,
                ..
            }) => {
                assert_eq!(position, Point::new(10.0, 20.0));
                let style = sticky_style.expect("sticky tool must set sticky_style");
                assert_eq!(style.background, Color::rgb(245, 200, 20));
                assert_eq!(style.max_width, STICKY_MAX_WIDTH);
            }
            other => panic!("expected EnterMode(TextInput), got {other:?}"),
        }
    }

    #[test]
    fn light_background_gets_black_text() {
        assert_eq!(
            contrasting_text_color(Color::rgb(255, 255, 255)),
            Color::rgb(0, 0, 0)
        );
    }

    #[test]
    fn dark_background_gets_white_text() {
        assert_eq!(
            contrasting_text_color(Color::rgb(10, 10, 10)),
            Color::rgb(255, 255, 255)
        );
    }
}
