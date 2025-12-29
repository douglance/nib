# Tiled Screenshot Capture System

## Overview

This specification defines a spatial tiling system for Nib that captures and stores screenshots as a hierarchy of tiles, similar to web map tiles (e.g., Google Maps, OpenStreetMap). The system solves the fundamental problem of **losing fine details when working with large screenshots** by enabling:

1. Full-resolution capture regardless of image size
2. Spatial queries: "What's at coordinates X,Y?" returns the relevant tile at full resolution
3. Hierarchical zoom levels for overview + detail navigation
4. Optimized loading for AI context windows (load only relevant tiles)
5. Per-tile OCR for improved text recognition accuracy

## Motivation

### Current Limitations

The existing `NibImage` structure stores the entire screenshot as a single PNG blob. For large captures (e.g., 4K monitors, multi-monitor setups, or scrolling captures), this creates problems:

1. **Memory pressure**: A 4K screenshot is ~33MB uncompressed RGBA
2. **Context window inefficiency**: AI models receive the entire image even when discussing a small region
3. **OCR accuracy degradation**: OCR on large images loses fine text details
4. **Slow annotation operations**: Any annotation requires loading the full image

### Tiled Approach Benefits

1. **Lazy loading**: Only load tiles visible in viewport or relevant to query
2. **Parallel processing**: OCR, annotation rendering can happen per-tile
3. **Progressive detail**: Show overview first, load details on demand
4. **Efficient AI context**: Send only the tiles containing the region of interest
5. **Future-proof**: Supports arbitrarily large captures (e.g., scrolling captures)

## File Structure

### Directory Layout

```
nib/
  captures/
    screenshot_20241228_143052/           # Capture session directory
      manifest.json                       # Tile metadata and spatial index
      tiles/
        z0/                               # Zoom level 0 (overview, 1 tile)
          0_0.png                         # Tile at (0,0)
        z1/                               # Zoom level 1 (2x2 grid)
          0_0.png
          0_1.png
          1_0.png
          1_1.png
        z2/                               # Zoom level 2 (4x4 grid)
          0_0.png
          0_1.png
          ...
          3_3.png
        zN/                               # Zoom level N (full resolution)
          ...
      ocr/
        z2_0_0.json                       # OCR results for tile z2/0_0
        z2_0_1.json
        ...
      annotations.json                    # Annotations (reference tile coordinates)
```

### Manifest Format

```json
{
  "version": "1.0.0",
  "capture_id": "screenshot_20241228_143052",
  "created_at": "2024-12-28T14:30:52Z",
  "source": {
    "type": "screen_capture",
    "display_id": 1,
    "original_width": 3840,
    "original_height": 2160
  },
  "tile_config": {
    "tile_size": 512,
    "zoom_levels": 4,
    "max_zoom": 3,
    "format": "png"
  },
  "levels": [
    {
      "zoom": 0,
      "scale": 0.125,
      "grid_width": 1,
      "grid_height": 1,
      "tile_count": 1
    },
    {
      "zoom": 1,
      "scale": 0.25,
      "grid_width": 2,
      "grid_height": 2,
      "tile_count": 4
    },
    {
      "zoom": 2,
      "scale": 0.5,
      "grid_width": 4,
      "grid_height": 3,
      "tile_count": 12
    },
    {
      "zoom": 3,
      "scale": 1.0,
      "grid_width": 8,
      "grid_height": 5,
      "tile_count": 40
    }
  ],
  "ocr": {
    "enabled": true,
    "min_zoom": 2,
    "engine": "ocrs"
  },
  "spatial_index": {
    "type": "rtree",
    "file": "spatial.idx"
  }
}
```

## Tile Generation Algorithm

### Calculating Zoom Levels

```rust
// src/capture/tiled.rs

/// Calculate optimal zoom levels for an image
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

/// Example for 3840x2160 image with 512px tiles:
/// zoom=0: scale=0.125, grid=1x1,   scaled=480x270
/// zoom=1: scale=0.25,  grid=2x2,   scaled=960x540
/// zoom=2: scale=0.5,   grid=4x3,   scaled=1920x1080
/// zoom=3: scale=1.0,   grid=8x5,   scaled=3840x2160 (full res)
```

### Tile Slicing Implementation

```rust
use image::{DynamicImage, RgbaImage, imageops::FilterType};
use rayon::prelude::*;
use std::fs;
use std::path::Path;

/// Generate all tiles for a tiled capture
pub fn generate_tiles(
    source: &RgbaImage,
    output_dir: &Path,
    config: &TileConfig,
) -> Result<TiledCaptureManifest> {
    let (width, height) = source.dimensions();
    let levels = calculate_zoom_levels(width, height, config.tile_size);

    // Create directory structure
    let tiles_dir = output_dir.join("tiles");
    for level in &levels {
        fs::create_dir_all(tiles_dir.join(format!("z{}", level.zoom)))?;
    }

    // Generate tiles for each zoom level (parallel per level)
    for level in &levels {
        generate_level_tiles(source, &tiles_dir, level, config)?;
    }

    // Build manifest
    let manifest = TiledCaptureManifest {
        version: "1.0.0".to_string(),
        capture_id: generate_capture_id(),
        created_at: chrono::Utc::now(),
        source: ImageSource::ScreenCapture {
            width,
            height,
            display_id: None,
        },
        tile_config: config.clone(),
        levels,
        ocr: OcrConfig {
            enabled: true,
            min_zoom: config.max_zoom.saturating_sub(1),
            engine: "ocrs".to_string(),
        },
    };

    // Write manifest
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    fs::write(output_dir.join("manifest.json"), manifest_json)?;

    Ok(manifest)
}

/// Generate tiles for a single zoom level
fn generate_level_tiles(
    source: &RgbaImage,
    tiles_dir: &Path,
    level: &ZoomLevel,
    config: &TileConfig,
) -> Result<()> {
    let (src_width, src_height) = source.dimensions();

    // Scale source image to this zoom level
    let scaled = if level.scale < 1.0 {
        image::imageops::resize(
            source,
            level.scaled_width,
            level.scaled_height,
            FilterType::Lanczos3, // High quality downscaling
        )
    } else {
        source.clone()
    };

    // Generate tiles in parallel
    let tile_coords: Vec<(u32, u32)> = (0..level.grid_height)
        .flat_map(|y| (0..level.grid_width).map(move |x| (x, y)))
        .collect();

    tile_coords.par_iter().try_for_each(|(tx, ty)| -> Result<()> {
        let tile = extract_tile(&scaled, *tx, *ty, config.tile_size);
        let tile_path = tiles_dir
            .join(format!("z{}", level.zoom))
            .join(format!("{}_{}.png", tx, ty));

        tile.save(&tile_path)?;
        Ok(())
    })?;

    Ok(())
}

/// Extract a single tile from a scaled image
fn extract_tile(source: &RgbaImage, tx: u32, ty: u32, tile_size: u32) -> RgbaImage {
    let (src_width, src_height) = source.dimensions();

    let x_start = tx * tile_size;
    let y_start = ty * tile_size;

    // Handle edge tiles that may be smaller
    let tile_width = tile_size.min(src_width.saturating_sub(x_start));
    let tile_height = tile_size.min(src_height.saturating_sub(y_start));

    // Create tile (pad with transparent if needed for consistency)
    let mut tile = RgbaImage::new(tile_size, tile_size);

    // Copy pixels from source
    for y in 0..tile_height {
        for x in 0..tile_width {
            let src_x = x_start + x;
            let src_y = y_start + y;
            if src_x < src_width && src_y < src_height {
                tile.put_pixel(x, y, *source.get_pixel(src_x, src_y));
            }
        }
    }

    tile
}
```

