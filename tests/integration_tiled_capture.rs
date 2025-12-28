//! Integration tests for the tiled capture system
//!
//! These tests verify the complete round-trip workflow:
//! 1. Generate a tiled capture from a test image
//! 2. Verify manifest.json contains expected tile metadata
//! 3. Verify spatial.idx binary file exists and is loadable
//! 4. Verify tiles/z0/0_0.png exists (overview tile)
//! 5. Verify tile pyramid structure matches expected zoom levels
//! 6. Verify TiledCapture can open and query the capture

use image::RgbaImage;
use quill::capture::tiled::{generate_tiles, load_spatial_index, TiledCapture};
use quill::core::{TileBounds, TileConfig, TileId};
use std::fs;
use tempfile::TempDir;

/// Create a test image with a gradient pattern for visual verification
fn create_gradient_test_image(width: u32, height: u32) -> RgbaImage {
    let mut img = RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let r = ((x as f32 / width as f32) * 255.0) as u8;
            let g = ((y as f32 / height as f32) * 255.0) as u8;
            let b = 128u8;
            img.put_pixel(x, y, image::Rgba([r, g, b, 255]));
        }
    }
    img
}

/// Full round-trip integration test for tiled capture system
#[test]
fn test_full_round_trip_tiled_capture() {
    let temp_dir = TempDir::new().expect("Failed to create temp directory");
    let output_dir = temp_dir.path().join("integration_capture");

    // ========================================================
    // STEP 1: Generate a tiled capture from a test image
    // ========================================================
    let source = create_gradient_test_image(2048, 1536);
    let config = TileConfig::for_image(2048, 1536, 512);

    let manifest = generate_tiles(&source, &output_dir, &config)
        .expect("Failed to generate tiled capture");

    // ========================================================
    // STEP 2: Verify manifest.json exists and contains expected metadata
    // ========================================================
    let manifest_path = output_dir.join("manifest.json");
    assert!(
        manifest_path.exists(),
        "manifest.json should exist at {:?}",
        manifest_path
    );

    // Parse manifest from disk to verify serialization
    let manifest_content =
        fs::read_to_string(&manifest_path).expect("Failed to read manifest.json");
    let parsed_manifest: serde_json::Value =
        serde_json::from_str(&manifest_content).expect("Failed to parse manifest.json");

    // Verify required manifest fields
    assert_eq!(parsed_manifest["version"], "1.0.0");
    assert!(parsed_manifest["capture_id"].is_string());
    assert!(parsed_manifest["created_at"].is_string());
    assert!(parsed_manifest["levels"].is_array());
    assert!(parsed_manifest["tile_config"]["tile_size"].as_u64().unwrap() == 512);

    // Verify source dimensions in manifest
    let source_section = &parsed_manifest["source"];
    assert_eq!(source_section["width"].as_u64().unwrap(), 2048);
    assert_eq!(source_section["height"].as_u64().unwrap(), 1536);

    // ========================================================
    // STEP 3: Verify spatial.idx binary file exists and is loadable
    // ========================================================
    let spatial_idx_path = output_dir.join("spatial.idx");
    assert!(
        spatial_idx_path.exists(),
        "spatial.idx should exist at {:?}",
        spatial_idx_path
    );

    // Verify we can load the spatial index
    let loaded_index =
        load_spatial_index(&spatial_idx_path).expect("Failed to load spatial index");

    // Verify entry count matches manifest total tile count
    let expected_tile_count: usize = manifest.levels.iter().map(|l| l.tile_count as usize).sum();
    assert_eq!(
        loaded_index.size(),
        expected_tile_count,
        "Spatial index should contain {} entries, got {}",
        expected_tile_count,
        loaded_index.size()
    );

    // ========================================================
    // STEP 4: Verify tiles/z0/0_0.png exists (overview tile)
    // ========================================================
    let overview_tile_path = output_dir.join("tiles").join("z0").join("0_0.png");
    assert!(
        overview_tile_path.exists(),
        "Overview tile z0/0_0.png should exist at {:?}",
        overview_tile_path
    );

    // Load and verify overview tile dimensions
    let overview_tile = image::open(&overview_tile_path).expect("Failed to load overview tile");
    assert_eq!(
        overview_tile.width(),
        512,
        "Overview tile should be 512px wide"
    );
    assert_eq!(
        overview_tile.height(),
        512,
        "Overview tile should be 512px tall"
    );

    // ========================================================
    // STEP 5: Verify tile pyramid structure matches expected zoom levels
    // ========================================================
    let tiles_dir = output_dir.join("tiles");

    // For 2048x1536 image with 512px tiles:
    // - z0: scale ~0.25, grid 1x1 (overview)
    // - z1: scale ~0.5, grid 2x2
    // - z2: scale 1.0, grid 4x3 (full resolution)

    // Check zoom level count
    assert!(
        manifest.levels.len() >= 2,
        "Should have at least 2 zoom levels, got {}",
        manifest.levels.len()
    );

    // Verify each zoom level directory and tiles exist
    for level in &manifest.levels {
        let level_dir = tiles_dir.join(format!("z{}", level.zoom));
        assert!(
            level_dir.exists(),
            "Zoom level directory z{} should exist",
            level.zoom
        );

        // Verify all tiles exist for this level
        for y in 0..level.grid_height {
            for x in 0..level.grid_width {
                let tile_path = level_dir.join(format!("{}_{}.png", x, y));
                assert!(
                    tile_path.exists(),
                    "Tile z{}/{}_{}.png should exist",
                    level.zoom,
                    x,
                    y
                );
            }
        }

        // Verify tile count matches
        let expected_tiles = level.grid_width * level.grid_height;
        assert_eq!(
            level.tile_count, expected_tiles,
            "Zoom level {} tile count should match grid dimensions",
            level.zoom
        );
    }

    // ========================================================
    // STEP 6: Verify TiledCapture can open and query the capture
    // ========================================================
    let mut capture =
        TiledCapture::open(&output_dir).expect("Failed to open TiledCapture from directory");

    // Verify image dimensions
    let (img_width, img_height) = capture.image_dimensions();
    assert_eq!(img_width, 2048);
    assert_eq!(img_height, 1536);

    // ========================================================
    // STEP 7: Verify tile loading via LRU cache
    // ========================================================
    let max_zoom = capture.manifest.tile_config.max_zoom;
    let tile_id = TileId::new(max_zoom, 0, 0);

    let tile = capture.load_tile(tile_id).expect("Failed to load tile");
    assert_eq!(tile.width(), 512);
    assert_eq!(tile.height(), 512);

    // Load same tile again (should hit cache)
    let tile_cached = capture.load_tile(tile_id).expect("Failed to load tile from cache");
    assert_eq!(tile_cached.width(), 512);

    // ========================================================
    // STEP 8: Verify spatial query via R-tree index
    // ========================================================

    // Find tile containing a specific point
    let tile_at_point = capture
        .tile_at_point(1000.0, 750.0, max_zoom)
        .expect("Should find tile containing point (1000, 750)");

    assert_eq!(tile_at_point.zoom, max_zoom);

    // Find tiles intersecting a region
    let query_region = TileBounds::from_corners(500.0, 400.0, 1500.0, 1200.0);
    let intersecting_tiles = capture.tiles_intersecting(&query_region, max_zoom);

    assert!(
        !intersecting_tiles.is_empty(),
        "Should find tiles intersecting region"
    );

    // For a 2048x1536 image with 512px tiles at max zoom:
    // Region 500-1500 x 400-1200 should span tiles (0,0), (0,1), (0,2), (1,0), (1,1), (1,2), (2,0), (2,1), (2,2)
    // Actually it depends on the grid, but should be multiple tiles
    assert!(
        intersecting_tiles.len() >= 2,
        "Region should intersect multiple tiles, got {}",
        intersecting_tiles.len()
    );

    // ========================================================
    // STEP 9: Verify region extraction
    // ========================================================
    let extract_region = TileBounds::from_corners(100.0, 100.0, 400.0, 400.0);
    let extracted = capture
        .extract_region(&extract_region)
        .expect("Failed to extract region");

    assert_eq!(extracted.width(), 300);
    assert_eq!(extracted.height(), 300);

    // Verify extracted pixels are from the gradient (should have some red/green values)
    let sample_pixel = extracted.get_pixel(0, 0);
    // At position (100, 100) in original:
    // r = (100/2048) * 255 = ~12
    // g = (100/1536) * 255 = ~16
    // Values may vary due to tile boundaries but should be low (dark corner of gradient)
    assert!(sample_pixel[0] < 50, "Red channel should be low for top-left");
    assert!(sample_pixel[3] == 255, "Alpha should be fully opaque");
}

