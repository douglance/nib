//! GPUI Application setup
//!
//! This module provides the main GPUI-based graphical interface for Quill.

use gpui::{
    div, img, px, rgb, rgba, size, App, AppContext, Application, Bounds, Context, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement,
    Point, Render, Size, StatefulInteractiveElement, Styled, StyledImage, Window, WindowBounds,
    WindowOptions,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::SystemTime;

use crate::core::types::{Annotation, AnnotationType, Color, Region};
use crate::core::types::Point as QuillPoint;
use crate::gui::toolbar::Tool;

/// Version string for the annotations file format
const ANNOTATIONS_FILE_VERSION: &str = "1.0";

/// Serializable annotation data for JSON persistence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedAnnotation {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: String,
    #[serde(flatten)]
    pub geometry: AnnotationGeometry,
    pub color: String,
}

/// Geometry data for different annotation types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AnnotationGeometry {
    Rectangle {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Line {
        start_x: f64,
        start_y: f64,
        end_x: f64,
        end_y: f64,
    },
    Ellipse {
        center_x: f64,
        center_y: f64,
        radius_x: f64,
        radius_y: f64,
    },
    Point {
        x: f64,
        y: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
}

/// Root structure for annotations JSON file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationsFile {
    pub version: String,
    pub image_path: String,
    pub annotations: Vec<SerializedAnnotation>,
}

impl AnnotationsFile {
    /// Create a new annotations file structure
    pub fn new(image_path: &str, annotations: Vec<SerializedAnnotation>) -> Self {
        Self {
            version: ANNOTATIONS_FILE_VERSION.to_string(),
            image_path: image_path.to_string(),
            annotations,
        }
    }
}

/// Convert a Color to hex string
fn color_to_hex(color: &Color) -> String {
    format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b)
}

/// Parse a hex color string to Color
fn hex_to_color(hex: &str) -> Color {
    let hex = hex.trim_start_matches('#');
    if hex.len() >= 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
        Color::rgb(r, g, b)
    } else {
        Color::RED
    }
}

/// Convert an Annotation to SerializedAnnotation
fn serialize_annotation(annotation: &Annotation) -> SerializedAnnotation {
    let (annotation_type, geometry) = match &annotation.annotation_type {
        AnnotationType::Box { region, .. } => (
            "rectangle".to_string(),
            AnnotationGeometry::Rectangle {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            },
        ),
        AnnotationType::Arrow { start, end, .. } => (
            "arrow".to_string(),
            AnnotationGeometry::Line {
                start_x: start.x,
                start_y: start.y,
                end_x: end.x,
                end_y: end.y,
            },
        ),
        AnnotationType::Line { start, end, .. } => (
            "line".to_string(),
            AnnotationGeometry::Line {
                start_x: start.x,
                start_y: start.y,
                end_x: end.x,
                end_y: end.y,
            },
        ),
        AnnotationType::Ellipse { center, radius_x, radius_y, .. } => (
            "ellipse".to_string(),
            AnnotationGeometry::Ellipse {
                center_x: center.x,
                center_y: center.y,
                radius_x: *radius_x,
                radius_y: *radius_y,
            },
        ),
        AnnotationType::Highlight { region, .. } => (
            "highlight".to_string(),
            AnnotationGeometry::Rectangle {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            },
        ),
        AnnotationType::Blur { region, .. } => (
            "blur".to_string(),
            AnnotationGeometry::Rectangle {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            },
        ),
        AnnotationType::Text { position, content, .. } => (
            "text".to_string(),
            AnnotationGeometry::Point {
                x: position.x,
                y: position.y,
                value: None,
                content: Some(content.clone()),
            },
        ),
        AnnotationType::Number { position, value, .. } => (
            "number".to_string(),
            AnnotationGeometry::Point {
                x: position.x,
                y: position.y,
                value: Some(*value),
                content: None,
            },
        ),
        AnnotationType::Crop { region } => (
            "crop".to_string(),
            AnnotationGeometry::Rectangle {
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
            },
        ),
    };

    SerializedAnnotation {
        id: format!("a{}", annotation.id.0),
        annotation_type,
        geometry,
        color: color_to_hex(&annotation.color),
    }
}

