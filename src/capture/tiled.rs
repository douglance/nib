//! Tiled capture generation
//!
//! This module handles generating tile pyramids from source images.
//! Tiles are organized in a hierarchical structure similar to web map tiles.

use crate::core::{
    calculate_zoom_levels, tile_global_bounds, TileBounds, TileConfig, TileEntry, TileError,
    TileId, TileResult, TiledCaptureManifest, TiledImageSource, TiledOcrConfig, ZoomLevel,
};
use chrono::Utc;
use image::{imageops::FilterType, RgbaImage};
use rayon::prelude::*;
use rstar::RTree;
use std::fs;
use std::io::{BufReader, BufWriter};
use std::num::NonZeroUsize;
use std::path::Path;

/// Generate a unique capture ID based on timestamp
pub fn generate_capture_id() -> String {
    Utc::now().format("capture_%Y%m%d_%H%M%S").to_string()
}

/// Generate all tiles for a source image
///
/// Creates a tile pyramid with multiple zoom levels, from overview to full resolution.
/// The output directory will contain:
/// - `manifest.json` - Metadata about the capture
/// - `tiles/z0/`, `tiles/z1/`, etc. - Tile images at each zoom level
/// - `spatial.idx` - Binary spatial index for fast queries
pub fn generate_tiles(
    source: &RgbaImage,
    output_dir: &Path,
    config: &TileConfig,
) -> TileResult<TiledCaptureManifest> {
    let (width, height) = source.dimensions();

    // Calculate zoom levels based on image dimensions
    let levels = calculate_zoom_levels(width, height, config.tile_size);
    let max_zoom = levels.last().map(|l| l.zoom).unwrap_or(0);

    // Create directory structure
    if output_dir.exists() {
        return Err(TileError::DirectoryExists(output_dir.to_path_buf()));
    }
    fs::create_dir_all(output_dir)?;

    let tiles_dir = output_dir.join("tiles");
    for level in &levels {
        fs::create_dir_all(tiles_dir.join(format!("z{}", level.zoom)))?;
    }

    // Create OCR directory
    fs::create_dir_all(output_dir.join("ocr"))?;

    // Generate tiles for each zoom level
    for level in &levels {
        generate_level_tiles(source, &tiles_dir, level, config)?;
    }

    // Build manifest
    let manifest = TiledCaptureManifest {
        version: "1.0.0".to_string(),
        capture_id: generate_capture_id(),
        created_at: Utc::now(),
        source: TiledImageSource::Generated { width, height },
        tile_config: TileConfig {
            tile_size: config.tile_size,
            zoom_levels: levels.len() as u8,
            max_zoom,
            format: config.format,
        },
        levels: levels.clone(),
        ocr: TiledOcrConfig {
            enabled: true,
            min_zoom: max_zoom.saturating_sub(1),
            engine: "ocrs".to_string(),
        },
    };

    // Write manifest
    let manifest_path = output_dir.join("manifest.json");
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    fs::write(&manifest_path, manifest_json)?;

    // Build and save spatial index
    let spatial_index = build_spatial_index(&manifest);
    let index_path = output_dir.join("spatial.idx");
    save_spatial_index(&spatial_index, &index_path)?;

    Ok(manifest)
}

/// Generate tiles for a single zoom level
fn generate_level_tiles(
    source: &RgbaImage,
    tiles_dir: &Path,
    level: &ZoomLevel,
    config: &TileConfig,
) -> TileResult<()> {
    // Scale source image to this zoom level if needed
    let scaled: RgbaImage = if level.scale < 1.0 {
        image::imageops::resize(
            source,
            level.scaled_width,
            level.scaled_height,
            FilterType::Lanczos3, // High quality downscaling
        )
    } else {
        source.clone()
    };

    // Generate tile coordinates
    let tile_coords: Vec<(u32, u32)> = (0..level.grid_height)
        .flat_map(|y| (0..level.grid_width).map(move |x| (x, y)))
        .collect();

    // Generate tiles in parallel
    tile_coords
        .par_iter()
        .try_for_each(|(tx, ty)| -> TileResult<()> {
            let tile = extract_tile(&scaled, *tx, *ty, config.tile_size);
            let tile_path = tiles_dir
                .join(format!("z{}", level.zoom))
                .join(format!("{}_{}.png", tx, ty));

            tile.save(&tile_path).map_err(|e| {
                TileError::TileGenerationFailed {
                    zoom: level.zoom,
                    x: *tx,
                    y: *ty,
                    reason: e.to_string(),
                }
            })?;

            Ok(())
        })?;

    Ok(())
}

