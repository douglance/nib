//! Conversion functions between sidecar JSON format and NibFile format
//!
//! This module provides utilities to convert between:
//! - GUI sidecar format (SerializedAnnotation from AnnotationsFile)
//! - NibFile format (Annotation from core/types.rs)

use nib_core::{
    Annotation, AnnotationType, ArrowHead, BlurIntensity, Color, Point, Region, StrokeStyle,
    TextAlign,
};
use nib_serde::{AnnotationGeometry, AnnotationsFile, SerializedAnnotation, SerializedStyle};
use std::path::Path;

/// Convert a SerializedAnnotation (sidecar format) to core Annotation
///
/// This handles all annotation types: rectangle, arrow, text, number, highlight, blur, line, ellipse.
/// Returns None if the annotation type is unknown or the geometry doesn't match.
pub fn sidecar_to_annotation(serialized: &SerializedAnnotation) -> Option<Annotation> {
    let color = parse_hex_color(&serialized.color);

    let annotation_type = match (serialized.annotation_type.as_str(), &serialized.geometry) {
        (
            "rectangle",
            AnnotationGeometry::Rectangle {
                x,
                y,
                width,
                height,
            },
        ) => AnnotationType::Box {
            region: Region::new(*x, *y, *width, *height),
            stroke_width: 2.0,
            stroke_style: StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        },
        (
            "arrow",
            AnnotationGeometry::Line {
                start_x,
                start_y,
                end_x,
                end_y,
            },
        ) => AnnotationType::Arrow {
            start: Point::new(*start_x, *start_y),
            end: Point::new(*end_x, *end_y),
            head: ArrowHead::End,
            stroke_width: 2.0,
        },
        (
            "line",
            AnnotationGeometry::Line {
                start_x,
                start_y,
                end_x,
                end_y,
            },
        ) => AnnotationType::Line {
            start: Point::new(*start_x, *start_y),
            end: Point::new(*end_x, *end_y),
            stroke_width: 2.0,
            stroke_style: StrokeStyle::Solid,
        },
        (
            "ellipse",
            AnnotationGeometry::Ellipse {
                center_x,
                center_y,
                radius_x,
                radius_y,
            },
        ) => AnnotationType::Ellipse {
            center: Point::new(*center_x, *center_y),
            radius_x: *radius_x,
            radius_y: *radius_y,
            stroke_width: 2.0,
            filled: false,
        },
        (
            "highlight",
            AnnotationGeometry::Rectangle {
                x,
                y,
                width,
                height,
            },
        ) => AnnotationType::Highlight {
            region: Region::new(*x, *y, *width, *height),
            corner_radius: 0.0,
        },
        (
            "blur",
            AnnotationGeometry::Rectangle {
                x,
                y,
                width,
                height,
            },
        ) => AnnotationType::Blur {
            region: Region::new(*x, *y, *width, *height),
            intensity: BlurIntensity::Medium,
        },
        ("text", AnnotationGeometry::Point { x, y, content, .. }) => AnnotationType::Text {
            position: Point::new(*x, *y),
            content: content.clone().unwrap_or_else(|| "Text".to_string()),
            font_size: 16.0,
            align: TextAlign::Left,
            background: None,
            max_width: None,
        },
        ("number", AnnotationGeometry::Point { x, y, value, .. }) => AnnotationType::Number {
            position: Point::new(*x, *y),
            value: value.unwrap_or(1),
            radius: 14.0,
        },
        (
            "crop",
            AnnotationGeometry::Rectangle {
                x,
                y,
                width,
                height,
            },
        ) => AnnotationType::Crop {
            region: Region::new(*x, *y, *width, *height),
        },
        _ => return None,
    };

    Some(Annotation::new(annotation_type).with_color(color))
}

/// Convert a core Annotation to SerializedAnnotation (sidecar format)
pub fn annotation_to_sidecar(annotation: &Annotation) -> SerializedAnnotation {
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
        AnnotationType::Ellipse {
            center,
            radius_x,
            radius_y,
            ..
        } => (
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
        AnnotationType::Text {
            position, content, ..
        } => (
            "text".to_string(),
            AnnotationGeometry::Point {
                x: position.x,
                y: position.y,
                value: None,
                content: Some(content.clone()),
            },
        ),
        AnnotationType::Number {
            position, value, ..
        } => (
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
        AnnotationType::Image { region, .. } => (
            "image".to_string(),
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
        color: format_color_hex(&annotation.color),
        // This module's sidecar<->core conversion is a separate, pre-existing path from
        // nib-serde's serialize_annotation/deserialize_annotation (used by the GUI's save/load
        // flow) and is out of scope for the Phase 1 sidecar fidelity fix, which targets
        // nib-serde only.
        style: SerializedStyle::default(),
    }
}

/// Load annotations from a sidecar JSON file
///
/// Returns a vector of Annotation objects, or an empty vector if the file doesn't exist
/// or cannot be parsed.
pub fn load_sidecar_annotations(image_path: &Path) -> Vec<Annotation> {
    let sidecar_path = sidecar_path_for_image(image_path);

    if !sidecar_path.exists() {
        return Vec::new();
    }

    let json_content = match std::fs::read_to_string(&sidecar_path) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };

    let annotations_file: AnnotationsFile = match serde_json::from_str(&json_content) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };

    annotations_file
        .annotations
        .iter()
        .filter_map(sidecar_to_annotation)
        .collect()
}

