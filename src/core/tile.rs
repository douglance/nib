//! Core types for the tiled screenshot capture system
//!
//! This module provides the fundamental types for representing and working with
//! tile-based screenshot captures, similar to web map tiles (e.g., Google Maps).
//!
//! The tiling system solves the problem of losing fine details when working with
//! large screenshots by enabling:
//! - Full-resolution capture regardless of image size
//! - Spatial queries: "What's at coordinates X,Y?"
//! - Hierarchical zoom levels for overview + detail navigation
//! - Optimized loading for AI context windows (load only relevant tiles)

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Unique identifier for a tile within a tiled capture
///
/// Tiles are addressed by their zoom level and (x, y) grid position.
/// Higher zoom levels have more tiles at finer resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileId {
    /// Zoom level (0 = overview, max = full resolution)
    pub zoom: u8,
    /// X position in the tile grid (0-based, left to right)
    pub x: u32,
    /// Y position in the tile grid (0-based, top to bottom)
    pub y: u32,
}

impl TileId {
    /// Create a new tile identifier
    pub fn new(zoom: u8, x: u32, y: u32) -> Self {
        Self { zoom, x, y }
    }

    /// Generate the relative file path for this tile (e.g., "z2/0_1.png")
    pub fn to_path(&self) -> PathBuf {
        PathBuf::from(format!("z{}/{}_{}.png", self.zoom, self.x, self.y))
    }

    /// Get the parent tile at zoom level - 1
    ///
    /// Each tile at zoom N covers the same area as 4 tiles at zoom N+1.
    /// Returns None if already at zoom level 0.
    pub fn parent(&self) -> Option<TileId> {
        if self.zoom == 0 {
            None
        } else {
            Some(TileId {
                zoom: self.zoom - 1,
                x: self.x / 2,
                y: self.y / 2,
            })
        }
    }

    /// Get the four child tiles at zoom level + 1
    ///
    /// Each tile contains 4 children at the next zoom level.
    pub fn children(&self) -> [TileId; 4] {
        let z = self.zoom + 1;
        let x = self.x * 2;
        let y = self.y * 2;
        [
            TileId::new(z, x, y),
            TileId::new(z, x + 1, y),
            TileId::new(z, x, y + 1),
            TileId::new(z, x + 1, y + 1),
        ]
    }
}

impl std::fmt::Display for TileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "z{}/{}_{}", self.zoom, self.x, self.y)
    }
}

/// Configuration for tile generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileConfig {
    /// Size of each tile in pixels (default: 512)
    pub tile_size: u32,
    /// Number of zoom levels to generate
    pub zoom_levels: u8,
    /// Maximum zoom level (0 = overview, max = full resolution)
    pub max_zoom: u8,
    /// Image format for tiles
    pub format: TileFormat,
}

impl Default for TileConfig {
    fn default() -> Self {
        Self {
            tile_size: 512,
            zoom_levels: 4,
            max_zoom: 3,
            format: TileFormat::Png,
        }
    }
}

impl TileConfig {
    /// Create a new tile configuration with the given tile size
    pub fn with_tile_size(tile_size: u32) -> Self {
        Self {
            tile_size,
            ..Default::default()
        }
    }

    /// Calculate optimal configuration for given image dimensions
    pub fn for_image(width: u32, height: u32, tile_size: u32) -> Self {
        let max_dim = width.max(height) as f64;
        let tile_size_f = tile_size as f64;

        // Max zoom = full resolution
        // Each lower zoom = 2x smaller
        // Stop when entire image fits in one tile
        let max_zoom = ((max_dim / tile_size_f).log2().ceil() as u8).max(1);
        let zoom_levels = max_zoom + 1;

        Self {
            tile_size,
            zoom_levels,
            max_zoom,
            format: TileFormat::Png,
        }
    }
}

/// Image format for tiles
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TileFormat {
    Png,
    #[serde(rename = "webp")]
    WebP { quality: u8 },
    #[serde(rename = "jpeg")]
    Jpeg { quality: u8 },
}

impl Default for TileFormat {
    fn default() -> Self {
        Self::Png
    }
}

impl TileFormat {
    /// Get the file extension for this format
    pub fn extension(&self) -> &'static str {
        match self {
            TileFormat::Png => "png",
            TileFormat::WebP { .. } => "webp",
            TileFormat::Jpeg { .. } => "jpg",
        }
    }
}

