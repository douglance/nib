//! Image export with baked annotations
//!
//! Renders annotations onto the image and exports as PNG/JPEG/WebP.

use crate::StorageResult;
use nib_core::blur::apply_blur_region;
use nib_core::{
    dash_segments, Annotation, AnnotationType, ArrowHead, AssetData, Color, NibImage, Point,
    Region, StorageError, StrokeStyle,
};
use image::{DynamicImage, Rgba, RgbaImage};
use imageproc::drawing::{draw_filled_circle_mut, draw_filled_rect_mut, draw_line_segment_mut};
use imageproc::rect::Rect;
use std::collections::HashMap;
use std::path::Path;

/// Export format options
#[derive(Debug, Clone, Copy)]
pub enum ExportFormat {
    Png,
    Jpeg { quality: u8 },
    WebP { quality: u8 },
}

impl Default for ExportFormat {
    fn default() -> Self {
        Self::Png
    }
}

/// Export options
#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub format: ExportFormat,
    /// Whether to render annotations onto image
    pub bake_annotations: bool,
    /// Whether to render QML block in corner
    pub render_qml_block: bool,
    /// Crop region (None = full image)
    pub crop: Option<Region>,
    /// Scale factor (1.0 = original size)
    pub scale: f64,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: ExportFormat::Png,
            bake_annotations: true,
            render_qml_block: false,
            crop: None,
            scale: 1.0,
        }
    }
}

