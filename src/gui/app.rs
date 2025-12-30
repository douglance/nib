//! GPUI Application setup
//!
//! This module provides the main GPUI-based graphical interface for Nib.

use gpui::{
    canvas, div, img, point, px, rgb, rgba, size, svg, App, AppContext, Application, AssetSource,
    Bounds, Context, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyDownEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, PathBuilder, Point,
    Render, Result as GpuiResult, ScrollWheelEvent, SharedString, Size,
    StatefulInteractiveElement, Styled, StyledImage, Window, WindowBounds, WindowKind, WindowOptions,
};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

/// Asset source for loading SVG icons and other assets
struct Assets {
    base: PathBuf,
}

impl AssetSource for Assets {
    fn load(&self, path: &str) -> GpuiResult<Option<Cow<'static, [u8]>>> {
        fs::read(self.base.join(path))
            .map(|data| Some(Cow::Owned(data)))
            .map_err(|err| err.into())
    }

    fn list(&self, path: &str) -> GpuiResult<Vec<SharedString>> {
        let full_path = self.base.join(path);
        if full_path.is_dir() {
            Ok(fs::read_dir(full_path)?
                .filter_map(|entry| entry.ok())
                .map(|entry| SharedString::from(entry.path().to_string_lossy().to_string()))
                .collect())
        } else {
            Ok(vec![])
        }
    }
}

use crate::core::blur::apply_blur_region;
use crate::core::types::{Annotation, AnnotationId, AnnotationType, Color, Region};
use crate::core::types::Point as NibPoint;
use crate::gui::canvas::{Canvas, ZOOM_FACTOR};
use crate::gui::toolbar::Tool;
use crate::gui::tools::{
    Modifiers, MouseButton as ToolMouseButton, TextTool, ToolContext, ToolEvent, ToolId,
    ToolManager, ToolMode, ToolPreview, ToolResult,
};
use crate::storage::nib_file::NibFile;

/// Version string for the annotations file format
const ANNOTATIONS_FILE_VERSION: &str = "1.0";

/// Height of the toolbar in pixels (used for coordinate offset)
/// Mouse events are window-relative, so we subtract this to get canvas-relative coords
const TOOLBAR_HEIGHT: f32 = 0.0; // Toolbar floats inside canvas, doesn't offset coordinates

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
pub fn deserialize_annotation(serialized: &SerializedAnnotation) -> Option<Annotation> {
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
                start: NibPoint::new(*start_x, *start_y),
                end: NibPoint::new(*end_x, *end_y),
                head: crate::core::types::ArrowHead::End,
                stroke_width: 2.0,
            }
        }
        ("line", AnnotationGeometry::Line { start_x, start_y, end_x, end_y }) => {
            AnnotationType::Line {
                start: NibPoint::new(*start_x, *start_y),
                end: NibPoint::new(*end_x, *end_y),
                stroke_width: 2.0,
                stroke_style: crate::core::types::StrokeStyle::Solid,
            }
        }
        ("ellipse", AnnotationGeometry::Ellipse { center_x, center_y, radius_x, radius_y }) => {
            AnnotationType::Ellipse {
                center: NibPoint::new(*center_x, *center_y),
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
                position: NibPoint::new(*x, *y),
                content: content.clone().unwrap_or_else(|| "Text".to_string()),
                font_size: 16.0,
                align: crate::core::types::TextAlign::Left,
                background: None,
                max_width: None,
            }
        }
        ("number", AnnotationGeometry::Point { x, y, value, .. }) => {
            AnnotationType::Number {
                position: NibPoint::new(*x, *y),
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

/// Text input state for creating/editing text annotations
#[derive(Debug, Clone)]
pub struct TextInputState {
    /// Screen position where user clicked (for rendering during input)
    pub screen_x: f32,
    pub screen_y: f32,
    /// Current text content being typed
    pub content: String,
    /// If editing an existing annotation, its ID
    pub editing_annotation_id: Option<AnnotationId>,
}

/// Main application struct for GPUI
pub struct NibApp {
    file_path: Option<PathBuf>,
}

impl NibApp {
    /// Create a new NibApp instance without a file
    pub fn new() -> Self {
        Self { file_path: None }
    }

    /// Create a new NibApp instance with a file to display
    pub fn with_file(file_path: PathBuf) -> Self {
        Self {
            file_path: Some(file_path),
        }
    }

    /// Launch the GUI application
    pub fn run(self) -> anyhow::Result<()> {
        let file_path = self.file_path.clone();

        // Get the assets base path - try manifest dir first, then executable dir
        let assets_base = std::env::var("CARGO_MANIFEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(PathBuf::from))
                    .unwrap_or_else(|| PathBuf::from("."))
            });

        Application::new()
            .with_assets(Assets { base: assets_base })
            .run(move |cx: &mut App| {
                let window_size: Size<gpui::Pixels> = size(px(1200.), px(800.));

                let options = WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: Point::default(),
                        size: window_size,
                    })),
                    kind: WindowKind::PopUp,
                    ..Default::default()
                };

                cx.open_window(options, |_window, cx| {
                    cx.new(|cx| EditorView::new(file_path.clone(), cx))
                })
                .expect("Failed to open window");
            });

        Ok(())
    }
}

impl Default for NibApp {
    fn default() -> Self {
        Self::new()
    }
}