/// Metadata for a single zoom level in the tile pyramid
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoomLevel {
    /// Zoom level index (0 = overview)
    pub zoom: u8,
    /// Scale factor relative to original (1.0 = full resolution)
    pub scale: f64,
    /// Number of tiles in X direction at this level
    pub grid_width: u32,
    /// Number of tiles in Y direction at this level
    pub grid_height: u32,
    /// Total tiles at this level (grid_width * grid_height)
    pub tile_count: u32,
    /// Scaled image width at this level
    pub scaled_width: u32,
    /// Scaled image height at this level
    pub scaled_height: u32,
}

impl ZoomLevel {
    /// Check if a tile coordinate is valid for this zoom level
    pub fn contains_tile(&self, x: u32, y: u32) -> bool {
        x < self.grid_width && y < self.grid_height
    }
}

/// Bounds in original image coordinates
///
/// Used for spatial queries and intersection testing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TileBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl TileBounds {
    /// Create bounds from origin and size
    pub fn from_origin_size(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            min_x: x,
            min_y: y,
            max_x: x + width,
            max_y: y + height,
        }
    }

    /// Create bounds from two corner points
    pub fn from_corners(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        Self {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }

    /// Check if a point is contained within these bounds
    pub fn contains_point(&self, x: f64, y: f64) -> bool {
        x >= self.min_x && x <= self.max_x && y >= self.min_y && y <= self.max_y
    }

    /// Check if these bounds intersect with another bounds
    pub fn intersects(&self, other: &TileBounds) -> bool {
        !(self.max_x < other.min_x
            || self.min_x > other.max_x
            || self.max_y < other.min_y
            || self.min_y > other.max_y)
    }

    /// Width of the bounds
    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    /// Height of the bounds
    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }

    /// Center point of the bounds
    pub fn center(&self) -> (f64, f64) {
        (
            (self.min_x + self.max_x) / 2.0,
            (self.min_y + self.max_y) / 2.0,
        )
    }

    /// Expand bounds by a padding amount on all sides
    pub fn expand(&self, padding: f64) -> Self {
        Self {
            min_x: self.min_x - padding,
            min_y: self.min_y - padding,
            max_x: self.max_x + padding,
            max_y: self.max_y + padding,
        }
    }

    /// Compute intersection with another bounds
    pub fn intersection(&self, other: &TileBounds) -> Option<TileBounds> {
        let min_x = self.min_x.max(other.min_x);
        let min_y = self.min_y.max(other.min_y);
        let max_x = self.max_x.min(other.max_x);
        let max_y = self.max_y.min(other.max_y);

        if min_x <= max_x && min_y <= max_y {
            Some(TileBounds {
                min_x,
                min_y,
                max_x,
                max_y,
            })
        } else {
            None
        }
    }
}

/// Source of the captured image for a tiled capture
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TiledImageSource {
    /// Screen capture
    ScreenCapture {
        width: u32,
        height: u32,
        display_id: Option<u32>,
    },
    /// Loaded from file
    File {
        path: PathBuf,
        width: u32,
        height: u32,
    },
    /// Generated/synthetic
    Generated { width: u32, height: u32 },
}

impl TiledImageSource {
    /// Get the original image width
    pub fn width(&self) -> u32 {
        match self {
            TiledImageSource::ScreenCapture { width, .. } => *width,
            TiledImageSource::File { width, .. } => *width,
            TiledImageSource::Generated { width, .. } => *width,
        }
    }

    /// Get the original image height
    pub fn height(&self) -> u32 {
        match self {
            TiledImageSource::ScreenCapture { height, .. } => *height,
            TiledImageSource::File { height, .. } => *height,
            TiledImageSource::Generated { height, .. } => *height,
        }
    }
}

/// OCR configuration for tiled captures
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TiledOcrConfig {
    /// Whether OCR is enabled
    pub enabled: bool,
    /// Minimum zoom level for OCR processing (higher = more detail)
    pub min_zoom: u8,
    /// OCR engine identifier
    pub engine: String,
}

impl Default for TiledOcrConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_zoom: 2,
            engine: "ocrs".to_string(),
        }
    }
}