/// Convert a SerializedAnnotation back to Annotation
fn deserialize_annotation(serialized: &SerializedAnnotation) -> Option<Annotation> {
    let color = hex_to_color(&serialized.color);

    let annotation_type = match (serialized.annotation_type.as_str(), &serialized.geometry) {
        ("rectangle", AnnotationGeometry::Rectangle { x, y, width, height }) => {
            AnnotationType::Box {
                region: Region::new(*x, *y, *width, *height),
                stroke_width: 2.0,
                stroke_style: crate::core::types::StrokeStyle::Solid,
                filled: false,
                corner_radius: 0.0,
            }
        }
        ("arrow", AnnotationGeometry::Line { start_x, start_y, end_x, end_y }) => {
            AnnotationType::Arrow {
                start: QuillPoint::new(*start_x, *start_y),
                end: QuillPoint::new(*end_x, *end_y),
                head: crate::core::types::ArrowHead::End,
                stroke_width: 2.0,
            }
        }
        ("line", AnnotationGeometry::Line { start_x, start_y, end_x, end_y }) => {
            AnnotationType::Line {
                start: QuillPoint::new(*start_x, *start_y),
                end: QuillPoint::new(*end_x, *end_y),
                stroke_width: 2.0,
                stroke_style: crate::core::types::StrokeStyle::Solid,
            }
        }
        ("ellipse", AnnotationGeometry::Ellipse { center_x, center_y, radius_x, radius_y }) => {
            AnnotationType::Ellipse {
                center: QuillPoint::new(*center_x, *center_y),
                radius_x: *radius_x,
                radius_y: *radius_y,
                stroke_width: 2.0,
                filled: false,
            }
        }
        ("highlight", AnnotationGeometry::Rectangle { x, y, width, height }) => {
            AnnotationType::Highlight {
                region: Region::new(*x, *y, *width, *height),
                corner_radius: 0.0,
            }
        }
        ("blur", AnnotationGeometry::Rectangle { x, y, width, height }) => {
            AnnotationType::Blur {
                region: Region::new(*x, *y, *width, *height),
                intensity: crate::core::types::BlurIntensity::Medium,
            }
        }
        ("text", AnnotationGeometry::Point { x, y, content, .. }) => {
            AnnotationType::Text {
                position: QuillPoint::new(*x, *y),
                content: content.clone().unwrap_or_else(|| "Text".to_string()),
                font_size: 16.0,
                align: crate::core::types::TextAlign::Left,
                background: None,
                max_width: None,
            }
        }
        ("number", AnnotationGeometry::Point { x, y, value, .. }) => {
            AnnotationType::Number {
                position: QuillPoint::new(*x, *y),
                value: value.unwrap_or(1),
                radius: 14.0,
            }
        }
        ("crop", AnnotationGeometry::Rectangle { x, y, width, height }) => {
            AnnotationType::Crop {
                region: Region::new(*x, *y, *width, *height),
            }
        }
        _ => return None,
    };

    Some(Annotation::new(annotation_type).with_color(color))
}

/// Get the sidecar annotations file path for an image
pub fn annotations_file_path(image_path: &PathBuf) -> PathBuf {
    let mut path = image_path.clone();
    let file_name = path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    path.set_file_name(format!("{}.annotations.json", file_name));
    path
}

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
    /// Last modification time of the sidecar annotations file (for file watching)
    last_sidecar_modified: Option<SystemTime>,
    /// Original image width in pixels
    image_width: u32,
    /// Original image height in pixels
    image_height: u32,
    /// Canvas display width (estimated)
    canvas_width: f32,
    /// Canvas display height (estimated)
    canvas_height: f32,
}

impl EditorView {
    /// Create a new editor view
    pub fn new(file_path: Option<PathBuf>) -> Self {
        // Load image dimensions if file path is provided
        let (image_width, image_height) = if let Some(ref path) = file_path {
            if let Ok(img) = image::open(path) {
                (img.width(), img.height())
            } else {
                (1920, 1080) // default fallback
            }
        } else {
            (1920, 1080) // default for no image
        };

        // Estimate canvas size (window 1200x800 minus toolbar ~44px and statusbar ~22px)
        let canvas_width = 1200.0_f32;
        let canvas_height = 734.0_f32; // 800 - 44 - 22

        let mut view = Self {
            file_path,
            annotations: Vec::new(),
            active_tool: Tool::Rectangle,
            drag_state: None,
            current_color: Color::RED,
            last_sidecar_modified: None,
            image_width,
            image_height,
            canvas_width,
            canvas_height,
        };
        // Load existing annotations if available
        view.load_annotations();
        // Record initial modification time
        view.update_sidecar_modified_time();
        view
    }

