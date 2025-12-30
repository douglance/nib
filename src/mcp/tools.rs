//! MCP tool request/response types for Nib annotation tools

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Request to add an annotation to an image
#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddAnnotationRequest {
    /// Path to the image file
    #[schemars(description = "Absolute path to the image file")]
    pub image_path: String,

    /// Type of annotation: arrow, rectangle, text, number, ellipse, line, highlight, blur
    #[schemars(description = "Type of annotation: arrow, rectangle, text, number, ellipse, line, highlight, blur")]
    pub annotation_type: String,

    /// X coordinate (pixels from left)
    #[schemars(description = "X coordinate in pixels from left edge")]
    pub x: f64,

    /// Y coordinate (pixels from top)
    #[schemars(description = "Y coordinate in pixels from top edge")]
    pub y: f64,

    /// Width (for rectangle, ellipse, highlight, blur)
    #[schemars(description = "Width in pixels (for rectangle, ellipse, highlight, blur)")]
    pub width: Option<f64>,

    /// Height (for rectangle, ellipse, highlight, blur)
    #[schemars(description = "Height in pixels (for rectangle, ellipse, highlight, blur)")]
    pub height: Option<f64>,

    /// End X coordinate (for arrow, line)
    #[schemars(description = "End X coordinate for arrow/line annotations")]
    pub end_x: Option<f64>,

    /// End Y coordinate (for arrow, line)
    #[schemars(description = "End Y coordinate for arrow/line annotations")]
    pub end_y: Option<f64>,

    /// Text content (for text annotation)
    #[schemars(description = "Text content for text annotations")]
    pub text: Option<String>,

    /// Number value (for number annotation)
    #[schemars(description = "Number value for numbered callouts (1-99)")]
    pub number: Option<u32>,

    /// Color in hex format (e.g., "#ff0000" for red)
    #[schemars(description = "Color in hex format, e.g. '#ff0000' for red, '#00ff0080' with alpha")]
    pub color: Option<String>,

    /// Stroke width in pixels
    #[schemars(description = "Stroke width in pixels (default: 3.0)")]
    pub stroke_width: Option<f64>,

    /// Font size for text (default: 24)
    #[schemars(description = "Font size for text annotations (default: 24)")]
    pub font_size: Option<f64>,
}

/// Request to read annotations from an image
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadAnnotationsRequest {
    /// Path to the image file
    #[schemars(description = "Absolute path to the image file")]
    pub image_path: String,
}

/// Request to remove a specific annotation
#[derive(Debug, Deserialize, JsonSchema)]
pub struct RemoveAnnotationRequest {
    /// Path to the image file
    #[schemars(description = "Absolute path to the image file")]
    pub image_path: String,

    /// Annotation ID to remove (e.g., "a1", "a2")
    #[schemars(description = "Annotation ID to remove, e.g. 'a1', 'a2'")]
    pub annotation_id: String,
}

/// Request to clear all annotations
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClearAnnotationsRequest {
    /// Path to the image file
    #[schemars(description = "Absolute path to the image file")]
    pub image_path: String,
}

/// Request to render annotations onto image
#[derive(Debug, Deserialize, JsonSchema)]
pub struct RenderRequest {
    /// Path to the image file
    #[schemars(description = "Absolute path to the image file")]
    pub image_path: String,

    /// Output path (defaults to {stem}.rendered.{ext})
    #[schemars(description = "Output path for rendered image (optional, defaults to {stem}.rendered.{ext})")]
    pub output_path: Option<String>,
}

/// Serialized annotation for JSON output
#[derive(Debug, Serialize)]
pub struct AnnotationInfo {
    pub id: String,
    pub annotation_type: String,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub end_x: Option<f64>,
    pub end_y: Option<f64>,
    pub text: Option<String>,
    pub number: Option<u32>,
    pub color: String,
}

// ============================================================================
// Event Types for wait_for_events
// ============================================================================

/// Request to wait for annotation events
#[derive(Debug, Deserialize, JsonSchema)]
pub struct WaitForEventsRequest {
    /// Path to the image file to watch
    #[schemars(description = "Absolute path to the image file to watch for annotation changes")]
    pub image_path: String,

    /// Timeout in milliseconds (default: 30000)
    #[schemars(description = "Timeout in milliseconds. Returns empty events on timeout. Default: 30000")]
    pub timeout_ms: Option<u64>,

    /// Only return events after this sequence number
    #[schemars(description = "Only return events with sequence number greater than this value. Use the 'seq' from previous response to avoid duplicates.")]
    pub since_seq: Option<u64>,
}

/// Result of waiting for events
#[derive(Debug, Serialize)]
pub struct WaitForEventsResult {
    /// Current sequence number (pass to since_seq in next call)
    pub seq: u64,
    /// List of events that occurred
    pub events: Vec<AnnotationEvent>,
    /// Reason for returning: "events", "timeout", or "session_ended"
    pub reason: String,
}

/// An annotation event
#[derive(Debug, Clone, Serialize)]
pub struct AnnotationEvent {
    /// Event type: "annotation.created", "annotation.modified", "annotation.deleted"
    pub event_type: String,
    /// Sequence number of this event
    pub seq: u64,
    /// Annotation data (present for created/modified events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation: Option<EventAnnotation>,
    /// Annotation ID (present for deleted events)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation_id: Option<String>,
}

/// Annotation data in an event
#[derive(Debug, Clone, Serialize)]
pub struct EventAnnotation {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: String,
    /// Position as [x, y]
    pub position: [f64; 2],
    /// Size as [width, height] (for rectangles, ellipses)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<[f64; 2]>,
    /// End position as [x, y] (for arrows, lines)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_position: Option<[f64; 2]>,
    /// Text content (for text annotations)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Number value (for numbered callouts)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    /// Color in hex format
    pub color: String,
}