/// Export image with annotations
pub fn export_image(
    image: &NibImage,
    path: impl AsRef<Path>,
    options: &ExportOptions,
) -> StorageResult<()> {
    let path = path.as_ref();

    // Load base image
    let mut img = image::load_from_memory(&image.image_data)
        .map_err(|e| StorageError::InvalidFormat(e.to_string()))?
        .to_rgba8();

    // Render annotations if requested
    if options.bake_annotations {
        render_annotations(&mut img, &image.annotations, &image.assets);
    }

    // Apply crop if specified
    let img = if let Some(ref crop) = options.crop {
        let cropped = image::imageops::crop_imm(
            &img,
            crop.x.max(0.0) as u32,
            crop.y.max(0.0) as u32,
            crop.width.min(img.width() as f64 - crop.x) as u32,
            crop.height.min(img.height() as f64 - crop.y) as u32,
        );
        cropped.to_image()
    } else {
        img
    };

    // Apply scale if not 1.0
    let img = if (options.scale - 1.0).abs() > 0.001 {
        let new_width = (img.width() as f64 * options.scale) as u32;
        let new_height = (img.height() as f64 * options.scale) as u32;
        image::imageops::resize(&img, new_width, new_height, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // Save in specified format
    match options.format {
        ExportFormat::Png => img
            .save_with_format(path, image::ImageFormat::Png)
            .map_err(|e| StorageError::InvalidFormat(e.to_string()))?,
        ExportFormat::Jpeg { quality } => {
            let rgb = DynamicImage::ImageRgba8(img).into_rgb8();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                std::fs::File::create(path)?,
                quality,
            );
            encoder
                .encode_image(&rgb)
                .map_err(|e| StorageError::InvalidFormat(e.to_string()))?;
        }
        ExportFormat::WebP { quality: _ } => {
            // WebP support through image crate
            img.save_with_format(path, image::ImageFormat::WebP)
                .map_err(|e| StorageError::InvalidFormat(e.to_string()))?;
        }
    }

    Ok(())
}

/// Render all annotations onto an image
fn render_annotations(
    img: &mut RgbaImage,
    annotations: &[Annotation],
    assets: &HashMap<String, AssetData>,
) {
    // Sort by z-index for proper layering
    let mut sorted: Vec<_> = annotations.iter().filter(|a| a.visible).collect();
    sorted.sort_by_key(|a| a.z_index);

    for annotation in sorted {
        render_annotation(img, annotation, assets);
    }
}

/// Render a single annotation
fn render_annotation(img: &mut RgbaImage, annotation: &Annotation, assets: &HashMap<String, AssetData>) {
    let color = color_to_rgba(&annotation.color);

    match &annotation.annotation_type {
        AnnotationType::Arrow { start, end, head, stroke_width } => {
            draw_arrow(img, *start, *end, *head, color, *stroke_width as i32);
        }
        AnnotationType::Box { region, stroke_width, stroke_style, filled, .. } => {
            let rect = Rect::at(region.x as i32, region.y as i32)
                .of_size(region.width as u32, region.height as u32);

            if *filled {
                let fill_color = Rgba([color.0[0], color.0[1], color.0[2], 80]);
                draw_filled_rect_mut(img, rect, fill_color);
            }

            draw_rect_outline_styled(img, region, *stroke_width, *stroke_style, color);
        }
        AnnotationType::Text { position, content, font_size, background, .. } => {
            // Draw background if specified
            if let Some(bg) = background {
                let bg_color = color_to_rgba(bg);
                let text_width = content.len() as u32 * (*font_size as u32 / 2);
                let text_height = *font_size as u32 + 4;
                let rect = Rect::at(position.x as i32 - 2, position.y as i32 - 2)
                    .of_size(text_width + 4, text_height);
                draw_filled_rect_mut(img, rect, bg_color);
            }

            // For text rendering, we use a simple approach since ab_glyph can be complex
            // Draw each character as a simple rectangle (placeholder until proper font support)
            let char_width = (*font_size as f32 * 0.6) as i32;
            let char_height = *font_size as i32;

            for (i, _c) in content.chars().enumerate() {
                let x = position.x as i32 + (i as i32 * char_width);
                let y = position.y as i32;

                // Draw a simple filled rectangle as placeholder for each character
                let rect = Rect::at(x, y).of_size(char_width as u32 - 1, char_height as u32);
                draw_filled_rect_mut(img, rect, color);
            }
        }
        AnnotationType::Number { position, value, radius } => {
            // Draw filled circle background
            draw_filled_circle_mut(
                img,
                (position.x as i32, position.y as i32),
                *radius as i32,
                color,
            );

            // Draw number (simplified - just draw a contrasting dot in center)
            let contrast = if annotation.color.r > 128 {
                Rgba([0, 0, 0, 255])
            } else {
                Rgba([255, 255, 255, 255])
            };

            // Simple number indicator - draw smaller circle
            if *value > 0 {
                let inner_radius = (*radius / 3.0) as i32;
                draw_filled_circle_mut(
                    img,
                    (position.x as i32, position.y as i32),
                    inner_radius.max(2),
                    contrast,
                );
            }
        }
        AnnotationType::Blur { region, intensity } => {
            apply_blur_region(img, region, intensity.radius());
        }
        AnnotationType::Highlight { region, .. } => {
            let highlight_color = Rgba([255, 255, 0, 100]); // Yellow highlight
            let rect = Rect::at(region.x as i32, region.y as i32)
                .of_size(region.width as u32, region.height as u32);
            draw_filled_rect_mut(img, rect, highlight_color);
        }
        AnnotationType::Line { start, end, stroke_width, stroke_style } => {
            draw_styled_line(img, *start, *end, *stroke_style, *stroke_width, color);
        }
        AnnotationType::Ellipse { center, radius_x, radius_y, filled, .. } => {
            // Approximate ellipse with polygon or use filled circle for now
            if *radius_x == *radius_y {
                // Circle
                if *filled {
                    draw_filled_circle_mut(
                        img,
                        (center.x as i32, center.y as i32),
                        *radius_x as i32,
                        color,
                    );
                } else {
                    // Draw hollow circle by drawing outline
                    draw_circle_outline(img, center.x, center.y, *radius_x, color);
                }
            } else {
                // For non-circular ellipses, approximate with multiple lines
                draw_ellipse_outline(img, center.x, center.y, *radius_x, *radius_y, color);
            }
        }
        AnnotationType::Crop { .. } => {
            // Crop regions are not rendered, they're used for export bounds
        }
        AnnotationType::Path { points, stroke_width, stroke_style } => {
            for pair in points.windows(2) {
                draw_styled_line(img, pair[0], pair[1], *stroke_style, *stroke_width, color);
            }
        }
        AnnotationType::Image { region, asset, opacity } => {
            if let Some(asset_data) = assets.get(&asset.0) {
                composite_image(img, &asset_data.bytes, region, *opacity);
            }
            // No asset bytes available (e.g. a sidecar-only load with no
            // asset_base64) -- silently skip rather than drawing a placeholder.
        }
    }
}

/// Decode `bytes`, resize to `region`'s size, and alpha-blend (source-over,
/// scaled by `opacity`) onto `img` at `region`'s position.
fn composite_image(img: &mut RgbaImage, bytes: &[u8], region: &Region, opacity: f64) {
    let Ok(decoded) = image::load_from_memory(bytes) else {
        return;
    };
    let width = region.width.max(1.0) as u32;
    let height = region.height.max(1.0) as u32;
    let resized = decoded
        .resize_exact(width, height, image::imageops::FilterType::Lanczos3)
        .to_rgba8();

    let opacity = opacity.clamp(0.0, 1.0);
    let origin_x = region.x as i64;
    let origin_y = region.y as i64;

    for (x, y, pixel) in resized.enumerate_pixels() {
        let px = origin_x + x as i64;
        let py = origin_y + y as i64;
        if px < 0 || py < 0 || px as u32 >= img.width() || py as u32 >= img.height() {
            continue;
        }
        let src_alpha = (pixel[3] as f64 / 255.0) * opacity;
        if src_alpha <= 0.0 {
            continue;
        }
        let dst = img.get_pixel_mut(px as u32, py as u32);
        for c in 0..3 {
            dst[c] = (pixel[c] as f64 * src_alpha + dst[c] as f64 * (1.0 - src_alpha)).round() as u8;
        }
        dst[3] = ((src_alpha + (dst[3] as f64 / 255.0) * (1.0 - src_alpha)) * 255.0).round() as u8;
    }
}

fn color_to_rgba(color: &Color) -> Rgba<u8> {
    Rgba([color.r, color.g, color.b, color.a])
}

fn draw_arrow(
    img: &mut RgbaImage,
    start: nib_core::Point,
    end: nib_core::Point,
    head: ArrowHead,
    color: Rgba<u8>,
    stroke_width: i32,
) {
    // Draw line (Arrow has no stroke_style field, so this stays solid)
    for offset in 0..stroke_width.max(1) {
        let dy = if offset == 0 { 0.0 } else { offset as f32 / 2.0 };
        draw_line_segment_mut(
            img,
            (start.x as f32, start.y as f32 + dy),
            (end.x as f32, end.y as f32 + dy),
            color,
        );
    }

    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let len = (dx * dx + dy * dy).sqrt();

    if len > 0.0 {
        let ndx = dx / len;
        let ndy = dy / len;

        if matches!(head, ArrowHead::End | ArrowHead::Both) {
            draw_arrow_wing(img, end, ndx, ndy, color);
        }
        if matches!(head, ArrowHead::Start | ArrowHead::Both) {
            draw_arrow_wing(img, start, -ndx, -ndy, color);
        }
    }
}

/// Draw the two wing lines of an arrowhead at `tip`, pointing back along the
/// normalized incoming direction `(dir_x, dir_y)`.
fn draw_arrow_wing(
    img: &mut RgbaImage,
    tip: nib_core::Point,
    dir_x: f64,
    dir_y: f64,
    color: Rgba<u8>,
) {
    let arrow_size: f64 = 15.0;
    let angle: f64 = 0.5; // radians

    let ax1 = tip.x - arrow_size * (dir_x * angle.cos() + dir_y * angle.sin());
    let ay1 = tip.y - arrow_size * (dir_y * angle.cos() - dir_x * angle.sin());
    let ax2 = tip.x - arrow_size * (dir_x * angle.cos() - dir_y * angle.sin());
    let ay2 = tip.y - arrow_size * (dir_y * angle.cos() + dir_x * angle.sin());

    draw_line_segment_mut(img, (tip.x as f32, tip.y as f32), (ax1 as f32, ay1 as f32), color);
    draw_line_segment_mut(img, (tip.x as f32, tip.y as f32), (ax2 as f32, ay2 as f32), color);
}

/// Draw a line honoring `stroke_style` (dashed/dotted segments via the shared
/// `dash_segments` helper) with `stroke_width`-scaled thickness.
fn draw_styled_line(
    img: &mut RgbaImage,
    start: Point,
    end: Point,
    stroke_style: StrokeStyle,
    stroke_width: f64,
    color: Rgba<u8>,
) {
    for (seg_start, seg_end) in dash_segments(start, end, stroke_style, stroke_width) {
        for offset in 0..(stroke_width as i32).max(1) {
            let dy = if offset == 0 { 0.0 } else { offset as f32 / 2.0 };
            draw_line_segment_mut(
                img,
                (seg_start.x as f32, seg_start.y as f32 + dy),
                (seg_end.x as f32, seg_end.y as f32 + dy),
                color,
            );
        }
    }
}

/// Draw a rectangle outline as four styled edges (supports dashed/dotted).
fn draw_rect_outline_styled(
    img: &mut RgbaImage,
    region: &Region,
    stroke_width: f64,
    stroke_style: StrokeStyle,
    color: Rgba<u8>,
) {
    let tl = Point::new(region.x, region.y);
    let tr = Point::new(region.x + region.width, region.y);
    let br = Point::new(region.x + region.width, region.y + region.height);
    let bl = Point::new(region.x, region.y + region.height);

    for (a, b) in [(tl, tr), (tr, br), (br, bl), (bl, tl)] {
        draw_styled_line(img, a, b, stroke_style, stroke_width, color);
    }
}


fn draw_circle_outline(img: &mut RgbaImage, cx: f64, cy: f64, radius: f64, color: Rgba<u8>) {
    let steps = (radius * 4.0) as i32;
    let step_angle = std::f64::consts::PI * 2.0 / steps as f64;

    for i in 0..steps {
        let angle1 = i as f64 * step_angle;
        let angle2 = (i + 1) as f64 * step_angle;

        let x1 = cx + radius * angle1.cos();
        let y1 = cy + radius * angle1.sin();
        let x2 = cx + radius * angle2.cos();
        let y2 = cy + radius * angle2.sin();

        draw_line_segment_mut(img, (x1 as f32, y1 as f32), (x2 as f32, y2 as f32), color);
    }
}

fn draw_ellipse_outline(
    img: &mut RgbaImage,
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    color: Rgba<u8>,
) {
    let steps = ((rx.max(ry)) * 4.0) as i32;
    let step_angle = std::f64::consts::PI * 2.0 / steps as f64;

    for i in 0..steps {
        let angle1 = i as f64 * step_angle;
        let angle2 = (i + 1) as f64 * step_angle;

        let x1 = cx + rx * angle1.cos();
        let y1 = cy + ry * angle1.sin();
        let x2 = cx + rx * angle2.cos();
        let y2 = cy + ry * angle2.sin();

        draw_line_segment_mut(img, (x1 as f32, y1 as f32), (x2 as f32, y2 as f32), color);
    }
}

/// Export to clipboard
pub fn export_to_clipboard(image: &NibImage, options: &ExportOptions) -> StorageResult<()> {
    use arboard::Clipboard;

    // Load and render image
    let mut img = image::load_from_memory(&image.image_data)
        .map_err(|e| StorageError::InvalidFormat(e.to_string()))?
        .to_rgba8();

    if options.bake_annotations {
        render_annotations(&mut img, &image.annotations, &image.assets);
    }

    let (width, height) = img.dimensions();

    let mut clipboard = Clipboard::new()
        .map_err(|e| StorageError::InvalidFormat(format!("Clipboard error: {}", e)))?;

    let img_data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: std::borrow::Cow::Owned(img.into_raw()),
    };

    clipboard
        .set_image(img_data)
        .map_err(|e| StorageError::InvalidFormat(format!("Clipboard error: {}", e)))?;

    Ok(())
}