/// Extract a single tile from a scaled image
///
/// Handles edge tiles that may be smaller than the full tile size by
/// padding with transparent pixels.
fn extract_tile(source: &RgbaImage, tx: u32, ty: u32, tile_size: u32) -> RgbaImage {
    let (src_width, src_height) = source.dimensions();

    let x_start = tx * tile_size;
    let y_start = ty * tile_size;

    // Handle edge tiles that may be smaller
    let tile_width = tile_size.min(src_width.saturating_sub(x_start));
    let tile_height = tile_size.min(src_height.saturating_sub(y_start));

    // Create tile with transparent background for edge padding
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

/// Save spatial index to binary file for fast loading
pub fn save_spatial_index(index: &RTree<TileEntry>, path: &Path) -> TileResult<()> {
    let file = fs::File::create(path)?;
    let writer = BufWriter::new(file);

    // Serialize entries (R-tree itself isn't directly serializable)
    let entries: Vec<_> = index.iter().cloned().collect();
    bincode::serialize_into(writer, &entries)
        .map_err(|e| TileError::SpatialIndexCorrupted(e.to_string()))?;

    Ok(())
}

/// Load spatial index from binary file
pub fn load_spatial_index(path: &Path) -> TileResult<RTree<TileEntry>> {
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);

    let entries: Vec<TileEntry> = bincode::deserialize_from(reader)
        .map_err(|e| TileError::SpatialIndexCorrupted(e.to_string()))?;

    Ok(RTree::bulk_load(entries))
}

/// A tiled capture session with tile loading and spatial queries
pub struct TiledCapture {
    /// Root directory for this capture
    pub root_dir: std::path::PathBuf,
    /// Manifest with metadata
    pub manifest: TiledCaptureManifest,
    /// Loaded tiles cache (LRU)
    tile_cache: lru::LruCache<TileId, RgbaImage>,
    /// Spatial index for fast lookups
    spatial_index: RTree<TileEntry>,
}

impl TiledCapture {
    /// Default cache size (64 tiles = ~64MB for 512px RGBA tiles)
    const DEFAULT_CACHE_SIZE: usize = 64;

    /// Open an existing tiled capture from a directory
    pub fn open(path: &Path) -> TileResult<Self> {
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            return Err(TileError::ManifestNotFound(manifest_path));
        }

        let manifest_str = fs::read_to_string(&manifest_path)?;
        let manifest: TiledCaptureManifest = serde_json::from_str(&manifest_str)
            .map_err(|e| TileError::InvalidManifest(e.to_string()))?;

        // Load or build spatial index
        let index_path = path.join("spatial.idx");
        let spatial_index = if index_path.exists() {
            load_spatial_index(&index_path)?
        } else {
            let index = build_spatial_index(&manifest);
            save_spatial_index(&index, &index_path)?;
            index
        };

        // Get cache size from environment or use default
        let cache_size = std::env::var("QUILL_TILE_CACHE_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(Self::DEFAULT_CACHE_SIZE);

        Ok(Self {
            root_dir: path.to_path_buf(),
            manifest,
            tile_cache: lru::LruCache::new(NonZeroUsize::new(cache_size).unwrap()),
            spatial_index,
        })
    }