    /// Update the stored modification time of the sidecar file
    fn update_sidecar_modified_time(&mut self) {
        if let Some(ref path) = self.file_path {
            let sidecar_path = annotations_file_path(path);
            if let Ok(metadata) = std::fs::metadata(&sidecar_path) {
                self.last_sidecar_modified = metadata.modified().ok();
            }
        }
    }

    /// Calculate the scale factor and offset for rendering annotations
    /// Returns (scale, offset_x, offset_y) where scale is uniform and offsets center the image
    fn calculate_scale_and_offset(&self) -> (f32, f32, f32) {
        let scale_x = self.canvas_width / self.image_width as f32;
        let scale_y = self.canvas_height / self.image_height as f32;
        let scale = scale_x.min(scale_y);

        // Calculate offset to center the image
        let scaled_img_width = self.image_width as f32 * scale;
        let scaled_img_height = self.image_height as f32 * scale;
        let offset_x = (self.canvas_width - scaled_img_width) / 2.0;
        let offset_y = (self.canvas_height - scaled_img_height) / 2.0;

        (scale, offset_x, offset_y)
    }

    /// Scale image coordinates to screen coordinates for rendering
    /// Takes (x, y, w, h) in image pixels and returns (sx, sy, sw, sh) in screen pixels
    fn scale_coords(&self, x: f64, y: f64, w: f64, h: f64) -> (f32, f32, f32, f32) {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();

        (
            (x as f32 * scale) + offset_x,
            (y as f32 * scale) + offset_y,
            w as f32 * scale,
            h as f32 * scale,
        )
    }

    /// Scale a single point from image coordinates to screen coordinates
    fn scale_point(&self, x: f64, y: f64) -> (f32, f32) {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();
        (
            (x as f32 * scale) + offset_x,
            (y as f32 * scale) + offset_y,
        )
    }

    /// Convert screen coordinates back to image coordinates for annotation creation
    fn screen_to_image_coords(&self, screen_x: f32, screen_y: f32) -> (f64, f64) {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();

        let image_x = (screen_x - offset_x) / scale;
        let image_y = (screen_y - offset_y) / scale;

        (image_x as f64, image_y as f64)
    }

    /// Check if the sidecar file has been modified and reload annotations if needed
    fn check_and_reload_annotations(&mut self) {
        let Some(ref path) = self.file_path else {
            return;
        };

        let sidecar_path = annotations_file_path(path);

        // Check if file exists and get modification time
        let Ok(metadata) = std::fs::metadata(&sidecar_path) else {
            return;
        };

        let Ok(current_modified) = metadata.modified() else {
            return;
        };

        // Compare with stored modification time
        if self.last_sidecar_modified != Some(current_modified) {
            tracing::debug!("Sidecar file changed, reloading annotations");
            self.load_annotations();
            self.last_sidecar_modified = Some(current_modified);
        }
    }

