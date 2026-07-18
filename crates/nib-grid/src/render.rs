//! Grid rendering onto images
//!
//! Draws grid lines and coordinate labels using imageproc,
//! following the same patterns as storage/export.rs.

use image::{Rgba, RgbaImage};
use imageproc::drawing::draw_line_segment_mut;
use rstar::RTree;

use nib_core::tile::TileBounds;

use super::spatial::lines_in_region;
use super::types::{GridColor, GridConfig, GridEntry, GridOrientation};

/// Render grid onto an image
///
/// # Arguments
/// * `img` - Mutable reference to the image to render onto
/// * `index` - R-tree of grid lines
/// * `viewport` - Region to render (lines outside this are skipped)
/// * `config` - Grid configuration
pub fn render_grid(
    img: &mut RgbaImage,
    index: &RTree<GridEntry>,
    viewport: &TileBounds,
    config: &GridConfig,
) {
    let entries = lines_in_region(index, viewport);
    let color = color_to_rgba(&config.color);
    let major_color = color_to_rgba(&config.major_color);

    // Collect vertical and horizontal line coordinates
    let mut vertical_coords: Vec<f64> = Vec::new();
    let mut horizontal_coords: Vec<f64> = Vec::new();

    for entry in entries.iter() {
        match entry.line.orientation {
            GridOrientation::Vertical => vertical_coords.push(entry.line.coordinate),
            GridOrientation::Horizontal => horizontal_coords.push(entry.line.coordinate),
        }
    }

    vertical_coords.sort_by(|a, b| a.partial_cmp(b).unwrap());
    horizontal_coords.sort_by(|a, b| a.partial_cmp(b).unwrap());
    vertical_coords.dedup();
    horizontal_coords.dedup();

    // Draw minor lines first (under major lines)
    for entry in entries.iter().filter(|e| !e.line.is_major) {
        draw_grid_line(img, entry, color);
    }

    // Draw major lines on top
    for entry in entries.iter().filter(|e| e.line.is_major) {
        draw_grid_line(img, entry, major_color);
    }

    // Draw base36 grid index labels at every junction
    // Labels are col,row indices - use JSON output to convert to pixels
    if config.show_labels {
        let label_color = Rgba([255, 255, 255, 220]);
        let origin_x = vertical_coords.first().copied().unwrap_or(0.0);
        let origin_y = horizontal_coords.first().copied().unwrap_or(0.0);
        let spacing = config.spacing as f64;

        for (col, &x) in vertical_coords.iter().enumerate() {
            for (row, &y) in horizontal_coords.iter().enumerate() {
                draw_junction_label(
                    img,
                    x,
                    y,
                    col,
                    row,
                    origin_x,
                    origin_y,
                    spacing,
                    config.label_font_size,
                    label_color,
                );
            }
        }
    }
}

/// Draw a single grid line
fn draw_grid_line(img: &mut RgbaImage, entry: &GridEntry, color: Rgba<u8>) {
    let line = &entry.line;

    // Clamp to image bounds
    let (width, height) = img.dimensions();
    let start_x = (line.start.0 as f32).clamp(0.0, width as f32 - 1.0);
    let start_y = (line.start.1 as f32).clamp(0.0, height as f32 - 1.0);
    let end_x = (line.end.0 as f32).clamp(0.0, width as f32 - 1.0);
    let end_y = (line.end.1 as f32).clamp(0.0, height as f32 - 1.0);

    draw_line_segment_mut(img, (start_x, start_y), (end_x, end_y), color);
}

/// Convert a number to base36 string (0-9, A-Z)
fn to_base36(mut n: usize) -> String {
    if n == 0 {
        return "0".to_string();
    }

    const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut result = Vec::new();

    while n > 0 {
        result.push(DIGITS[n % 36] as char);
        n /= 36;
    }

    result.into_iter().rev().collect()
}

/// Draw base36 grid index label at a junction
/// Labels show col,row indices (e.g., "A,5" means column 10, row 5)
/// Use JSON output to get origin and spacing for pixel conversion:
///   pixel_x = origin_x + col * spacing
///   pixel_y = origin_y + row * spacing
#[allow(clippy::too_many_arguments)]
fn draw_junction_label(
    img: &mut RgbaImage,
    x: f64,
    y: f64,
    col: usize,
    row: usize,
    _origin_x: f64,
    _origin_y: f64,
    _spacing: f64,
    font_size: f32,
    color: Rgba<u8>,
) {
    // Format as base36 indices: "col,row"
    let label = format!("{},{}", to_base36(col), to_base36(row));

    // Position label slightly offset from junction
    let label_x = x as i32 + 3;
    let label_y = y as i32 + 3;

    draw_text_simple(img, &label, label_x, label_y, font_size, color);
}

