//! Unit tests for tool trait implementations

use nib_core::{
    Annotation, AnnotationStyle, AnnotationType, ArrowHead, BlurIntensity, Color, Point, Region,
    StrokeStyle,
};
use crate::tools::*;

// ============================================================================
// Test Utilities
// ============================================================================

/// Create a test context with default settings
fn make_test_context() -> ToolContext<'static> {
    static EMPTY: Vec<Annotation> = Vec::new();
    ToolContext {
        style: AnnotationStyle::Custom,
        custom_color: Color::RED,
        stroke_width: 2.0,
        fill_enabled: false,
        stroke_style: StrokeStyle::Solid,
        arrow_head: ArrowHead::End,
        font_size: 32.0,
        blur_intensity: BlurIntensity::Medium,
        opacity: 1.0,
        image_size: (1920, 1080),
        scale: 1.0,
        offset: (0.0, 0.0),
        annotations: &EMPTY,
        min_drag_distance: 5.0,
    }
}

/// Create a test context with existing annotations
fn make_test_context_with_annotations(annotations: &[Annotation]) -> ToolContext<'_> {
    ToolContext {
        style: AnnotationStyle::Custom,
        custom_color: Color::RED,
        stroke_width: 2.0,
        fill_enabled: false,
        stroke_style: StrokeStyle::Solid,
        arrow_head: ArrowHead::End,
        font_size: 32.0,
        blur_intensity: BlurIntensity::Medium,
        opacity: 1.0,
        image_size: (1920, 1080),
        scale: 1.0,
        offset: (0.0, 0.0),
        annotations,
        min_drag_distance: 5.0,
    }
}

/// Create default modifiers (no keys pressed)
fn no_modifiers() -> Modifiers {
    Modifiers::default()
}

/// Helper to check if result is Created with a specific annotation type
fn assert_created_type(result: &ToolResult, expected_type: &str) {
    match result {
        ToolResult::Created(annotation) => {
            assert_eq!(
                annotation.annotation_type.type_name(),
                expected_type,
                "Expected annotation type {}, got {}",
                expected_type,
                annotation.annotation_type.type_name()
            );
        }
        _ => panic!("Expected Created result, got {:?}", result),
    }
}

// ============================================================================
// ToolId Tests
// ============================================================================

#[cfg(test)]
mod tool_id_tests {
    use super::*;

    #[test]
    fn test_tool_id_all_returns_twelve_tools() {
        let all_tools = ToolId::all();
        assert_eq!(all_tools.len(), 12, "Expected 12 tools");
    }

    #[test]
    fn test_tool_id_names() {
        assert_eq!(ToolId::Select.name(), "Select");
        assert_eq!(ToolId::Arrow.name(), "Arrow");
        assert_eq!(ToolId::Rectangle.name(), "Rectangle");
        assert_eq!(ToolId::Ellipse.name(), "Ellipse");
        assert_eq!(ToolId::Text.name(), "Text");
        assert_eq!(ToolId::Number.name(), "Number");
        assert_eq!(ToolId::Blur.name(), "Blur");
        assert_eq!(ToolId::Highlight.name(), "Highlight");
        assert_eq!(ToolId::Line.name(), "Line");
        assert_eq!(ToolId::Crop.name(), "Crop");
    }

    #[test]
    fn test_tool_id_shortcuts() {
        assert_eq!(ToolId::Select.shortcut(), 'v');
        assert_eq!(ToolId::Arrow.shortcut(), 'a');
        assert_eq!(ToolId::Rectangle.shortcut(), 'r');
        assert_eq!(ToolId::Ellipse.shortcut(), 'e');
        assert_eq!(ToolId::Text.shortcut(), 't');
        assert_eq!(ToolId::Number.shortcut(), 'n');
        assert_eq!(ToolId::Blur.shortcut(), 'b');
        assert_eq!(ToolId::Highlight.shortcut(), 'h');
        assert_eq!(ToolId::Line.shortcut(), 'l');
        assert_eq!(ToolId::Crop.shortcut(), 'c');
    }

    #[test]
    fn test_tool_id_default() {
        let default_id: ToolId = Default::default();
        assert_eq!(default_id, ToolId::Select);
    }

    #[test]
    fn test_tool_id_shortcuts_are_unique() {
        let mut shortcuts: Vec<char> = ToolId::all().iter().map(|t| t.shortcut()).collect();
        shortcuts.sort();
        let original_len = shortcuts.len();
        shortcuts.dedup();
        assert_eq!(shortcuts.len(), original_len, "Tool shortcuts must be unique");
    }
}

// ============================================================================
// ToolContext Tests
// ============================================================================

#[cfg(test)]
mod tool_context_tests {
    use super::*;

    #[test]
    fn test_screen_to_image_at_scale_1() {
        let ctx = make_test_context();
        let point = ctx.screen_to_image(100.0, 200.0);
        assert_eq!(point.x, 100.0);
        assert_eq!(point.y, 200.0);
    }

    #[test]
    fn test_screen_to_image_at_scale_2() {
        static EMPTY: Vec<Annotation> = Vec::new();
        let ctx = ToolContext {
            style: AnnotationStyle::Custom,
            custom_color: Color::RED,
            stroke_width: 2.0,
            fill_enabled: false,
            stroke_style: StrokeStyle::Solid,
            arrow_head: ArrowHead::End,
            font_size: 32.0,
            blur_intensity: BlurIntensity::Medium,
            opacity: 1.0,
            image_size: (1920, 1080),
            scale: 2.0,
            offset: (0.0, 0.0),
            annotations: &EMPTY,
            min_drag_distance: 5.0,
        };
        let point = ctx.screen_to_image(100.0, 200.0);
        assert_eq!(point.x, 50.0);
        assert_eq!(point.y, 100.0);
    }

