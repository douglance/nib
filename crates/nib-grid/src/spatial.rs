//! Spatial indexing for grid lines
//!
//! Uses R-tree for efficient queries of grid lines within a region,
//! following the same pattern as the tiled capture system.

use nib_core::tile::TileBounds;
use rstar::RTree;

use super::types::{GridConfig, GridEntry, GridLine};

/// Build a spatial index of grid lines for an image
///
/// # Arguments
/// * `width` - Image width in pixels
/// * `height` - Image height in pixels
/// * `config` - Grid configuration (spacing, major interval, etc.)
/// * `region` - Optional region to constrain grid lines to
///
/// # Returns
/// An R-tree containing all grid line entries for efficient spatial queries
pub fn build_grid_index(
    width: u32,
    height: u32,
    config: &GridConfig,
    region: Option<&TileBounds>,
) -> RTree<GridEntry> {
    let mut entries = Vec::new();
    let spacing = config.spacing as f64;

    // Determine bounds (full image or specified region)
    let bounds = region
        .cloned()
        .unwrap_or_else(|| TileBounds::from_corners(0.0, 0.0, width as f64, height as f64));

    // Generate vertical lines (x-axis)
    let start_x = (bounds.min_x / spacing).floor() * spacing;
    let mut x = start_x;
    let mut line_idx = 0u32;

    while x <= bounds.max_x {
        // Skip if before region
        if x >= bounds.min_x {
            let is_major = line_idx.is_multiple_of(config.major_interval);
            let line = GridLine::vertical(x, bounds.min_y, bounds.max_y, is_major);

            // Thin bounding box for R-tree (1px wide around the line)
            let line_bounds =
                TileBounds::from_corners(x - 0.5, bounds.min_y, x + 0.5, bounds.max_y);

            entries.push(GridEntry {
                line,
                bounds: line_bounds,
            });
        }

        x += spacing;
        line_idx += 1;
    }

    // Generate horizontal lines (y-axis)
    let start_y = (bounds.min_y / spacing).floor() * spacing;
    let mut y = start_y;
    let mut line_idx = 0u32;

    while y <= bounds.max_y {
        // Skip if before region
        if y >= bounds.min_y {
            let is_major = line_idx.is_multiple_of(config.major_interval);
            let line = GridLine::horizontal(y, bounds.min_x, bounds.max_x, is_major);

            // Thin bounding box for R-tree (1px tall around the line)
            let line_bounds =
                TileBounds::from_corners(bounds.min_x, y - 0.5, bounds.max_x, y + 0.5);

            entries.push(GridEntry {
                line,
                bounds: line_bounds,
            });
        }

        y += spacing;
        line_idx += 1;
    }

    RTree::bulk_load(entries)
}

/// Query grid lines intersecting a region
///
/// This is the key efficiency gain - only returns lines we need to render.
/// For a 1920x1080 image with 10px spacing, we have ~300 lines total.
/// But if we query a 100x100 region, we only get ~20 lines back.
pub fn lines_in_region<'a>(index: &'a RTree<GridEntry>, region: &TileBounds) -> Vec<&'a GridEntry> {
    let envelope =
        rstar::AABB::from_corners([region.min_x, region.min_y], [region.max_x, region.max_y]);

    index.locate_in_envelope_intersecting(&envelope).collect()
}

/// Get all grid lines from the index
pub fn all_lines(index: &RTree<GridEntry>) -> Vec<&GridEntry> {
    index.iter().collect()
}

/// Count lines in the index
pub fn line_count(index: &RTree<GridEntry>) -> usize {
    index.size()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_grid_index_full_image() {
        let config = GridConfig::with_spacing(100);
        let index = build_grid_index(1000, 800, &config, None);

        // 1000px / 100px = 11 vertical lines (0, 100, 200, ..., 1000)
        // 800px / 100px = 9 horizontal lines (0, 100, 200, ..., 800)
        // Total = 20 lines
        assert_eq!(line_count(&index), 20);
    }

    #[test]
    fn test_build_grid_index_region() {
        let config = GridConfig::with_spacing(100);
        let region = TileBounds::from_corners(150.0, 150.0, 450.0, 350.0);
        let index = build_grid_index(1000, 800, &config, Some(&region));

        // Region from 150-450 x, 150-350 y
        // Vertical lines at 200, 300, 400 (3 lines)
        // Horizontal lines at 200, 300 (2 lines)
        // Total = 5 lines
        assert_eq!(line_count(&index), 5);
    }

    #[test]
    fn test_lines_in_region() {
        let config = GridConfig::with_spacing(100);
        let index = build_grid_index(1000, 800, &config, None);

        // Query a small region
        let region = TileBounds::from_corners(150.0, 150.0, 350.0, 350.0);
        let lines = lines_in_region(&index, &region);

        // Should find lines at x=200, x=300 (2 vertical)
        // and y=200, y=300 (2 horizontal)
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn test_major_lines() {
        let config = GridConfig {
            spacing: 10,
            major_interval: 5,
            ..Default::default()
        };
        let index = build_grid_index(100, 100, &config, None);

        let all = all_lines(&index);
        let major_count = all.iter().filter(|e| e.line.is_major).count();
        let minor_count = all.iter().filter(|e| !e.line.is_major).count();

        // Every 5th line is major
        assert!(major_count > 0);
        assert!(minor_count > major_count);
    }
}