/// Main editor view that displays the image and annotations
pub struct EditorView {
    /// Path to the image file being edited (for .nib files, this is the extracted temp image)
    file_path: Option<PathBuf>,
    /// List of completed annotations
    annotations: Vec<Annotation>,
    /// Currently selected tool
    active_tool: Tool,
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
    /// Canvas state for zoom/pan (Figma-like mechanics)
    canvas: Canvas,
    /// Focus handle for keyboard input
    focus_handle: FocusHandle,
    /// Text input state for creating/editing text annotations
    /// NOTE: Content is synced from TextTool after key events. The TextTool is the source
    /// of truth for content; this is kept for screen-space rendering coordinates.
    /// Could be removed in a future refactor by computing screen coords during render.
    text_input_state: Option<TextInputState>,
    /// Tool manager for trait-based tool dispatch
    tool_manager: ToolManager,
    /// NibFile handle for .nib format (SQLite-based storage)
    nib_file: Option<NibFile>,
    /// Original .nib file path (file_path points to extracted temp image for rendering)
    /// Kept for future use (e.g., window title display)
    #[allow(dead_code)]
    nib_path: Option<PathBuf>,
    /// Last annotation modification timestamp in .nib file (for file watching)
    last_nib_modified: Option<i64>,
    /// Cached path to blur-processed image (temp file with blur regions applied)
    blur_preview_path: Option<PathBuf>,
    /// Hash of blur annotation state to detect when regeneration is needed
    blur_annotations_hash: u64,
}

impl EditorView {
    /// Create a new editor view
    pub fn new(file_path: Option<PathBuf>, cx: &mut Context<Self>) -> Self {
        // Check if this is a .nib file
        let is_nib_file = file_path
            .as_ref()
            .map(|p| p.extension().map(|e| e == "nib").unwrap_or(false))
            .unwrap_or(false);

        // For .nib files, we need to extract the image and open the NibFile
        let (actual_file_path, nib_file, nib_path, image_width, image_height) = if is_nib_file {
            if let Some(ref path) = file_path {
                match NibFile::open(path) {
                    Ok(nib) => {
                        match nib.get_image() {
                            Ok((image_data, image_info)) => {
                                // Create a temp file for the extracted image
                                let temp_dir = std::env::temp_dir();
                                let temp_filename = format!(
                                    "nib_extracted_{}.{}",
                                    std::process::id(),
                                    image_info.format
                                );
                                let temp_path = temp_dir.join(temp_filename);

                                // Write image data to temp file
                                if let Err(e) = std::fs::write(&temp_path, &image_data) {
                                    tracing::error!("Failed to write extracted image to temp file: {}", e);
                                    (file_path.clone(), None, None, 1920, 1080)
                                } else {
                                    (
                                        Some(temp_path),
                                        Some(nib),
                                        file_path.clone(),
                                        image_info.width,
                                        image_info.height,
                                    )
                                }
                            }
                            Err(e) => {
                                tracing::error!("Failed to get image from .nib file: {}", e);
                                (file_path.clone(), None, None, 1920, 1080)
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to open .nib file: {}", e);
                        (file_path.clone(), None, None, 1920, 1080)
                    }
                }
            } else {
                (None, None, None, 1920, 1080)
            }
        } else {
            // Standard image file - load dimensions directly
            let (width, height) = if let Some(ref path) = file_path {
                if let Ok(img) = image::open(path) {
                    (img.width(), img.height())
                } else {
                    (1920, 1080) // default fallback
                }
            } else {
                (1920, 1080) // default for no image
            };
            (file_path.clone(), None, None, width, height)
        };

        // Estimate canvas size (window 1200x800 minus toolbar ~44px)
        let canvas_width = 1200.0_f32;
        let canvas_height = 756.0_f32; // 800 - 44

        // Create focus handle for keyboard input
        let focus_handle = cx.focus_handle();

        // Create canvas with image dimensions
        let mut canvas = Canvas::new(image_width, image_height);
        canvas.set_viewport(canvas_width as f64, canvas_height as f64);

        let mut view = Self {
            file_path: actual_file_path,
            annotations: Vec::new(),
            active_tool: Tool::Rectangle,
            current_color: Color::RED,
            last_sidecar_modified: None,
            image_width,
            image_height,
            canvas_width,
            canvas_height,
            canvas,
            focus_handle,
            text_input_state: None,
            tool_manager: ToolManager::with_all_tools(),
            nib_file,
            nib_path,
            last_nib_modified: None,
            blur_preview_path: None,
            blur_annotations_hash: 0,
        };
        // Load existing annotations if available
        view.load_annotations();
        // Generate blur preview if there are blur annotations
        view.regenerate_blur_preview_if_needed();
        // Record initial modification time
        view.update_sidecar_modified_time();
        // For .nib files, also record the annotation modification timestamp
        if view.nib_file.is_some() {
            view.update_nib_modified_time();
        }
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

    /// Update the stored modification time for .nib file annotations
    fn update_nib_modified_time(&mut self) {
        if let Some(ref nib) = self.nib_file {
            if let Ok(Some(modified_at)) = nib.latest_annotation_modified_at() {
                self.last_nib_modified = Some(modified_at);
            }
        }
    }

    /// Calculate the scale factor and offset for rendering annotations
    /// Returns (scale, offset_x, offset_y) from the Canvas zoom/pan state
    fn calculate_scale_and_offset(&self) -> (f32, f32, f32) {
        let scale = self.canvas.scale();
        let (offset_x, offset_y) = self.canvas.offset_tuple();
        (scale, offset_x, offset_y)
    }

    /// Scale image coordinates to canvas coordinates for rendering
    /// Takes (x, y, w, h) in image pixels and returns (sx, sy, sw, sh) in canvas pixels
    /// Coordinates are canvas-relative (canvas div is already below toolbar)
    fn scale_coords(&self, x: f64, y: f64, w: f64, h: f64) -> (f32, f32, f32, f32) {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();

        (
            (x as f32 * scale) + offset_x,
            (y as f32 * scale) + offset_y,
            w as f32 * scale,
            h as f32 * scale,
        )
    }

    /// Scale a single point from image coordinates to canvas coordinates
    fn scale_point(&self, x: f64, y: f64) -> (f32, f32) {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();
        (
            (x as f32 * scale) + offset_x,
            (y as f32 * scale) + offset_y,
        )
    }

    /// Create a line element using paint_path with proper bounds adjustment
    /// paint_path uses window coordinates, so we adjust by bounds origin
    fn render_line_element(
        start_sx: f32,
        start_sy: f32,
        end_sx: f32,
        end_sy: f32,
        stroke_width: f32,
        color: gpui::Hsla,
    ) -> impl IntoElement {
        canvas(
            move |bounds, _window, _cx| {
                let origin_x: f32 = bounds.origin.x.into();
                let origin_y: f32 = bounds.origin.y.into();
                (
                    point(px(start_sx + origin_x), px(start_sy + origin_y)),
                    point(px(end_sx + origin_x), px(end_sy + origin_y)),
                )
            },
            move |_bounds, (p_start, p_end), window, _cx| {
                let mut builder = PathBuilder::stroke(px(stroke_width));
                builder.move_to(p_start);
                builder.line_to(p_end);
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }
            },
        )
        .absolute()
        .size_full()
    }

    /// Create an arrow element using paint_path with proper bounds adjustment
    fn render_arrow_element(
        start_sx: f32,
        start_sy: f32,
        end_sx: f32,
        end_sy: f32,
        stroke_width: f32,
        color: gpui::Hsla,
    ) -> impl IntoElement {
        // Calculate arrowhead geometry
        let dx = end_sx - start_sx;
        let dy = end_sy - start_sy;
        let angle = dy.atan2(dx);
        let arrow_size: f32 = 12.0;
        let arrow_angle: f32 = 0.5; // ~28 degrees

        let ax1_offset = -arrow_size * (angle + arrow_angle).cos();
        let ay1_offset = -arrow_size * (angle + arrow_angle).sin();
        let ax2_offset = -arrow_size * (angle - arrow_angle).cos();
        let ay2_offset = -arrow_size * (angle - arrow_angle).sin();

        canvas(
            move |bounds, _window, _cx| {
                let origin_x: f32 = bounds.origin.x.into();
                let origin_y: f32 = bounds.origin.y.into();
                let start_wx = start_sx + origin_x;
                let start_wy = start_sy + origin_y;
                let end_wx = end_sx + origin_x;
                let end_wy = end_sy + origin_y;
                (
                    point(px(start_wx), px(start_wy)),
                    point(px(end_wx), px(end_wy)),
                    point(px(end_wx + ax1_offset), px(end_wy + ay1_offset)),
                    point(px(end_wx + ax2_offset), px(end_wy + ay2_offset)),
                )
            },
            move |_bounds, (p_start, p_end, p_arrow1, p_arrow2), window, _cx| {
                // Draw main line
                let mut builder = PathBuilder::stroke(px(stroke_width));
                builder.move_to(p_start);
                builder.line_to(p_end);
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }

                // Draw arrowhead
                let mut arrow1 = PathBuilder::stroke(px(stroke_width));
                arrow1.move_to(p_end);
                arrow1.line_to(p_arrow1);
                if let Ok(path) = arrow1.build() {
                    window.paint_path(path, color);
                }

                let mut arrow2 = PathBuilder::stroke(px(stroke_width));
                arrow2.move_to(p_end);
                arrow2.line_to(p_arrow2);
                if let Ok(path) = arrow2.build() {
                    window.paint_path(path, color);
                }
            },
        )
        .absolute()
        .size_full()
    }

    /// Convert window coordinates to image coordinates for annotation creation
    /// Mouse events are window-relative, so we subtract toolbar height first
    fn screen_to_image_coords(&self, window_x: f32, window_y: f32) -> (f64, f64) {
        // Window coords -> canvas coords (subtract toolbar)
        let canvas_y = window_y - TOOLBAR_HEIGHT;
        self.canvas.screen_to_image(window_x, canvas_y)
    }

    /// Build a ToolContext for tool event handling
    fn build_tool_context(&self) -> ToolContext<'_> {
        let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();
        ToolContext {
            color: self.current_color,
            stroke_width: 2.0,
            fill_enabled: false,
            image_size: (self.image_width, self.image_height),
            scale,
            offset: (offset_x, offset_y),
            annotations: &self.annotations,
            min_drag_distance: 5.0,
        }
    }