#[cfg(test)]
mod image_annotation_export_tests {
    use super::*;
    use nib_core::AssetRef;
    use std::collections::HashMap;

    fn solid_png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let img = RgbaImage::from_pixel(width, height, Rgba(color));
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    /// Golden-pixel test: a 2x2 fully-opaque red asset composited at (1,1)
    /// onto a 4x4 black base must turn exactly those 4 pixels red and leave
    /// everything else untouched.
    #[test]
    fn image_annotation_composites_expected_pixels() {
        let mut base = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));

        let asset_bytes = solid_png(2, 2, [255, 0, 0, 255]);
        let asset = AssetRef::from_bytes(&asset_bytes);
        let mut assets = HashMap::new();
        assets.insert(
            asset.0.clone(),
            AssetData { bytes: asset_bytes, format: "png".to_string(), width: 2, height: 2 },
        );

        let annotation = Annotation::new(AnnotationType::Image {
            region: Region::new(1.0, 1.0, 2.0, 2.0),
            asset,
            opacity: 1.0,
        });

        render_annotation(&mut base, &annotation, &assets);

        for (x, y) in [(1, 1), (2, 1), (1, 2), (2, 2)] {
            assert_eq!(*base.get_pixel(x, y), Rgba([255, 0, 0, 255]), "pixel ({x},{y}) should be red");
        }
        for (x, y) in [(0, 0), (3, 3), (0, 3), (3, 0)] {
            assert_eq!(*base.get_pixel(x, y), Rgba([0, 0, 0, 255]), "pixel ({x},{y}) outside the region must stay black");
        }
    }

    #[test]
    fn image_annotation_respects_opacity_blend() {
        let mut base = RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255]));
        let asset_bytes = solid_png(1, 1, [255, 255, 255, 255]);
        let asset = AssetRef::from_bytes(&asset_bytes);
        let mut assets = HashMap::new();
        assets.insert(
            asset.0.clone(),
            AssetData { bytes: asset_bytes, format: "png".to_string(), width: 1, height: 1 },
        );

        let annotation = Annotation::new(AnnotationType::Image {
            region: Region::new(0.0, 0.0, 1.0, 1.0),
            asset,
            opacity: 0.5,
        });

        render_annotation(&mut base, &annotation, &assets);

        // 50% white over black is ~mid-gray, not full white or unchanged black.
        let pixel = base.get_pixel(0, 0);
        assert!((110..=145).contains(&pixel[0]), "expected ~50% blend, got {pixel:?}");
        assert_eq!(pixel[3], 255, "compositing onto an opaque base stays opaque");
    }

    #[test]
    fn image_annotation_with_missing_asset_is_skipped_gracefully() {
        let mut base = RgbaImage::from_pixel(2, 2, Rgba([9, 9, 9, 255]));
        let annotation = Annotation::new(AnnotationType::Image {
            region: Region::new(0.0, 0.0, 2.0, 2.0),
            asset: AssetRef("not-in-the-map".to_string()),
            opacity: 1.0,
        });

        render_annotation(&mut base, &annotation, &HashMap::new());

        assert_eq!(*base.get_pixel(0, 0), Rgba([9, 9, 9, 255]), "no panic, base image untouched");
    }
}
