//! Core data types for Nib annotation system
//!
//! This module defines the fundamental types used throughout Nib:
//! - Annotations and their variants
//! - Color, Point, Region primitives
//! - NibImage document type

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

/// Unique identifier for annotations
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AnnotationId(pub u64);

impl AnnotationId {
    pub fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        Self(COUNTER.fetch_add(1, Ordering::Relaxed))
    }
}

impl Default for AnnotationId {
    fn default() -> Self {
        Self::new()
    }
}

/// RGBA color with 8-bit components
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    // Semantic colors for severity
    pub const RED: Self = Self::rgb(220, 38, 38);
    pub const YELLOW: Self = Self::rgb(234, 179, 8);
    pub const BLUE: Self = Self::rgb(59, 130, 246);
    pub const GREEN: Self = Self::rgb(34, 197, 94);
    pub const WHITE: Self = Self::rgb(255, 255, 255);
    pub const BLACK: Self = Self::rgb(0, 0, 0);
}

impl Default for Color {
    fn default() -> Self {
        Self::RED
    }
}

/// 2D point in image coordinates (pixels from top-left)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn distance_to(&self, other: Point) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        (dx * dx + dy * dy).sqrt()
    }
}

/// Rectangular region in image coordinates
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Region {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    pub fn from_points(p1: Point, p2: Point) -> Self {
        let x = p1.x.min(p2.x);
        let y = p1.y.min(p2.y);
        let width = (p1.x - p2.x).abs();
        let height = (p1.y - p2.y).abs();
        Self { x, y, width, height }
    }

    pub fn contains(&self, point: Point) -> bool {
        point.x >= self.x
            && point.x <= self.x + self.width
            && point.y >= self.y
            && point.y <= self.y + self.height
    }

    pub fn center(&self) -> Point {
        Point::new(self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    /// Expand region by padding on all sides
    pub fn expand(&self, padding: f64) -> Self {
        Self {
            x: self.x - padding,
            y: self.y - padding,
            width: self.width + padding * 2.0,
            height: self.height + padding * 2.0,
        }
    }

    /// Check if this region intersects with another region
    pub fn intersects(&self, other: &Region) -> bool {
        !(self.x + self.width < other.x
            || other.x + other.width < self.x
            || self.y + self.height < other.y
            || other.y + other.height < self.y)
    }
}

/// Severity level for annotations (affects default color)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Severity {
    #[default]
    None,
    Info,
    Warning,
    Error,
    Success,
}

impl Severity {
    pub fn default_color(&self) -> Color {
        match self {
            Severity::None => Color::RED,
            Severity::Info => Color::BLUE,
            Severity::Warning => Color::YELLOW,
            Severity::Error => Color::RED,
            Severity::Success => Color::GREEN,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::None => "none",
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Error => "error",
            Severity::Success => "success",
        }
    }
}

/// Arrow head style
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ArrowHead {
    #[default]
    End,
    Start,
    Both,
    None,
}

/// Text alignment for text annotations
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// Blur intensity level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlurIntensity {
    Light,
    #[default]
    Medium,
    Heavy,
    Pixelate,
}

impl BlurIntensity {
    /// Returns blur radius in pixels
    pub fn radius(&self) -> u32 {
        match self {
            BlurIntensity::Light => 8,
            BlurIntensity::Medium => 16,
            BlurIntensity::Heavy => 32,
            BlurIntensity::Pixelate => 0, // Special case: use pixelation instead
        }
    }

    /// Returns pixel block size for pixelation mode
    pub fn pixel_size(&self) -> u32 {
        match self {
            BlurIntensity::Pixelate => 12,
            _ => 1,
        }
    }
}

/// Line/stroke style
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StrokeStyle {
    #[default]
    Solid,
    Dashed,
    Dotted,
}

/// The type-specific data for each annotation variant
#[derive(Debug, Clone, PartialEq)]
pub enum AnnotationType {
    /// Arrow from start to end point
    Arrow {
        start: Point,
        end: Point,
        head: ArrowHead,
        stroke_width: f64,
    },