    #[test]
    fn test_screen_to_image_with_offset() {
        static EMPTY: Vec<Annotation> = Vec::new();
        let ctx = ToolContext {
            style: AnnotationStyle::Custom,
            custom_color: Color::RED,
            stroke_width: 2.0,
            fill_enabled: false,
            stroke_style: StrokeStyle::Solid,
            arrow_head: ArrowHead::End,
            font_size: 32.0,
            blur_intensity: BlurIntensity::Medium,
            opacity: 1.0,
            image_size: (1920, 1080),
            scale: 1.0,
            offset: (50.0, 100.0),
            annotations: &EMPTY,
            min_drag_distance: 5.0,
        };
        let point = ctx.screen_to_image(100.0, 200.0);
        assert_eq!(point.x, 50.0);
        assert_eq!(point.y, 100.0);
    }

    #[test]
    fn test_image_to_screen_at_scale_1() {
        let ctx = make_test_context();
        let (screen_x, screen_y) = ctx.image_to_screen(Point::new(100.0, 200.0));
        assert_eq!(screen_x, 100.0);
        assert_eq!(screen_y, 200.0);
    }

    #[test]
    fn test_image_to_screen_at_scale_2() {
        static EMPTY: Vec<Annotation> = Vec::new();
        let ctx = ToolContext {
            style: AnnotationStyle::Custom,
            custom_color: Color::RED,
            stroke_width: 2.0,
            fill_enabled: false,
            stroke_style: StrokeStyle::Solid,
            arrow_head: ArrowHead::End,
            font_size: 32.0,
            blur_intensity: BlurIntensity::Medium,
            opacity: 1.0,
            image_size: (1920, 1080),
            scale: 2.0,
            offset: (50.0, 100.0),
            annotations: &EMPTY,
            min_drag_distance: 5.0,
        };
        let (screen_x, screen_y) = ctx.image_to_screen(Point::new(100.0, 200.0));
        assert_eq!(screen_x, 250.0); // 100 * 2 + 50
        assert_eq!(screen_y, 500.0); // 200 * 2 + 100
    }

    #[test]
    fn test_next_number_value_empty_annotations() {
        let ctx = make_test_context();
        assert_eq!(ctx.next_number_value(), 1);
    }

    #[test]
    fn test_next_number_value_with_existing() {
        let annotations = vec![
            Annotation::new(AnnotationType::Number {
                position: Point::new(100.0, 100.0),
                value: 1,
                radius: 14.0,
            }),
            Annotation::new(AnnotationType::Number {
                position: Point::new(200.0, 200.0),
                value: 3,
                radius: 14.0,
            }),
        ];
        let ctx = make_test_context_with_annotations(&annotations);
        assert_eq!(ctx.next_number_value(), 4);
    }

    #[test]
    fn test_annotation_at_empty() {
        let ctx = make_test_context();
        let result = ctx.annotation_at(Point::new(100.0, 100.0));
        assert!(result.is_none());
    }

    #[test]
    fn test_annotation_at_hit() {
        let annotations = vec![Annotation::new(AnnotationType::Box {
            region: Region::new(50.0, 50.0, 100.0, 100.0),
            stroke_width: 2.0,
            stroke_style: nib_core::StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })];
        let ctx = make_test_context_with_annotations(&annotations);
        let result = ctx.annotation_at(Point::new(100.0, 100.0));
        assert!(result.is_some());
    }
}

// ============================================================================
// DragState Tests
// ============================================================================

#[cfg(test)]
mod drag_state_tests {
    use super::*;

    #[test]
    fn test_drag_state_default() {
        let state = DragState::default();
        assert!(!state.is_dragging());
        assert!(state.start.is_none());
        assert!(state.current.is_none());
    }

    #[test]
    fn test_drag_state_start_drag() {
        let mut state = DragState::default();
        state.start_drag(Point::new(100.0, 100.0));

        assert!(state.is_dragging());
        assert_eq!(state.start, Some(Point::new(100.0, 100.0)));
        assert_eq!(state.current, Some(Point::new(100.0, 100.0)));
    }

    #[test]
    fn test_drag_state_update() {
        let mut state = DragState::default();
        state.start_drag(Point::new(100.0, 100.0));
        state.update(Point::new(200.0, 150.0));

        assert_eq!(state.start, Some(Point::new(100.0, 100.0)));
        assert_eq!(state.current, Some(Point::new(200.0, 150.0)));
    }

    #[test]
    fn test_drag_state_end_drag() {
        let mut state = DragState::default();
        state.start_drag(Point::new(100.0, 100.0));
        state.update(Point::new(200.0, 150.0));

        let result = state.end_drag();
        assert_eq!(
            result,
            Some((Point::new(100.0, 100.0), Point::new(200.0, 150.0)))
        );
        assert!(!state.is_dragging());
    }

    #[test]
    fn test_drag_state_reset() {
        let mut state = DragState::default();
        state.start_drag(Point::new(100.0, 100.0));
        state.reset();

        assert!(!state.is_dragging());
        assert!(state.start.is_none());
        assert!(state.current.is_none());
    }
}

