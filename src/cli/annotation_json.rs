//! JSON annotation parser for Claude feedback loop
//!
//! Provides a simplified JSON schema for specifying annotations from the CLI.
//! Converts to the internal AnnotationData format used by the collab system.

use serde::{Deserialize, Serialize};

use crate::collab::types::{AnnotationData, AnnotationTypeData};

/// Simplified annotation input format for JSON parsing
///
/// This is a user-friendly schema that gets converted to the internal AnnotationData format.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AnnotationInput {
    /// Arrow annotation with start and end points
    Arrow {
        from: [f64; 2],
        to: [f64; 2],
        #[serde(default)]
        color: Option<String>,
    },

    /// Rectangle annotation
    Rectangle {
        at: [f64; 2],
        size: [f64; 2],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        filled: Option<bool>,
    },

    /// Highlight annotation (semi-transparent rectangle)
    Highlight {
        at: [f64; 2],
        size: [f64; 2],
        #[serde(default)]
        color: Option<String>,
    },

    /// Text annotation
    Text {
        at: [f64; 2],
        content: String,
        #[serde(default)]
        color: Option<String>,
    },

    /// Number callout annotation
    Number {
        at: [f64; 2],
        value: u32,
        #[serde(default)]
        color: Option<String>,
    },

    /// Ellipse annotation
    Ellipse {
        center: [f64; 2],
        radius: [f64; 2],
        #[serde(default)]
        color: Option<String>,
        #[serde(default)]
        filled: Option<bool>,
    },

    /// Line annotation
    Line {
        from: [f64; 2],
        to: [f64; 2],
        #[serde(default)]
        color: Option<String>,
    },

    /// Blur annotation (obscures a region)
    Blur {
        at: [f64; 2],
        size: [f64; 2],
    },
}

impl AnnotationInput {
    /// Convert to internal AnnotationData format
    pub fn to_annotation_data(&self) -> AnnotationData {
        let (annotation_type, color) = match self {
            AnnotationInput::Arrow { from, to, color } => {
                let type_data = AnnotationTypeData::Arrow {
                    start_x: from[0],
                    start_y: from[1],
                    end_x: to[0],
                    end_y: to[1],
                    head: "end".to_string(),
                    stroke_width: 2.0,
                };
                (type_data, color.clone())
            }

            AnnotationInput::Rectangle { at, size, color, filled } => {
                let type_data = AnnotationTypeData::Box {
                    x: at[0],
                    y: at[1],
                    width: size[0],
                    height: size[1],
                    stroke_width: 2.0,
                    stroke_style: "solid".to_string(),
                    filled: filled.unwrap_or(false),
                    corner_radius: 0.0,
                };
                (type_data, color.clone())
            }

            AnnotationInput::Highlight { at, size, color } => {
                let type_data = AnnotationTypeData::Highlight {
                    x: at[0],
                    y: at[1],
                    width: size[0],
                    height: size[1],
                    corner_radius: 0.0,
                };
                (type_data, color.clone())
            }

            AnnotationInput::Text { at, content, color } => {
                let type_data = AnnotationTypeData::Text {
                    x: at[0],
                    y: at[1],
                    content: content.clone(),
                    font_size: 16.0,
                    align: "left".to_string(),
                    background: None,
                    max_width: None,
                };
                (type_data, color.clone())
            }

            AnnotationInput::Number { at, value, color } => {
                let type_data = AnnotationTypeData::Number {
                    x: at[0],
                    y: at[1],
                    value: *value,
                    radius: 16.0,
                };
                (type_data, color.clone())
            }

            AnnotationInput::Ellipse { center, radius, color, filled } => {
                let type_data = AnnotationTypeData::Ellipse {
                    center_x: center[0],
                    center_y: center[1],
                    radius_x: radius[0],
                    radius_y: radius[1],
                    stroke_width: 2.0,
                    filled: filled.unwrap_or(false),
                };
                (type_data, color.clone())
            }

            AnnotationInput::Line { from, to, color } => {
                let type_data = AnnotationTypeData::Line {
                    start_x: from[0],
                    start_y: from[1],
                    end_x: to[0],
                    end_y: to[1],
                    stroke_width: 2.0,
                    stroke_style: "solid".to_string(),
                };
                (type_data, color.clone())
            }

            AnnotationInput::Blur { at, size } => {
                let type_data = AnnotationTypeData::Blur {
                    x: at[0],
                    y: at[1],
                    width: size[0],
                    height: size[1],
                    intensity: "medium".to_string(),
                };
                (type_data, None)
            }
        };

        // Parse color or use default red
        let color_rgba = parse_color(&color.unwrap_or_else(|| "#ff0000".to_string()));

        AnnotationData {
            annotation_type,
            color: color_rgba,
            severity: "none".to_string(),
            label: None,
            z_index: 0,
            owner: "claude".to_string(), // CLI annotations are from Claude
            group_id: None,
        }
    }
}

/// Parse a JSON array of annotations
pub fn parse_annotations(json: &str) -> Result<Vec<AnnotationInput>, String> {
    serde_json::from_str(json).map_err(|e| format!("Failed to parse annotations JSON: {}", e))
}