    /// Load a tile image (with LRU caching)
    pub fn load_tile(&mut self, tile_id: TileId) -> TileResult<&RgbaImage> {
        // Validate tile exists in manifest
        let level = self
            .manifest
            .levels
            .get(tile_id.zoom as usize)
            .ok_or(TileError::InvalidZoomLevel(
                tile_id.zoom,
                self.manifest.tile_config.max_zoom,
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
            let tile_path = self.root_dir.join("tiles").join(tile_id.to_path());

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
            self.manifest.tile_config.tile_size,
        )
    }

    /// Get image dimensions
    pub fn image_dimensions(&self) -> (u32, u32) {
        self.manifest.dimensions()
    }

    /// Find zoom level closest to a target scale factor
    pub fn zoom_for_scale(&self, target_scale: f64) -> u8 {
        self.manifest
            .levels
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
        self.manifest.total_tile_count()
    }

    /// Find tile containing a point at the specified zoom level
    pub fn tile_at_point(&self, x: f64, y: f64, zoom: u8) -> Option<TileId> {
        let level = self.manifest.levels.get(zoom as usize)?;
        let tile_size = self.manifest.tile_config.tile_size as f64;

        // Scale point to this zoom level
        let scaled_x = x * level.scale;
        let scaled_y = y * level.scale;

        let tile_x = (scaled_x / tile_size).floor() as u32;
        let tile_y = (scaled_y / tile_size).floor() as u32;

        if tile_x < level.grid_width && tile_y < level.grid_height {
            Some(TileId::new(zoom, tile_x, tile_y))
        } else {
            None
        }
    }

    /// Find tile containing a point at max zoom (full resolution)
    pub fn tile_at_point_max_zoom(&self, x: f64, y: f64) -> Option<TileEntry> {
        let point = [x, y];
        // locate_at_point returns Option, so we filter after
        self.spatial_index
            .locate_at_point(&point)
            .filter(|e| e.tile_id.zoom == self.manifest.tile_config.max_zoom)
            .cloned()
    }

    /// Find all tiles intersecting a region at a specific zoom level
    pub fn tiles_intersecting(&self, bounds: &TileBounds, zoom: u8) -> Vec<TileEntry> {
        let envelope = rstar::AABB::from_corners(
            [bounds.min_x, bounds.min_y],
            [bounds.max_x, bounds.max_y],
        );

        self.spatial_index
            .locate_in_envelope_intersecting(&envelope)
            .filter(|e| e.tile_id.zoom == zoom)
            .cloned()
            .collect()
    }

    /// Get tiles visible in a viewport (for GUI rendering)
    pub fn tiles_in_viewport(&self, viewport: &TileBounds, viewport_scale: f64) -> Vec<TileId> {
        let zoom = self.zoom_for_scale(viewport_scale);
        self.tiles_intersecting(viewport, zoom)
            .into_iter()
            .map(|e| e.tile_id)
            .collect()
    }

    /// Find nearest tiles to a point (useful for prefetching)
    pub fn nearest_tiles(&self, x: f64, y: f64, count: usize, zoom: u8) -> Vec<TileEntry> {
        self.spatial_index
            .nearest_neighbor_iter(&[x, y])
            .filter(|e| e.tile_id.zoom == zoom)
            .take(count)
            .cloned()
            .collect()
    }

    /// Prefetch tiles likely to be needed soon
    pub fn prefetch(&mut self, center: (f64, f64), zoom: u8, radius: usize) {
        let tiles = self.nearest_tiles(center.0, center.1, radius * radius, zoom);
        for entry in tiles {
            let _ = self.load_tile(entry.tile_id);
        }
    }

    /// Clear the tile cache
    pub fn clear_cache(&mut self) {
        self.tile_cache.clear();
    }

    /// Get path to OCR data for a tile
    pub fn ocr_path(&self, tile_id: TileId) -> std::path::PathBuf {
        self.root_dir
            .join("ocr")
            .join(format!("z{}_{}_{}.json", tile_id.zoom, tile_id.x, tile_id.y))
    }

    /// Extract a region at full resolution by stitching tiles
    pub fn extract_region(&mut self, region: &TileBounds) -> TileResult<RgbaImage> {
        // Validate region is within image bounds
        let (img_width, img_height) = self.image_dimensions();
        if region.min_x < 0.0
            || region.min_y < 0.0
            || region.max_x > img_width as f64
            || region.max_y > img_height as f64
        {
            return Err(TileError::RegionOutOfBounds {
                x: region.min_x,
                y: region.min_y,
                width: img_width,
                height: img_height,
            });
        }

        let max_zoom = self.manifest.tile_config.max_zoom;

        // Get tiles that cover this region
        let tiles = self.tiles_intersecting(region, max_zoom);

        // Create output image
        let out_width = region.width().ceil() as u32;
        let out_height = region.height().ceil() as u32;
        let mut output = RgbaImage::new(out_width, out_height);

        // Copy relevant pixels from each tile
        for entry in &tiles {
            let tile_img = self.load_tile(entry.tile_id)?.clone();
            let tile_bounds = &entry.bounds;

            // Calculate intersection between tile and requested region
            let intersect = match region.intersection(tile_bounds) {
                Some(i) => i,
                None => continue,
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

            // Copy pixels
            for y in 0..copy_height {
                for x in 0..copy_width {
                    let sx = src_x + x;
                    let sy = src_y + y;
                    let dx = dst_x + x;
                    let dy = dst_y + y;

                    if sx < tile_img.width()
                        && sy < tile_img.height()
                        && dx < out_width
                        && dy < out_height
                    {
                        let pixel = tile_img.get_pixel(sx, sy);
                        output.put_pixel(dx, dy, *pixel);
                    }
                }
            }
        }

        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_image(width: u32, height: u32) -> RgbaImage {
        let mut img = RgbaImage::new(width, height);
        // Fill with a gradient pattern for easy verification
        for y in 0..height {
            for x in 0..width {
                let r = ((x as f32 / width as f32) * 255.0) as u8;
                let g = ((y as f32 / height as f32) * 255.0) as u8;
                let b = 128;
                img.put_pixel(x, y, image::Rgba([r, g, b, 255]));
            }
        }
        img
    }

    #[test]
    fn test_generate_tiles_creates_structure() {
        let temp_dir = TempDir::new().unwrap();
        let output_dir = temp_dir.path().join("capture");

        let source = create_test_image(1024, 1024);
        let config = TileConfig::for_image(1024, 1024, 512);

        let manifest = generate_tiles(&source, &output_dir, &config).unwrap();

        // Check directory structure
        assert!(output_dir.join("manifest.json").exists());
        assert!(output_dir.join("tiles").exists());
        assert!(output_dir.join("spatial.idx").exists());

        // Check tiles exist
        for level in &manifest.levels {
            let level_dir = output_dir.join("tiles").join(format!("z{}", level.zoom));
            assert!(level_dir.exists());

            for y in 0..level.grid_height {
                for x in 0..level.grid_width {
                    let tile_path = level_dir.join(format!("{}_{}.png", x, y));
                    assert!(tile_path.exists(), "Missing tile: {:?}", tile_path);
                }
            }
        }
    }

    #[test]
    fn test_generate_tiles_manifest_content() {
        let temp_dir = TempDir::new().unwrap();
        let output_dir = temp_dir.path().join("capture");

        let source = create_test_image(1024, 1024);
        let config = TileConfig::for_image(1024, 1024, 512);

        let manifest = generate_tiles(&source, &output_dir, &config).unwrap();

        assert_eq!(manifest.version, "1.0.0");
        assert!(!manifest.levels.is_empty());
        assert_eq!(manifest.source.width(), 1024);
        assert_eq!(manifest.source.height(), 1024);

        // Max zoom should be full resolution
        let max_level = manifest.levels.last().unwrap();
        assert_eq!(max_level.scale, 1.0);
    }

    #[test]
    fn test_open_tiled_capture() {
        let temp_dir = TempDir::new().unwrap();
        let output_dir = temp_dir.path().join("capture");

        let source = create_test_image(1024, 1024);
        let config = TileConfig::for_image(1024, 1024, 512);
        generate_tiles(&source, &output_dir, &config).unwrap();

        // Open the capture
        let capture = TiledCapture::open(&output_dir).unwrap();
        assert_eq!(capture.image_dimensions(), (1024, 1024));
    }

    #[test]
    fn test_load_tile() {
        let temp_dir = TempDir::new().unwrap();
        let output_dir = temp_dir.path().join("capture");

        let source = create_test_image(1024, 1024);
        let config = TileConfig::for_image(1024, 1024, 512);
        generate_tiles(&source, &output_dir, &config).unwrap();

        let mut capture = TiledCapture::open(&output_dir).unwrap();
        let max_zoom = capture.manifest.tile_config.max_zoom;

        // Load a tile
        let tile_id = TileId::new(max_zoom, 0, 0);
        let tile = capture.load_tile(tile_id).unwrap();

        assert_eq!(tile.width(), 512);
        assert_eq!(tile.height(), 512);
    }

    #[test]
    fn test_tile_at_point() {
        let temp_dir = TempDir::new().unwrap();
        let output_dir = temp_dir.path().join("capture");

        let source = create_test_image(1024, 1024);
        let config = TileConfig::for_image(1024, 1024, 512);
        generate_tiles(&source, &output_dir, &config).unwrap();

        let capture = TiledCapture::open(&output_dir).unwrap();
        let max_zoom = capture.manifest.tile_config.max_zoom;

        // Point in first tile
        let tile = capture.tile_at_point(100.0, 100.0, max_zoom).unwrap();
        assert_eq!(tile.x, 0);
        assert_eq!(tile.y, 0);

        // Point in second tile (x direction)
        let tile = capture.tile_at_point(600.0, 100.0, max_zoom).unwrap();
        assert_eq!(tile.x, 1);
        assert_eq!(tile.y, 0);
    }

    #[test]
    fn test_tiles_intersecting() {
        let temp_dir = TempDir::new().unwrap();
        let output_dir = temp_dir.path().join("capture");

        let source = create_test_image(1024, 1024);
        let config = TileConfig::for_image(1024, 1024, 512);
        generate_tiles(&source, &output_dir, &config).unwrap();

        let capture = TiledCapture::open(&output_dir).unwrap();
        let max_zoom = capture.manifest.tile_config.max_zoom;

        // Region spanning all 4 tiles
        let region = TileBounds::from_corners(256.0, 256.0, 768.0, 768.0);
        let tiles = capture.tiles_intersecting(&region, max_zoom);

        assert_eq!(tiles.len(), 4);
    }

    #[test]
    fn test_extract_region() {
        let temp_dir = TempDir::new().unwrap();
        let output_dir = temp_dir.path().join("capture");

        let source = create_test_image(1024, 1024);
        let config = TileConfig::for_image(1024, 1024, 512);
        generate_tiles(&source, &output_dir, &config).unwrap();

        let mut capture = TiledCapture::open(&output_dir).unwrap();

        // Extract a 200x200 region
        let region = TileBounds::from_corners(100.0, 100.0, 300.0, 300.0);
        let extracted = capture.extract_region(&region).unwrap();

        assert_eq!(extracted.width(), 200);
        assert_eq!(extracted.height(), 200);
    }

    #[test]
    fn test_spatial_index_persistence() {
        let temp_dir = TempDir::new().unwrap();
        let output_dir = temp_dir.path().join("capture");

        let source = create_test_image(1024, 1024);
        let config = TileConfig::for_image(1024, 1024, 512);
        let manifest = generate_tiles(&source, &output_dir, &config).unwrap();

        // Load index from file
        let index_path = output_dir.join("spatial.idx");
        let loaded_index = load_spatial_index(&index_path).unwrap();

        // Verify entry count matches
        let expected_count: usize = manifest.levels.iter().map(|l| l.tile_count as usize).sum();
        assert_eq!(loaded_index.size(), expected_count);
    }

    #[test]
    fn test_extract_tile_edge_handling() {
        // Create image that doesn't evenly divide by tile size
        let source = create_test_image(700, 500);

        // Extract edge tile
        let tile = extract_tile(&source, 1, 0, 512);
        assert_eq!(tile.width(), 512);
        assert_eq!(tile.height(), 512);

        // Verify edge pixels are transparent (padding)
        let edge_pixel = tile.get_pixel(511, 0);
        assert_eq!(edge_pixel[3], 0, "Edge should be transparent padding");
    }
}
