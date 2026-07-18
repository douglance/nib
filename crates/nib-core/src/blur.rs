//! Blur and pixelation functions for image regions
//!
//! This module provides shared blur/pixelation functionality used by both
//! the export system and GUI preview.

use image::{Rgba, RgbaImage};

use super::Region;

/// Apply blur to a region of an image.
///
/// If radius is 0, pixelation is used instead of gaussian blur.
pub fn apply_blur_region(img: &mut RgbaImage, region: &Region, radius: u32) {
    if radius == 0 {
        // Pixelate mode
        pixelate_region(img, region, 12);
        return;
    }

    // Extract region
    let x = region.x.max(0.0) as u32;
    let y = region.y.max(0.0) as u32;
    let w = (region.width as u32).min(img.width().saturating_sub(x));
    let h = (region.height as u32).min(img.height().saturating_sub(y));

    if w == 0 || h == 0 {
        return;
    }

    // Extract, blur, and put back
    let sub = image::imageops::crop_imm(img, x, y, w, h).to_image();
    let blurred = image::imageops::blur(&sub, radius as f32);

    for (dx, dy, pixel) in blurred.enumerate_pixels() {
        if x + dx < img.width() && y + dy < img.height() {
            img.put_pixel(x + dx, y + dy, *pixel);
        }
    }
}

/// Pixelate a region of an image by averaging blocks of pixels.
pub fn pixelate_region(img: &mut RgbaImage, region: &Region, block_size: u32) {
    let x = region.x.max(0.0) as u32;
    let y = region.y.max(0.0) as u32;
    let w = (region.width as u32).min(img.width().saturating_sub(x));
    let h = (region.height as u32).min(img.height().saturating_sub(y));

    // Process in blocks
    for by in (0..h).step_by(block_size as usize) {
        for bx in (0..w).step_by(block_size as usize) {
            // Get average color of block
            let mut r_sum: u32 = 0;
            let mut g_sum: u32 = 0;
            let mut b_sum: u32 = 0;
            let mut count: u32 = 0;

            for dy in 0..block_size.min(h - by) {
                for dx in 0..block_size.min(w - bx) {
                    let px = x + bx + dx;
                    let py = y + by + dy;
                    if px < img.width() && py < img.height() {
                        let pixel = img.get_pixel(px, py);
                        r_sum += pixel.0[0] as u32;
                        g_sum += pixel.0[1] as u32;
                        b_sum += pixel.0[2] as u32;
                        count += 1;
                    }
                }
            }

            if let (Some(r), Some(g), Some(b)) = (
                r_sum.checked_div(count),
                g_sum.checked_div(count),
                b_sum.checked_div(count),
            ) {
                let avg = Rgba([r as u8, g as u8, b as u8, 255]);

                // Fill block with average
                for dy in 0..block_size.min(h - by) {
                    for dx in 0..block_size.min(w - bx) {
                        let px = x + bx + dx;
                        let py = y + by + dy;
                        if px < img.width() && py < img.height() {
                            img.put_pixel(px, py, avg);
                        }
                    }
                }
            }
        }
    }
}

/// Apply all blur annotations to an image and return the result.
///
/// This creates a copy of the image with blur regions applied.
pub fn apply_blur_annotations(
    img: &RgbaImage,
    blur_regions: &[(Region, u32)], // (region, radius)
) -> RgbaImage {
    let mut result = img.clone();
    for (region, radius) in blur_regions {
        apply_blur_region(&mut result, region, *radius);
    }
    result
}