### Coordinate Mapping

```rust
/// Convert global image coordinates to tile coordinates
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

    // Local coords within tile
    let local_x = (scaled_x - (tile_x * tile_size) as f64) as u32;
    let local_y = (scaled_y - (tile_y * tile_size) as f64) as u32;

    (TileId::new(level.zoom, tile_x, tile_y), local_x, local_y)
}

/// Convert tile-local coordinates to global image coordinates
pub fn tile_to_global(
    tile_id: &TileId,
    local_x: u32,
    local_y: u32,
    levels: &[ZoomLevel],
    tile_size: u32,
) -> (f64, f64) {
    let level = &levels[tile_id.zoom as usize];

    let scaled_x = (tile_id.x * tile_size + local_x) as f64;
    let scaled_y = (tile_id.y * tile_size + local_y) as f64;

    let global_x = scaled_x / level.scale;
    let global_y = scaled_y / level.scale;

    (global_x, global_y)
}

/// Get the bounds of a tile in global image coordinates
pub fn tile_global_bounds(
    tile_id: &TileId,
    levels: &[ZoomLevel],
    tile_size: u32,
) -> TileBounds {
    let level = &levels[tile_id.zoom as usize];
    let ts = tile_size as f64;

    TileBounds {
        min_x: (tile_id.x as f64 * ts) / level.scale,
        min_y: (tile_id.y as f64 * ts) / level.scale,
        max_x: ((tile_id.x + 1) as f64 * ts) / level.scale,
        max_y: ((tile_id.y + 1) as f64 * ts) / level.scale,
    }
}
```

## Core Types

### Rust Type Definitions

```rust
// src/core/tile.rs

use std::path::PathBuf;
use serde::{Serialize, Deserialize};

/// Unique identifier for a tile within a capture
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileId {
    pub zoom: u8,
    pub x: u32,
    pub y: u32,
}

impl TileId {
    pub fn new(zoom: u8, x: u32, y: u32) -> Self {
        Self { zoom, x, y }
    }

    /// Filename for this tile (e.g., "z2/0_1.png")
    pub fn to_path(&self) -> PathBuf {
        PathBuf::from(format!("z{}/{}_{}.png", self.zoom, self.x, self.y))
    }

    /// Parent tile at zoom level - 1
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

    /// Child tiles at zoom level + 1
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum TileFormat {
    Png,
    WebP { quality: u8 },
    Jpeg { quality: u8 },
}

/// Metadata for a single zoom level
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoomLevel {
    pub zoom: u8,
    /// Scale factor relative to original (1.0 = full resolution)
    pub scale: f64,
    /// Number of tiles in X direction
    pub grid_width: u32,
    /// Number of tiles in Y direction
    pub grid_height: u32,
    /// Total tiles at this level
    pub tile_count: u32,
}

/// Bounds in original image coordinates
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TileBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl TileBounds {
    pub fn contains_point(&self, x: f64, y: f64) -> bool {
        x >= self.min_x && x <= self.max_x && y >= self.min_y && y <= self.max_y
    }

    pub fn intersects(&self, other: &TileBounds) -> bool {
        !(self.max_x < other.min_x
            || self.min_x > other.max_x
            || self.max_y < other.min_y
            || self.min_y > other.max_y)
    }

    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }
}

/// Complete manifest for a tiled capture
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TiledCaptureManifest {
    pub version: String,
    pub capture_id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub source: ImageSource,
    pub tile_config: TileConfig,
    pub levels: Vec<ZoomLevel>,
    pub ocr: OcrConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrConfig {
    pub enabled: bool,
    /// Minimum zoom level for OCR (higher = more detail)
    pub min_zoom: u8,
    pub engine: String,
}

/// A tiled capture session (like NibImage but tiled)
pub struct TiledCapture {
    /// Root directory for this capture
    pub root_dir: PathBuf,
    /// Manifest with metadata
    pub manifest: TiledCaptureManifest,
    /// Loaded tiles cache (LRU)
    tile_cache: lru::LruCache<TileId, RgbaImage>,
    /// Spatial index for fast lookups
    spatial_index: RTree<TileEntry>,
}

impl TiledCapture {
    /// Open an existing tiled capture
    pub fn open(path: &Path) -> TileResult<Self> {
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            return Err(TileError::ManifestNotFound(manifest_path));
        }

        let manifest_str = fs::read_to_string(&manifest_path)?;
        let manifest: TiledCaptureManifest = serde_json::from_str(&manifest_str)?;

        // Load or build spatial index
        let index_path = path.join("spatial.idx");
        let spatial_index = if index_path.exists() {
            load_spatial_index(&index_path)?
        } else {
            let index = build_spatial_index(&manifest);
            save_spatial_index(&index, &index_path)?;
            index
        };

        // Default cache size: 64 tiles (~64MB for 512px RGBA tiles)
        let cache_size = std::env::var("NIB_TILE_CACHE_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(64);

        Ok(Self {
            root_dir: path.to_path_buf(),
            manifest,
            tile_cache: lru::LruCache::new(
                std::num::NonZeroUsize::new(cache_size).unwrap()
            ),
            spatial_index,
        })
    }

    /// Load a tile (cached)
    pub fn load_tile(&mut self, tile_id: TileId) -> TileResult<&RgbaImage> {
        // Validate tile exists
        let level = self.manifest.levels.get(tile_id.zoom as usize)
            .ok_or(TileError::InvalidZoomLevel(
                tile_id.zoom,
                self.manifest.tile_config.max_zoom
            ))?;

        if tile_id.x >= level.grid_width || tile_id.y >= level.grid_height {
            return Err(TileError::TileNotFound {
                zoom: tile_id.zoom,
                x: tile_id.x,
                y: tile_id.y,
            });
        }

        // Check cache first
        if !self.tile_cache.contains(&tile_id) {
            let tile_path = self.root_dir
                .join("tiles")
                .join(tile_id.to_path());

            if !tile_path.exists() {
                return Err(TileError::TileNotFound {
                    zoom: tile_id.zoom,
                    x: tile_id.x,
                    y: tile_id.y,
                });
            }

            let image = image::open(&tile_path)?.to_rgba8();
            self.tile_cache.put(tile_id, image);
        }

        Ok(self.tile_cache.get(&tile_id).unwrap())
    }

    /// Get tile bounds in global coordinates
    pub fn tile_bounds(&self, tile_id: TileId) -> TileBounds {
        tile_global_bounds(
            &tile_id,
            &self.manifest.levels,
            self.manifest.tile_config.tile_size
        )
    }

    /// Get image dimensions
    pub fn image_dimensions(&self) -> (u32, u32) {
        (self.manifest.source.width(), self.manifest.source.height())
    }

    /// Find zoom level closest to a scale factor
    pub fn zoom_for_scale(&self, target_scale: f64) -> u8 {
        self.manifest.levels
            .iter()
            .min_by(|a, b| {
                let diff_a = (a.scale - target_scale).abs();
                let diff_b = (b.scale - target_scale).abs();
                diff_a.partial_cmp(&diff_b).unwrap()
            })
            .map(|l| l.zoom)
            .unwrap_or(self.manifest.tile_config.max_zoom)
    }

    /// Total tile count across all zoom levels
    pub fn total_tile_count(&self) -> u32 {
        self.manifest.levels.iter().map(|l| l.tile_count).sum()
    }

    /// Prefetch tiles likely to be needed soon
    pub fn prefetch(&mut self, center: (f64, f64), zoom: u8, radius: usize) {
        let tiles = self.nearest_tiles(center.0, center.1, radius * radius, zoom);
        for entry in tiles {
            let _ = self.load_tile(entry.tile_id);
        }
    }

    /// Clear tile cache
    pub fn clear_cache(&mut self) {
        self.tile_cache.clear();
    }

    /// OCR path for a tile
    pub fn ocr_path(&self, tile_id: TileId) -> PathBuf {
        self.root_dir
            .join("ocr")
            .join(format!("z{}_{}_{}..json", tile_id.zoom, tile_id.x, tile_id.y))
    }

    /// Load OCR data for a tile
    pub fn load_ocr(&self, tile_id: TileId) -> TileResult<TileOcrData> {
        let ocr_path = self.ocr_path(tile_id);
        if !ocr_path.exists() {
            return Err(TileError::OcrFailed {
                zoom: tile_id.zoom,
                x: tile_id.x,
                y: tile_id.y,
                reason: "OCR data not found".into(),
            });
        }

        let ocr_str = fs::read_to_string(&ocr_path)?;
        let ocr_data: TileOcrData = serde_json::from_str(&ocr_str)?;
        Ok(ocr_data)
    }

    /// Save OCR data for a tile
    pub fn save_ocr(&self, tile_id: TileId, data: &TileOcrData) -> TileResult<()> {
        let ocr_dir = self.root_dir.join("ocr");
        fs::create_dir_all(&ocr_dir)?;

        let ocr_path = self.ocr_path(tile_id);
        let ocr_json = serde_json::to_string_pretty(data)?;
        fs::write(&ocr_path, ocr_json)?;

        Ok(())
    }
}
```

