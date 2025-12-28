//! GPUI Application setup
//!
//! This module provides the main GPUI-based graphical interface for Quill.

use gpui::{
    div, img, px, rgb, rgba, size, App, AppContext, Application, Bounds, Context, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement,
    Point, Render, Size, StatefulInteractiveElement, Styled, StyledImage, Window, WindowBounds,
    WindowOptions,
};
use std::path::PathBuf;

use crate::core::types::{Annotation, AnnotationType, Color, Region};
use crate::core::types::Point as QuillPoint;
use crate::gui::toolbar::Tool;

/// Drag state for in-progress annotation drawing
#[derive(Debug, Clone)]
pub struct DragState {
    /// Tool being used for this drag operation
    pub tool: Tool,
    /// Starting point of the drag (in screen coordinates)
    pub start_point: QuillPoint,
    /// Current point of the drag (in screen coordinates)
    pub current_point: QuillPoint,
}

/// Main application struct for GPUI
pub struct QuillApp {
    file_path: Option<PathBuf>,
}

impl QuillApp {
    /// Create a new QuillApp instance without a file
    pub fn new() -> Self {
        Self { file_path: None }
    }

    /// Create a new QuillApp instance with a file to display
    pub fn with_file(file_path: PathBuf) -> Self {
        Self {
            file_path: Some(file_path),
        }
    }

    /// Launch the GUI application
    pub fn run(self) -> anyhow::Result<()> {
        let file_path = self.file_path.clone();

        Application::new().run(move |cx: &mut App| {
            let window_size: Size<gpui::Pixels> = size(px(1200.), px(800.));

            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: Point::default(),
                    size: window_size,
                })),
                ..Default::default()
            };

            cx.open_window(options, |_window, cx| {
                cx.new(|_cx| EditorView::new(file_path.clone()))
            })
            .expect("Failed to open window");
        });

        Ok(())
    }
}

impl Default for QuillApp {
    fn default() -> Self {
        Self::new()
    }
}

/// Main editor view that displays the image and annotations
pub struct EditorView {
    /// Path to the image file being edited
    file_path: Option<PathBuf>,
    /// List of completed annotations
    annotations: Vec<Annotation>,
    /// Currently selected tool
    active_tool: Tool,
    /// In-progress drag state for drawing annotations
    drag_state: Option<DragState>,
    /// Current drawing color
    current_color: Color,
}

impl EditorView {
    /// Create a new editor view
    pub fn new(file_path: Option<PathBuf>) -> Self {
        Self {
            file_path,
            annotations: Vec::new(),
            active_tool: Tool::Rectangle,
            drag_state: None,
            current_color: Color::RED,
        }
    }

    /// Handle tool selection from toolbar
    fn select_tool(&mut self, tool: Tool, cx: &mut Context<Self>) {
        self.active_tool = tool;
        cx.notify();
    }

    /// Handle mouse down event on canvas
    fn handle_mouse_down(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        // Only start drawing for tools that support drag-to-draw
        match self.active_tool {
            Tool::Rectangle | Tool::Arrow | Tool::Line | Tool::Ellipse | Tool::Highlight | Tool::Blur => {
                let position = event.position;
                let x: f32 = position.x.into();
                let y: f32 = position.y.into();
                self.drag_state = Some(DragState {
                    tool: self.active_tool,
                    start_point: QuillPoint::new(x as f64, y as f64),
                    current_point: QuillPoint::new(x as f64, y as f64),
                });
                cx.notify();
            }
            Tool::Text | Tool::Number => {
                // For text/number, we place at click position
                let position = event.position;
                let x: f32 = position.x.into();
                let y: f32 = position.y.into();
                let point = QuillPoint::new(x as f64, y as f64);

                match self.active_tool {
                    Tool::Text => {
                        let annotation = Annotation::new(AnnotationType::Text {
                            position: point,
                            content: "Text".to_string(),
                            font_size: 16.0,
                            align: crate::core::types::TextAlign::Left,
                            background: None,
                            max_width: None,
                        }).with_color(self.current_color);
                        self.annotations.push(annotation);
                    }
                    Tool::Number => {
                        let next_number = self.annotations.iter()
                            .filter_map(|a| match &a.annotation_type {
                                AnnotationType::Number { value, .. } => Some(*value),
                                _ => None,
                            })
                            .max()
                            .unwrap_or(0) + 1;

                        let annotation = Annotation::new(AnnotationType::Number {
                            position: point,
                            value: next_number,
                            radius: 14.0,
                        }).with_color(self.current_color);
                        self.annotations.push(annotation);
                    }
                    _ => {}
                }
                cx.notify();
            }
            Tool::Select | Tool::Crop => {
                // Select and Crop have different behaviors
            }
        }
    }