/// Save annotations to a sidecar JSON file
pub fn save_sidecar_annotations(
    image_path: &Path,
    annotations: &[Annotation],
) -> std::io::Result<()> {
    let sidecar_path = sidecar_path_for_image(image_path);

    let serialized: Vec<SerializedAnnotation> =
        annotations.iter().map(annotation_to_sidecar).collect();

    let file = AnnotationsFile::new(&image_path.to_string_lossy(), serialized);

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;

    std::fs::write(&sidecar_path, json)
}

/// Get the sidecar annotations file path for an image
pub fn sidecar_path_for_image(image_path: &Path) -> std::path::PathBuf {
    let mut path = image_path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    path.set_file_name(format!("{}.annotations.json", file_name));
    path
}

/// Parse a hex color string (#rrggbb or #rrggbbaa) to Color
fn parse_hex_color(hex: &str) -> Color {
    let hex = hex.trim_start_matches('#');

    if hex.len() >= 8 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
        let a = u8::from_str_radix(&hex[6..8], 16).unwrap_or(255);
        Color::rgba(r, g, b, a)
    } else if hex.len() >= 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
        Color::rgb(r, g, b)
    } else {
        Color::RED // Fallback
    }
}

/// Format a Color as hex string (#rrggbb or #rrggbbaa)
fn format_color_hex(color: &Color) -> String {
    if color.a == 255 {
        format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b)
    } else {
        format!(
            "#{:02x}{:02x}{:02x}{:02x}",
            color.r, color.g, color.b, color.a
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sidecar_to_annotation_rectangle() {
        let serialized = SerializedAnnotation {
            id: "a1".to_string(),
            annotation_type: "rectangle".to_string(),
            geometry: AnnotationGeometry::Rectangle {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 50.0,
            },
            color: "#ff0000".to_string(),
            style: SerializedStyle::default(),
        };

        let annotation = sidecar_to_annotation(&serialized).unwrap();
        assert!(matches!(
            annotation.annotation_type,
            AnnotationType::Box { .. }
        ));
        assert_eq!(annotation.color.r, 255);
        assert_eq!(annotation.color.g, 0);
        assert_eq!(annotation.color.b, 0);
    }

    #[test]
    fn test_sidecar_to_annotation_arrow() {
        let serialized = SerializedAnnotation {
            id: "a2".to_string(),
            annotation_type: "arrow".to_string(),
            geometry: AnnotationGeometry::Line {
                start_x: 0.0,
                start_y: 0.0,
                end_x: 100.0,
                end_y: 100.0,
            },
            color: "#00ff00".to_string(),
            style: SerializedStyle::default(),
        };

        let annotation = sidecar_to_annotation(&serialized).unwrap();
        assert!(matches!(
            annotation.annotation_type,
            AnnotationType::Arrow { .. }
        ));
    }

    #[test]
    fn test_annotation_to_sidecar_roundtrip() {
        let original = Annotation::new(AnnotationType::Box {
            region: Region::new(10.0, 20.0, 100.0, 50.0),
            stroke_width: 2.0,
            stroke_style: StrokeStyle::Solid,
            filled: false,
            corner_radius: 0.0,
        })
        .with_color(Color::RED);

        let serialized = annotation_to_sidecar(&original);
        let restored = sidecar_to_annotation(&serialized).unwrap();

        // Check type matches
        assert!(matches!(
            restored.annotation_type,
            AnnotationType::Box { .. }
        ));

        // Check color matches
        assert_eq!(restored.color.r, original.color.r);
        assert_eq!(restored.color.g, original.color.g);
        assert_eq!(restored.color.b, original.color.b);
    }

    #[test]
    fn test_parse_hex_color() {
        // RGB format
        let color = parse_hex_color("#ff0000");
        assert_eq!(color.r, 255);
        assert_eq!(color.g, 0);
        assert_eq!(color.b, 0);
        assert_eq!(color.a, 255);

        // RGBA format
        let color = parse_hex_color("#00ff0080");
        assert_eq!(color.r, 0);
        assert_eq!(color.g, 255);
        assert_eq!(color.b, 0);
        assert_eq!(color.a, 128);
    }

    #[test]
    fn test_format_color_hex() {
        // Opaque color
        let color = Color::rgb(255, 128, 0);
        assert_eq!(format_color_hex(&color), "#ff8000");

        // Semi-transparent color
        let color = Color::rgba(255, 128, 0, 200);
        assert_eq!(format_color_hex(&color), "#ff8000c8");
    }
}
