//! Tool system for annotation editing
//!
//! This module provides a trait-based abstraction for annotation tools,
//! enabling composable, testable tool implementations.

mod arrow;
mod blur;
mod context;
mod crop;
mod ellipse;
mod eraser;
mod highlight;
mod image_tool;
mod line;
mod manager;
mod number;
mod pencil;
mod rectangle;
mod select;
mod state;
mod sticky;
mod text;
mod r#trait;

#[cfg(test)]
mod tests;

pub use arrow::*;
pub use blur::*;
pub use context::*;
pub use crop::*;
pub use ellipse::*;
pub use eraser::*;
pub use image_tool::*;
pub use highlight::*;
pub use line::*;
pub use manager::*;
pub use number::*;
pub use pencil::*;
pub use rectangle::*;
pub use select::*;
pub use state::*;
pub use sticky::*;
pub use text::*;
pub use r#trait::*;

use nib_core::{Annotation, AnnotationId, Color, Point, Region};

/// Events that tools can receive
#[derive(Debug, Clone)]
pub enum ToolEvent {
    /// Mouse button pressed (image coordinates)
    MouseDown {
        position: Point,
        button: MouseButton,
        modifiers: Modifiers,
    },
    /// Mouse moved while button may be held (image coordinates)
    MouseMove {
        position: Point,
        modifiers: Modifiers,
    },
    /// Mouse button released (image coordinates)
    MouseUp {
        position: Point,
        button: MouseButton,
    },
    /// Key pressed while tool is active
    KeyDown {
        key: String,
        key_char: Option<char>,
        modifiers: Modifiers,
    },
    /// Tool was activated (switched to)
    Activated,
    /// Tool is being deactivated (switching away)
    Deactivated,
}

/// Modifier keys state
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub cmd: bool,
}

/// Mouse button identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// What the tool produces after handling an event
#[derive(Debug)]
pub enum ToolResult {
    /// No action taken
    Ignored,

    /// Tool handled the event, UI should refresh
    Handled,

    /// Tool created a new annotation
    Created(Annotation),

    /// Tool created a new Image annotation that references an out-of-band
    /// asset; the asset's bytes must be registered (e.g. into EditorView's
    /// asset cache) before/alongside pushing the annotation, since an
    /// `Annotation` only ever carries the asset's content-hash reference.
    CreatedWithAsset {
        annotation: Annotation,
        asset_hash: String,
        asset: nib_core::AssetData,
    },

    /// Tool updated an existing annotation
    Updated(AnnotationId),

    /// Tool updated a text annotation with new content
    UpdatedText(AnnotationId, String),

    /// Tool deleted an annotation
    Deleted(AnnotationId),

    /// Tool wants to enter a special mode (e.g., text input)
    EnterMode(ToolMode),

    /// Tool wants to exit current mode
    ExitMode,

    /// Tool produced multiple results (batch operations)
    Batch(Vec<ToolResult>),

    /// Tool moved annotations by delta
    Moved {
        ids: Vec<AnnotationId>,
        delta_x: f64,
        delta_y: f64,
    },

    /// Tool resized an annotation
    Resized {
        id: AnnotationId,
        new_bounds: Region,
    },
}

/// Special modes tools can request
#[derive(Debug, Clone)]
pub enum ToolMode {
    /// Text input mode with initial state
    TextInput {
        position: Point,
        initial_content: String,
        editing_annotation_id: Option<AnnotationId>,
        /// Set by the Sticky tool to make the resulting Text annotation carry a
        /// background/max_width (a "sticky note") instead of the plain default.
        /// `None` for ordinary Text tool usage.
        sticky_style: Option<StickyStyle>,
    },
}

/// Background/text color and wrap width for a sticky note, carried through
/// `ToolMode::TextInput` so EditorView can seed the shared text-edit flow
/// (see `TextTool::begin_sticky`) instead of duplicating it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StickyStyle {
    pub background: Color,
    pub text_color: Color,
    pub max_width: f64,
}

/// Renderable preview during tool operation
#[derive(Debug, Clone)]
pub enum ToolPreview {
    /// No preview
    None,
    /// Rectangle outline
    Rectangle { region: Region, color: Color },
    /// Line between two points
    Line { start: Point, end: Point, color: Color },
    /// Ellipse outline
    Ellipse {
        center: Point,
        radius_x: f64,
        radius_y: f64,
        color: Color,
    },
    /// Selection bounds with optional resize handles
    Selection {
        /// Bounding regions of selected annotations
        bounds: Vec<Region>,
        /// Handle positions (point in image coords and handle type)
        handles: Option<Vec<(Point, HandlePosition)>>,
    },
    /// Marquee selection rectangle (for drag-to-select)
    Marquee { region: Region },
    /// Freeform path (pencil drawing)
    Path {
        points: Vec<Point>,
        color: Color,
        stroke_width: f64,
    },
}