// ============================================================================
// Rectangle Tool Tests
// ============================================================================

#[cfg(test)]
mod rectangle_tool_tests {
    use super::*;

    #[test]
    fn test_rectangle_tool_id() {
        let tool = RectangleTool::new();
        assert_eq!(tool.id(), ToolId::Rectangle);
        assert_eq!(tool.name(), "Rectangle");
        assert_eq!(tool.shortcut(), 'r');
    }

    #[test]
    fn test_rectangle_tool_initial_state() {
        let tool = RectangleTool::new();
        assert!(!tool.is_active());
    }

    #[test]
    fn test_rectangle_tool_drag_create() {
        let mut tool = RectangleTool::new();
        let ctx = make_test_context();

        // Start drag
        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(matches!(result, ToolResult::Handled));
        assert!(tool.is_active());

        // Move to form rectangle
        let result = tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 150.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(matches!(result, ToolResult::Handled));

        // Release to create
        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(200.0, 150.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert_created_type(&result, "box");
        assert!(!tool.is_active());
    }

    #[test]
    fn test_rectangle_tool_creation_carries_ctx_style_values() {
        let mut tool = RectangleTool::new();
        let ctx = ToolContext {
            stroke_width: 8.0,
            stroke_style: StrokeStyle::Dashed,
            fill_enabled: true,
            ..make_test_context()
        };

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 150.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(200.0, 150.0),
                button: MouseButton::Left,
            },
            &ctx,
        );

        match result {
            ToolResult::Created(annotation) => match annotation.annotation_type {
                AnnotationType::Box { stroke_width, stroke_style, filled, .. } => {
                    assert_eq!(stroke_width, 8.0);
                    assert_eq!(stroke_style, StrokeStyle::Dashed);
                    assert!(filled);
                }
                other => panic!("expected Box, got {other:?}"),
            },
            other => panic!("expected Created, got {other:?}"),
        }
    }

    #[test]
    fn test_rectangle_tool_small_drag_ignored() {
        let mut tool = RectangleTool::new();
        let ctx = make_test_context();

        // Start drag
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Very small movement (less than min_drag_distance = 5.0)
        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(102.0, 102.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert!(matches!(result, ToolResult::Ignored));
    }

    #[test]
    fn test_rectangle_tool_preview() {
        let mut tool = RectangleTool::new();
        let ctx = make_test_context();

        // No preview before drag
        assert!(matches!(tool.preview(&ctx), ToolPreview::None));

        // Start drag
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Update position
        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 150.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Should have rectangle preview
        let preview = tool.preview(&ctx);
        assert!(matches!(preview, ToolPreview::Rectangle { .. }));
    }

    #[test]
    fn test_rectangle_tool_reset() {
        let mut tool = RectangleTool::new();
        let ctx = make_test_context();

        // Start drag
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(tool.is_active());

        tool.reset();
        assert!(!tool.is_active());
    }

    #[test]
    fn test_rectangle_tool_right_click_ignored() {
        let mut tool = RectangleTool::new();
        let ctx = make_test_context();

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Right,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(matches!(result, ToolResult::Ignored));
        assert!(!tool.is_active());
    }

    #[test]
    fn test_rectangle_tool_deactivated_resets_state() {
        let mut tool = RectangleTool::new();
        let ctx = make_test_context();

        // Start drag
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(tool.is_active());

        // Deactivate
        let result = tool.handle_event(ToolEvent::Deactivated, &ctx);
        assert!(matches!(result, ToolResult::Handled));
        assert!(!tool.is_active());
    }
}

// ============================================================================
// Arrow Tool Tests
// ============================================================================

#[cfg(test)]
mod arrow_tool_tests {
    use super::*;

    #[test]
    fn test_arrow_tool_id() {
        let tool = ArrowTool::new();
        assert_eq!(tool.id(), ToolId::Arrow);
        assert_eq!(tool.name(), "Arrow");
        assert_eq!(tool.shortcut(), 'a');
    }

    #[test]
    fn test_arrow_tool_drag_create() {
        let mut tool = ArrowTool::new();
        let ctx = make_test_context();

        // Start drag
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Move
        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Release
        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(200.0, 200.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert_created_type(&result, "arrow");
    }

    #[test]
    fn test_arrow_tool_creation_carries_ctx_style_values() {
        let mut tool = ArrowTool::new();
        let ctx = ToolContext {
            stroke_width: 8.0,
            arrow_head: ArrowHead::Both,
            ..make_test_context()
        };

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(200.0, 200.0),
                button: MouseButton::Left,
            },
            &ctx,
        );

        match result {
            ToolResult::Created(annotation) => match annotation.annotation_type {
                AnnotationType::Arrow { stroke_width, head, .. } => {
                    assert_eq!(stroke_width, 8.0);
                    assert_eq!(head, ArrowHead::Both);
                }
                other => panic!("expected Arrow, got {other:?}"),
            },
            other => panic!("expected Created, got {other:?}"),
        }
    }

    #[test]
    fn test_arrow_tool_preview_is_line() {
        let mut tool = ArrowTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let preview = tool.preview(&ctx);
        assert!(matches!(preview, ToolPreview::Line { .. }));
    }

    #[test]
    fn test_arrow_tool_small_drag_ignored() {
        let mut tool = ArrowTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(101.0, 101.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert!(matches!(result, ToolResult::Ignored));
    }
}

// ============================================================================
// Line Tool Tests
// ============================================================================