    /// Rectangle outline or filled
    Box {
        region: Region,
        stroke_width: f64,
        stroke_style: StrokeStyle,
        filled: bool,
        corner_radius: f64,
    },

    /// Text label at position
    Text {
        position: Point,
        content: String,
        font_size: f64,
        align: TextAlign,
        background: Option<Color>,
        max_width: Option<f64>,
    },

    /// Numbered callout (circled number)
    Number {
        position: Point,
        value: u32,
        radius: f64,
    },

    /// Blur/redact region
    Blur {
        region: Region,
        intensity: BlurIntensity,
    },

    /// Freeform highlight (semi-transparent)
    Highlight {
        region: Region,
        corner_radius: f64,
    },

    /// Line between two points (no arrow head)
    Line {
        start: Point,
        end: Point,
        stroke_width: f64,
        stroke_style: StrokeStyle,
    },

    /// Ellipse/circle annotation
    Ellipse {
        center: Point,
        radius_x: f64,
        radius_y: f64,
        stroke_width: f64,
        filled: bool,
    },

    /// Crop indicator (defines export bounds)
    Crop { region: Region },
}

impl AnnotationType {
    /// Returns the bounding box of this annotation
    pub fn bounds(&self) -> Region {
        match self {
            AnnotationType::Arrow {
                start,
                end,
                stroke_width,
                ..
            } => {
                let padding = stroke_width / 2.0 + 10.0; // Extra for arrow head
                Region::from_points(*start, *end).expand(padding)
            }
            AnnotationType::Box {
                region,
                stroke_width,
                ..
            } => region.expand(*stroke_width / 2.0),
            AnnotationType::Text {
                position,
                font_size,
                content,
                max_width,
                ..
            } => {
                // Approximate text bounds
                let width = max_width.unwrap_or(content.len() as f64 * font_size * 0.6);
                let height = *font_size * 1.2;
                Region::new(position.x, position.y, width, height)
            }
            AnnotationType::Number {
                position, radius, ..
            } => Region::new(
                position.x - radius,
                position.y - radius,
                radius * 2.0,
                radius * 2.0,
            ),
            AnnotationType::Blur { region, .. } => *region,
            AnnotationType::Highlight { region, .. } => *region,
            AnnotationType::Line {
                start,
                end,
                stroke_width,
                ..
            } => Region::from_points(*start, *end).expand(*stroke_width / 2.0),
            AnnotationType::Ellipse {
                center,
                radius_x,
                radius_y,
                stroke_width,
                ..
            } => Region::new(
                center.x - radius_x - stroke_width / 2.0,
                center.y - radius_y - stroke_width / 2.0,
                radius_x * 2.0 + stroke_width,
                radius_y * 2.0 + stroke_width,
            ),
            AnnotationType::Crop { region } => *region,
        }
    }

    /// Returns the type name for QML serialization
    pub fn type_name(&self) -> &'static str {
        match self {
            AnnotationType::Arrow { .. } => "arrow",
            AnnotationType::Box { .. } => "box",
            AnnotationType::Text { .. } => "text",
            AnnotationType::Number { .. } => "number",
            AnnotationType::Blur { .. } => "blur",
            AnnotationType::Highlight { .. } => "highlight",
            AnnotationType::Line { .. } => "line",
            AnnotationType::Ellipse { .. } => "ellipse",
            AnnotationType::Crop { .. } => "crop",
        }
    }
}

/// A single annotation with metadata
#[derive(Debug, Clone, PartialEq)]
pub struct Annotation {
    pub id: AnnotationId,
    pub annotation_type: AnnotationType,
    pub color: Color,
    pub severity: Severity,
    pub label: Option<String>,
    pub visible: bool,
    pub locked: bool,
    pub z_index: i32,
    pub created_at: SystemTime,
    pub modified_at: SystemTime,
}

impl Annotation {
    pub fn new(annotation_type: AnnotationType) -> Self {
        let now = SystemTime::now();
        Self {
            id: AnnotationId::new(),
            annotation_type,
            color: Color::default(),
            severity: Severity::default(),
            label: None,
            visible: true,
            locked: false,
            z_index: 0,
            created_at: now,
            modified_at: now,
        }
    }

