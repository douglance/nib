//! Annotation tool toolbar

use crate::core::Color;

/// Available annotation tools
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Tool {
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
}

impl Tool {
    /// Returns all available tools
    pub fn all() -> &'static [Tool] {
        &[
            Tool::Select,
            Tool::Arrow,
            Tool::Rectangle,
            Tool::Ellipse,
            Tool::Text,
            Tool::Number,
            Tool::Blur,
            Tool::Highlight,
            Tool::Line,
            Tool::Crop,
        ]
    }

    /// Returns the display name
    pub fn name(&self) -> &'static str {
        match self {
            Tool::Select => "Select",
            Tool::Arrow => "Arrow",
            Tool::Rectangle => "Rectangle",
            Tool::Ellipse => "Ellipse",
            Tool::Text => "Text",
            Tool::Number => "Number",
            Tool::Blur => "Blur",
            Tool::Highlight => "Highlight",
            Tool::Line => "Line",
            Tool::Crop => "Crop",
        }
    }

    /// Returns the keyboard shortcut
    pub fn shortcut(&self) -> char {
        match self {
            Tool::Select => 'v',
            Tool::Arrow => 'a',
            Tool::Rectangle => 'r',
            Tool::Ellipse => 'e',
            Tool::Text => 't',
            Tool::Number => 'n',
            Tool::Blur => 'b',
            Tool::Highlight => 'h',
            Tool::Line => 'l',
            Tool::Crop => 'c',
        }
    }
}

/// Toolbar state
pub struct Toolbar {
    /// Currently selected tool
    pub active_tool: Tool,
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
            active_tool: Tool::Select,
            color: Color::RED,
            stroke_width: 2.0,
            fill_enabled: false,
        }
    }

    pub fn set_tool(&mut self, tool: Tool) {
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