#[cfg(test)]
mod line_tool_tests {
    use super::*;

    #[test]
    fn test_line_tool_id() {
        let tool = LineTool::new();
        assert_eq!(tool.id(), ToolId::Line);
        assert_eq!(tool.name(), "Line");
        assert_eq!(tool.shortcut(), 'l');
    }

    #[test]
    fn test_line_tool_drag_create() {
        let mut tool = LineTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(300.0, 300.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(300.0, 300.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert_created_type(&result, "line");
    }

    #[test]
    fn test_line_tool_creation_carries_ctx_style_values() {
        let mut tool = LineTool::new();
        let ctx = ToolContext {
            stroke_width: 8.0,
            stroke_style: StrokeStyle::Dotted,
            ..make_test_context()
        };

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(300.0, 300.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(300.0, 300.0),
                button: MouseButton::Left,
            },
            &ctx,
        );

        match result {
            ToolResult::Created(annotation) => match annotation.annotation_type {
                AnnotationType::Line { stroke_width, stroke_style, .. } => {
                    assert_eq!(stroke_width, 8.0);
                    assert_eq!(stroke_style, StrokeStyle::Dotted);
                }
                other => panic!("expected Line, got {other:?}"),
            },
            other => panic!("expected Created, got {other:?}"),
        }
    }

    #[test]
    fn test_line_tool_preview() {
        let mut tool = LineTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let preview = tool.preview(&ctx);
        assert!(matches!(preview, ToolPreview::Line { .. }));
    }
}

// ============================================================================
// Ellipse Tool Tests
// ============================================================================

#[cfg(test)]
mod ellipse_tool_tests {
    use super::*;

    #[test]
    fn test_ellipse_tool_id() {
        let tool = EllipseTool::new();
        assert_eq!(tool.id(), ToolId::Ellipse);
        assert_eq!(tool.name(), "Ellipse");
        assert_eq!(tool.shortcut(), 'e');
    }

