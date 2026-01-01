//! JSON serialization types for Nib annotations
//!
//! This crate provides types and functions for serializing annotations
//! to a JSON format for persistence and interoperability.

use std::path::{Path, PathBuf};

use nib_core::{
    Annotation, AnnotationType, ArrowHead, BlurIntensity, Color,
    Point as NibPoint, Region, StrokeStyle, TextAlign,
};
use serde::{Deserialize, Serialize};

/// Version of the annotations file format
pub const ANNOTATIONS_FILE_VERSION: &str = "1.0";

/// Serializable annotation data for JSON persistence
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SerializedAnnotation {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: String,
    #[serde(flatten)]
    pub geometry: AnnotationGeometry,
    pub color: String,
}

/// Geometry data for different annotation types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    Path {
        points: Vec<(f64, f64)>,
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
pub fn color_to_hex(color: &Color) -> String {
    format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b)
}

/// Parse a hex color string to Color
pub fn hex_to_color(hex: &str) -> Color {
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
pub fn serialize_annotation(annotation: &Annotation) -> SerializedAnnotation {
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
        AnnotationType::Path { points, .. } => (
            "path".to_string(),
            AnnotationGeometry::Path {
                points: points.iter().map(|p| (p.x, p.y)).collect(),
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
                stroke_style: StrokeStyle::Solid,
                filled: false,
                corner_radius: 0.0,
            }
        }
        ("arrow", AnnotationGeometry::Line { start_x, start_y, end_x, end_y }) => {
            AnnotationType::Arrow {
                start: NibPoint::new(*start_x, *start_y),
                end: NibPoint::new(*end_x, *end_y),
                head: ArrowHead::End,
                stroke_width: 2.0,
            }
        }
        ("line", AnnotationGeometry::Line { start_x, start_y, end_x, end_y }) => {
            AnnotationType::Line {
                start: NibPoint::new(*start_x, *start_y),
                end: NibPoint::new(*end_x, *end_y),
                stroke_width: 2.0,
                stroke_style: StrokeStyle::Solid,
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
                intensity: BlurIntensity::Medium,
            }
        }
        ("text", AnnotationGeometry::Point { x, y, content, .. }) => {
            AnnotationType::Text {
                position: NibPoint::new(*x, *y),
                content: content.clone().unwrap_or_else(|| "Text".to_string()),
                font_size: 16.0,
                align: TextAlign::Left,
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
        ("path", AnnotationGeometry::Path { points }) => {
            AnnotationType::Path {
                points: points.iter().map(|(x, y)| NibPoint::new(*x, *y)).collect(),
                stroke_width: 2.0,
                stroke_style: StrokeStyle::Solid,
            }
        }
        _ => return None,
    };

    Some(Annotation::new(annotation_type).with_color(color))
}

/// Get the sidecar annotations file path for an image
pub fn annotations_file_path(image_path: &Path) -> PathBuf {
    let mut path = image_path.to_path_buf();
    let file_name = path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    path.set_file_name(format!("{}.annotations.json", file_name));
    path
}