### Spatial Index Entry

```rust
/// Entry in the spatial index (R-tree)
#[derive(Debug, Clone)]
pub struct TileEntry {
    pub tile_id: TileId,
    pub bounds: TileBounds,
    /// OCR text snippets for quick search (optional)
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
```

## Error Types

```rust
// src/core/tile_error.rs

use thiserror::Error;
use std::path::PathBuf;

#[derive(Error, Debug)]
pub enum TileError {
    #[error("Tile not found: z{zoom}/{x}_{y}")]
    TileNotFound { zoom: u8, x: u32, y: u32 },

    #[error("Invalid zoom level {0} (max: {1})")]
    InvalidZoomLevel(u8, u8),

    #[error("Manifest not found at {0}")]
    ManifestNotFound(PathBuf),

    #[error("Invalid manifest format: {0}")]
    InvalidManifest(String),

    #[error("Spatial index corrupted: {0}")]
    SpatialIndexCorrupted(String),

    #[error("Region out of bounds: ({x}, {y}) is outside image ({width}x{height})")]
    RegionOutOfBounds { x: f64, y: f64, width: u32, height: u32 },

    #[error("Tile generation failed for z{zoom}/{x}_{y}: {reason}")]
    TileGenerationFailed { zoom: u8, x: u32, y: u32, reason: String },

    #[error("OCR failed for tile z{zoom}/{x}_{y}: {reason}")]
    OcrFailed { zoom: u8, x: u32, y: u32, reason: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type TileResult<T> = Result<T, TileError>;
```

## R-Tree Spatial Index

### Building the Index

```rust
// src/capture/spatial_index.rs

use rstar::{RTree, RTreeObject, AABB};
use std::fs::File;
use std::io::{BufReader, BufWriter};

/// Build spatial index from manifest
pub fn build_spatial_index(manifest: &TiledCaptureManifest) -> RTree<TileEntry> {
    let mut entries = Vec::new();
    let tile_size = manifest.tile_config.tile_size;

    for level in &manifest.levels {
        for y in 0..level.grid_height {
            for x in 0..level.grid_width {
                let tile_id = TileId::new(level.zoom, x, y);
                let bounds = tile_global_bounds(&tile_id, &manifest.levels, tile_size);

                entries.push(TileEntry {
                    tile_id,
                    bounds,
                    text_preview: None, // Populated later by OCR
                });
            }
        }
    }

    RTree::bulk_load(entries)
}

/// Persist index to binary file for fast loading
pub fn save_spatial_index(index: &RTree<TileEntry>, path: &Path) -> TileResult<()> {
    let file = File::create(path)?;
    let writer = BufWriter::new(file);

    // Serialize entries (R-tree itself isn't directly serializable)
    let entries: Vec<_> = index.iter().cloned().collect();
    bincode::serialize_into(writer, &entries)
        .map_err(|e| TileError::SpatialIndexCorrupted(e.to_string()))?;

    Ok(())
}

/// Load index from binary file
pub fn load_spatial_index(path: &Path) -> TileResult<RTree<TileEntry>> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);

    let entries: Vec<TileEntry> = bincode::deserialize_from(reader)
        .map_err(|e| TileError::SpatialIndexCorrupted(e.to_string()))?;

    Ok(RTree::bulk_load(entries))
}

/// TileEntry must implement RTreeObject for spatial queries
impl RTreeObject for TileEntry {
    type Envelope = AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        AABB::from_corners(
            [self.bounds.min_x, self.bounds.min_y],
            [self.bounds.max_x, self.bounds.max_y],
        )
    }
}

/// Serializable tile entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileEntry {
    pub tile_id: TileId,
    pub bounds: TileBounds,
    pub text_preview: Option<String>,
}
```