    pub fn with_color(mut self, color: Color) -> Self {
        self.color = color;
        self
    }

    pub fn with_severity(mut self, severity: Severity) -> Self {
        self.severity = severity;
        self.color = severity.default_color();
        self
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn bounds(&self) -> Region {
        self.annotation_type.bounds()
    }

    pub fn contains_point(&self, point: Point) -> bool {
        self.bounds().contains(point)
    }

    pub fn touch(&mut self) {
        self.modified_at = SystemTime::now();
    }
}

/// Source of the base image
#[derive(Debug, Clone, PartialEq)]
pub enum ImageSource {
    /// Image loaded from file path
    File(PathBuf),
    /// Image captured from screen
    ScreenCapture {
        display_id: u32,
        captured_at: SystemTime,
    },
    /// Image captured from specific window
    WindowCapture {
        window_title: String,
        captured_at: SystemTime,
    },
    /// Image from clipboard
    Clipboard { pasted_at: SystemTime },
    /// Image from URL (downloaded)
    Url(String),
}

/// A complete annotated image document
#[derive(Debug, Clone)]
pub struct NibImage {
    /// Original image data (PNG bytes)
    pub image_data: Vec<u8>,
    /// Image dimensions
    pub width: u32,
    pub height: u32,
    /// Where the image came from
    pub source: ImageSource,
    /// All annotations on this image
    pub annotations: Vec<Annotation>,
    /// Document-level metadata
    pub title: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    /// File path if saved
    pub file_path: Option<PathBuf>,
    /// Document timestamps
    pub created_at: SystemTime,
    pub modified_at: SystemTime,
}

impl NibImage {
    pub fn new(image_data: Vec<u8>, width: u32, height: u32, source: ImageSource) -> Self {
        let now = SystemTime::now();
        Self {
            image_data,
            width,
            height,
            source,
            annotations: Vec::new(),
            title: None,
            description: None,
            tags: Vec::new(),
            file_path: None,
            created_at: now,
            modified_at: now,
        }
    }

    pub fn add_annotation(&mut self, annotation: Annotation) {
        self.annotations.push(annotation);
        self.touch();
    }

    pub fn remove_annotation(&mut self, id: AnnotationId) -> Option<Annotation> {
        if let Some(pos) = self.annotations.iter().position(|a| a.id == id) {
            self.touch();
            Some(self.annotations.remove(pos))
        } else {
            None
        }
    }

    pub fn get_annotation(&self, id: AnnotationId) -> Option<&Annotation> {
        self.annotations.iter().find(|a| a.id == id)
    }

    pub fn get_annotation_mut(&mut self, id: AnnotationId) -> Option<&mut Annotation> {
        self.annotations.iter_mut().find(|a| a.id == id)
    }

    pub fn annotations_at_point(&self, point: Point) -> Vec<&Annotation> {
        self.annotations
            .iter()
            .filter(|a| a.visible && a.contains_point(point))
            .collect()
    }

    pub fn visible_annotations(&self) -> impl Iterator<Item = &Annotation> {
        self.annotations.iter().filter(|a| a.visible)
    }

    /// Returns annotations sorted by z-index for rendering
    pub fn annotations_by_z_order(&self) -> Vec<&Annotation> {
        let mut sorted: Vec<_> = self.annotations.iter().filter(|a| a.visible).collect();
        sorted.sort_by_key(|a| a.z_index);
        sorted
    }

    pub fn touch(&mut self) {
        self.modified_at = SystemTime::now();
    }

    pub fn is_modified(&self) -> bool {
        self.modified_at > self.created_at
    }

    /// Get crop region if defined, otherwise full image bounds
    pub fn export_bounds(&self) -> Region {
        self.annotations
            .iter()
            .find_map(|a| match &a.annotation_type {
                AnnotationType::Crop { region } => Some(*region),
                _ => None,
            })
            .unwrap_or(Region::new(0.0, 0.0, self.width as f64, self.height as f64))
    }
}