/// Test that attempting to regenerate to an existing directory fails
#[test]
fn test_generate_tiles_directory_exists_error() {
    let temp_dir = TempDir::new().expect("Failed to create temp directory");
    let output_dir = temp_dir.path().join("existing_capture");

    // Create directory first
    fs::create_dir_all(&output_dir).expect("Failed to create directory");

    let source = create_gradient_test_image(1024, 1024);
    let config = TileConfig::for_image(1024, 1024, 512);

    let result = generate_tiles(&source, &output_dir, &config);
    assert!(result.is_err(), "Should fail when directory exists");
}

/// Test opening a non-existent capture directory
#[test]
fn test_open_nonexistent_capture() {
    let result = TiledCapture::open(std::path::Path::new("/nonexistent/path/capture"));
    assert!(result.is_err(), "Should fail when directory doesn't exist");
}

/// Test loading an invalid tile ID
#[test]
fn test_load_invalid_tile() {
    let temp_dir = TempDir::new().expect("Failed to create temp directory");
    let output_dir = temp_dir.path().join("capture");

    let source = create_gradient_test_image(1024, 1024);
    let config = TileConfig::for_image(1024, 1024, 512);
    generate_tiles(&source, &output_dir, &config).expect("Failed to generate tiles");

    let mut capture = TiledCapture::open(&output_dir).expect("Failed to open capture");

    // Try to load a tile with invalid zoom level
    let invalid_tile = TileId::new(99, 0, 0);
    let result = capture.load_tile(invalid_tile);
    assert!(result.is_err(), "Should fail for invalid zoom level");

    // Try to load a tile outside grid bounds
    let invalid_tile = TileId::new(capture.manifest.tile_config.max_zoom, 100, 100);
    let result = capture.load_tile(invalid_tile);
    assert!(result.is_err(), "Should fail for tile outside grid");
}