    /// Process a ToolResult and update EditorView state accordingly
    fn process_tool_result(&mut self, result: ToolResult, cx: &mut Context<Self>) {
        match result {
            ToolResult::Created(annotation) => {
                self.annotations.push(annotation);
                self.save_annotations();
                cx.notify();
            }
            ToolResult::Updated(id) => {
                // Simple update without content - tool should handle internally
                tracing::debug!("Annotation {:?} updated", id);
                cx.notify();
            }
            ToolResult::UpdatedText(id, new_content) => {
                // Update text annotation content
                if let Some(ann) = self.annotations.iter_mut().find(|a| a.id == id) {
                    if let AnnotationType::Text { ref mut content, .. } = ann.annotation_type {
                        *content = new_content;
                    }
                }
                self.save_annotations();
                cx.notify();
            }
            ToolResult::Deleted(id) => {
                self.annotations.retain(|a| a.id != id);
                self.save_annotations();
                cx.notify();
            }
            ToolResult::EnterMode(mode) => {
                match mode {
                    ToolMode::TextInput { position, initial_content, editing_annotation_id } => {
                        // Convert image position to screen position
                        let (screen_x, screen_y) = self.scale_point(position.x, position.y);
                        // Adjust for font height (text is drawn with baseline at position)
                        let (scale, _, _) = self.calculate_scale_and_offset();
                        let adjusted_screen_y = screen_y + (16.0 * scale); // font_size * scale
                        self.text_input_state = Some(TextInputState {
                            screen_x,
                            screen_y: adjusted_screen_y,
                            content: initial_content,
                            editing_annotation_id,
                        });
                    }
                }
                cx.notify();
            }
            ToolResult::ExitMode => {
                self.text_input_state = None;
                cx.notify();
            }
            ToolResult::Batch(results) => {
                for r in results {
                    self.process_tool_result(r, cx);
                }
            }
            ToolResult::Moved {
                ids,
                delta_x,
                delta_y,
            } => {
                // Move all specified annotations by the delta
                for id in ids {
                    if let Some(ann) = self.annotations.iter_mut().find(|a| a.id == id) {
                        Self::move_annotation_type(&mut ann.annotation_type, delta_x, delta_y);
                    }
                }
                self.save_annotations();
                cx.notify();
            }
            ToolResult::Resized { id, new_bounds } => {
                // Resize the specified annotation to new bounds
                if let Some(ann) = self.annotations.iter_mut().find(|a| a.id == id) {
                    Self::resize_annotation_type(&mut ann.annotation_type, new_bounds);
                    ann.touch();
                }
                self.save_annotations();
                cx.notify();
            }
            ToolResult::Handled => {
                cx.notify();
            }
            ToolResult::Ignored => {
                // Nothing to do
            }
        }
    }

