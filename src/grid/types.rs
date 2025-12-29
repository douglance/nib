//! Core types for the coordinate grid overlay system
//!
//! This module provides types for generating and rendering coordinate grids
//! onto images, enabling precise pixel-level positioning.

use crate::core::tile::TileBounds;
use serde::{Deserialize, Serialize};

/// Orientation of a grid line
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GridOrientation {
    /// Horizontal line (constant y, spans x-axis)
    Horizontal,
    /// Vertical line (constant x, spans y-axis)
    Vertical,
}

/// A single grid line with its coordinate value
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridLine {
    /// The coordinate value this line represents (x for vertical, y for horizontal)
    pub coordinate: f64,
    /// Whether this is horizontal or vertical
    pub orientation: GridOrientation,
    /// Start point of the line
    pub start: (f64, f64),
    /// End point of the line
    pub end: (f64, f64),
    /// Whether this is a major gridline (will be labeled)
    pub is_major: bool,
}

impl GridLine {
    /// Create a new vertical grid line at the given x coordinate
    pub fn vertical(x: f64, min_y: f64, max_y: f64, is_major: bool) -> Self {
        Self {
            coordinate: x,
            orientation: GridOrientation::Vertical,
            start: (x, min_y),
            end: (x, max_y),
            is_major,
        }
    }

    /// Create a new horizontal grid line at the given y coordinate
    pub fn horizontal(y: f64, min_x: f64, max_x: f64, is_major: bool) -> Self {
        Self {
            coordinate: y,
            orientation: GridOrientation::Horizontal,
            start: (min_x, y),
            end: (max_x, y),
            is_major,
        }
    }
}

/// Entry for R-tree spatial indexing (mirrors TileEntry pattern)
#[derive(Debug, Clone)]
pub struct GridEntry {
    /// The grid line
    pub line: GridLine,
    /// Bounding box for spatial queries
    pub bounds: TileBounds,
}

impl rstar::RTreeObject for GridEntry {
    type Envelope = rstar::AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        rstar::AABB::from_corners(
            [self.bounds.min_x, self.bounds.min_y],
            [self.bounds.max_x, self.bounds.max_y],
        )
    }
}

impl rstar::PointDistance for GridEntry {
    fn distance_2(&self, point: &[f64; 2]) -> f64 {
        use rstar::RTreeObject;
        self.envelope().distance_2(point)
    }
}

/// RGBA color for grid lines
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct GridColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl GridColor {
    pub const fn new(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    /// Semi-transparent gray (default for minor lines)
    pub const GRAY: Self = Self::new(128, 128, 128, 128);

    /// Semi-transparent red (default for major lines)
    pub const RED: Self = Self::new(255, 0, 0, 160);

    /// Parse from hex string (e.g., "#80808080" for RGBA)
    pub fn from_hex(hex: &str) -> Result<Self, String> {
        let hex = hex.trim_start_matches('#');

        if hex.len() == 6 {
            // RGB format, assume full opacity
            let r = u8::from_str_radix(&hex[0..2], 16)
                .map_err(|_| "Invalid red component")?;
            let g = u8::from_str_radix(&hex[2..4], 16)
                .map_err(|_| "Invalid green component")?;
            let b = u8::from_str_radix(&hex[4..6], 16)
                .map_err(|_| "Invalid blue component")?;
            Ok(Self::new(r, g, b, 255))
        } else if hex.len() == 8 {
            // RGBA format
            let r = u8::from_str_radix(&hex[0..2], 16)
                .map_err(|_| "Invalid red component")?;
            let g = u8::from_str_radix(&hex[2..4], 16)
                .map_err(|_| "Invalid green component")?;
            let b = u8::from_str_radix(&hex[4..6], 16)
                .map_err(|_| "Invalid blue component")?;
            let a = u8::from_str_radix(&hex[6..8], 16)
                .map_err(|_| "Invalid alpha component")?;
            Ok(Self::new(r, g, b, a))
        } else {
            Err(format!("Invalid hex color format: expected 6 or 8 characters, got {}", hex.len()))
        }
    }
}

impl Default for GridColor {
    fn default() -> Self {
        Self::GRAY
    }
}

/// Configuration for grid generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridConfig {
    /// Spacing between grid lines in pixels
    pub spacing: u32,
    /// How often to show major lines with labels (every N lines)
    pub major_interval: u32,
    /// Color for minor grid lines
    pub color: GridColor,
    /// Color for major grid lines
    pub major_color: GridColor,
    /// Font size for coordinate labels
    pub label_font_size: f32,
    /// Whether to show coordinate labels on major lines
    pub show_labels: bool,
}