/// Test zoom_for_scale finds the best matching zoom level
#[test]
fn test_zoom_for_scale() {
    let temp_dir = TempDir::new().expect("Failed to create temp directory");
    let output_dir = temp_dir.path().join("capture");

    let source = create_gradient_test_image(2048, 2048);
    let config = TileConfig::for_image(2048, 2048, 512);
    generate_tiles(&source, &output_dir, &config).expect("Failed to generate tiles");

    let capture = TiledCapture::open(&output_dir).expect("Failed to open capture");

    // Full resolution should return max zoom
    let zoom = capture.zoom_for_scale(1.0);
    assert_eq!(zoom, capture.manifest.tile_config.max_zoom);

    // Half scale should return lower zoom
    let zoom_half = capture.zoom_for_scale(0.5);
    assert!(
        zoom_half < capture.manifest.tile_config.max_zoom,
        "Half scale should return lower zoom level"
    );

    // Very small scale should return zoom 0
    let zoom_tiny = capture.zoom_for_scale(0.1);
    assert!(
        zoom_tiny <= 1,
        "Tiny scale should return low zoom level, got {}",
        zoom_tiny
    );
}

/// Test tile pyramid geometry is mathematically correct
#[test]
fn test_tile_pyramid_geometry() {
    let temp_dir = TempDir::new().expect("Failed to create temp directory");
    let output_dir = temp_dir.path().join("capture");

    // Use 4K-like dimensions
    let source = create_gradient_test_image(3840, 2160);
    let config = TileConfig::for_image(3840, 2160, 512);
    let manifest = generate_tiles(&source, &output_dir, &config).expect("Failed to generate tiles");

    // Verify zoom levels form a proper pyramid
    let max_level = manifest.levels.last().unwrap();
    assert_eq!(max_level.scale, 1.0, "Max zoom should have scale 1.0");
    assert_eq!(
        max_level.scaled_width, 3840,
        "Max zoom should preserve original width"
    );
    assert_eq!(
        max_level.scaled_height, 2160,
        "Max zoom should preserve original height"
    );

    // Each lower level should halve the scale
    for i in 1..manifest.levels.len() {
        let lower = &manifest.levels[i - 1];
        let higher = &manifest.levels[i];
        let expected_scale = lower.scale * 2.0;
        let tolerance = 0.001;
        assert!(
            (higher.scale - expected_scale).abs() < tolerance,
            "Level {} scale should be 2x level {}: {} vs {}",
            i,
            i - 1,
            higher.scale,
            expected_scale
        );
    }

    // Verify overview (z0) fits in a single tile or small grid
    let overview = &manifest.levels[0];
    assert!(
        overview.grid_width * overview.grid_height <= 4,
        "Overview should be 1-4 tiles, got {}",
        overview.grid_width * overview.grid_height
    );
}

/// Test nearest_tiles for prefetching
#[test]
fn test_nearest_tiles_prefetch() {
    let temp_dir = TempDir::new().expect("Failed to create temp directory");
    let output_dir = temp_dir.path().join("capture");

    let source = create_gradient_test_image(2048, 2048);
    let config = TileConfig::for_image(2048, 2048, 512);
    generate_tiles(&source, &output_dir, &config).expect("Failed to generate tiles");

    let capture = TiledCapture::open(&output_dir).expect("Failed to open capture");
    let max_zoom = capture.manifest.tile_config.max_zoom;

    // Find nearest tiles to center of image
    let nearest = capture.nearest_tiles(1024.0, 1024.0, 4, max_zoom);

    assert!(
        !nearest.is_empty(),
        "Should find nearest tiles to center point"
    );
    assert!(
        nearest.len() <= 4,
        "Should return at most 4 tiles, got {}",
        nearest.len()
    );

    // All returned tiles should be at the requested zoom level
    for entry in &nearest {
        assert_eq!(
            entry.tile_id.zoom, max_zoom,
            "Nearest tiles should be at requested zoom level"
        );
    }
}