    /// Resize an annotation type to new bounds
    fn resize_annotation_type(annotation_type: &mut AnnotationType, new_bounds: Region) {
        match annotation_type {
            AnnotationType::Box { region, .. }
            | AnnotationType::Blur { region, .. }
            | AnnotationType::Highlight { region, .. }
            | AnnotationType::Crop { region } => {
                *region = new_bounds;
            }
            AnnotationType::Ellipse {
                center,
                radius_x,
                radius_y,
                ..
            } => {
                *center = new_bounds.center();
                *radius_x = new_bounds.width / 2.0;
                *radius_y = new_bounds.height / 2.0;
            }
            // For line-based types, map bounds corners to start/end
            AnnotationType::Arrow { start, end, .. }
            | AnnotationType::Line { start, end, .. } => {
                *start = NibPoint::new(new_bounds.x, new_bounds.y);
                *end = NibPoint::new(
                    new_bounds.x + new_bounds.width,
                    new_bounds.y + new_bounds.height,
                );
            }
            // Text/Number: just update position (cannot resize content)
            AnnotationType::Text { position, .. } | AnnotationType::Number { position, .. } => {
                *position = NibPoint::new(new_bounds.x, new_bounds.y);
            }
        }
    }

    /// Move an annotation type by the given delta
    fn move_annotation_type(annotation_type: &mut AnnotationType, delta_x: f64, delta_y: f64) {
        match annotation_type {
            AnnotationType::Arrow {
                ref mut start,
                ref mut end,
                ..
            } => {
                start.x += delta_x;
                start.y += delta_y;
                end.x += delta_x;
                end.y += delta_y;
            }
            AnnotationType::Box { ref mut region, .. } => {
                region.x += delta_x;
                region.y += delta_y;
            }
            AnnotationType::Text {
                ref mut position, ..
            } => {
                position.x += delta_x;
                position.y += delta_y;
            }
            AnnotationType::Number {
                ref mut position, ..
            } => {
                position.x += delta_x;
                position.y += delta_y;
            }
            AnnotationType::Blur { ref mut region, .. } => {
                region.x += delta_x;
                region.y += delta_y;
            }
            AnnotationType::Highlight { ref mut region, .. } => {
                region.x += delta_x;
                region.y += delta_y;
            }
            AnnotationType::Line {
                ref mut start,
                ref mut end,
                ..
            } => {
                start.x += delta_x;
                start.y += delta_y;
                end.x += delta_x;
                end.y += delta_y;
            }
            AnnotationType::Ellipse {
                ref mut center, ..
            } => {
                center.x += delta_x;
                center.y += delta_y;
            }
            AnnotationType::Crop { ref mut region } => {
                region.x += delta_x;
                region.y += delta_y;
            }
        }
    }