### Index Queries

```rust
impl TiledCapture {
    /// Find tile containing a point at max zoom
    pub fn tile_at_point_max_zoom(&self, x: f64, y: f64) -> Option<TileEntry> {
        let point = [x, y];
        self.spatial_index
            .locate_at_point(&point)
            .filter(|e| e.tile_id.zoom == self.manifest.tile_config.max_zoom)
            .cloned()
    }

    /// Find all tiles intersecting a region at a specific zoom
    pub fn tiles_intersecting(&self, bounds: &TileBounds, zoom: u8) -> Vec<TileEntry> {
        let envelope = AABB::from_corners(
            [bounds.min_x, bounds.min_y],
            [bounds.max_x, bounds.max_y],
        );

        self.spatial_index
            .locate_in_envelope_intersecting(&envelope)
            .filter(|e| e.tile_id.zoom == zoom)
            .cloned()
            .collect()
    }

    /// Find nearest tiles to a point (for prefetching)
    pub fn nearest_tiles(&self, x: f64, y: f64, count: usize, zoom: u8) -> Vec<TileEntry> {
        self.spatial_index
            .nearest_neighbor_iter(&[x, y])
            .filter(|e| e.tile_id.zoom == zoom)
            .take(count)
            .cloned()
            .collect()
    }
}
```

## Region Extraction (Full Implementation)

```rust
// src/capture/extract.rs

use image::{RgbaImage, GenericImage, GenericImageView};

impl TiledCapture {
    /// Extract a region at full resolution by stitching tiles
    pub fn extract_region(&mut self, region: &TileBounds) -> TileResult<RgbaImage> {
        // Validate region is within image bounds
        let (img_width, img_height) = self.image_dimensions();
        if region.min_x < 0.0 || region.min_y < 0.0 ||
           region.max_x > img_width as f64 || region.max_y > img_height as f64 {
            return Err(TileError::RegionOutOfBounds {
                x: region.min_x,
                y: region.min_y,
                width: img_width,
                height: img_height,
            });
        }

        let max_zoom = self.manifest.tile_config.max_zoom;
        let tile_size = self.manifest.tile_config.tile_size;

        // Get tiles that cover this region
        let tiles = self.tiles_intersecting(region, max_zoom);

        // Create output image
        let out_width = (region.max_x - region.min_x).ceil() as u32;
        let out_height = (region.max_y - region.min_y).ceil() as u32;
        let mut output = RgbaImage::new(out_width, out_height);

        // Copy relevant pixels from each tile
        for entry in &tiles {
            let tile_img = self.load_tile(entry.tile_id)?;
            let tile_bounds = &entry.bounds;

            // Calculate intersection between tile and requested region
            let intersect = TileBounds {
                min_x: region.min_x.max(tile_bounds.min_x),
                min_y: region.min_y.max(tile_bounds.min_y),
                max_x: region.max_x.min(tile_bounds.max_x),
                max_y: region.max_y.min(tile_bounds.max_y),
            };

            if intersect.width() <= 0.0 || intersect.height() <= 0.0 {
                continue;
            }

            // Source coordinates (within tile)
            let src_x = (intersect.min_x - tile_bounds.min_x) as u32;
            let src_y = (intersect.min_y - tile_bounds.min_y) as u32;
            let copy_width = intersect.width() as u32;
            let copy_height = intersect.height() as u32;

            // Destination coordinates (within output)
            let dst_x = (intersect.min_x - region.min_x) as u32;
            let dst_y = (intersect.min_y - region.min_y) as u32;

            // Copy pixel by pixel (handles edge cases)
            for y in 0..copy_height {
                for x in 0..copy_width {
                    let sx = src_x + x;
                    let sy = src_y + y;
                    let dx = dst_x + x;
                    let dy = dst_y + y;

                    if sx < tile_img.width() && sy < tile_img.height() &&
                       dx < out_width && dy < out_height {
                        let pixel = tile_img.get_pixel(sx, sy);
                        output.put_pixel(dx, dy, *pixel);
                    }
                }
            }
        }

        Ok(output)
    }

    /// Extract region at a specific zoom level (for previews)
    pub fn extract_region_at_zoom(
        &mut self,
        region: &TileBounds,
        zoom: u8,
    ) -> TileResult<RgbaImage> {
        let level = self.manifest.levels.get(zoom as usize)
            .ok_or(TileError::InvalidZoomLevel(zoom, self.manifest.tile_config.max_zoom))?;

        // Scale region to this zoom level
        let scaled_region = TileBounds {
            min_x: region.min_x * level.scale,
            min_y: region.min_y * level.scale,
            max_x: region.max_x * level.scale,
            max_y: region.max_y * level.scale,
        };

        // Get tiles and stitch (same logic as above but at different zoom)
        let tiles = self.tiles_intersecting(region, zoom);

        let out_width = scaled_region.width().ceil() as u32;
        let out_height = scaled_region.height().ceil() as u32;
        let mut output = RgbaImage::new(out_width, out_height);

        for entry in &tiles {
            let tile_img = self.load_tile(entry.tile_id)?;
            // ... same copy logic scaled appropriately
        }

        Ok(output)
    }
}
```

## Spatial Query API

### Core Query Operations