/// Parse a hex color string (e.g., "#ff0000" or "#ff0000ff") into RGBA array
fn parse_color(hex: &str) -> [u8; 4] {
    let hex = hex.trim_start_matches('#');
    if hex.len() == 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
        [r, g, b, 255]
    } else if hex.len() == 8 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
        let a = u8::from_str_radix(&hex[6..8], 16).unwrap_or(255);
        [r, g, b, a]
    } else {
        [255, 0, 0, 255] // Default red
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_arrow() {
        let json = r#"[{"type":"arrow","from":[100,100],"to":[200,200]}]"#;
        let annotations = parse_annotations(json).unwrap();
        assert_eq!(annotations.len(), 1);

        match &annotations[0] {
            AnnotationInput::Arrow { from, to, color } => {
                assert_eq!(from, &[100.0, 100.0]);
                assert_eq!(to, &[200.0, 200.0]);
                assert!(color.is_none());
            }
            _ => panic!("Expected Arrow annotation"),
        }
    }

    #[test]
    fn test_parse_rectangle_with_color() {
        let json = r##"[{"type":"rectangle","at":[50,50],"size":[100,80],"color":"#00ff00"}]"##;
        let annotations = parse_annotations(json).unwrap();
        assert_eq!(annotations.len(), 1);

        match &annotations[0] {
            AnnotationInput::Rectangle { at, size, color, filled } => {
                assert_eq!(at, &[50.0, 50.0]);
                assert_eq!(size, &[100.0, 80.0]);
                assert_eq!(color.as_deref(), Some("#00ff00"));
                assert!(filled.is_none());
            }
            _ => panic!("Expected Rectangle annotation"),
        }
    }

    #[test]
    fn test_parse_text() {
        let json = r#"[{"type":"text","at":[10,20],"content":"Hello World"}]"#;
        let annotations = parse_annotations(json).unwrap();
        assert_eq!(annotations.len(), 1);

        match &annotations[0] {
            AnnotationInput::Text { at, content, color } => {
                assert_eq!(at, &[10.0, 20.0]);
                assert_eq!(content, "Hello World");
                assert!(color.is_none());
            }
            _ => panic!("Expected Text annotation"),
        }
    }

    #[test]
    fn test_parse_number() {
        let json = r#"[{"type":"number","at":[150,150],"value":3}]"#;
        let annotations = parse_annotations(json).unwrap();
        assert_eq!(annotations.len(), 1);

        match &annotations[0] {
            AnnotationInput::Number { at, value, color } => {
                assert_eq!(at, &[150.0, 150.0]);
                assert_eq!(*value, 3);
                assert!(color.is_none());
            }
            _ => panic!("Expected Number annotation"),
        }
    }

    #[test]
    fn test_parse_multiple() {
        let json = r##"[
            {"type":"arrow","from":[0,0],"to":[100,100]},
            {"type":"rectangle","at":[200,200],"size":[50,50]},
            {"type":"highlight","at":[300,300],"size":[100,30],"color":"#ffff00"}
        ]"##;
        let annotations = parse_annotations(json).unwrap();
        assert_eq!(annotations.len(), 3);
    }

    #[test]
    fn test_to_annotation_data() {
        let input = AnnotationInput::Arrow {
            from: [10.0, 20.0],
            to: [100.0, 200.0],
            color: Some("#0000ff".to_string()),
        };

        let data = input.to_annotation_data();
        match data.annotation_type {
            AnnotationTypeData::Arrow { start_x, start_y, end_x, end_y, .. } => {
                assert_eq!(start_x, 10.0);
                assert_eq!(start_y, 20.0);
                assert_eq!(end_x, 100.0);
                assert_eq!(end_y, 200.0);
            }
            _ => panic!("Expected Arrow type"),
        }
        assert_eq!(data.color, [0, 0, 255, 255]);
    }

    #[test]
    fn test_parse_color() {
        assert_eq!(super::parse_color("#ff0000"), [255, 0, 0, 255]);
        assert_eq!(super::parse_color("#00ff00"), [0, 255, 0, 255]);
        assert_eq!(super::parse_color("#0000ff"), [0, 0, 255, 255]);
        assert_eq!(super::parse_color("#ff000080"), [255, 0, 0, 128]);
        assert_eq!(super::parse_color("ff0000"), [255, 0, 0, 255]); // Without #
    }

    #[test]
    fn test_parse_blur() {
        let json = r#"[{"type":"blur","at":[100,100],"size":[200,150]}]"#;
        let annotations = parse_annotations(json).unwrap();
        assert_eq!(annotations.len(), 1);

        match &annotations[0] {
            AnnotationInput::Blur { at, size } => {
                assert_eq!(at, &[100.0, 100.0]);
                assert_eq!(size, &[200.0, 150.0]);
            }
            _ => panic!("Expected Blur annotation"),
        }
    }

    #[test]
    fn test_parse_ellipse() {
        let json = r#"[{"type":"ellipse","center":[100,100],"radius":[50,30],"filled":true}]"#;
        let annotations = parse_annotations(json).unwrap();
        assert_eq!(annotations.len(), 1);

        match &annotations[0] {
            AnnotationInput::Ellipse { center, radius, color, filled } => {
                assert_eq!(center, &[100.0, 100.0]);
                assert_eq!(radius, &[50.0, 30.0]);
                assert!(color.is_none());
                assert_eq!(*filled, Some(true));
            }
            _ => panic!("Expected Ellipse annotation"),
        }
    }

    #[test]
    fn test_invalid_json() {
        let json = r#"not valid json"#;
        let result = parse_annotations(json);
        assert!(result.is_err());
    }
}