impl Default for GridConfig {
    fn default() -> Self {
        Self {
            spacing: 100,
            major_interval: 5,
            color: GridColor::GRAY,
            major_color: GridColor::RED,
            label_font_size: 12.0,
            show_labels: true,
        }
    }
}

impl GridConfig {
    /// Create a new config with the given spacing
    pub fn with_spacing(spacing: u32) -> Self {
        Self {
            spacing,
            ..Default::default()
        }
    }
}

/// JSON output format for grid metadata (formula-based)
///
/// Labels on the image show base36 indices (col,row).
/// Use this metadata to convert indices to pixel coordinates:
///   pixel_x = origin[0] + col * spacing
///   pixel_y = origin[1] + row * spacing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridMetadata {
    /// Original image dimensions [width, height]
    pub image_size: [u32; 2],
    /// Grid origin in pixels [x, y] - top-left corner of grid
    pub origin: [f64; 2],
    /// Grid spacing in pixels
    pub spacing: u32,
    /// Grid dimensions [cols, rows]
    pub grid_size: [usize; 2],
    /// Major line interval (every N lines is a major line)
    pub major_interval: u32,
    /// Region covered by grid (if cropped)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<RegionJson>,
    /// Formula for converting indices to pixels
    pub formula: String,
}

impl GridMetadata {
    /// Create metadata for a grid
    pub fn new(
        image_width: u32,
        image_height: u32,
        origin_x: f64,
        origin_y: f64,
        spacing: u32,
        cols: usize,
        rows: usize,
        major_interval: u32,
        region: Option<RegionJson>,
    ) -> Self {
        Self {
            image_size: [image_width, image_height],
            origin: [origin_x, origin_y],
            spacing,
            grid_size: [cols, rows],
            major_interval,
            region,
            formula: "pixel_x = origin[0] + col * spacing, pixel_y = origin[1] + row * spacing".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionJson {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

impl From<&TileBounds> for RegionJson {
    fn from(bounds: &TileBounds) -> Self {
        Self {
            x1: bounds.min_x,
            y1: bounds.min_y,
            x2: bounds.max_x,
            y2: bounds.max_y,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_grid_color_from_hex() {
        let color = GridColor::from_hex("#ff0000").unwrap();
        assert_eq!(color.r, 255);
        assert_eq!(color.g, 0);
        assert_eq!(color.b, 0);
        assert_eq!(color.a, 255);

        let color = GridColor::from_hex("#80808080").unwrap();
        assert_eq!(color.r, 128);
        assert_eq!(color.g, 128);
        assert_eq!(color.b, 128);
        assert_eq!(color.a, 128);
    }

    #[test]
    fn test_grid_line_vertical() {
        let line = GridLine::vertical(100.0, 0.0, 500.0, true);
        assert_eq!(line.coordinate, 100.0);
        assert_eq!(line.orientation, GridOrientation::Vertical);
        assert_eq!(line.start, (100.0, 0.0));
        assert_eq!(line.end, (100.0, 500.0));
        assert!(line.is_major);
    }

    #[test]
    fn test_grid_line_horizontal() {
        let line = GridLine::horizontal(200.0, 0.0, 800.0, false);
        assert_eq!(line.coordinate, 200.0);
        assert_eq!(line.orientation, GridOrientation::Horizontal);
        assert_eq!(line.start, (0.0, 200.0));
        assert_eq!(line.end, (800.0, 200.0));
        assert!(!line.is_major);
    }
}