```rust
// src/capture/tile_query.rs

impl TiledCapture {
    /// Get the best tile containing a point at the desired zoom level
    pub fn tile_at_point(&self, x: f64, y: f64, zoom: u8) -> Option<TileId> {
        let level = self.manifest.levels.get(zoom as usize)?;
        let tile_size = self.manifest.tile_config.tile_size as f64 * level.scale;

        let tile_x = (x / tile_size).floor() as u32;
        let tile_y = (y / tile_size).floor() as u32;

        if tile_x < level.grid_width && tile_y < level.grid_height {
            Some(TileId::new(zoom, tile_x, tile_y))
        } else {
            None
        }
    }

    /// Get all tiles that intersect a region
    pub fn tiles_in_region(&self, region: &TileBounds, zoom: u8) -> Vec<TileId> {
        self.spatial_index
            .locate_in_envelope_intersecting(&rstar::AABB::from_corners(
                [region.min_x, region.min_y],
                [region.max_x, region.max_y],
            ))
            .filter(|entry| entry.tile_id.zoom == zoom)
            .map(|entry| entry.tile_id)
            .collect()
    }

    /// Get tiles visible in viewport (for GUI rendering)
    pub fn tiles_in_viewport(
        &self,
        viewport: &TileBounds,
        viewport_zoom: f64,
    ) -> Vec<TileId> {
        // Determine appropriate zoom level based on viewport scale
        let zoom = self.zoom_for_scale(viewport_zoom);
        self.tiles_in_region(viewport, zoom)
    }

    /// Load tile image data (with caching)
    pub fn load_tile(&mut self, tile_id: TileId) -> Result<&RgbaImage> {
        if !self.tile_cache.contains(&tile_id) {
            let path = self.root_dir.join("tiles").join(tile_id.to_path());
            let image = image::open(&path)?.to_rgba8();
            self.tile_cache.put(tile_id, image);
        }
        Ok(self.tile_cache.get(&tile_id).unwrap())
    }

    /// Extract a region at full resolution (stitching tiles)
    pub fn extract_region(&mut self, region: &TileBounds) -> Result<RgbaImage> {
        let max_zoom = self.manifest.tile_config.max_zoom;
        let tiles = self.tiles_in_region(region, max_zoom);

        let width = region.width() as u32;
        let height = region.height() as u32;
        let mut output = RgbaImage::new(width, height);

        for tile_id in tiles {
            let tile = self.load_tile(tile_id)?;
            let tile_bounds = self.tile_bounds(tile_id);

            // Calculate overlap and copy pixels
            let src_x = (region.min_x - tile_bounds.min_x).max(0.0) as u32;
            let src_y = (region.min_y - tile_bounds.min_y).max(0.0) as u32;
            let dst_x = (tile_bounds.min_x - region.min_x).max(0.0) as u32;
            let dst_y = (tile_bounds.min_y - region.min_y).max(0.0) as u32;

            // Copy overlapping pixels
            image::imageops::overlay(
                &mut output,
                tile,
                dst_x as i64,
                dst_y as i64,
            );
        }

        Ok(output)
    }

    /// Search for text and return tile + location
    pub fn find_text(&self, query: &str) -> Vec<TextMatch> {
        let mut results = Vec::new();

        for entry in self.spatial_index.iter() {
            if let Some(ocr_path) = self.ocr_path(entry.tile_id) {
                if let Ok(ocr_data) = self.load_ocr(entry.tile_id) {
                    for region in &ocr_data.regions {
                        if region.text.to_lowercase().contains(&query.to_lowercase()) {
                            results.push(TextMatch {
                                tile_id: entry.tile_id,
                                text: region.text.clone(),
                                bounds: region.bounds,
                                confidence: region.confidence,
                            });
                        }
                    }
                }
            }
        }

        results
    }
}

/// Result of a text search
#[derive(Debug, Clone)]
pub struct TextMatch {
    pub tile_id: TileId,
    pub text: String,
    /// Bounds in original image coordinates
    pub bounds: TileBounds,
    pub confidence: f32,
}
```

## CLI Commands

### New Commands

```bash
# Capture with tiling enabled (default for large captures)
nib capture --tiled -o screenshot.tiles/
nib capture --tiled --tile-size 256 --zoom-levels 5

# Query a specific region (returns tile info + extracted data)
nib query screenshot.tiles/ --point 1920,1080
nib query screenshot.tiles/ --region 100,200,400,300

# Extract a region at full resolution
nib extract screenshot.tiles/ --region 100,200,400,300 -o region.png

# List tiles at a zoom level
nib tiles screenshot.tiles/ --zoom 2

# Run OCR on tiles (background or on-demand)
nib ocr screenshot.tiles/ --tiles all
nib ocr screenshot.tiles/ --tiles z3/2_1,z3/2_2

# Find text across tiles
nib find-text screenshot.tiles/ -s "error message"

# View tile info
nib tile-info screenshot.tiles/z2/1_0.png

# Render tiles to single image (for export)
nib stitch screenshot.tiles/ -o full.png --zoom 2
```

### Full CLI Command Implementations