    /// Check if the sidecar file or .nib file has been modified and reload annotations if needed
    fn check_and_reload_annotations(&mut self) {
        // For .nib files, check the annotation modification timestamp
        if let Some(ref nib) = self.nib_file {
            match nib.latest_annotation_modified_at() {
                Ok(Some(current_modified)) => {
                    if self.last_nib_modified != Some(current_modified) {
                        tracing::debug!(".nib file changed, reloading annotations");
                        self.load_annotations();
                        self.last_nib_modified = Some(current_modified);
                    }
                }
                Ok(None) => {
                    // No annotations yet, nothing to reload
                }
                Err(e) => {
                    tracing::warn!("Failed to check .nib modification time: {}", e);
                }
            }
            return;
        }

        // For regular image files, check sidecar modification time
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

    /// Save annotations to a sidecar JSON file or .nib file
    fn save_annotations(&mut self) {
        // For .nib files, save to NibFile
        if let Some(ref nib) = self.nib_file {
            // Strategy: delete all existing annotations, then add all current ones
            // This is simpler than tracking individual changes and ensures consistency

            // First, get existing annotation IDs and delete them
            match nib.list_annotations() {
                Ok(existing) => {
                    for ann in existing {
                        let id = format!("a{}", ann.id.0);
                        if let Err(e) = nib.delete_annotation(&id) {
                            tracing::warn!("Failed to delete annotation {}: {}", id, e);
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to list existing annotations: {}", e);
                }
            }

            // Now add all current annotations
            for annotation in &self.annotations {
                if let Err(e) = nib.add_annotation(annotation) {
                    tracing::warn!("Failed to add annotation: {}", e);
                }
            }

            // Flush changes to disk
            if let Err(e) = nib.save() {
                tracing::warn!("Failed to save .nib file: {}", e);
            } else {
                tracing::debug!("Saved {} annotations to .nib file", self.annotations.len());
                // Update modification time to avoid reloading our own changes
                self.update_nib_modified_time();
            }
            return;
        }

        // For regular image files, save to sidecar JSON
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

        // Regenerate blur preview if blur annotations changed
        self.regenerate_blur_preview_if_needed();
    }

    /// Compute a hash of blur annotation state to detect changes
    fn compute_blur_hash(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        for annotation in &self.annotations {
            if let AnnotationType::Blur { region, intensity } = &annotation.annotation_type {
                // Hash the blur region parameters
                region.x.to_bits().hash(&mut hasher);
                region.y.to_bits().hash(&mut hasher);
                region.width.to_bits().hash(&mut hasher);
                region.height.to_bits().hash(&mut hasher);
                intensity.radius().hash(&mut hasher);
            }
        }
        hasher.finish()
    }

    /// Regenerate the blur preview image if blur annotations have changed
    fn regenerate_blur_preview_if_needed(&mut self) {
        let new_hash = self.compute_blur_hash();

        // Check if blur annotations changed
        if new_hash == self.blur_annotations_hash {
            return;
        }
        self.blur_annotations_hash = new_hash;

        // If no blur annotations, clear the preview
        let blur_regions: Vec<_> = self.annotations.iter()
            .filter_map(|a| {
                if let AnnotationType::Blur { region, intensity } = &a.annotation_type {
                    Some((region.clone(), intensity.radius()))
                } else {
                    None
                }
            })
            .collect();

        if blur_regions.is_empty() {
            // Clean up old preview file
            if let Some(ref path) = self.blur_preview_path {
                let _ = std::fs::remove_file(path);
            }
            self.blur_preview_path = None;
            return;
        }

        // Load and process the original image
        let Some(ref image_path) = self.file_path else {
            return;
        };

        let img = match image::open(image_path) {
            Ok(img) => img.to_rgba8(),
            Err(e) => {
                tracing::warn!("Failed to load image for blur preview: {}", e);
                return;
            }
        };

        // Apply blur regions
        let mut processed = img;
        for (region, radius) in &blur_regions {
            apply_blur_region(&mut processed, region, *radius);
        }

        // Save to temp file
        let temp_dir = std::env::temp_dir();
        let temp_filename = format!(
            "nib_blur_preview_{}.png",
            std::process::id()
        );
        let temp_path = temp_dir.join(temp_filename);

        match processed.save(&temp_path) {
            Ok(()) => {
                tracing::debug!("Generated blur preview at {:?}", temp_path);
                self.blur_preview_path = Some(temp_path);
            }
            Err(e) => {
                tracing::warn!("Failed to save blur preview: {}", e);
            }
        }
    }

    /// Load annotations from a sidecar JSON file or .nib file
    fn load_annotations(&mut self) {
        // For .nib files, load from NibFile
        if let Some(ref nib) = self.nib_file {
            match nib.list_annotations() {
                Ok(annotations) => {
                    self.annotations = annotations;
                    tracing::info!("Loaded {} annotations from .nib file", self.annotations.len());
                }
                Err(e) => {
                    tracing::warn!("Failed to load annotations from .nib file: {}", e);
                }
            }
            return;
        }

        // For regular image files, load from sidecar JSON
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
    fn select_tool(&mut self, tool: ToolId, cx: &mut Context<Self>) {
        // Set the active tool in the tool manager, which handles:
        // - Deactivating the old tool (may produce pending results)
        // - Activating the new tool
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let deactivation_result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = ToolContext {
                color: self.current_color,
                stroke_width: 2.0,
                fill_enabled: false,
                image_size: (self.image_width, self.image_height),
                scale,
                offset,
                annotations: &self.annotations,
                min_drag_distance: 5.0,
            };
            self.tool_manager.set_active_tool(tool, &ctx)
        };

        // Process any result from deactivating the old tool (e.g., pending text)
        if let Some(result) = deactivation_result {
            self.process_tool_result(result, cx);
        }

        // Update UI state
        self.active_tool = tool;
        cx.notify();
    }

    /// Handle mouse down event on canvas
    fn handle_mouse_down(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        // If in text input mode, clicking away confirms the text (Figma behavior)
        if self.text_input_state.is_some() {
            self.confirm_text_input(cx);
            // Don't start a new action on this click - just finish the text
            return;
        }

        // Convert screen coordinates to image coordinates
        let position = event.position;
        let screen_x: f32 = position.x.into();
        let screen_y: f32 = position.y.into();
        let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);

        // Map GPUI mouse button to tool mouse button
        let button = match event.button {
            MouseButton::Left => ToolMouseButton::Left,
            MouseButton::Right => ToolMouseButton::Right,
            MouseButton::Middle => ToolMouseButton::Middle,
            MouseButton::Navigate(_) => ToolMouseButton::Left, // Fallback
        };

        // Build tool event
        let tool_event = ToolEvent::MouseDown {
            position: NibPoint::new(img_x, img_y),
            button,
            modifiers: Modifiers::default(),
        };

        // Dispatch to tool manager
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = ToolContext {
                color: self.current_color,
                stroke_width: 2.0,
                fill_enabled: false,
                image_size: (self.image_width, self.image_height),
                scale,
                offset,
                annotations: &self.annotations,
                min_drag_distance: 5.0,
            };
            self.tool_manager.handle_event(tool_event, &ctx)
        };
        self.process_tool_result(result, cx);
    }

    /// Handle mouse move event on canvas
    fn handle_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        // Convert screen coordinates to image coordinates
        let position = event.position;
        let screen_x: f32 = position.x.into();
        let screen_y: f32 = position.y.into();
        let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);

        // Build tool event
        let tool_event = ToolEvent::MouseMove {
            position: NibPoint::new(img_x, img_y),
            modifiers: Modifiers::default(),
        };

