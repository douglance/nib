//! Coordinate grid overlay system
//!
//! Provides spatial coordinate grids for precise pixel positioning on images.
//! Uses R-tree spatial indexing for efficient queries, following the same
//! patterns as the tiled capture system.
//!
//! # Usage
//!
//! ```bash
//! # Coarse grid on full image
//! quill grid screenshot.png --spacing 100 -o screenshot_grid.png
//!
//! # Fine grid on specific region
//! quill grid screenshot.png --region 300,150,500,300 --spacing 10 -o detail.png
//!
//! # JSON output for programmatic use
//! quill grid screenshot.png --spacing 100 --json
//! ```

pub mod render;
pub mod spatial;
pub mod types;

pub use render::render_grid;
pub use spatial::{build_grid_index, lines_in_region};
pub use types::{GridColor, GridConfig, GridEntry, GridLine, GridMetadata, GridOrientation};