    /// Handle mouse move event on canvas
    fn handle_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if let Some(ref mut drag_state) = self.drag_state {
            let position = event.position;
            let x: f32 = position.x.into();
            let y: f32 = position.y.into();
            drag_state.current_point = QuillPoint::new(x as f64, y as f64);
            cx.notify();
        }
    }

    /// Handle mouse up event on canvas
    fn handle_mouse_up(&mut self, _event: &MouseUpEvent, cx: &mut Context<Self>) {
        if let Some(drag_state) = self.drag_state.take() {
            // Create the annotation based on drag state
            let annotation = self.create_annotation_from_drag(&drag_state);
            if let Some(annotation) = annotation {
                self.annotations.push(annotation);
            }
            cx.notify();
        }
    }

    /// Create an annotation from completed drag state
    fn create_annotation_from_drag(&self, drag_state: &DragState) -> Option<Annotation> {
        let start = drag_state.start_point;
        let end = drag_state.current_point;

        // Ignore very small drags (accidental clicks)
        if start.distance_to(end) < 5.0 {
            return None;
        }

        let annotation_type = match drag_state.tool {
            Tool::Rectangle => AnnotationType::Box {
                region: Region::from_points(start, end),
                stroke_width: 2.0,
                stroke_style: crate::core::types::StrokeStyle::Solid,
                filled: false,
                corner_radius: 0.0,
            },
            Tool::Arrow => AnnotationType::Arrow {
                start,
                end,
                head: crate::core::types::ArrowHead::End,
                stroke_width: 2.0,
            },
            Tool::Line => AnnotationType::Line {
                start,
                end,
                stroke_width: 2.0,
                stroke_style: crate::core::types::StrokeStyle::Solid,
            },
            Tool::Ellipse => {
                let center = QuillPoint::new(
                    (start.x + end.x) / 2.0,
                    (start.y + end.y) / 2.0,
                );
                let radius_x = (end.x - start.x).abs() / 2.0;
                let radius_y = (end.y - start.y).abs() / 2.0;
                AnnotationType::Ellipse {
                    center,
                    radius_x,
                    radius_y,
                    stroke_width: 2.0,
                    filled: false,
                }
            }
            Tool::Highlight => AnnotationType::Highlight {
                region: Region::from_points(start, end),
                corner_radius: 0.0,
            },
            Tool::Blur => AnnotationType::Blur {
                region: Region::from_points(start, end),
                intensity: crate::core::types::BlurIntensity::Medium,
            },
            _ => return None,
        };

        Some(Annotation::new(annotation_type).with_color(self.current_color))
    }

    /// Render the toolbar
    fn render_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let tools_to_show = [
            Tool::Select,
            Tool::Arrow,
            Tool::Rectangle,
            Tool::Ellipse,
            Tool::Line,
            Tool::Text,
            Tool::Number,
            Tool::Highlight,
            Tool::Blur,
        ];

        let toolbar_bg = rgb(0x2d2d2d);
        let button_bg = rgb(0x3d3d3d);
        let button_active_bg = rgb(0x0078d4);
        let text_color = rgb(0xcccccc);

        div()
            .flex()
            .flex_row()
            .w_full()
            .h(px(44.))
            .bg(toolbar_bg)
            .border_b_1()
            .border_color(rgb(0x1e1e1e))
            .px_2()
            .gap_1()
            .items_center()
            .children(tools_to_show.iter().map(|tool| {
                let is_active = *tool == self.active_tool;
                let tool_copy = *tool;

                div()
                    .id(tool.name())
                    .flex()
                    .items_center()
                    .justify_center()
                    .px_3()
                    .py_1()
                    .rounded_md()
                    .cursor_pointer()
                    .bg(if is_active { button_active_bg } else { button_bg })
                    .text_color(text_color)
                    .text_sm()
                    .child(tool.name())
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.select_tool(tool_copy, cx);
                    }))
            }))
    }

    /// Render a single annotation as an overlay element
    fn render_annotation(&self, annotation: &Annotation) -> impl IntoElement {
        let color = annotation.color;
        let gpui_color = rgba(
            color.r as u32 * 0x1000000 +
            color.g as u32 * 0x10000 +
            color.b as u32 * 0x100 +
            color.a as u32
        );
        let border_color = rgb(
            color.r as u32 * 0x10000 +
            color.g as u32 * 0x100 +
            color.b as u32
        );

        match &annotation.annotation_type {
            AnnotationType::Box { region, filled, corner_radius, .. } => {
                let mut element = div()
                    .absolute()
                    .left(px(region.x as f32))
                    .top(px(region.y as f32))
                    .w(px(region.width as f32))
                    .h(px(region.height as f32))
                    .border_2()
                    .border_color(border_color);

                if *corner_radius > 0.0 {
                    element = element.rounded_md();
                }

                if *filled {
                    element = element.bg(gpui_color);
                }

                element.into_any_element()
            }
            AnnotationType::Arrow { start, end, .. } => {
                // For arrows, we render a simple line indicator
                // GPUI doesn't have native line drawing, so we use a rotated div
                let dx = end.x - start.x;
                let dy = end.y - start.y;
                let length = (dx * dx + dy * dy).sqrt();
                let min_x = start.x.min(end.x);
                let min_y = start.y.min(end.y);

                div()
                    .absolute()
                    .left(px(min_x as f32))
                    .top(px(min_y as f32))
                    .w(px(length.max(2.0) as f32))
                    .h(px(3.))
                    .bg(border_color)
                    .into_any_element()
            }
            AnnotationType::Line { start, end, .. } => {
                let dx = end.x - start.x;
                let dy = end.y - start.y;
                let length = (dx * dx + dy * dy).sqrt();
                let min_x = start.x.min(end.x);
                let min_y = start.y.min(end.y);

                div()
                    .absolute()
                    .left(px(min_x as f32))
                    .top(px(min_y as f32))
                    .w(px(length.max(2.0) as f32))
                    .h(px(2.))
                    .bg(border_color)
                    .into_any_element()
            }
            AnnotationType::Ellipse { center, radius_x, radius_y, filled, .. } => {
                let mut element = div()
                    .absolute()
                    .left(px((center.x - radius_x) as f32))
                    .top(px((center.y - radius_y) as f32))
                    .w(px((*radius_x * 2.0) as f32))
                    .h(px((*radius_y * 2.0) as f32))
                    .border_2()
                    .border_color(border_color)
                    .rounded_full();

                if *filled {
                    element = element.bg(gpui_color);
                }

                element.into_any_element()
            }
            AnnotationType::Text { position, content, font_size, .. } => {
                div()
                    .absolute()
                    .left(px(position.x as f32))
                    .top(px(position.y as f32))
                    .text_color(border_color)
                    .text_size(px(*font_size as f32))
                    .child(content.clone())
                    .into_any_element()
            }
            AnnotationType::Number { position, value, radius } => {
                div()
                    .absolute()
                    .left(px((position.x - radius) as f32))
                    .top(px((position.y - radius) as f32))
                    .w(px((*radius * 2.0) as f32))
                    .h(px((*radius * 2.0) as f32))
                    .rounded_full()
                    .bg(border_color)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(rgb(0xffffff))
                    .text_sm()
                    .child(value.to_string())
                    .into_any_element()
            }
            AnnotationType::Highlight { region, .. } => {
                let highlight_color = rgba(
                    color.r as u32 * 0x1000000 +
                    color.g as u32 * 0x10000 +
                    color.b as u32 * 0x100 +
                    0x60  // Semi-transparent
                );

                div()
                    .absolute()
                    .left(px(region.x as f32))
                    .top(px(region.y as f32))
                    .w(px(region.width as f32))
                    .h(px(region.height as f32))
                    .bg(highlight_color)
                    .into_any_element()
            }
            AnnotationType::Blur { region, .. } => {
                // Blur is represented as a dark semi-transparent overlay
                div()
                    .absolute()
                    .left(px(region.x as f32))
                    .top(px(region.y as f32))
                    .w(px(region.width as f32))
                    .h(px(region.height as f32))
                    .bg(rgba(0x00000080))
                    .into_any_element()
            }
            AnnotationType::Crop { region } => {
                // Crop region shown as dashed border
                div()
                    .absolute()
                    .left(px(region.x as f32))
                    .top(px(region.y as f32))
                    .w(px(region.width as f32))
                    .h(px(region.height as f32))
                    .border_2()
                    .border_color(rgb(0x00ff00))
                    .into_any_element()
            }
        }
    }

    /// Render the in-progress drag preview
    fn render_drag_preview(&self) -> Option<impl IntoElement> {
        let drag_state = self.drag_state.as_ref()?;
        let start = drag_state.start_point;
        let end = drag_state.current_point;

        let preview_color = rgb(0x0078d4);
        let preview_bg = rgba(0x0078d440);

        let element = match drag_state.tool {
            Tool::Rectangle | Tool::Highlight | Tool::Blur => {
                let region = Region::from_points(start, end);
                div()
                    .absolute()
                    .left(px(region.x as f32))
                    .top(px(region.y as f32))
                    .w(px(region.width as f32))
                    .h(px(region.height as f32))
                    .border_2()
                    .border_color(preview_color)
                    .bg(preview_bg)
                    .into_any_element()
            }
            Tool::Arrow | Tool::Line => {
                let dx = end.x - start.x;
                let dy = end.y - start.y;
                let length = (dx * dx + dy * dy).sqrt();
                let min_x = start.x.min(end.x);
                let min_y = start.y.min(end.y);

                div()
                    .absolute()
                    .left(px(min_x as f32))
                    .top(px(min_y as f32))
                    .w(px(length.max(2.0) as f32))
                    .h(px(3.))
                    .bg(preview_color)
                    .into_any_element()
            }
            Tool::Ellipse => {
                let center_x = (start.x + end.x) / 2.0;
                let center_y = (start.y + end.y) / 2.0;
                let radius_x = (end.x - start.x).abs() / 2.0;
                let radius_y = (end.y - start.y).abs() / 2.0;

                div()
                    .absolute()
                    .left(px((center_x - radius_x) as f32))
                    .top(px((center_y - radius_y) as f32))
                    .w(px((radius_x * 2.0) as f32))
                    .h(px((radius_y * 2.0) as f32))
                    .border_2()
                    .border_color(preview_color)
                    .rounded_full()
                    .into_any_element()
            }
            _ => return None,
        };

        Some(element)
    }

    /// Render the canvas area with image and annotations
    fn render_canvas(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let background_color = rgb(0x1e1e1e);
        let text_color = rgb(0xcccccc);

        let mut canvas = div()
            .id("canvas")
            .flex_1()
            .w_full()
            .bg(background_color)
            .relative()
            .overflow_hidden()
            .on_mouse_down(MouseButton::Left, cx.listener(|this, event, _window, cx| {
                this.handle_mouse_down(event, cx);
            }))
            .on_mouse_move(cx.listener(|this, event, _window, cx| {
                this.handle_mouse_move(event, cx);
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, event, _window, cx| {
                this.handle_mouse_up(event, cx);
            }));

        // Add image if we have one
        if let Some(path) = &self.file_path {
            canvas = canvas.child(
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        img(path.clone())
                            .max_w_full()
                            .max_h_full()
                            .with_fallback(move || {
                                div()
                                    .text_color(rgb(0xff6666))
                                    .child("Failed to load image")
                                    .into_any_element()
                            }),
                    ),
            );
        } else {
            canvas = canvas.child(
                div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap_4()
                    .child(
                        div()
                            .text_color(text_color)
                            .text_xl()
                            .child("Quill Screenshot Annotator"),
                    )
                    .child(
                        div()
                            .text_color(rgb(0x888888))
                            .child("No image loaded. Use: quill gui <file>"),
                    ),
            );
        }

        // Add annotation overlays
        for annotation in &self.annotations {
            canvas = canvas.child(self.render_annotation(annotation));
        }

        // Add drag preview if actively drawing
        if let Some(preview) = self.render_drag_preview() {
            canvas = canvas.child(preview);
        }

        canvas
    }

    /// Render the status bar at the bottom
    fn render_status_bar(&self) -> impl IntoElement {
        let status_bg = rgb(0x007acc);
        let text_color = rgb(0xffffff);

        let status_text = format!(
            "Tool: {} | Annotations: {} | {}",
            self.active_tool.name(),
            self.annotations.len(),
            if self.drag_state.is_some() { "Drawing..." } else { "Ready" }
        );

        div()
            .flex()
            .w_full()
            .h(px(22.))
            .bg(status_bg)
            .px_2()
            .items_center()
            .text_color(text_color)
            .text_xs()
            .child(status_text)
    }
}

impl Render for EditorView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(self.render_toolbar(cx))
            .child(self.render_canvas(cx))
            .child(self.render_status_bar())
    }
}
