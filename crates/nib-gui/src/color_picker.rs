//! Color selection widget

use nib_core::Color;

/// Predefined color palette
pub const COLOR_PALETTE: &[Color] = &[
    Color::RED,
    Color::rgb(249, 115, 22), // Orange
    Color::YELLOW,
    Color::GREEN,
    Color::BLUE,
    Color::rgb(139, 92, 246), // Purple
    Color::rgb(236, 72, 153), // Pink
    Color::WHITE,
    Color::rgb(156, 163, 175), // Gray
    Color::BLACK,
];

/// Color picker state
pub struct ColorPicker {
    /// Currently selected color
    pub selected: Color,
    /// Whether picker popup is open
    pub is_open: bool,
    /// Recent colors used
    pub recent: Vec<Color>,
}

impl ColorPicker {
    pub fn new() -> Self {
        Self {
            selected: Color::RED,
            is_open: false,
            recent: Vec::new(),
        }
    }

    pub fn select(&mut self, color: Color) {
        self.selected = color;
        self.add_to_recent(color);
        self.is_open = false;
    }

    fn add_to_recent(&mut self, color: Color) {
        // Remove if already in recent
        self.recent.retain(|&c| c != color);
        // Add to front
        self.recent.insert(0, color);
        // Limit size
        self.recent.truncate(5);
    }

    pub fn toggle(&mut self) {
        self.is_open = !self.is_open;
    }
}

impl Default for ColorPicker {
    fn default() -> Self {
        Self::new()
    }
}