```rust
// src/cli/commands.rs - tiled capture commands

use crate::capture::{TiledCapture, TileConfig, generate_tiles};
use crate::core::{TileId, TileBounds, TileError, TileResult};

/// Run tiled capture command
pub fn run_tiled_capture(args: CaptureArgs) -> TileResult<()> {
    info!("Running tiled capture with args: {:?}", args);

    // 1. Capture the screen (reuse existing capture logic)
    let screenshot = crate::capture::capture_screen(args.mode, args.display)?;

    // 2. Determine output directory
    let output_dir = args.output
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
            PathBuf::from(format!("capture_{}", timestamp))
        });

    // 3. Create tile config
    let config = TileConfig {
        tile_size: args.tile_size,
        zoom_levels: args.zoom_levels.unwrap_or_else(|| {
            calculate_auto_zoom_levels(screenshot.width(), screenshot.height(), args.tile_size)
        }),
        max_zoom: 0, // Calculated by generate_tiles
        format: TileFormat::Png,
    };

    // 4. Generate tiles
    let manifest = generate_tiles(&screenshot, &output_dir, &config)?;

    println!("Created tiled capture: {}", output_dir.display());
    println!("  Dimensions: {}x{}", manifest.source.width(), manifest.source.height());
    println!("  Zoom levels: {}", manifest.levels.len());
    println!("  Total tiles: {}", manifest.total_tile_count());

    // 5. Run OCR if enabled
    if args.ocr {
        println!("Running OCR on tiles...");
        let mut capture = TiledCapture::open(&output_dir)?;
        let ocr_zoom = manifest.tile_config.max_zoom;
        capture.ocr_all(ocr_zoom)?;
        println!("OCR complete.");
    }

    Ok(())
}

/// Run query command
pub fn run_query(args: QueryArgs) -> TileResult<()> {
    info!("Running query with args: {:?}", args);

    let mut capture = TiledCapture::open(&args.capture_dir)?;

    // Parse query type
    let result = if let Some(point_str) = &args.point {
        // Point query: "1920,1080"
        let coords: Vec<f64> = point_str
            .split(',')
            .map(|s| s.trim().parse().expect("Invalid coordinate"))
            .collect();

        let (x, y) = (coords[0], coords[1]);
        let zoom = args.zoom.unwrap_or(capture.manifest.tile_config.max_zoom);

        let tile = capture.tile_at_point(x, y, zoom)
            .ok_or_else(|| TileError::RegionOutOfBounds {
                x, y,
                width: capture.manifest.source.width(),
                height: capture.manifest.source.height(),
            })?;

        QueryResult::Point {
            x,
            y,
            tile_id: tile,
            tile_bounds: capture.tile_bounds(tile),
            ocr: if args.include_ocr {
                capture.load_ocr(tile).ok()
            } else {
                None
            },
        }
    } else if let Some(region_str) = &args.region {
        // Region query: "100,200,400,300"
        let coords: Vec<f64> = region_str
            .split(',')
            .map(|s| s.trim().parse().expect("Invalid coordinate"))
            .collect();

        let bounds = TileBounds {
            min_x: coords[0],
            min_y: coords[1],
            max_x: coords[0] + coords[2],
            max_y: coords[1] + coords[3],
        };

        let zoom = args.zoom.unwrap_or(capture.manifest.tile_config.max_zoom);
        let tiles = capture.tiles_in_region(&bounds, zoom);

        QueryResult::Region {
            bounds,
            tiles: tiles.iter().map(|t| TileInfo {
                id: *t,
                bounds: capture.tile_bounds(*t),
            }).collect(),
            ocr: if args.include_ocr {
                tiles.iter()
                    .filter_map(|t| capture.load_ocr(*t).ok())
                    .collect()
            } else {
                vec![]
            },
        }
    } else {
        return Err(TileError::InvalidManifest("No query specified".into()));
    };

    // Output result
    match args.format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        OutputFormat::Text => {
            println!("{}", result.to_text());
        }
    }

    Ok(())
}

/// Run extract command
pub fn run_extract(args: ExtractArgs) -> TileResult<()> {
    info!("Running extract with args: {:?}", args);

    let mut capture = TiledCapture::open(&args.capture_dir)?;

    // Parse region: "x,y,width,height"
    let coords: Vec<f64> = args.region
        .split(',')
        .map(|s| s.trim().parse().expect("Invalid coordinate"))
        .collect();

    let bounds = TileBounds {
        min_x: coords[0],
        min_y: coords[1],
        max_x: coords[0] + coords[2],
        max_y: coords[1] + coords[3],
    };

    // Extract at full resolution or scaled
    let extracted = if args.scale == 1.0 {
        capture.extract_region(&bounds)?
    } else {
        // Find zoom level closest to desired scale
        let zoom = capture.zoom_for_scale(args.scale);
        capture.extract_region_at_zoom(&bounds, zoom)?
    };

    // Save to output
    extracted.save(&args.output)?;

    println!("Extracted region to: {}", args.output.display());
    println!("  Size: {}x{}", extracted.width(), extracted.height());

    Ok(())
}

/// Run tiles list command
pub fn run_tiles_list(args: TilesListArgs) -> TileResult<()> {
    let capture = TiledCapture::open(&args.capture_dir)?;

    let zoom = args.zoom.unwrap_or(capture.manifest.tile_config.max_zoom);
    let level = capture.manifest.levels.get(zoom as usize)
        .ok_or(TileError::InvalidZoomLevel(zoom, capture.manifest.tile_config.max_zoom))?;

    println!("Tiles at zoom level {}:", zoom);
    println!("  Scale: {:.2}x", level.scale);
    println!("  Grid: {}x{}", level.grid_width, level.grid_height);
    println!("  Total: {} tiles", level.tile_count);
    println!();

    if args.verbose {
        for y in 0..level.grid_height {
            for x in 0..level.grid_width {
                let tile_id = TileId::new(zoom, x, y);
                let bounds = capture.tile_bounds(tile_id);
                println!("  z{}/{}_{}: ({:.0},{:.0}) - ({:.0},{:.0})",
                    zoom, x, y,
                    bounds.min_x, bounds.min_y,
                    bounds.max_x, bounds.max_y
                );
            }
        }
    }

    Ok(())
}

/// Query result types
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum QueryResult {
    Point {
        x: f64,
        y: f64,
        tile_id: TileId,
        tile_bounds: TileBounds,
        ocr: Option<TileOcrData>,
    },
    Region {
        bounds: TileBounds,
        tiles: Vec<TileInfo>,
        ocr: Vec<TileOcrData>,
    },
}

impl QueryResult {
    pub fn to_text(&self) -> String {
        match self {
            QueryResult::Point { x, y, tile_id, tile_bounds, ocr } => {
                let mut s = format!(
                    "Point ({}, {})\n  Tile: z{}/{}_{}\n  Bounds: ({:.0},{:.0}) - ({:.0},{:.0})",
                    x, y,
                    tile_id.zoom, tile_id.x, tile_id.y,
                    tile_bounds.min_x, tile_bounds.min_y,
                    tile_bounds.max_x, tile_bounds.max_y
                );
                if let Some(ocr_data) = ocr {
                    s.push_str(&format!("\n  OCR: {} regions", ocr_data.regions.len()));
                }
                s
            }
            QueryResult::Region { bounds, tiles, ocr } => {
                let mut s = format!(
                    "Region ({:.0},{:.0}) - ({:.0},{:.0})\n  Tiles: {}",
                    bounds.min_x, bounds.min_y,
                    bounds.max_x, bounds.max_y,
                    tiles.len()
                );
                for tile in tiles {
                    s.push_str(&format!("\n    z{}/{}_{}",
                        tile.id.zoom, tile.id.x, tile.id.y));
                }
                if !ocr.is_empty() {
                    let total_regions: usize = ocr.iter().map(|o| o.regions.len()).sum();
                    s.push_str(&format!("\n  OCR: {} regions across {} tiles",
                        total_regions, ocr.len()));
                }
                s
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TileInfo {
    pub id: TileId,
    pub bounds: TileBounds,
}
```

### CLI Argument Definitions

```rust
// src/cli/args.rs additions

#[derive(Parser, Debug)]
pub struct CaptureArgs {
    // ... existing fields ...

    /// Enable tiled capture for large images
    #[arg(long)]
    pub tiled: bool,

    /// Tile size in pixels (default: 512)
    #[arg(long, default_value = "512")]
    pub tile_size: u32,

    /// Number of zoom levels (default: auto-calculated)
    #[arg(long)]
    pub zoom_levels: Option<u8>,

    /// Minimum dimension to trigger automatic tiling (default: 2048)
    #[arg(long, default_value = "2048")]
    pub tile_threshold: u32,
}

#[derive(Parser, Debug)]
pub struct QueryArgs {
    /// Tiled capture directory
    pub capture_dir: PathBuf,

    /// Query by point (x,y)
    #[arg(long)]
    pub point: Option<String>,

    /// Query by region (x,y,width,height)
    #[arg(long)]
    pub region: Option<String>,

    /// Zoom level for query (default: max)
    #[arg(long)]
    pub zoom: Option<u8>,

    /// Output format
    #[arg(long, default_value = "json")]
    pub format: OutputFormat,

    /// Include OCR data in response
    #[arg(long)]
    pub include_ocr: bool,
}

#[derive(Parser, Debug)]
pub struct ExtractArgs {
    /// Tiled capture directory
    pub capture_dir: PathBuf,

    /// Region to extract (x,y,width,height)
    #[arg(short, long)]
    pub region: String,

    /// Output file
    #[arg(short, long)]
    pub output: PathBuf,

    /// Scale factor (default: 1.0 = full resolution)
    #[arg(long, default_value = "1.0")]
    pub scale: f64,
}
```

