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
    /// Style fields not covered by `geometry`/`color`. Optional and flattened so
    /// old sidecar files (written before this field existed) still deserialize:
    /// every field defaults to `None`, and `deserialize_annotation` falls back to
    /// the same hardcoded defaults it always used.
    #[serde(flatten, default, skip_serializing_if = "SerializedStyle::is_empty")]
    pub style: SerializedStyle,
}

/// Optional style block carrying the annotation-model fields that used to be
/// silently dropped by the sidecar format (stroke width/style, fill, arrowhead,
/// font size, blur intensity, text background/wrap, opacity). Every field is
/// `Option` so unset fields are omitted from JSON and old files parse cleanly.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SerializedStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corner_radius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intensity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

impl SerializedStyle {
    fn is_empty(&self) -> bool {
        *self == SerializedStyle::default()
    }
}

fn stroke_style_to_str(style: StrokeStyle) -> String {
    match style {
        StrokeStyle::Solid => "solid",
        StrokeStyle::Dashed => "dashed",
        StrokeStyle::Dotted => "dotted",
    }
    .to_string()
}

fn stroke_style_from_str(s: &str) -> StrokeStyle {
    match s {
        "dashed" => StrokeStyle::Dashed,
        "dotted" => StrokeStyle::Dotted,
        _ => StrokeStyle::Solid,
    }
}

fn arrow_head_to_str(head: ArrowHead) -> String {
    match head {
        ArrowHead::End => "end",
        ArrowHead::Start => "start",
        ArrowHead::Both => "both",
        ArrowHead::None => "none",
    }
    .to_string()
}

fn arrow_head_from_str(s: &str) -> ArrowHead {
    match s {
        "start" => ArrowHead::Start,
        "both" => ArrowHead::Both,
        "none" => ArrowHead::None,
        _ => ArrowHead::End,
    }
}

fn blur_intensity_to_str(intensity: BlurIntensity) -> String {
    match intensity {
        BlurIntensity::Light => "light",
        BlurIntensity::Medium => "medium",
        BlurIntensity::Heavy => "heavy",
        BlurIntensity::Pixelate => "pixelate",
    }
    .to_string()
}

fn blur_intensity_from_str(s: &str) -> BlurIntensity {
    match s {
        "light" => BlurIntensity::Light,
        "heavy" => BlurIntensity::Heavy,
        "pixelate" => BlurIntensity::Pixelate,
        _ => BlurIntensity::Medium,
    }
}

fn text_align_to_str(align: TextAlign) -> String {
    match align {
        TextAlign::Left => "left",
        TextAlign::Center => "center",
        TextAlign::Right => "right",
    }
    .to_string()
}

fn text_align_from_str(s: &str) -> TextAlign {
    match s {
        "center" => TextAlign::Center,
        "right" => TextAlign::Right,
        _ => TextAlign::Left,
    }
}

/// Build the style block for an annotation: populates only the fields that
/// apply to its variant, plus opacity whenever the color isn't fully opaque.
fn serialize_style(annotation: &Annotation) -> SerializedStyle {
    let mut style = SerializedStyle::default();

    if annotation.color.a != 255 {
        style.opacity = Some(annotation.color.a as f64 / 255.0);
    }

    match &annotation.annotation_type {
        AnnotationType::Box { stroke_width, stroke_style, filled, corner_radius, .. } => {
            style.stroke_width = Some(*stroke_width);
            style.stroke_style = Some(stroke_style_to_str(*stroke_style));
            style.filled = Some(*filled);
            style.corner_radius = Some(*corner_radius);
        }
        AnnotationType::Arrow { head, stroke_width, .. } => {
            style.stroke_width = Some(*stroke_width);
            style.head = Some(arrow_head_to_str(*head));
        }
        AnnotationType::Line { stroke_width, stroke_style, .. } => {
            style.stroke_width = Some(*stroke_width);
            style.stroke_style = Some(stroke_style_to_str(*stroke_style));
        }
        AnnotationType::Ellipse { stroke_width, filled, .. } => {
            style.stroke_width = Some(*stroke_width);
            style.filled = Some(*filled);
        }
        AnnotationType::Path { stroke_width, stroke_style, .. } => {
            style.stroke_width = Some(*stroke_width);
            style.stroke_style = Some(stroke_style_to_str(*stroke_style));
        }
        AnnotationType::Text { font_size, align, background, max_width, .. } => {
            style.font_size = Some(*font_size);
            style.align = Some(text_align_to_str(*align));
            style.background = background.as_ref().map(color_to_hex);
            style.max_width = *max_width;
        }
        AnnotationType::Blur { intensity, .. } => {
            style.intensity = Some(blur_intensity_to_str(*intensity));
        }
        AnnotationType::Highlight { corner_radius, .. } => {
            style.corner_radius = Some(*corner_radius);
        }
        AnnotationType::Number { .. } | AnnotationType::Crop { .. } => {}
    }

    style
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
        style: serialize_style(annotation),
    }
}

