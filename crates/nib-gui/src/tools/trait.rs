//! Core Tool trait definition

use super::{ToolContext, ToolEvent, ToolPreview, ToolResult};
use std::any::Any;

/// Tool identifier enum
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ToolId {
    #[default]
    Select,
    Arrow,
    Rectangle,
    Ellipse,
    Text,
    Number,
    Blur,
    Highlight,
    Line,
    Crop,
    Pencil,
    Eraser,
    Sticky,
    Image,
}

impl ToolId {
    /// Get all available tool IDs
    pub fn all() -> &'static [ToolId] {
        &[
            ToolId::Select,
            ToolId::Arrow,
            ToolId::Rectangle,
            ToolId::Ellipse,
            ToolId::Text,
            ToolId::Number,
            ToolId::Blur,
            ToolId::Highlight,
            ToolId::Line,
            ToolId::Crop,
            ToolId::Pencil,
            ToolId::Eraser,
            ToolId::Sticky,
            ToolId::Image,
        ]
    }

    /// Returns the display name
    pub fn name(&self) -> &'static str {
        match self {
            ToolId::Select => "Select",
            ToolId::Arrow => "Arrow",
            ToolId::Rectangle => "Rectangle",
            ToolId::Ellipse => "Ellipse",
            ToolId::Text => "Text",
            ToolId::Number => "Number",
            ToolId::Blur => "Blur",
            ToolId::Highlight => "Highlight",
            ToolId::Line => "Line",
            ToolId::Crop => "Crop",
            ToolId::Pencil => "Pencil",
            ToolId::Eraser => "Eraser",
            ToolId::Sticky => "Sticky",
            ToolId::Image => "Image",
        }
    }

    /// Returns the keyboard shortcut
    pub fn shortcut(&self) -> char {
        match self {
            ToolId::Select => 'v',
            ToolId::Arrow => 'a',
            ToolId::Rectangle => 'r',
            ToolId::Ellipse => 'e',
            ToolId::Text => 't',
            ToolId::Number => 'n',
            ToolId::Blur => 'b',
            ToolId::Highlight => 'h',
            ToolId::Line => 'l',
            ToolId::Crop => 'c',
            ToolId::Pencil => 'p',
            ToolId::Eraser => 'x',
            ToolId::Sticky => 'k',
            ToolId::Image => 'i',
        }
    }

    /// Returns the icon file path for this tool (Lucide icons, ISC license)
    pub fn icon_path(&self) -> &'static str {
        match self {
            ToolId::Select => "assets/icons/select.svg",
            ToolId::Arrow => "assets/icons/arrow.svg",
            ToolId::Rectangle => "assets/icons/rectangle.svg",
            ToolId::Ellipse => "assets/icons/ellipse.svg",
            ToolId::Text => "assets/icons/text.svg",
            ToolId::Number => "assets/icons/number.svg",
            ToolId::Blur => "assets/icons/blur.svg",
            ToolId::Highlight => "assets/icons/highlight.svg",
            ToolId::Line => "assets/icons/line.svg",
            ToolId::Crop => "assets/icons/crop.svg",
            ToolId::Pencil => "assets/icons/pencil.svg",
            ToolId::Eraser => "assets/icons/eraser.svg",
            ToolId::Sticky => "assets/icons/sticky.svg",
            ToolId::Image => "assets/icons/image.svg",
        }
    }
}

/// Core trait for all annotation tools
pub trait Tool: Send + Sync {
    /// Unique identifier for this tool type
    fn id(&self) -> ToolId;

    /// Display name for UI
    fn name(&self) -> &'static str;

    /// Keyboard shortcut character
    fn shortcut(&self) -> char;

    /// Icon asset path
    fn icon_path(&self) -> &'static str;

    /// Handle an input event
    /// Returns what action the tool took (if any)
    fn handle_event(&mut self, event: ToolEvent, ctx: &ToolContext) -> ToolResult;

    /// Get current preview element (for in-progress operations)
    /// Called during render to show drag previews, cursor hints, etc.
    fn preview(&self, ctx: &ToolContext) -> ToolPreview;

    /// Reset tool to initial state
    /// Called when switching away or after completing an action
    fn reset(&mut self);

    /// Whether tool is currently in an active operation (dragging, typing, etc.)
    fn is_active(&self) -> bool;

    /// Access internal state (for special handling like text input)
    fn as_any(&self) -> &dyn Any;

    /// Access internal state mutably
    fn as_any_mut(&mut self) -> &mut dyn Any;
}