/// Simple text rendering using rectangles
///
/// This is a simplified approach since proper font rendering requires
/// additional dependencies. Each character is drawn as a small filled area.
fn draw_text_simple(
    img: &mut RgbaImage,
    text: &str,
    x: i32,
    y: i32,
    font_size: f32,
    color: Rgba<u8>,
) {
    let (width, height) = img.dimensions();
    let char_width = (font_size * 0.6) as i32;
    let char_height = font_size as i32;

    // Draw background for better visibility
    let bg_color = Rgba([0, 0, 0, 180]);
    let text_width = text.len() as i32 * char_width;
    let padding = 2;

    // Draw background rectangle
    for dy in -padding..(char_height + padding) {
        for dx in -padding..(text_width + padding) {
            let px = x + dx;
            let py = y + dy;
            if px >= 0 && px < width as i32 && py >= 0 && py < height as i32 {
                blend_pixel(img, px as u32, py as u32, bg_color);
            }
        }
    }

    // Draw each character as a simple shape
    for (i, c) in text.chars().enumerate() {
        let cx = x + (i as i32 * char_width);

        // Simple digit rendering - draw dots/lines for each digit
        draw_digit(img, c, cx, y, char_width, char_height, color);
    }
}

/// Draw a simple digit/character representation
#[allow(clippy::too_many_arguments)]
fn draw_digit(
    img: &mut RgbaImage,
    c: char,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    color: Rgba<u8>,
) {
    let (img_width, img_height) = img.dimensions();

    // Simple 5x7 pixel patterns for digits and hex chars
    let patterns: &[(char, &[&[u8]])] = &[
        (
            '0',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            '1',
            &[
                &[0, 0, 1, 0, 0],
                &[0, 1, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            '2',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[0, 0, 0, 0, 1],
                &[0, 0, 1, 1, 0],
                &[0, 1, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 1, 1, 1, 1],
            ],
        ),
        (
            '3',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[0, 0, 0, 0, 1],
                &[0, 0, 1, 1, 0],
                &[0, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            '4',
            &[
                &[0, 0, 0, 1, 0],
                &[0, 0, 1, 1, 0],
                &[0, 1, 0, 1, 0],
                &[1, 0, 0, 1, 0],
                &[1, 1, 1, 1, 1],
                &[0, 0, 0, 1, 0],
                &[0, 0, 0, 1, 0],
            ],
        ),
        (
            '5',
            &[
                &[1, 1, 1, 1, 1],
                &[1, 0, 0, 0, 0],
                &[1, 1, 1, 1, 0],
                &[0, 0, 0, 0, 1],
                &[0, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            '6',
            &[
                &[0, 0, 1, 1, 0],
                &[0, 1, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            '7',
            &[
                &[1, 1, 1, 1, 1],
                &[0, 0, 0, 0, 1],
                &[0, 0, 0, 1, 0],
                &[0, 0, 1, 0, 0],
                &[0, 1, 0, 0, 0],
                &[0, 1, 0, 0, 0],
                &[0, 1, 0, 0, 0],
            ],
        ),
        (
            '8',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            '9',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 1],
                &[0, 0, 0, 0, 1],
                &[0, 0, 0, 1, 0],
                &[0, 1, 1, 0, 0],
            ],
        ),
        (
            'A',
            &[
                &[0, 0, 1, 0, 0],
                &[0, 1, 0, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 1, 1, 1, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
            ],
        ),
        (
            'B',
            &[
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 1, 1, 1, 0],
            ],
        ),
        (
            'C',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            'D',
            &[
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 1, 1, 1, 0],
            ],
        ),
        (
            'E',
            &[
                &[1, 1, 1, 1, 1],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 1, 1, 1, 1],
            ],
        ),
        (
            'F',
            &[
                &[1, 1, 1, 1, 1],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
            ],
        ),
        (
            'G',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 0],
                &[1, 0, 1, 1, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            'H',
            &[
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 1, 1, 1, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
            ],
        ),
        (
            'I',
            &[
                &[0, 1, 1, 1, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            'J',
            &[
                &[0, 0, 1, 1, 1],
                &[0, 0, 0, 1, 0],
                &[0, 0, 0, 1, 0],
                &[0, 0, 0, 1, 0],
                &[1, 0, 0, 1, 0],
                &[1, 0, 0, 1, 0],
                &[0, 1, 1, 0, 0],
            ],
        ),
        (
            'K',
            &[
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 1, 0],
                &[1, 0, 1, 0, 0],
                &[1, 1, 0, 0, 0],
                &[1, 0, 1, 0, 0],
                &[1, 0, 0, 1, 0],
                &[1, 0, 0, 0, 1],
            ],
        ),
        (
            'L',
            &[
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 1, 1, 1, 1],
            ],
        ),
        (
            'M',
            &[
                &[1, 0, 0, 0, 1],
                &[1, 1, 0, 1, 1],
                &[1, 0, 1, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
            ],
        ),
        (
            'N',
            &[
                &[1, 0, 0, 0, 1],
                &[1, 1, 0, 0, 1],
                &[1, 0, 1, 0, 1],
                &[1, 0, 0, 1, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
            ],
        ),
        (
            'O',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            'P',
            &[
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 0, 0, 0, 0],
            ],
        ),
        (
            'Q',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 1, 0, 1],
                &[1, 0, 0, 1, 0],
                &[0, 1, 1, 0, 1],
            ],
        ),
        (
            'R',
            &[
                &[1, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 1, 1, 1, 0],
                &[1, 0, 1, 0, 0],
                &[1, 0, 0, 1, 0],
                &[1, 0, 0, 0, 1],
            ],
        ),
        (
            'S',
            &[
                &[0, 1, 1, 1, 0],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 0],
                &[0, 1, 1, 1, 0],
                &[0, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            'T',
            &[
                &[1, 1, 1, 1, 1],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
            ],
        ),
        (
            'U',
            &[
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 1, 1, 0],
            ],
        ),
        (
            'V',
            &[
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[0, 1, 0, 1, 0],
                &[0, 1, 0, 1, 0],
                &[0, 0, 1, 0, 0],
            ],
        ),
        (
            'W',
            &[
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 0, 0, 1],
                &[1, 0, 1, 0, 1],
                &[1, 0, 1, 0, 1],
                &[1, 1, 0, 1, 1],
                &[1, 0, 0, 0, 1],
            ],
        ),
        (
            'X',
            &[
                &[1, 0, 0, 0, 1],
                &[0, 1, 0, 1, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 1, 0, 1, 0],
                &[1, 0, 0, 0, 1],
            ],
        ),
        (
            'Y',
            &[
                &[1, 0, 0, 0, 1],
                &[0, 1, 0, 1, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 0, 1, 0, 0],
            ],
        ),
        (
            'Z',
            &[
                &[1, 1, 1, 1, 1],
                &[0, 0, 0, 0, 1],
                &[0, 0, 0, 1, 0],
                &[0, 0, 1, 0, 0],
                &[0, 1, 0, 0, 0],
                &[1, 0, 0, 0, 0],
                &[1, 1, 1, 1, 1],
            ],
        ),
        (
            ',',
            &[
                &[0, 0, 0, 0, 0],
                &[0, 0, 0, 0, 0],
                &[0, 0, 0, 0, 0],
                &[0, 0, 0, 0, 0],
                &[0, 0, 0, 0, 0],
                &[0, 0, 1, 0, 0],
                &[0, 1, 0, 0, 0],
            ],
        ),
    ];

    let pattern = patterns.iter().find(|(ch, _)| *ch == c).map(|(_, p)| *p);

    if let Some(pat) = pattern {
        let scale_x = width as f32 / 5.0;
        let scale_y = height as f32 / 7.0;

        for (row, line) in pat.iter().enumerate() {
            for (col, &pixel) in line.iter().enumerate() {
                if pixel == 1 {
                    let px = x + (col as f32 * scale_x) as i32;
                    let py = y + (row as f32 * scale_y) as i32;

                    // Draw scaled pixel
                    for dy in 0..(scale_y as i32).max(1) {
                        for dx in 0..(scale_x as i32).max(1) {
                            let fx = px + dx;
                            let fy = py + dy;
                            if fx >= 0 && fx < img_width as i32 && fy >= 0 && fy < img_height as i32
                            {
                                img.put_pixel(fx as u32, fy as u32, color);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Blend a pixel with alpha
fn blend_pixel(img: &mut RgbaImage, x: u32, y: u32, color: Rgba<u8>) {
    let existing = img.get_pixel(x, y);
    let alpha = color.0[3] as f32 / 255.0;
    let inv_alpha = 1.0 - alpha;

    let blended = Rgba([
        (color.0[0] as f32 * alpha + existing.0[0] as f32 * inv_alpha) as u8,
        (color.0[1] as f32 * alpha + existing.0[1] as f32 * inv_alpha) as u8,
        (color.0[2] as f32 * alpha + existing.0[2] as f32 * inv_alpha) as u8,
        255,
    ]);

    img.put_pixel(x, y, blended);
}

/// Convert GridColor to image::Rgba
fn color_to_rgba(color: &GridColor) -> Rgba<u8> {
    Rgba([color.r, color.g, color.b, color.a])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spatial::build_grid_index;

    #[test]
    fn test_render_grid_basic() {
        let mut img = RgbaImage::new(200, 200);
        let config = GridConfig::with_spacing(50);
        let index = build_grid_index(200, 200, &config, None);
        let viewport = TileBounds::from_corners(0.0, 0.0, 200.0, 200.0);

        render_grid(&mut img, &index, &viewport, &config);

        // Check that some pixels have been modified (grid lines drawn)
        let mut non_black = 0;
        for pixel in img.pixels() {
            if pixel.0 != [0, 0, 0, 0] {
                non_black += 1;
            }
        }
        assert!(non_black > 0, "Grid should have drawn some pixels");
    }
}