/// Convert a SerializedAnnotation back to Annotation
pub fn deserialize_annotation(serialized: &SerializedAnnotation) -> Option<Annotation> {
    let mut color = hex_to_color(&serialized.color);
    let style = &serialized.style;

    let annotation_type = match (serialized.annotation_type.as_str(), &serialized.geometry) {
        ("rectangle", AnnotationGeometry::Rectangle { x, y, width, height }) => {
            AnnotationType::Box {
                region: Region::new(*x, *y, *width, *height),
                stroke_width: style.stroke_width.unwrap_or(2.0),
                stroke_style: style.stroke_style.as_deref().map(stroke_style_from_str).unwrap_or(StrokeStyle::Solid),
                filled: style.filled.unwrap_or(false),
                corner_radius: style.corner_radius.unwrap_or(0.0),
            }
        }
        ("arrow", AnnotationGeometry::Line { start_x, start_y, end_x, end_y }) => {
            AnnotationType::Arrow {
                start: NibPoint::new(*start_x, *start_y),
                end: NibPoint::new(*end_x, *end_y),
                head: style.head.as_deref().map(arrow_head_from_str).unwrap_or(ArrowHead::End),
                stroke_width: style.stroke_width.unwrap_or(2.0),
            }
        }
        ("line", AnnotationGeometry::Line { start_x, start_y, end_x, end_y }) => {
            AnnotationType::Line {
                start: NibPoint::new(*start_x, *start_y),
                end: NibPoint::new(*end_x, *end_y),
                stroke_width: style.stroke_width.unwrap_or(2.0),
                stroke_style: style.stroke_style.as_deref().map(stroke_style_from_str).unwrap_or(StrokeStyle::Solid),
            }
        }
        ("ellipse", AnnotationGeometry::Ellipse { center_x, center_y, radius_x, radius_y }) => {
            AnnotationType::Ellipse {
                center: NibPoint::new(*center_x, *center_y),
                radius_x: *radius_x,
                radius_y: *radius_y,
                stroke_width: style.stroke_width.unwrap_or(2.0),
                filled: style.filled.unwrap_or(false),
            }
        }
        ("highlight", AnnotationGeometry::Rectangle { x, y, width, height }) => {
            AnnotationType::Highlight {
                region: Region::new(*x, *y, *width, *height),
                corner_radius: style.corner_radius.unwrap_or(0.0),
            }
        }
        ("blur", AnnotationGeometry::Rectangle { x, y, width, height }) => {
            AnnotationType::Blur {
                region: Region::new(*x, *y, *width, *height),
                intensity: style.intensity.as_deref().map(blur_intensity_from_str).unwrap_or(BlurIntensity::Medium),
            }
        }
        ("text", AnnotationGeometry::Point { x, y, content, .. }) => {
            AnnotationType::Text {
                position: NibPoint::new(*x, *y),
                content: content.clone().unwrap_or_else(|| "Text".to_string()),
                font_size: style.font_size.unwrap_or(16.0),
                align: style.align.as_deref().map(text_align_from_str).unwrap_or(TextAlign::Left),
                background: style.background.as_deref().map(hex_to_color),
                max_width: style.max_width,
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
                stroke_width: style.stroke_width.unwrap_or(2.0),
                stroke_style: style.stroke_style.as_deref().map(stroke_style_from_str).unwrap_or(StrokeStyle::Solid),
            }
        }
        _ => return None,
    };

    if let Some(opacity) = style.opacity {
        color.a = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip an annotation through JSON and assert every style field survives with its
    /// non-default value. Before the `SerializedStyle` block existed, `serialize_annotation`
    /// dropped all of these onto the floor and `deserialize_annotation` always reconstructed
    /// the same hardcoded defaults (stroke_width 2.0, StrokeStyle::Solid, filled false, ...),
    /// so this test failed on the pre-fix code — that's the fidelity gap Phase 1 closes.
    fn round_trip(annotation: Annotation) -> Annotation {
        let serialized = serialize_annotation(&annotation);
        let json = serde_json::to_string(&serialized).expect("serialize to json");
        let parsed: SerializedAnnotation = serde_json::from_str(&json).expect("parse json");
        deserialize_annotation(&parsed).expect("deserialize annotation")
    }

    #[test]
    fn round_trip_box_preserves_non_default_style() {
        let original = Annotation::new(AnnotationType::Box {
            region: Region::new(1.0, 2.0, 3.0, 4.0),
            stroke_width: 8.0,
            stroke_style: StrokeStyle::Dashed,
            filled: true,
            corner_radius: 12.0,
        })
        .with_color(Color::rgba(10, 20, 30, 128));

        let restored = round_trip(original);
        match restored.annotation_type {
            AnnotationType::Box { stroke_width, stroke_style, filled, corner_radius, .. } => {
                assert_eq!(stroke_width, 8.0);
                assert_eq!(stroke_style, StrokeStyle::Dashed);
                assert!(filled);
                assert_eq!(corner_radius, 12.0);
            }
            other => panic!("expected Box, got {other:?}"),
        }
        assert_eq!(restored.color.a, 128, "opacity (alpha) must survive the round trip");
    }

    #[test]
    fn round_trip_arrow_preserves_non_default_style() {
        let original = Annotation::new(AnnotationType::Arrow {
            start: NibPoint::new(0.0, 0.0),
            end: NibPoint::new(10.0, 10.0),
            head: ArrowHead::Both,
            stroke_width: 8.0,
        })
        .with_color(Color::RED);

        let restored = round_trip(original);
        match restored.annotation_type {
            AnnotationType::Arrow { head, stroke_width, .. } => {
                assert_eq!(head, ArrowHead::Both);
                assert_eq!(stroke_width, 8.0);
            }
            other => panic!("expected Arrow, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_line_preserves_non_default_style() {
        let original = Annotation::new(AnnotationType::Line {
            start: NibPoint::new(0.0, 0.0),
            end: NibPoint::new(10.0, 10.0),
            stroke_width: 4.0,
            stroke_style: StrokeStyle::Dotted,
        })
        .with_color(Color::RED);

        let restored = round_trip(original);
        match restored.annotation_type {
            AnnotationType::Line { stroke_width, stroke_style, .. } => {
                assert_eq!(stroke_width, 4.0);
                assert_eq!(stroke_style, StrokeStyle::Dotted);
            }
            other => panic!("expected Line, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_ellipse_preserves_non_default_style() {
        let original = Annotation::new(AnnotationType::Ellipse {
            center: NibPoint::new(5.0, 5.0),
            radius_x: 3.0,
            radius_y: 4.0,
            stroke_width: 8.0,
            filled: true,
        })
        .with_color(Color::RED);

        let restored = round_trip(original);
        match restored.annotation_type {
            AnnotationType::Ellipse { stroke_width, filled, .. } => {
                assert_eq!(stroke_width, 8.0);
                assert!(filled);
            }
            other => panic!("expected Ellipse, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_path_preserves_non_default_style() {
        let original = Annotation::new(AnnotationType::Path {
            points: vec![NibPoint::new(0.0, 0.0), NibPoint::new(1.0, 1.0)],
            stroke_width: 8.0,
            stroke_style: StrokeStyle::Dashed,
        })
        .with_color(Color::RED);

        let restored = round_trip(original);
        match restored.annotation_type {
            AnnotationType::Path { stroke_width, stroke_style, .. } => {
                assert_eq!(stroke_width, 8.0);
                assert_eq!(stroke_style, StrokeStyle::Dashed);
            }
            other => panic!("expected Path, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_text_preserves_non_default_style() {
        let original = Annotation::new(AnnotationType::Text {
            position: NibPoint::new(0.0, 0.0),
            content: "hello".to_string(),
            font_size: 24.0,
            align: TextAlign::Center,
            background: Some(Color::rgb(1, 2, 3)),
            max_width: Some(200.0),
        })
        .with_color(Color::RED);

        let restored = round_trip(original);
        match restored.annotation_type {
            AnnotationType::Text { font_size, align, background, max_width, .. } => {
                assert_eq!(font_size, 24.0);
                assert_eq!(align, TextAlign::Center);
                assert_eq!(background, Some(Color::rgb(1, 2, 3)));
                assert_eq!(max_width, Some(200.0));
            }
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_blur_preserves_non_default_style() {
        let original = Annotation::new(AnnotationType::Blur {
            region: Region::new(0.0, 0.0, 10.0, 10.0),
            intensity: BlurIntensity::Heavy,
        })
        .with_color(Color::RED);

        let restored = round_trip(original);
        match restored.annotation_type {
            AnnotationType::Blur { intensity, .. } => {
                assert_eq!(intensity, BlurIntensity::Heavy);
            }
            other => panic!("expected Blur, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_highlight_preserves_non_default_style() {
        let original = Annotation::new(AnnotationType::Highlight {
            region: Region::new(0.0, 0.0, 10.0, 10.0),
            corner_radius: 6.0,
        })
        .with_color(Color::RED);

        let restored = round_trip(original);
        match restored.annotation_type {
            AnnotationType::Highlight { corner_radius, .. } => {
                assert_eq!(corner_radius, 6.0);
            }
            other => panic!("expected Highlight, got {other:?}"),
        }
    }

    /// A sidecar JSON file written before `SerializedStyle` existed (no style fields at all)
    /// must still parse, and every field must fall back to the same hardcoded defaults that
    /// `deserialize_annotation` always used.
    #[test]
    fn old_format_fixture_without_style_block_deserializes_to_defaults() {
        let json = r##"{
            "id": "a1",
            "type": "rectangle",
            "x": 1.0,
            "y": 2.0,
            "width": 3.0,
            "height": 4.0,
            "color": "#ff0000"
        }"##;
        let parsed: SerializedAnnotation = serde_json::from_str(json).expect("parse old fixture");
        let annotation = deserialize_annotation(&parsed).expect("deserialize");
        match annotation.annotation_type {
            AnnotationType::Box { stroke_width, stroke_style, filled, corner_radius, .. } => {
                assert_eq!(stroke_width, 2.0);
                assert_eq!(stroke_style, StrokeStyle::Solid);
                assert!(!filled);
                assert_eq!(corner_radius, 0.0);
            }
            other => panic!("expected Box, got {other:?}"),
        }
        assert_eq!(annotation.color.a, 255, "opacity defaults to fully opaque");
    }

    #[test]
    fn dash_helper_pure_test_lives_in_nib_core_and_is_reused() {
        // nib-serde doesn't render, but this documents where the pure dash_segments()
        // helper actually lives (nib-core) so both nib-gui and nib-storage share it.
        let segments = nib_core::dash_segments(
            NibPoint::new(0.0, 0.0),
            NibPoint::new(10.0, 0.0),
            StrokeStyle::Solid,
            2.0,
        );
        assert_eq!(segments.len(), 1);
    }
}