## Integration with Existing Systems

### Annotation System Integration

Annotations continue to use original image coordinates. The tile system transparently maps between coordinate spaces:

```rust
// src/core/types.rs additions

impl Annotation {
    /// Get tiles that this annotation intersects
    pub fn intersecting_tiles(&self, capture: &TiledCapture, zoom: u8) -> Vec<TileId> {
        let bounds = self.bounds();
        capture.tiles_in_region(&TileBounds {
            min_x: bounds.x,
            min_y: bounds.y,
            max_x: bounds.x + bounds.width,
            max_y: bounds.y + bounds.height,
        }, zoom)
    }
}

// Annotations file includes tile references for efficient loading
#[derive(Debug, Serialize, Deserialize)]
pub struct TiledAnnotation {
    /// Core annotation data (unchanged)
    #[serde(flatten)]
    pub annotation: SerializedAnnotation,

    /// Tiles this annotation touches (computed, not stored)
    #[serde(skip)]
    pub tile_refs: Vec<TileId>,
}
```

### Storage Index Integration

```rust
// src/storage/index.rs additions

impl Index {
    /// Add a tiled capture to the index
    pub fn index_tiled_capture(&self, capture: &TiledCapture) -> StorageResult<i64> {
        let manifest = &capture.manifest;

        self.conn.execute(
            r#"
            INSERT INTO tiled_captures (
                path, capture_id, width, height,
                tile_count, zoom_levels, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                capture.root_dir.to_string_lossy(),
                manifest.capture_id,
                manifest.source.width(),
                manifest.source.height(),
                manifest.total_tile_count(),
                manifest.tile_config.zoom_levels,
                manifest.created_at.timestamp(),
            ],
        )?;

        Ok(self.conn.last_insert_rowid())
    }
}
```

### OCR Integration

Per-tile OCR enables more accurate text recognition and efficient spatial queries:

```rust
// src/ocr/tile_ocr.rs

/// OCR data for a single tile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileOcrData {
    pub tile_id: TileId,
    pub processed_at: chrono::DateTime<chrono::Utc>,
    pub engine_version: String,
    pub regions: Vec<OcrRegion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrRegion {
    pub text: String,
    /// Bounds in tile-local coordinates
    pub local_bounds: TileBounds,
    /// Bounds in original image coordinates
    pub global_bounds: TileBounds,
    pub confidence: f32,
    pub line_index: u32,
    pub word_index: u32,
}

impl TiledCapture {
    /// Run OCR on a specific tile
    pub fn ocr_tile(&self, tile_id: TileId) -> Result<TileOcrData> {
        let tile_path = self.root_dir.join("tiles").join(tile_id.to_path());
        let regions = crate::ocr::extract_text_regions(&tile_path)?;

        // Convert to global coordinates
        let tile_bounds = self.tile_bounds(tile_id);
        let global_regions: Vec<OcrRegion> = regions
            .into_iter()
            .map(|r| OcrRegion {
                text: r.text,
                local_bounds: TileBounds {
                    min_x: r.x as f64,
                    min_y: r.y as f64,
                    max_x: (r.x + r.width) as f64,
                    max_y: (r.y + r.height) as f64,
                },
                global_bounds: TileBounds {
                    min_x: tile_bounds.min_x + r.x as f64,
                    min_y: tile_bounds.min_y + r.y as f64,
                    max_x: tile_bounds.min_x + (r.x + r.width) as f64,
                    max_y: tile_bounds.min_y + (r.y + r.height) as f64,
                },
                confidence: r.confidence,
                line_index: 0,
                word_index: 0,
            })
            .collect();

        Ok(TileOcrData {
            tile_id,
            processed_at: chrono::Utc::now(),
            engine_version: "ocrs-0.8".to_string(),
            regions: global_regions,
        })
    }

    /// Run OCR on all tiles at specified zoom level
    pub fn ocr_all(&self, zoom: u8) -> Result<()> {
        let level = self.manifest.levels.get(zoom as usize)
            .ok_or_else(|| anyhow::anyhow!("Invalid zoom level"))?;

        for y in 0..level.grid_height {
            for x in 0..level.grid_width {
                let tile_id = TileId::new(zoom, x, y);
                let ocr_data = self.ocr_tile(tile_id)?;
                self.save_ocr(tile_id, &ocr_data)?;
            }
        }

        Ok(())
    }
}
```

## AI Context Optimization

The tiled system is designed to optimize AI context windows:

```rust
// src/ai/context.rs

/// Generate optimal context for AI consumption
pub struct AiContextBuilder {
    capture: TiledCapture,
    max_tiles: usize,
    max_bytes: usize,
}

impl AiContextBuilder {
    /// Build context for a specific region of interest
    pub fn context_for_region(&mut self, region: &TileBounds) -> AiContext {
        // 1. Get tiles at appropriate zoom for AI vision models
        let zoom = self.optimal_zoom_for_ai(region);
        let tiles = self.capture.tiles_in_region(region, zoom);

        // 2. Prioritize tiles by relevance
        let prioritized = self.prioritize_tiles(&tiles, region);

        // 3. Build context within budget
        let mut context = AiContext::new();
        let mut bytes_used = 0;

        for tile_id in prioritized.iter().take(self.max_tiles) {
            let tile = self.capture.load_tile(*tile_id)?;
            let tile_bytes = tile.as_bytes().len();

            if bytes_used + tile_bytes > self.max_bytes {
                break;
            }

            context.add_tile(*tile_id, tile, self.capture.tile_bounds(*tile_id));
            bytes_used += tile_bytes;

            // Include OCR if available
            if let Ok(ocr) = self.capture.load_ocr(*tile_id) {
                context.add_ocr(*tile_id, ocr);
            }
        }

        context
    }

    /// Determine optimal zoom level for AI vision
    fn optimal_zoom_for_ai(&self, region: &TileBounds) -> u8 {
        // AI vision models typically work well with ~512-1024px tiles
        // Choose zoom level that gives reasonable detail without overload
        let max_zoom = self.capture.manifest.tile_config.max_zoom;
        let tile_size = self.capture.manifest.tile_config.tile_size;

        // If region is small, use max zoom
        // If region is large, use lower zoom for overview
        let region_area = region.width() * region.height();
        let tile_area = (tile_size * tile_size) as f64;

        if region_area < tile_area * 4.0 {
            max_zoom
        } else if region_area < tile_area * 16.0 {
            max_zoom.saturating_sub(1)
        } else {
            max_zoom.saturating_sub(2)
        }
    }
}

#[derive(Debug)]
pub struct AiContext {
    pub tiles: Vec<(TileId, TileBounds, Vec<u8>)>,
    pub ocr_data: Vec<(TileId, TileOcrData)>,
    pub annotations: Vec<TiledAnnotation>,
}
```