/// Complete manifest for a tiled capture
///
/// This manifest is stored as `manifest.json` in the capture directory
/// and contains all metadata needed to work with the tiled capture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TiledCaptureManifest {
    /// Manifest format version
    pub version: String,
    /// Unique capture identifier
    pub capture_id: String,
    /// When the capture was created
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Source image information
    pub source: TiledImageSource,
    /// Tile generation configuration
    pub tile_config: TileConfig,
    /// All zoom levels in the pyramid
    pub levels: Vec<ZoomLevel>,
    /// OCR configuration
    pub ocr: TiledOcrConfig,
}

impl TiledCaptureManifest {
    /// Get the total number of tiles across all zoom levels
    pub fn total_tile_count(&self) -> u32 {
        self.levels.iter().map(|l| l.tile_count).sum()
    }

    /// Get the zoom level metadata for a specific zoom
    pub fn get_level(&self, zoom: u8) -> Option<&ZoomLevel> {
        self.levels.get(zoom as usize)
    }

    /// Get image dimensions
    pub fn dimensions(&self) -> (u32, u32) {
        (self.source.width(), self.source.height())
    }
}

/// Entry in the spatial index (R-tree)
///
/// Each entry represents a tile and its bounds in the original image coordinate space.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileEntry {
    /// Tile identifier
    pub tile_id: TileId,
    /// Bounds in original image coordinates
    pub bounds: TileBounds,
    /// OCR text preview for quick search (first 100 chars)
    pub text_preview: Option<String>,
}

impl rstar::RTreeObject for TileEntry {
    type Envelope = rstar::AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        rstar::AABB::from_corners(
            [self.bounds.min_x, self.bounds.min_y],
            [self.bounds.max_x, self.bounds.max_y],
        )
    }
}

impl rstar::PointDistance for TileEntry {
    fn distance_2(&self, point: &[f64; 2]) -> f64 {
        use rstar::RTreeObject;
        self.envelope().distance_2(point)
    }
}

/// Calculate zoom levels for an image given its dimensions and tile size
///
/// Returns a Vec of ZoomLevel structs, from zoom 0 (overview) to max zoom (full resolution).
///
/// # Example
/// For a 3840x2160 image with 512px tiles:
/// - zoom=0: scale=0.125, grid=1x1, scaled=480x270
/// - zoom=1: scale=0.25, grid=2x2, scaled=960x540
/// - zoom=2: scale=0.5, grid=4x3, scaled=1920x1080
/// - zoom=3: scale=1.0, grid=8x5, scaled=3840x2160 (full res)
pub fn calculate_zoom_levels(width: u32, height: u32, tile_size: u32) -> Vec<ZoomLevel> {
    let mut levels = Vec::new();
    let max_dim = width.max(height) as f64;
    let tile_size_f = tile_size as f64;

    // Max zoom = full resolution
    // Each lower zoom = 2x smaller
    // Stop when entire image fits in one tile
    let max_zoom = ((max_dim / tile_size_f).log2().ceil() as u8).max(1);

    for zoom in 0..=max_zoom {
        let scale = 2_f64.powi(zoom as i32 - max_zoom as i32);
        let scaled_width = (width as f64 * scale).ceil() as u32;
        let scaled_height = (height as f64 * scale).ceil() as u32;

        let grid_width = (scaled_width as f64 / tile_size_f).ceil() as u32;
        let grid_height = (scaled_height as f64 / tile_size_f).ceil() as u32;

        levels.push(ZoomLevel {
            zoom,
            scale,
            grid_width,
            grid_height,
            tile_count: grid_width * grid_height,
            scaled_width,
            scaled_height,
        });
    }

    levels
}

/// Convert global image coordinates to tile coordinates
///
/// Returns the tile ID and the local coordinates within that tile.
pub fn global_to_tile(
    global_x: f64,
    global_y: f64,
    level: &ZoomLevel,
    tile_size: u32,
) -> (TileId, u32, u32) {
    // Scale global coords to this zoom level
    let scaled_x = global_x * level.scale;
    let scaled_y = global_y * level.scale;

    // Which tile?
    let tile_x = (scaled_x / tile_size as f64).floor() as u32;
    let tile_y = (scaled_y / tile_size as f64).floor() as u32;

    // Clamp to valid tile range
    let tile_x = tile_x.min(level.grid_width.saturating_sub(1));
    let tile_y = tile_y.min(level.grid_height.saturating_sub(1));

    // Local coords within tile
    let local_x = (scaled_x - (tile_x * tile_size) as f64).max(0.0) as u32;
    let local_y = (scaled_y - (tile_y * tile_size) as f64).max(0.0) as u32;

    (TileId::new(level.zoom, tile_x, tile_y), local_x, local_y)
}

