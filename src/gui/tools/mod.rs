//! Tool system for annotation editing
//!
//! This module provides a trait-based abstraction for annotation tools,
//! enabling composable, testable tool implementations.

mod context;
mod manager;
mod state;
mod r#trait;

pub use context::*;
pub use manager::*;
pub use state::*;
pub use r#trait::*;

use crate::core::types::{Annotation, AnnotationId, Color, Point, Region};

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

    /// Tool updated an existing annotation
    Updated(AnnotationId),

    /// Tool deleted an annotation
    Deleted(AnnotationId),

    /// Tool wants to enter a special mode (e.g., text input)
    EnterMode(ToolMode),

    /// Tool wants to exit current mode
    ExitMode,

    /// Tool produced multiple results (batch operations)
    Batch(Vec<ToolResult>),
}

/// Special modes tools can request
#[derive(Debug, Clone)]
pub enum ToolMode {
    /// Text input mode with initial state
    TextInput {
        position: Point,
        initial_content: String,
        editing_annotation_id: Option<AnnotationId>,
    },
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
}