## Implementation Phases

### Phase 1: Core Tile Infrastructure (Week 1-2)

1. **Define core types** in `src/core/tile.rs`
   - `TileId`, `TileConfig`, `TileBounds`, `TiledCaptureManifest`
   - Serialization/deserialization with serde

2. **Implement tile generation** in `src/capture/tiled.rs`
   - Generate tiles from captured image
   - Create zoom level pyramid
   - Write manifest.json

3. **Basic file I/O**
   - Load/save individual tiles
   - Parse manifest

### Phase 2: Spatial Index and Queries (Week 2-3)

1. **Integrate R-tree** (using `rstar` crate)
   - Build index from manifest
   - Persist index for fast loading

2. **Implement query API**
   - `tile_at_point()`
   - `tiles_in_region()`
   - `tiles_in_viewport()`

3. **Region extraction**
   - Stitch tiles for region export
   - Handle edge cases (partial tiles)

### Phase 3: CLI Commands (Week 3)

1. **Extend capture command**
   - `--tiled` flag
   - Auto-tiling for large captures

2. **New query commands**
   - `nib query`
   - `nib extract`
   - `nib tiles`

3. **Update existing commands**
   - `nib render` works with tiled captures
   - `nib find-text` uses per-tile OCR

### Phase 4: OCR Integration (Week 4)

1. **Per-tile OCR processing**
   - Generate OCR for each tile
   - Store in ocr/ subdirectory

2. **Coordinate mapping**
   - Tile-local to global coordinates
   - Include in spatial index

3. **Text search across tiles**
   - Fast lookup via spatial index
   - Return tile + coordinates

### Phase 5: Annotation Integration (Week 4-5)

1. **Coordinate system compatibility**
   - Annotations use original coordinates
   - Transparent mapping in tile system

2. **Efficient annotation rendering**
   - Only load tiles touched by annotations
   - Render annotations on tile boundaries

3. **Sidecar file updates**
   - Track tile references
   - Efficient partial updates

### Phase 6: GUI Integration (Future)

1. **Viewport-based tile loading**
   - Load visible tiles only
   - Prefetch adjacent tiles

2. **Progressive rendering**
   - Show low-zoom overview first
   - Load detail tiles on zoom

3. **LRU tile cache**
   - Memory-efficient tile management
   - Configurable cache size

## Testing Strategy

### Unit Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tile_id_path() {
        let tile = TileId::new(2, 3, 1);
        assert_eq!(tile.to_path(), PathBuf::from("z2/3_1.png"));
    }

    #[test]
    fn test_tile_parent_child() {
        let tile = TileId::new(2, 2, 3);
        let parent = tile.parent().unwrap();
        assert_eq!(parent, TileId::new(1, 1, 1));

        let children = parent.children();
        assert!(children.contains(&tile));
    }

    #[test]
    fn test_tile_bounds_intersection() {
        let a = TileBounds { min_x: 0.0, min_y: 0.0, max_x: 100.0, max_y: 100.0 };
        let b = TileBounds { min_x: 50.0, min_y: 50.0, max_x: 150.0, max_y: 150.0 };
        let c = TileBounds { min_x: 200.0, min_y: 200.0, max_x: 300.0, max_y: 300.0 };

        assert!(a.intersects(&b));
        assert!(!a.intersects(&c));
    }

    #[test]
    fn test_spatial_query() {
        let capture = create_test_tiled_capture();
        let tiles = capture.tiles_in_region(
            &TileBounds { min_x: 500.0, min_y: 500.0, max_x: 700.0, max_y: 700.0 },
            2
        );
        assert!(!tiles.is_empty());
    }
}
```

### Integration Tests

```rust
#[test]
fn test_end_to_end_tiled_capture() {
    // 1. Capture with tiling
    let capture = capture_tiled(test_display_id(), TileConfig::default()).unwrap();

    // 2. Query a point
    let tile = capture.tile_at_point(100.0, 100.0, 2).unwrap();
    assert!(tile.zoom == 2);

    // 3. Extract region
    let region = capture.extract_region(&TileBounds {
        min_x: 0.0, min_y: 0.0, max_x: 200.0, max_y: 200.0
    }).unwrap();
    assert!(region.width() > 0);

    // 4. OCR
    capture.ocr_all(2).unwrap();
    let matches = capture.find_text("test");

    // 5. Add annotation
    let annotation = Annotation::new(AnnotationType::Box { ... });
    let tiles = annotation.intersecting_tiles(&capture, 2);
    assert!(!tiles.is_empty());
}
```

## Performance Considerations

### Memory Budget

- Default tile cache: 64 tiles (512x512 RGBA = 1MB each = 64MB max)
- Configurable via `NIB_TILE_CACHE_SIZE` env var
- LRU eviction for least-recently-used tiles

### Disk I/O

- Tiles stored as compressed PNG (lossy WebP optional)
- Manifest cached in memory
- OCR results lazy-loaded on demand

### Parallel Processing

- Tile generation uses rayon for parallelism
- OCR can run on multiple tiles concurrently
- R-tree queries are thread-safe

## Dependencies

```toml
# Cargo.toml additions
[dependencies]
rstar = "0.11"              # R-tree spatial index
lru = "0.12"                # LRU cache for tiles
rayon = "1.8"               # Parallel tile processing (already in project)
bincode = "1.3"             # Binary serialization for spatial index
thiserror = "1.0"           # Error derive macros (already in project)

# Optional: better compression
[dependencies.image]
version = "0.25"
features = ["webp"]         # WebP support for smaller tiles
```

## Module Structure

```
src/
  core/
    mod.rs
    tile.rs          # TileId, TileConfig, TileBounds, ZoomLevel
    tile_error.rs    # TileError enum, TileResult type alias
  capture/
    mod.rs
    tiled.rs         # generate_tiles(), generate_level_tiles(), extract_tile()
    spatial_index.rs # build_spatial_index(), save/load_spatial_index()
    extract.rs       # extract_region(), extract_region_at_zoom()
    tile_query.rs    # TiledCapture query methods
  cli/
    args.rs          # Add CaptureArgs::tiled, QueryArgs, ExtractArgs
    commands.rs      # run_tiled_capture(), run_query(), run_extract()
  ocr/
    tile_ocr.rs      # TileOcrData, per-tile OCR processing
  ai/
    context.rs       # AiContextBuilder for optimized AI context
```

## Future Enhancements

1. **Streaming captures**: Generate tiles during scrolling capture
2. **Delta updates**: Update only changed tiles on re-capture
3. **Remote tile storage**: S3/GCS backend for large captures
4. **Tile compression**: AVIF support for smaller files
5. **Vector annotations**: Resolution-independent annotations
6. **Multi-capture compositing**: Stitch multiple tiled captures