/// Convert tile-local coordinates to global image coordinates
pub fn tile_to_global(
    tile_id: &TileId,
    local_x: u32,
    local_y: u32,
    levels: &[ZoomLevel],
    tile_size: u32,
) -> Option<(f64, f64)> {
    let level = levels.get(tile_id.zoom as usize)?;

    let scaled_x = (tile_id.x * tile_size + local_x) as f64;
    let scaled_y = (tile_id.y * tile_size + local_y) as f64;

    let global_x = scaled_x / level.scale;
    let global_y = scaled_y / level.scale;

    Some((global_x, global_y))
}

/// Get the bounds of a tile in global image coordinates
pub fn tile_global_bounds(tile_id: &TileId, levels: &[ZoomLevel], tile_size: u32) -> TileBounds {
    let level = &levels[tile_id.zoom as usize];
    let ts = tile_size as f64;

    TileBounds {
        min_x: (tile_id.x as f64 * ts) / level.scale,
        min_y: (tile_id.y as f64 * ts) / level.scale,
        max_x: ((tile_id.x + 1) as f64 * ts) / level.scale,
        max_y: ((tile_id.y + 1) as f64 * ts) / level.scale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tile_id_path() {
        let tile = TileId::new(2, 3, 1);
        assert_eq!(tile.to_path(), PathBuf::from("z2/3_1.png"));
    }

    #[test]
    fn test_tile_id_display() {
        let tile = TileId::new(2, 3, 1);
        assert_eq!(format!("{}", tile), "z2/3_1");
    }

    #[test]
    fn test_tile_parent() {
        let tile = TileId::new(2, 2, 3);
        let parent = tile.parent().unwrap();
        assert_eq!(parent, TileId::new(1, 1, 1));

        let root = TileId::new(0, 0, 0);
        assert!(root.parent().is_none());
    }

    #[test]
    fn test_tile_children() {
        let parent = TileId::new(1, 1, 1);
        let children = parent.children();

        assert_eq!(children[0], TileId::new(2, 2, 2));
        assert_eq!(children[1], TileId::new(2, 3, 2));
        assert_eq!(children[2], TileId::new(2, 2, 3));
        assert_eq!(children[3], TileId::new(2, 3, 3));

        // Verify parent-child relationship
        let tile = TileId::new(2, 2, 3);
        let tile_parent = tile.parent().unwrap();
        assert!(tile_parent.children().contains(&tile));
    }

    #[test]
    fn test_tile_bounds_contains_point() {
        let bounds = TileBounds::from_corners(0.0, 0.0, 100.0, 100.0);

        assert!(bounds.contains_point(50.0, 50.0));
        assert!(bounds.contains_point(0.0, 0.0));
        assert!(bounds.contains_point(100.0, 100.0));
        assert!(!bounds.contains_point(-1.0, 50.0));
        assert!(!bounds.contains_point(101.0, 50.0));
    }

    #[test]
    fn test_tile_bounds_intersects() {
        let a = TileBounds::from_corners(0.0, 0.0, 100.0, 100.0);
        let b = TileBounds::from_corners(50.0, 50.0, 150.0, 150.0);
        let c = TileBounds::from_corners(200.0, 200.0, 300.0, 300.0);

        assert!(a.intersects(&b));
        assert!(b.intersects(&a));
        assert!(!a.intersects(&c));
        assert!(!c.intersects(&a));
    }

    #[test]
    fn test_tile_bounds_intersection() {
        let a = TileBounds::from_corners(0.0, 0.0, 100.0, 100.0);
        let b = TileBounds::from_corners(50.0, 50.0, 150.0, 150.0);

        let intersection = a.intersection(&b).unwrap();
        assert_eq!(intersection.min_x, 50.0);
        assert_eq!(intersection.min_y, 50.0);
        assert_eq!(intersection.max_x, 100.0);
        assert_eq!(intersection.max_y, 100.0);

        let c = TileBounds::from_corners(200.0, 200.0, 300.0, 300.0);
        assert!(a.intersection(&c).is_none());
    }

    #[test]
    fn test_calculate_zoom_levels() {
        // Test with 3840x2160 image and 512px tiles
        let levels = calculate_zoom_levels(3840, 2160, 512);

        assert!(!levels.is_empty());

        // Zoom 0 should be the overview
        let overview = &levels[0];
        assert_eq!(overview.zoom, 0);
        assert!(overview.scale < 1.0);

        // Max zoom should be full resolution
        let full_res = levels.last().unwrap();
        assert_eq!(full_res.scale, 1.0);
        assert_eq!(full_res.scaled_width, 3840);
        assert_eq!(full_res.scaled_height, 2160);
    }

    #[test]
    fn test_global_to_tile() {
        let levels = calculate_zoom_levels(1024, 1024, 512);
        let max_level = levels.last().unwrap();

        // Point at (256, 256) should be in tile (0, 0) at max zoom
        let (tile_id, local_x, local_y) = global_to_tile(256.0, 256.0, max_level, 512);
        assert_eq!(tile_id.x, 0);
        assert_eq!(tile_id.y, 0);
        assert_eq!(local_x, 256);
        assert_eq!(local_y, 256);

        // Point at (768, 768) should be in tile (1, 1) at max zoom
        let (tile_id, local_x, local_y) = global_to_tile(768.0, 768.0, max_level, 512);
        assert_eq!(tile_id.x, 1);
        assert_eq!(tile_id.y, 1);
        assert_eq!(local_x, 256);
        assert_eq!(local_y, 256);
    }

    #[test]
    fn test_tile_to_global() {
        let levels = calculate_zoom_levels(1024, 1024, 512);

        // Tile (1, 1) with local coords (0, 0) at max zoom should be (512, 512)
        let max_zoom = levels.len() - 1;
        let tile_id = TileId::new(max_zoom as u8, 1, 1);
        let (global_x, global_y) = tile_to_global(&tile_id, 0, 0, &levels, 512).unwrap();

        assert!((global_x - 512.0).abs() < 0.001);
        assert!((global_y - 512.0).abs() < 0.001);
    }

    #[test]
    fn test_tile_global_bounds() {
        let levels = calculate_zoom_levels(1024, 1024, 512);
        let max_zoom = levels.len() - 1;

        let tile_id = TileId::new(max_zoom as u8, 0, 0);
        let bounds = tile_global_bounds(&tile_id, &levels, 512);

        assert_eq!(bounds.min_x, 0.0);
        assert_eq!(bounds.min_y, 0.0);
        assert_eq!(bounds.max_x, 512.0);
        assert_eq!(bounds.max_y, 512.0);
    }

    #[test]
    fn test_tile_config_for_image() {
        let config = TileConfig::for_image(3840, 2160, 512);

        assert_eq!(config.tile_size, 512);
        assert!(config.max_zoom > 0);
        assert_eq!(config.zoom_levels, config.max_zoom + 1);
    }

    #[test]
    fn test_zoom_level_contains_tile() {
        let level = ZoomLevel {
            zoom: 2,
            scale: 0.5,
            grid_width: 4,
            grid_height: 3,
            tile_count: 12,
            scaled_width: 1920,
            scaled_height: 1080,
        };

        assert!(level.contains_tile(0, 0));
        assert!(level.contains_tile(3, 2));
        assert!(!level.contains_tile(4, 0));
        assert!(!level.contains_tile(0, 3));
    }

    #[test]
    fn test_manifest_total_tile_count() {
        let manifest = TiledCaptureManifest {
            version: "1.0.0".to_string(),
            capture_id: "test".to_string(),
            created_at: chrono::Utc::now(),
            source: TiledImageSource::Generated {
                width: 1024,
                height: 1024,
            },
            tile_config: TileConfig::default(),
            levels: vec![
                ZoomLevel {
                    zoom: 0,
                    scale: 0.5,
                    grid_width: 1,
                    grid_height: 1,
                    tile_count: 1,
                    scaled_width: 512,
                    scaled_height: 512,
                },
                ZoomLevel {
                    zoom: 1,
                    scale: 1.0,
                    grid_width: 2,
                    grid_height: 2,
                    tile_count: 4,
                    scaled_width: 1024,
                    scaled_height: 1024,
                },
            ],
            ocr: TiledOcrConfig::default(),
        };

        assert_eq!(manifest.total_tile_count(), 5);
    }
}