        // Dispatch to tool manager
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = ToolContext {
                color: self.current_color,
                stroke_width: 2.0,
                fill_enabled: false,
                image_size: (self.image_width, self.image_height),
                scale,
                offset,
                annotations: &self.annotations,
                min_drag_distance: 5.0,
            };
            self.tool_manager.handle_event(tool_event, &ctx)
        };
        self.process_tool_result(result, cx);
    }

    /// Handle mouse up event on canvas
    fn handle_mouse_up(&mut self, event: &MouseUpEvent, cx: &mut Context<Self>) {
        // Convert screen coordinates to image coordinates
        let position = event.position;
        let screen_x: f32 = position.x.into();
        let screen_y: f32 = position.y.into();
        let (img_x, img_y) = self.screen_to_image_coords(screen_x, screen_y);

        // Map GPUI mouse button to tool mouse button
        let button = match event.button {
            MouseButton::Left => ToolMouseButton::Left,
            MouseButton::Right => ToolMouseButton::Right,
            MouseButton::Middle => ToolMouseButton::Middle,
            MouseButton::Navigate(_) => ToolMouseButton::Left, // Fallback
        };

        // Build tool event
        let tool_event = ToolEvent::MouseUp {
            position: NibPoint::new(img_x, img_y),
            button,
        };

        // Dispatch to tool manager
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = ToolContext {
                color: self.current_color,
                stroke_width: 2.0,
                fill_enabled: false,
                image_size: (self.image_width, self.image_height),
                scale,
                offset,
                annotations: &self.annotations,
                min_drag_distance: 5.0,
            };
            self.tool_manager.handle_event(tool_event, &ctx)
        };
        self.process_tool_result(result, cx);
    }

    /// Handle scroll wheel event for zoom (Figma-like: Cmd/Ctrl+scroll = zoom to cursor)
    fn handle_scroll_wheel(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        let position = event.position;
        let screen_x: f32 = position.x.into();
        let screen_y: f32 = position.y.into();

        // Get scroll delta - convert to pixels if needed
        let delta = event.delta.pixel_delta(px(20.0));
        let delta_y: f32 = delta.y.into();

        // Cmd/Ctrl + scroll = zoom, otherwise pan
        if event.modifiers.secondary() {
            // Zoom mode: zoom in/out centered on cursor
            // Positive delta_y = scroll up = zoom in
            let zoom_factor = if delta_y > 0.0 {
                ZOOM_FACTOR
            } else if delta_y < 0.0 {
                1.0 / ZOOM_FACTOR
            } else {
                return;
            };

            self.canvas.zoom_at(screen_x, screen_y, zoom_factor);
            cx.notify();
        } else {
            // Pan mode: scroll to pan the canvas
            let delta_x: f32 = delta.x.into();
            self.canvas.pan(delta_x as f64, delta_y as f64);
            cx.notify();
        }
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

        let button_bg = rgb(0x3d3d3d);
        let button_active_bg = rgb(0x0078d4);
        let text_color = rgb(0xcccccc);
        let icon_color = rgb(0xffffff);

        // Outer wrapper for centering at bottom
        div()
            .absolute()
            .bottom_4()
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(
                // Actual toolbar container
                div()
                    .flex()
                    .flex_row()
                    .h(px(64.))
                    .bg(rgba(0x2d2d2dee)) // Semi-transparent background
                    .rounded_xl()
                    .border_1()
                    .border_color(rgba(0x00000044))
                    .px_3()
                    .gap_1()
                    .items_center()
                    .children(tools_to_show.iter().map(|tool| {
                let is_active = *tool == self.active_tool;
                let tool_copy = *tool;

                div()
                    .id(tool.name())
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .w(px(56.))
                    .h(px(56.))
                    .gap_1()
                    .rounded_md()
                    .cursor_pointer()
                    .bg(if is_active { button_active_bg } else { rgba(0x3d3d3d00) })
                    .hover(|style| style.bg(button_bg))
                    .child(
                        svg()
                            .path(tool.icon_path())
                            .size(px(28.))
                            .text_color(icon_color)
                    )
                    .child(
                        div()
                            .text_color(text_color)
                            .text_size(px(10.))
                            .child(format!("{} ({})", tool.name(), tool.shortcut().to_ascii_uppercase()))
                    )
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.select_tool(tool_copy, cx);
                    }))
            })),
            ) // Close inner toolbar container
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
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);
                Self::render_arrow_element(start_sx, start_sy, end_sx, end_sy, 2.0, border_color.into())
                    .into_any_element()
            }
            AnnotationType::Line { start, end, .. } => {
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);
                Self::render_line_element(start_sx, start_sy, end_sx, end_sy, 2.0, border_color.into())
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

                // Blur is rendered in the preview image, no overlay needed
                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
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

    /// Render the tool preview from the tool manager
    fn render_tool_preview(&self) -> Option<impl IntoElement> {
        let ctx = self.build_tool_context();
        let preview = self.tool_manager.preview(&ctx);

        match preview {
            ToolPreview::None => None,
            ToolPreview::Rectangle { region, color } => {
                let preview_color = rgb(
                    color.r as u32 * 0x10000 + color.g as u32 * 0x100 + color.b as u32,
                );
                let preview_bg = rgba(
                    color.r as u32 * 0x1000000
                        + color.g as u32 * 0x10000
                        + color.b as u32 * 0x100
                        + 0x40, // Semi-transparent
                );

                // Scale region to screen coordinates
                let (sx, sy, sw, sh) =
                    self.scale_coords(region.x, region.y, region.width, region.height);

                Some(
                    div()
                        .absolute()
                        .left(px(sx))
                        .top(px(sy))
                        .w(px(sw))
                        .h(px(sh))
                        .border_2()
                        .border_color(preview_color)
                        .bg(preview_bg)
                        .into_any_element(),
                )
            }
            ToolPreview::Line { start, end, color } => {
                let preview_color = rgb(
                    color.r as u32 * 0x10000 + color.g as u32 * 0x100 + color.b as u32,
                );
                let (start_sx, start_sy) = self.scale_point(start.x, start.y);
                let (end_sx, end_sy) = self.scale_point(end.x, end.y);

                Some(
                    Self::render_line_element(start_sx, start_sy, end_sx, end_sy, 2.0, preview_color.into())
                        .into_any_element(),
                )
            }
            ToolPreview::Ellipse {
                center,
                radius_x,
                radius_y,
                color,
            } => {
                let preview_color = rgb(
                    color.r as u32 * 0x10000 + color.g as u32 * 0x100 + color.b as u32,
                );

                // Scale to screen coordinates
                let (center_sx, center_sy) = self.scale_point(center.x, center.y);
                let (scale, _, _) = self.calculate_scale_and_offset();
                let scaled_radius_x = radius_x as f32 * scale;
                let scaled_radius_y = radius_y as f32 * scale;

                Some(
                    div()
                        .absolute()
                        .left(px(center_sx - scaled_radius_x))
                        .top(px(center_sy - scaled_radius_y))
                        .w(px(scaled_radius_x * 2.0))
                        .h(px(scaled_radius_y * 2.0))
                        .border_2()
                        .border_color(preview_color)
                        .rounded_full()
                        .into_any_element(),
                )
            }
            ToolPreview::Selection { bounds, handles } => {
                // Render selection bounds with optional resize handles
                if bounds.is_empty() {
                    return None;
                }

                let selection_color = rgb(0x3b82f6); // Blue selection color
                let handle_color = rgb(0xffffff); // White handles
                let handle_size = 8.0_f32;

                // For now, render only the first bound (single selection case)
                // Multi-selection rendering can be enhanced later
                let region = &bounds[0];
                let (sx, sy, sw, sh) =
                    self.scale_coords(region.x, region.y, region.width, region.height);

                let mut container = div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(sw))
                    .h(px(sh))
                    .border_1()
                    .border_color(selection_color);

                // Render resize handles if provided
                if let Some(handle_positions) = handles {
                    let mut handles_container = div().absolute().left(px(0.0)).top(px(0.0));

                    for (point, _handle_type) in handle_positions {
                        let (hx, hy) = self.scale_point(point.x, point.y);
                        handles_container = handles_container.child(
                            div()
                                .absolute()
                                .left(px(hx - handle_size / 2.0))
                                .top(px(hy - handle_size / 2.0))
                                .w(px(handle_size))
                                .h(px(handle_size))
                                .bg(handle_color)
                                .border_1()
                                .border_color(selection_color),
                        );
                    }

                    container = container.child(handles_container);
                }

                Some(container.into_any_element())
            }
            ToolPreview::Marquee { region } => {
                // Render marquee selection rectangle (dashed border effect)
                let marquee_color = rgb(0x3b82f6); // Blue
                let (sx, sy, sw, sh) =
                    self.scale_coords(region.x, region.y, region.width, region.height);

                Some(
                    div()
                        .absolute()
                        .left(px(sx))
                        .top(px(sy))
                        .w(px(sw))
                        .h(px(sh))
                        .border_1()
                        .border_color(marquee_color)
                        .into_any_element(),
                )
            }
        }
    }

    /// Render the canvas area with image and annotations
    fn render_canvas(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let background_color = rgb(0x1e1e1e);
        let text_color = rgb(0xcccccc);

        let mut canvas = div()
            .id("canvas")
            .size_full()
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
            }))
            .on_scroll_wheel(cx.listener(|this, event, _window, cx| {
                this.handle_scroll_wheel(event, cx);
            }));

        // Add image if we have one - use explicit positioning to match annotation coordinates
        if let Some(path) = &self.file_path {
            let (scale, offset_x, offset_y) = self.calculate_scale_and_offset();
            let scaled_width = self.image_width as f32 * scale;
            let scaled_height = self.image_height as f32 * scale;

            // Use blur preview if available, otherwise original image
            let display_path = self.blur_preview_path.as_ref().unwrap_or(path);

            canvas = canvas.child(
                div()
                    .absolute()
                    .left(px(offset_x))
                    .top(px(offset_y))
                    .w(px(scaled_width))
                    .h(px(scaled_height))
                    .child(
                        img(display_path.clone())
                            .size_full()
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
                            .child("Nib Screenshot Annotator"),
                    )
                    .child(
                        div()
                            .text_color(rgb(0x888888))
                            .child("No image loaded. Use: nib gui <file>"),
                    ),
            );
        }

        // Add annotation overlays (skip text annotation being edited)
        for annotation in &self.annotations {
            // If we're editing this annotation, skip rendering it - we'll render the editable version
            let is_being_edited = self.text_input_state.as_ref()
                .and_then(|state| state.editing_annotation_id)
                .map(|id| id == annotation.id)
                .unwrap_or(false);

            if !is_being_edited {
                canvas = canvas.child(self.render_annotation(annotation));
            }
        }

        // Add tool preview if actively drawing
        if let Some(preview) = self.render_tool_preview() {
            canvas = canvas.child(preview);
        }

        // Add inline text editing if in text input mode (Figma-style, directly on canvas)
        if let Some(ref input_state) = self.text_input_state {
            canvas = canvas.child(self.render_inline_text_editing(input_state));
        }

        canvas
    }

    /// Handle keyboard input
    fn handle_key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;

        // Handle zoom keyboard shortcuts (Cmd/Ctrl + key)
        // Skip if in text input mode
        if keystroke.modifiers.platform && self.text_input_state.is_none() {
            let key = keystroke.key.as_str();
            match key {
                // Cmd/Ctrl + Plus or Cmd/Ctrl + = : Zoom in
                "+" | "=" => {
                    self.canvas.zoom_center(ZOOM_FACTOR);
                    cx.notify();
                    return;
                }
                // Cmd/Ctrl + Minus : Zoom out
                "-" => {
                    self.canvas.zoom_center(1.0 / ZOOM_FACTOR);
                    cx.notify();
                    return;
                }
                // Cmd/Ctrl + 0 : Fit to view
                "0" => {
                    self.canvas.fit_to_view();
                    cx.notify();
                    return;
                }
                // Cmd/Ctrl + 1 : 100% zoom
                "1" => {
                    self.canvas.reset_zoom();
                    cx.notify();
                    return;
                }
                _ => {}
            }
        }

        // Check for tool shortcuts (single letter, no modifiers, not in text input mode)
        if !keystroke.modifiers.shift
            && !keystroke.modifiers.control
            && !keystroke.modifiers.alt
            && !keystroke.modifiers.platform
            && self.text_input_state.is_none()
        {
            if let Some(key_char) = keystroke.key_char.as_ref().and_then(|s| s.chars().next()) {
                for &tool_id in Tool::all() {
                    if tool_id.shortcut() == key_char {
                        self.select_tool(tool_id, cx);
                        return;
                    }
                }
            }
        }

        // Extract modifier keys from the keystroke
        let modifiers = Modifiers {
            shift: keystroke.modifiers.shift,
            ctrl: keystroke.modifiers.control,
            alt: keystroke.modifiers.alt,
            cmd: keystroke.modifiers.platform,
        };

        // Build ToolEvent::KeyDown
        let tool_event = ToolEvent::KeyDown {
            key: keystroke.key.clone(),
            key_char: keystroke.key_char.as_ref().and_then(|s| s.chars().next()),
            modifiers,
        };

        // Dispatch to tool manager
        // We inline context building to enable split borrows (annotations vs tool_manager)
        let result = {
            let scale = self.canvas.scale();
            let offset = self.canvas.offset_tuple();
            let ctx = ToolContext {
                color: self.current_color,
                stroke_width: 2.0,
                fill_enabled: false,
                image_size: (self.image_width, self.image_height),
                scale,
                offset,
                annotations: &self.annotations,
                min_drag_distance: 5.0,
            };
            self.tool_manager.handle_event(tool_event, &ctx)
        };

        // Process the result
        self.process_tool_result(result, cx);

        // Sync content from TextTool to EditorView's text_input_state for rendering
        // (TextTool is the source of truth for content)
        if let Some(ref mut state) = self.text_input_state {
            if let Some(text_tool) = self.tool_manager.get_tool_as::<TextTool>(ToolId::Text) {
                state.content = text_tool.text_state().content.clone();
            }
        }
    }

    /// Confirm text input and create/update the annotation
    fn confirm_text_input(&mut self, cx: &mut Context<Self>) {
        let Some(input_state) = self.text_input_state.take() else {
            return;
        };

        // Only create annotation if there's actual content
        if input_state.content.trim().is_empty() {
            cx.notify();
            return;
        }

        if let Some(annotation_id) = input_state.editing_annotation_id {
            // Update existing annotation
            if let Some(annotation) = self.annotations.iter_mut().find(|a| a.id == annotation_id) {
                if let AnnotationType::Text { content, .. } = &mut annotation.annotation_type {
                    *content = input_state.content;
                    annotation.touch();
                }
            }
        } else {
            // Create new annotation
            // Convert screen coords to image coords for storage
            let font_size = 16.0;
            let (scale, _, _) = self.calculate_scale_and_offset();
            let scaled_font_size = font_size * scale;

            // Offset screen position up by scaled font height (to match rendering)
            let adjusted_screen_y = input_state.screen_y - scaled_font_size;

            // Convert to image coordinates
            let (img_x, img_y) = self.screen_to_image_coords(input_state.screen_x, adjusted_screen_y);
            let position = NibPoint::new(img_x, img_y);

            let annotation = Annotation::new(AnnotationType::Text {
                position,
                content: input_state.content,
                font_size: font_size as f64,
                align: crate::core::types::TextAlign::Left,
                background: None,
                max_width: None,
            }).with_color(self.current_color);
            self.annotations.push(annotation);
        }

        // Save annotations to disk
        self.save_annotations();
        cx.notify();
    }

    /// Render inline text editing directly on canvas (Figma-style)
    /// Text renders just above the click position with a cursor, no overlay box
    fn render_inline_text_editing(&self, input_state: &TextInputState) -> impl IntoElement {
        // Window coords -> canvas coords (subtract toolbar height)
        let canvas_x = input_state.screen_x;
        let canvas_y = input_state.screen_y - TOOLBAR_HEIGHT;

        // Get scale for font sizing
        let (scale, _, _) = self.calculate_scale_and_offset();
        let font_size = 16.0_f32;
        let scaled_font_size = font_size * scale;

        // Offset text up so it appears above the click point
        let text_y = canvas_y - scaled_font_size;

        // Use the current drawing color (same as annotations)
        let text_color = rgb(
            self.current_color.r as u32 * 0x10000 +
            self.current_color.g as u32 * 0x100 +
            self.current_color.b as u32
        );

        // Cursor color matches text
        let cursor_color = text_color;

        div()
            .absolute()
            .left(px(canvas_x))
            .top(px(text_y))
            .flex()
            .flex_row()
            .items_center()
            .text_color(text_color)
            .text_size(px(scaled_font_size))
            .child(input_state.content.clone())
            .child(
                // Blinking cursor - thin vertical bar after text
                div()
                    .w(px(2.))
                    .h(px(scaled_font_size))
                    .bg(cursor_color)
            )
    }
}

impl Focusable for EditorView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for EditorView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // Update canvas dimensions from actual window size
        let viewport = window.viewport_size();
        let viewport_width: f32 = viewport.width.into();
        let viewport_height: f32 = viewport.height.into();
        self.canvas_width = viewport_width;
        self.canvas_height = viewport_height; // Toolbar floats inside canvas

        // Sync canvas viewport (handles resize and initial fit-to-view)
        self.canvas.set_viewport(viewport_width as f64, viewport_height as f64);

        // Check if sidecar file has changed and reload annotations if needed
        self.check_and_reload_annotations();

        // Inline text editing is now rendered directly on the canvas (Figma-style)
        // No separate overlay needed
        div()
            .id("editor-container")
            .size_full()
            .relative()
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.handle_key_down(event, window, cx);
            }))
            .child(self.render_canvas(cx))
            .child(self.render_toolbar(cx)) // Toolbar floats over canvas
    }
}