    #[test]
    fn test_ellipse_tool_drag_create() {
        let mut tool = EllipseTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 180.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(200.0, 180.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert_created_type(&result, "ellipse");
    }

    #[test]
    fn test_ellipse_tool_preview() {
        let mut tool = EllipseTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 180.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let preview = tool.preview(&ctx);
        assert!(matches!(preview, ToolPreview::Ellipse { .. }));
    }

    #[test]
    fn test_ellipse_tool_small_drag_ignored() {
        let mut tool = EllipseTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(102.0, 102.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert!(matches!(result, ToolResult::Ignored));
    }
}

// ============================================================================
// Highlight Tool Tests
// ============================================================================

#[cfg(test)]
mod highlight_tool_tests {
    use super::*;

    #[test]
    fn test_highlight_tool_id() {
        let tool = HighlightTool::new();
        assert_eq!(tool.id(), ToolId::Highlight);
        assert_eq!(tool.name(), "Highlight");
        assert_eq!(tool.shortcut(), 'h');
    }

    #[test]
    fn test_highlight_tool_drag_create() {
        let mut tool = HighlightTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(300.0, 120.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(300.0, 120.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert_created_type(&result, "highlight");
    }

    #[test]
    fn test_highlight_tool_preview() {
        let mut tool = HighlightTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(300.0, 120.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let preview = tool.preview(&ctx);
        assert!(matches!(preview, ToolPreview::Rectangle { .. }));
    }
}

// ============================================================================
// Blur Tool Tests
// ============================================================================

#[cfg(test)]
mod blur_tool_tests {
    use super::*;

    #[test]
    fn test_blur_tool_id() {
        let tool = BlurTool::new();
        assert_eq!(tool.id(), ToolId::Blur);
        assert_eq!(tool.name(), "Blur");
        assert_eq!(tool.shortcut(), 'b');
    }

    #[test]
    fn test_blur_tool_drag_create() {
        let mut tool = BlurTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(200.0, 200.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert_created_type(&result, "blur");
    }

    #[test]
    fn test_blur_tool_creation_carries_ctx_style_values() {
        let mut tool = BlurTool::new();
        let ctx = ToolContext {
            blur_intensity: BlurIntensity::Heavy,
            ..make_test_context()
        };

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(200.0, 200.0),
                button: MouseButton::Left,
            },
            &ctx,
        );

        match result {
            ToolResult::Created(annotation) => match annotation.annotation_type {
                AnnotationType::Blur { intensity, .. } => {
                    assert_eq!(intensity, BlurIntensity::Heavy);
                }
                other => panic!("expected Blur, got {other:?}"),
            },
            other => panic!("expected Created, got {other:?}"),
        }
    }

    #[test]
    fn test_blur_tool_uses_fixed_preview_color() {
        let mut tool = BlurTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let preview = tool.preview(&ctx);
        if let ToolPreview::Rectangle { color, .. } = preview {
            assert_eq!(color, BlurTool::BLUR_PREVIEW_COLOR);
        } else {
            panic!("Expected Rectangle preview");
        }
    }
}

// ============================================================================
// Crop Tool Tests
// ============================================================================

#[cfg(test)]
mod crop_tool_tests {
    use super::*;

    #[test]
    fn test_crop_tool_id() {
        let tool = CropTool::new();
        assert_eq!(tool.id(), ToolId::Crop);
        assert_eq!(tool.name(), "Crop");
        assert_eq!(tool.shortcut(), 'c');
    }

    #[test]
    fn test_crop_tool_drag_create() {
        let mut tool = CropTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(500.0, 400.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let result = tool.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(500.0, 400.0),
                button: MouseButton::Left,
            },
            &ctx,
        );
        assert_created_type(&result, "crop");
    }

    #[test]
    fn test_crop_tool_preview() {
        let mut tool = CropTool::new();
        let ctx = make_test_context();

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(500.0, 400.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let preview = tool.preview(&ctx);
        assert!(matches!(preview, ToolPreview::Rectangle { .. }));
    }
}

// ============================================================================
// Number Tool Tests
// ============================================================================

#[cfg(test)]
mod number_tool_tests {
    use super::*;

    #[test]
    fn test_number_tool_id() {
        let tool = NumberTool::new();
        assert_eq!(tool.id(), ToolId::Number);
        assert_eq!(tool.name(), "Number");
        assert_eq!(tool.shortcut(), 'n');
    }

    #[test]
    fn test_number_tool_creates_immediately_on_click() {
        let mut tool = NumberTool::new();
        let ctx = make_test_context();

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert_created_type(&result, "number");
    }

    #[test]
    fn test_number_tool_auto_increments() {
        let mut tool = NumberTool::new();
        let ctx = make_test_context();

        // First click should create number 1
        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        if let ToolResult::Created(annotation) = result {
            if let AnnotationType::Number { value, .. } = annotation.annotation_type {
                assert_eq!(value, 1);
            } else {
                panic!("Expected Number annotation type");
            }
        } else {
            panic!("Expected Created result");
        }
    }

    #[test]
    fn test_number_tool_with_existing_numbers() {
        let mut tool = NumberTool::new();
        let annotations = vec![
            Annotation::new(AnnotationType::Number {
                position: Point::new(50.0, 50.0),
                value: 1,
                radius: 14.0,
            }),
            Annotation::new(AnnotationType::Number {
                position: Point::new(150.0, 150.0),
                value: 2,
                radius: 14.0,
            }),
        ];
        let ctx = make_test_context_with_annotations(&annotations);

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(200.0, 200.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        if let ToolResult::Created(annotation) = result {
            if let AnnotationType::Number { value, .. } = annotation.annotation_type {
                assert_eq!(value, 3, "Should create number 3 after existing 1 and 2");
            } else {
                panic!("Expected Number annotation type");
            }
        } else {
            panic!("Expected Created result");
        }
    }

    #[test]
    fn test_number_tool_is_never_active() {
        let tool = NumberTool::new();
        assert!(!tool.is_active(), "Number tool should never be in active state");
    }

    #[test]
    fn test_number_tool_no_preview() {
        let tool = NumberTool::new();
        let ctx = make_test_context();
        assert!(matches!(tool.preview(&ctx), ToolPreview::None));
    }
}

// ============================================================================
// Text Tool Tests
// ============================================================================

#[cfg(test)]
mod text_tool_tests {
    use super::*;

    #[test]
    fn test_text_tool_id() {
        let tool = TextTool::new();
        assert_eq!(tool.id(), ToolId::Text);
        assert_eq!(tool.name(), "Text");
        assert_eq!(tool.shortcut(), 't');
    }

    #[test]
    fn test_text_tool_click_enters_text_mode() {
        let mut tool = TextTool::new();
        let ctx = make_test_context();

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        assert!(matches!(result, ToolResult::EnterMode(ToolMode::TextInput { .. })));
        assert!(tool.is_active());
    }

    #[test]
    fn test_text_tool_key_input() {
        let mut tool = TextTool::new();
        let ctx = make_test_context();

        // Start text input
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Type some text
        let result = tool.handle_event(
            ToolEvent::KeyDown {
                key: "H".to_string(),
                key_char: Some('H'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(matches!(result, ToolResult::Handled));

        tool.handle_event(
            ToolEvent::KeyDown {
                key: "i".to_string(),
                key_char: Some('i'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        assert_eq!(tool.text_state().content, "Hi");
    }

    #[test]
    fn test_text_tool_creation_carries_ctx_font_size() {
        let mut tool = TextTool::new();
        let ctx = ToolContext {
            font_size: 48.0,
            ..make_test_context()
        };

        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        tool.handle_event(
            ToolEvent::KeyDown {
                key: "H".to_string(),
                key_char: Some('H'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        let result = tool.confirm_text(&ctx);
        match result {
            ToolResult::Batch(results) => match &results[0] {
                ToolResult::Created(annotation) => match &annotation.annotation_type {
                    AnnotationType::Text { font_size, .. } => assert_eq!(*font_size, 48.0),
                    other => panic!("expected Text, got {other:?}"),
                },
                other => panic!("expected Created, got {other:?}"),
            },
            other => panic!("expected Batch, got {other:?}"),
        }
    }

    #[test]
    fn test_text_tool_backspace() {
        let mut tool = TextTool::new();
        let ctx = make_test_context();

        // Start and type
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::KeyDown {
                key: "H".to_string(),
                key_char: Some('H'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::KeyDown {
                key: "i".to_string(),
                key_char: Some('i'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Backspace
        tool.handle_event(
            ToolEvent::KeyDown {
                key: "backspace".to_string(),
                key_char: None,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        assert_eq!(tool.text_state().content, "H");
    }

    #[test]
    fn test_text_tool_enter_confirms() {
        let mut tool = TextTool::new();
        let ctx = make_test_context();

        // Start and type
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::KeyDown {
                key: "T".to_string(),
                key_char: Some('T'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Confirm with Enter
        let result = tool.handle_event(
            ToolEvent::KeyDown {
                key: "enter".to_string(),
                key_char: None,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Should create annotation and exit mode
        assert!(matches!(result, ToolResult::Batch(_)));
        assert!(!tool.is_active());
    }

    #[test]
    fn test_text_tool_escape_cancels() {
        let mut tool = TextTool::new();
        let ctx = make_test_context();

        // Start and type
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::KeyDown {
                key: "T".to_string(),
                key_char: Some('T'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Cancel with Escape
        let result = tool.handle_event(
            ToolEvent::KeyDown {
                key: "escape".to_string(),
                key_char: None,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        assert!(matches!(result, ToolResult::ExitMode));
        assert!(!tool.is_active());
        assert!(tool.text_state().content.is_empty());
    }

    #[test]
    fn test_text_tool_empty_text_not_created() {
        let mut tool = TextTool::new();
        let ctx = make_test_context();

        // Start but don't type anything
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Confirm with Enter (no text)
        let result = tool.handle_event(
            ToolEvent::KeyDown {
                key: "enter".to_string(),
                key_char: None,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Should just exit mode, not create
        assert!(matches!(result, ToolResult::ExitMode));
    }

    #[test]
    fn test_text_tool_click_away_confirms() {
        let mut tool = TextTool::new();
        let ctx = make_test_context();

        // Start and type
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        tool.handle_event(
            ToolEvent::KeyDown {
                key: "H".to_string(),
                key_char: Some('H'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Click elsewhere (should confirm)
        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(300.0, 300.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Should create annotation
        assert!(matches!(result, ToolResult::Batch(_)));
    }
}

// ============================================================================
// Select Tool Tests
// ============================================================================

#[cfg(test)]
mod select_tool_tests {
    use super::*;

    #[test]
    fn test_select_tool_id() {
        let tool = SelectTool::new();
        assert_eq!(tool.id(), ToolId::Select);
        assert_eq!(tool.name(), "Select");
        assert_eq!(tool.shortcut(), 'v');
    }

    #[test]
    fn test_select_tool_initial_state() {
        let tool = SelectTool::new();
        assert!(tool.selected().is_empty());
        assert!(!tool.is_active());
    }

    #[test]
    fn test_select_tool_click_empty_deselects() {
        let mut tool = SelectTool::new();
        let ctx = make_test_context();

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        assert!(matches!(result, ToolResult::Handled));
        assert!(tool.selected().is_empty());
    }

    #[test]
    fn test_select_tool_click_selects_annotation() {
        let mut tool = SelectTool::new();
        let annotations = vec![Annotation::new(AnnotationType::Box {
            region: Region::new(50.0, 50.0, 100.0, 100.0),
            stroke_width: 2.0,
            stroke_style: nib_core::StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })];
        let ctx = make_test_context_with_annotations(&annotations);

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        assert!(matches!(result, ToolResult::Handled));
        assert!(!tool.selected().is_empty());
    }

    #[test]
    fn test_select_tool_click_text_selects_without_edit_mode() {
        // Single-click on text now just selects, doesn't enter edit mode
        // (Edit mode will be triggered by double-click in Phase 6)
        let mut tool = SelectTool::new();
        let annotations = vec![Annotation::new(AnnotationType::Text {
            position: Point::new(100.0, 100.0),
            content: "Hello".to_string(),
            font_size: 16.0,
            align: nib_core::TextAlign::Left,
            background: None,
            max_width: None,
        })];
        let ctx = make_test_context_with_annotations(&annotations);

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(120.0, 110.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Single-click should just select, not enter edit mode
        assert!(matches!(result, ToolResult::Handled));
        assert!(!tool.selected().is_empty());
    }

    #[test]
    fn test_select_tool_reset() {
        let mut tool = SelectTool::new();
        let annotations = vec![Annotation::new(AnnotationType::Box {
            region: Region::new(50.0, 50.0, 100.0, 100.0),
            stroke_width: 2.0,
            stroke_style: nib_core::StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })];
        let ctx = make_test_context_with_annotations(&annotations);

        // Select something
        tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(!tool.selected().is_empty());

        // Reset
        tool.reset();
        assert!(tool.selected().is_empty());
    }

    #[test]
    fn test_select_tool_double_click_text_enters_edit_mode() {
        // Double-click on text annotation should enter edit mode (Phase 6)
        let mut tool = SelectTool::new();
        let annotations = vec![Annotation::new(AnnotationType::Text {
            position: Point::new(100.0, 100.0),
            content: "Hello World".to_string(),
            font_size: 16.0,
            align: nib_core::TextAlign::Left,
            background: None,
            max_width: None,
        })];
        let ctx = make_test_context_with_annotations(&annotations);

        // First click - should select
        let result1 = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(120.0, 110.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(matches!(result1, ToolResult::Handled));
        assert!(!tool.selected().is_empty());

        // Second click immediately after (simulates double-click)
        // The timing is handled internally by comparing with last_click_time
        let result2 = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(120.0, 110.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Should enter text edit mode
        match result2 {
            ToolResult::EnterMode(ToolMode::TextInput {
                position,
                initial_content,
                editing_annotation_id,
            }) => {
                assert_eq!(position.x, 100.0);
                assert_eq!(position.y, 100.0);
                assert_eq!(initial_content, "Hello World");
                assert!(editing_annotation_id.is_some());
            }
            _ => panic!("Expected EnterMode(TextInput), got {:?}", result2),
        }
    }

    #[test]
    fn test_select_tool_double_click_non_text_does_not_enter_edit_mode() {
        // Double-click on non-text annotation should not enter edit mode
        let mut tool = SelectTool::new();
        let annotations = vec![Annotation::new(AnnotationType::Box {
            region: Region::new(50.0, 50.0, 100.0, 100.0),
            stroke_width: 2.0,
            stroke_style: nib_core::StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })];
        let ctx = make_test_context_with_annotations(&annotations);

        // First click
        let _result1 = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Second click immediately (double-click)
        let result2 = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Should NOT enter edit mode for non-text annotation
        assert!(matches!(result2, ToolResult::Handled));
    }
}

// ============================================================================
// Tool Manager Tests
// ============================================================================

#[cfg(test)]
mod tool_manager_tests {
    use super::*;

    #[test]
    fn test_tool_manager_with_all_tools() {
        let manager = ToolManager::with_all_tools();

        // Verify all 11 tools are registered
        for tool_id in ToolId::all() {
            assert!(
                manager.has_tool(*tool_id),
                "Tool {:?} should be registered",
                tool_id
            );
        }
    }

    #[test]
    fn test_tool_manager_default_tool() {
        let manager = ToolManager::with_all_tools();
        assert_eq!(manager.active_tool_id(), ToolId::Select);
    }

    #[test]
    fn test_tool_manager_set_active_tool() {
        let mut manager = ToolManager::with_all_tools();
        let ctx = make_test_context();

        manager.set_active_tool(ToolId::Rectangle, &ctx);
        assert_eq!(manager.active_tool_id(), ToolId::Rectangle);

        manager.set_active_tool(ToolId::Arrow, &ctx);
        assert_eq!(manager.active_tool_id(), ToolId::Arrow);
    }

    #[test]
    fn test_tool_manager_set_same_tool_no_op() {
        let mut manager = ToolManager::with_all_tools();
        let ctx = make_test_context();

        manager.set_active_tool(ToolId::Rectangle, &ctx);
        let result = manager.set_active_tool(ToolId::Rectangle, &ctx);
        assert!(result.is_none());
    }

    #[test]
    fn test_tool_manager_handle_event() {
        let mut manager = ToolManager::with_all_tools();
        let ctx = make_test_context();

        manager.set_active_tool(ToolId::Rectangle, &ctx);

        // Start drag
        let result = manager.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(matches!(result, ToolResult::Handled));
    }

    #[test]
    fn test_tool_manager_preview() {
        let mut manager = ToolManager::with_all_tools();
        let ctx = make_test_context();

        manager.set_active_tool(ToolId::Rectangle, &ctx);

        // No preview before drag
        assert!(matches!(manager.preview(&ctx), ToolPreview::None));

        // Start drag
        manager.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        manager.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Should have preview
        assert!(matches!(manager.preview(&ctx), ToolPreview::Rectangle { .. }));
    }

    #[test]
    fn test_tool_manager_get_tool() {
        let manager = ToolManager::with_all_tools();

        let tool = manager.get_tool(ToolId::Arrow);
        assert!(tool.is_some());
        assert_eq!(tool.unwrap().id(), ToolId::Arrow);
    }

    #[test]
    fn test_tool_manager_registered_tools() {
        let manager = ToolManager::with_all_tools();

        let registered: Vec<ToolId> = manager.registered_tools().collect();
        assert_eq!(registered.len(), 12);
    }

    #[test]
    fn test_tool_manager_deactivation_returns_pending_results() {
        let mut manager = ToolManager::with_all_tools();
        let ctx = make_test_context();

        // Switch to text tool and start typing
        manager.set_active_tool(ToolId::Text, &ctx);

        manager.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        manager.handle_event(
            ToolEvent::KeyDown {
                key: "H".to_string(),
                key_char: Some('H'),
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Switch away - should return pending text creation
        let result = manager.set_active_tool(ToolId::Select, &ctx);

        // Should have captured the pending text
        assert!(result.is_some());
    }

    #[test]
    fn test_tool_manager_empty() {
        let manager = ToolManager::new();

        assert!(manager.active_tool().is_none());
        assert!(manager.get_tool(ToolId::Arrow).is_none());
    }

    #[test]
    fn test_tool_manager_register() {
        let mut manager = ToolManager::new();

        assert!(!manager.has_tool(ToolId::Arrow));

        manager.register(Box::new(ArrowTool::new()));

        assert!(manager.has_tool(ToolId::Arrow));
    }

    #[test]
    fn test_tool_manager_get_tool_as() {
        let manager = ToolManager::with_all_tools();

        let arrow_tool = manager.get_tool_as::<ArrowTool>(ToolId::Arrow);
        assert!(arrow_tool.is_some());

        // Wrong type should return None
        let wrong_type = manager.get_tool_as::<RectangleTool>(ToolId::Arrow);
        assert!(wrong_type.is_none());
    }
}

// ============================================================================
// TextInputState Tests
// ============================================================================

#[cfg(test)]
mod text_input_state_tests {
    use super::*;

    #[test]
    fn test_text_input_state_default() {
        let state = TextInputState::default();
        assert!(!state.active);
        assert!(state.position.is_none());
        assert!(state.content.is_empty());
        assert!(state.editing_id.is_none());
    }

    #[test]
    fn test_text_input_state_start_new() {
        let mut state = TextInputState::default();
        state.start_new(Point::new(100.0, 100.0));

        assert!(state.active);
        assert_eq!(state.position, Some(Point::new(100.0, 100.0)));
        assert!(state.content.is_empty());
        assert!(state.editing_id.is_none());
    }

    #[test]
    fn test_text_input_state_start_edit() {
        let mut state = TextInputState::default();
        let id = nib_core::AnnotationId::new();
        state.start_edit(id, Point::new(100.0, 100.0), "Hello".to_string());

        assert!(state.active);
        assert_eq!(state.position, Some(Point::new(100.0, 100.0)));
        assert_eq!(state.content, "Hello");
        assert_eq!(state.editing_id, Some(id));
    }

    #[test]
    fn test_text_input_state_append() {
        let mut state = TextInputState::default();
        state.start_new(Point::new(100.0, 100.0));
        state.append("Hello");
        state.append(" World");

        assert_eq!(state.content, "Hello World");
    }

    #[test]
    fn test_text_input_state_backspace() {
        let mut state = TextInputState::default();
        state.start_new(Point::new(100.0, 100.0));
        state.append("Hello");
        state.backspace();

        assert_eq!(state.content, "Hell");
    }

    #[test]
    fn test_text_input_state_backspace_empty() {
        let mut state = TextInputState::default();
        state.start_new(Point::new(100.0, 100.0));
        state.backspace(); // Should not panic on empty

        assert!(state.content.is_empty());
    }

    #[test]
    fn test_text_input_state_reset() {
        let mut state = TextInputState::default();
        state.start_new(Point::new(100.0, 100.0));
        state.append("Hello");
        state.reset();

        assert!(!state.active);
        assert!(state.position.is_none());
        assert!(state.content.is_empty());
    }
}

// ============================================================================
// Modifiers Tests
// ============================================================================

#[cfg(test)]
mod modifiers_tests {
    use super::*;

    #[test]
    fn test_modifiers_default() {
        let mods = Modifiers::default();
        assert!(!mods.shift);
        assert!(!mods.ctrl);
        assert!(!mods.alt);
        assert!(!mods.cmd);
    }

    #[test]
    fn test_modifiers_equality() {
        let mods1 = Modifiers {
            shift: true,
            ctrl: false,
            alt: false,
            cmd: false,
        };
        let mods2 = Modifiers {
            shift: true,
            ctrl: false,
            alt: false,
            cmd: false,
        };
        let mods3 = Modifiers {
            shift: false,
            ctrl: true,
            alt: false,
            cmd: false,
        };

        assert_eq!(mods1, mods2);
        assert_ne!(mods1, mods3);
    }
}

// ============================================================================
// Integration Tests - Tool Workflows
// ============================================================================

#[cfg(test)]
mod integration_tests {
    use super::*;

    #[test]
    fn test_complete_rectangle_workflow() {
        let mut manager = ToolManager::with_all_tools();
        let ctx = make_test_context();

        // Switch to rectangle tool
        manager.set_active_tool(ToolId::Rectangle, &ctx);

        // Start drag
        manager.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Verify preview
        manager.handle_event(
            ToolEvent::MouseMove {
                position: Point::new(200.0, 200.0),
                modifiers: no_modifiers(),
            },
            &ctx,
        );
        assert!(matches!(manager.preview(&ctx), ToolPreview::Rectangle { .. }));

        // Complete drag
        let result = manager.handle_event(
            ToolEvent::MouseUp {
                position: Point::new(200.0, 200.0),
                button: MouseButton::Left,
            },
            &ctx,
        );

        // Verify annotation created
        assert_created_type(&result, "box");

        // Verify no preview after completion
        assert!(matches!(manager.preview(&ctx), ToolPreview::None));
    }

    #[test]
    fn test_tool_switching_clears_state() {
        let mut manager = ToolManager::with_all_tools();
        let ctx = make_test_context();

        // Start rectangle drag
        manager.set_active_tool(ToolId::Rectangle, &ctx);
        manager.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        // Switch to arrow - should clear rectangle state
        manager.set_active_tool(ToolId::Arrow, &ctx);

        // Rectangle preview should be gone
        assert!(matches!(manager.preview(&ctx), ToolPreview::None));
    }

    #[test]
    fn test_multiple_number_placement() {
        let mut manager = ToolManager::with_all_tools();

        // Create context with no existing annotations
        let ctx = make_test_context();

        manager.set_active_tool(ToolId::Number, &ctx);

        // Place first number
        let result1 = manager.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(100.0, 100.0),
                button: MouseButton::Left,
                modifiers: no_modifiers(),
            },
            &ctx,
        );

        if let ToolResult::Created(ann) = result1 {
            if let AnnotationType::Number { value, .. } = ann.annotation_type {
                assert_eq!(value, 1);
            }

            // Create context with first annotation
            let annotations = vec![ann];
            let ctx2 = make_test_context_with_annotations(&annotations);

            // Place second number
            let result2 = manager.handle_event(
                ToolEvent::MouseDown {
                    position: Point::new(200.0, 200.0),
                    button: MouseButton::Left,
                    modifiers: no_modifiers(),
                },
                &ctx2,
            );

            if let ToolResult::Created(ann2) = result2 {
                if let AnnotationType::Number { value, .. } = ann2.annotation_type {
                    assert_eq!(value, 2);
                }
            }
        }
    }
}
