//! Annotation tool toolbar

use nib_core::Color;
use crate::tools::ToolId;

/// Type alias for backward compatibility during migration
/// Use ToolId directly for new code
pub type Tool = ToolId;

/// Toolbar state
pub struct Toolbar {
    /// Currently selected tool
    pub active_tool: ToolId,
    /// Current drawing color
    pub color: Color,
    /// Current stroke width
    pub stroke_width: f64,
    /// Whether fill is enabled for shapes
    pub fill_enabled: bool,
}

impl Toolbar {
    pub fn new() -> Self {
        Self {
            active_tool: ToolId::Select,
            color: Color::RED,
            stroke_width: 2.0,
            fill_enabled: false,
        }
    }

    pub fn set_tool(&mut self, tool: ToolId) {
        self.active_tool = tool;
    }

    pub fn set_color(&mut self, color: Color) {
        self.color = color;
    }
}

impl Default for Toolbar {
    fn default() -> Self {
        Self::new()
    }
}