    /// Save annotations to a sidecar JSON file
    fn save_annotations(&mut self) {
        let Some(ref image_path) = self.file_path else {
            return;
        };

        let annotations_path = annotations_file_path(image_path);
        let serialized: Vec<SerializedAnnotation> = self.annotations
            .iter()
            .map(serialize_annotation)
            .collect();

        let file = AnnotationsFile::new(
            &image_path.to_string_lossy(),
            serialized,
        );

        match serde_json::to_string_pretty(&file) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&annotations_path, json) {
                    tracing::warn!("Failed to save annotations to {:?}: {}", annotations_path, e);
                } else {
                    tracing::debug!("Saved {} annotations to {:?}", self.annotations.len(), annotations_path);
                    // Update modification time to avoid reloading our own changes
                    self.update_sidecar_modified_time();
                }
            }
            Err(e) => {
                tracing::warn!("Failed to serialize annotations: {}", e);
            }
        }
    }

    /// Load annotations from a sidecar JSON file
    fn load_annotations(&mut self) {
        let Some(ref image_path) = self.file_path else {
            return;
        };

        let annotations_path = annotations_file_path(image_path);
        if !annotations_path.exists() {
            return;
        }

        match std::fs::read_to_string(&annotations_path) {
            Ok(json) => {
                match serde_json::from_str::<AnnotationsFile>(&json) {
                    Ok(file) => {
                        self.annotations = file.annotations
                            .iter()
                            .filter_map(deserialize_annotation)
                            .collect();
                        tracing::info!("Loaded {} annotations from {:?}", self.annotations.len(), annotations_path);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse annotations file {:?}: {}", annotations_path, e);
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to read annotations file {:?}: {}", annotations_path, e);
            }
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
                let screen_x: f32 = position.x.into();
                let screen_y: f32 = position.y.into();
                // Convert screen coordinates to image coordinates
                let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);
                self.drag_state = Some(DragState {
                    tool: self.active_tool,
                    start_point: QuillPoint::new(img_x, img_y),
                    current_point: QuillPoint::new(img_x, img_y),
                });
                cx.notify();
            }
            Tool::Text | Tool::Number => {
                // For text/number, we place at click position
                let position = event.position;
                let screen_x: f32 = position.x.into();
                let screen_y: f32 = position.y.into();
                // Convert screen coordinates to image coordinates
                let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);
                let point = QuillPoint::new(img_x, img_y);

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
                        // Save annotations to disk after adding
                        self.save_annotations();
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
                        // Save annotations to disk after adding
                        self.save_annotations();
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
        if self.drag_state.is_some() {
            let position = event.position;
            let screen_x: f32 = position.x.into();
            let screen_y: f32 = position.y.into();
            // Convert screen coordinates to image coordinates
            let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);
            // Now we can safely update the drag state
            if let Some(ref mut drag_state) = self.drag_state {
                drag_state.current_point = QuillPoint::new(img_x, img_y);
            }
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
                // Save annotations to disk after adding
                self.save_annotations();
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

        // Get scale factor for stroke width scaling
        let (scale, _, _) = self.calculate_scale_and_offset();

        match &annotation.annotation_type {
            AnnotationType::Box { region, filled, corner_radius, .. } => {
                // Scale coordinates from image space to screen space
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);
                let mut element = div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
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
                // Scale start and end points
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);
                let dx = end_sx - start_sx;
                let dy = end_sy - start_sy;
                let length = (dx * dx + dy * dy).sqrt();
                let min_x = start_sx.min(end_sx);
                let min_y = start_sy.min(end_sy);

                div()
                    .absolute()
                    .left(px(min_x))
                    .top(px(min_y))
                    .w(px(length.max(2.0)))
                    .h(px(3.))
                    .bg(border_color)
                    .into_any_element()
            }
            AnnotationType::Line { start, end, .. } => {
                // Scale start and end points
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);
                let dx = end_sx - start_sx;
                let dy = end_sy - start_sy;
                let length = (dx * dx + dy * dy).sqrt();
                let min_x = start_sx.min(end_sx);
                let min_y = start_sy.min(end_sy);

                div()
                    .absolute()
                    .left(px(min_x))
                    .top(px(min_y))
                    .w(px(length.max(2.0)))
                    .h(px(2.))
                    .bg(border_color)
                    .into_any_element()
            }
            AnnotationType::Ellipse { center, radius_x, radius_y, filled, .. } => {
                // Scale center and radii
                let (center_sx, center_sy) = self.scale_point(center.x, center.y);
                let scaled_radius_x = *radius_x as f32 * scale;
                let scaled_radius_y = *radius_y as f32 * scale;

                let mut element = div()
                    .absolute()
                    .left(px(center_sx - scaled_radius_x))
                    .top(px(center_sy - scaled_radius_y))
                    .w(px(scaled_radius_x * 2.0))
                    .h(px(scaled_radius_y * 2.0))
                    .border_2()
                    .border_color(border_color)
                    .rounded_full();

                if *filled {
                    element = element.bg(gpui_color);
                }

                element.into_any_element()
            }
            AnnotationType::Text { position, content, font_size, .. } => {
                // Scale position and font size
                let (sx, sy) = self.scale_point(position.x, position.y);
                let scaled_font_size = *font_size as f32 * scale;

                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .text_color(border_color)
                    .text_size(px(scaled_font_size))
                    .child(content.clone())
                    .into_any_element()
            }
            AnnotationType::Number { position, value, radius } => {
                // Scale position and radius
                let (sx, sy) = self.scale_point(position.x, position.y);
                let scaled_radius = *radius as f32 * scale;

                div()
                    .absolute()
                    .left(px(sx - scaled_radius))
                    .top(px(sy - scaled_radius))
                    .w(px(scaled_radius * 2.0))
                    .h(px(scaled_radius * 2.0))
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

                // Scale coordinates
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);

                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .bg(highlight_color)
                    .into_any_element()
            }
            AnnotationType::Blur { region, .. } => {
                // Scale coordinates
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);

                // Blur is represented as a dark semi-transparent overlay
                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .bg(rgba(0x00000080))
                    .into_any_element()
            }
            AnnotationType::Crop { region } => {
                // Scale coordinates
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);

                // Crop region shown as dashed border
                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .border_2()
                    .border_color(rgb(0x00ff00))
                    .into_any_element()
            }
        }
    }

    /// Render the in-progress drag preview
    fn render_drag_preview(&self) -> Option<impl IntoElement> {
        let drag_state = self.drag_state.as_ref()?;
        // drag_state stores image coordinates, convert to screen coordinates for display
        let start = drag_state.start_point;
        let end = drag_state.current_point;

        let preview_color = rgb(0x0078d4);
        let preview_bg = rgba(0x0078d440);

        let element = match drag_state.tool {
            Tool::Rectangle | Tool::Highlight | Tool::Blur => {
                let region = Region::from_points(start, end);
                // Scale region to screen coordinates
                let (sx, sy, sw, sh) = self.scale_coords(region.x, region.y, region.width, region.height);
                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .border_2()
                    .border_color(preview_color)
                    .bg(preview_bg)
                    .into_any_element()
            }
            Tool::Arrow | Tool::Line => {
                // Scale start and end points to screen coordinates
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);
                let dx = end_sx - start_sx;
                let dy = end_sy - start_sy;
                let length = (dx * dx + dy * dy).sqrt();
                let min_x = start_sx.min(end_sx);
                let min_y = start_sy.min(end_sy);

                div()
                    .absolute()
                    .left(px(min_x))
                    .top(px(min_y))
                    .w(px(length.max(2.0)))
                    .h(px(3.))
                    .bg(preview_color)
                    .into_any_element()
            }
            Tool::Ellipse => {
                // Calculate ellipse in image coordinates
                let center_x = (start.x + end.x) / 2.0;
                let center_y = (start.y + end.y) / 2.0;
                let radius_x = (end.x - start.x).abs() / 2.0;
                let radius_y = (end.y - start.y).abs() / 2.0;

                // Scale to screen coordinates
                let (center_sx, center_sy) = self.scale_point(center_x, center_y);
                let (scale, _, _) = self.calculate_scale_and_offset();
                let scaled_radius_x = radius_x as f32 * scale;
                let scaled_radius_y = radius_y as f32 * scale;

                div()
                    .absolute()
                    .left(px(center_sx - scaled_radius_x))
                    .top(px(center_sy - scaled_radius_y))
                    .w(px(scaled_radius_x * 2.0))
                    .h(px(scaled_radius_y * 2.0))
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // Update canvas dimensions from actual window size
        let viewport = window.viewport_size();
        let viewport_width: f32 = viewport.width.into();
        let viewport_height: f32 = viewport.height.into();
        self.canvas_width = viewport_width;
        self.canvas_height = viewport_height - 66.0; // Subtract toolbar (44px) + status bar (22px)

        // Check if sidecar file has changed and reload annotations if needed
        self.check_and_reload_annotations();

        div()
            .size_full()
            .flex()
            .flex_col()
            .child(self.render_toolbar(cx))
            .child(self.render_canvas(cx))
            .child(self.render_status_bar())
    }
}
