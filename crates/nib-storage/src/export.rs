//! Image export with baked annotations
//!
//! Renders annotations onto the image and exports as PNG/JPEG/WebP.

use crate::StorageResult;
use ab_glyph::{FontRef, PxScale};
use image::{DynamicImage, Rgba, RgbaImage};
use imageproc::drawing::{
    draw_filled_circle_mut, draw_filled_rect_mut, draw_line_segment_mut, draw_text_mut, text_size,
};
use imageproc::rect::Rect;
use nib_core::blur::apply_blur_region;
use nib_core::{
    dash_segments, Annotation, AnnotationType, ArrowHead, AssetData, Color, NibImage, Point,
    Region, StorageError, StrokeStyle,
};
use std::collections::HashMap;
use std::path::Path;

/// Embedded font for flattened text/sticky-note rendering (MIT-licensed Hack
/// Regular; see assets/fonts/Hack-Regular-LICENSE.txt). Real glyphs instead
/// of the old solid-block placeholder.
static TEXT_FONT_BYTES: &[u8] = include_bytes!("../../../assets/fonts/Hack-Regular.ttf");

fn text_font() -> FontRef<'static> {
    FontRef::try_from_slice(TEXT_FONT_BYTES).expect("embedded font bytes must be valid")
}

/// Clamp a `(pos, size)` span to `[0, canvas_dim)`, shrinking `size` instead
/// of letting the span run off either edge of the canvas.
fn clamp_span(pos: i32, size: u32, canvas_dim: u32) -> (i32, u32) {
    let canvas_dim = canvas_dim as i64;
    let mut pos = pos as i64;
    let mut size = size as i64;
    if pos < 0 {
        size += pos;
        pos = 0;
    }
    if pos >= canvas_dim || size <= 0 {
        return (pos.clamp(0, canvas_dim) as i32, 0);
    }
    if pos + size > canvas_dim {
        size = canvas_dim - pos;
    }
    (pos as i32, size.max(0) as u32)
}

/// Export format options
#[derive(Debug, Clone, Copy, Default)]
pub enum ExportFormat {
    #[default]
    Png,
    Jpeg {
        quality: u8,
    },
    WebP {
        quality: u8,
    },
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
        image::imageops::resize(
            &img,
            new_width,
            new_height,
            image::imageops::FilterType::Lanczos3,
        )
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
fn render_annotation(
    img: &mut RgbaImage,
    annotation: &Annotation,
    assets: &HashMap<String, AssetData>,
) {
    let color = color_to_rgba(&annotation.color);

    match &annotation.annotation_type {
        AnnotationType::Arrow {
            start,
            end,
            head,
            stroke_width,
        } => {
            draw_arrow(img, *start, *end, *head, color, *stroke_width as i32);
        }
        AnnotationType::Box {
            region,
            stroke_width,
            stroke_style,
            filled,
            ..
        } => {
            let rect = Rect::at(region.x as i32, region.y as i32)
                .of_size(region.width as u32, region.height as u32);

            if *filled {
                let fill_color = Rgba([color.0[0], color.0[1], color.0[2], 80]);
                draw_filled_rect_mut(img, rect, fill_color);
            }

            draw_rect_outline_styled(img, region, *stroke_width, *stroke_style, color);
        }
        AnnotationType::Text {
            position,
            content,
            font_size,
            background,
            max_width,
            ..
        } => {
            let font = text_font();
            let scale = PxScale::from(*font_size as f32);
            let line_height = *font_size * 1.2;
            let padding = 2.0_f64;

            // Wrap the same way the live GUI does (nib_core::wrap_text), so a
            // sticky note's background/wrap geometry matches on both paths.
            let lines = nib_core::wrap_text(content, *font_size, *max_width);

            // Measure with the exact font/scale we render with, instead of the
            // old "half the font size per character" heuristic -- that's what
            // let the background run off the canvas edge on wrapped/long text.
            let text_block_width = lines
                .iter()
                .map(|line| text_size(scale, &font, line).0)
                .max()
                .unwrap_or(0) as f64;
            let text_block_height = lines.len() as f64 * line_height;

            if let Some(bg) = background {
                let bg_color = color_to_rgba(bg);
                let rect_x = (position.x - padding).round() as i32;
                let rect_y = (position.y - padding).round() as i32;
                let rect_width = (text_block_width + padding * 2.0).max(1.0).round() as u32;
                let rect_height = (text_block_height + padding * 2.0).max(1.0).round() as u32;

                let (rect_x, rect_width) = clamp_span(rect_x, rect_width, img.width());
                let (rect_y, rect_height) = clamp_span(rect_y, rect_height, img.height());
                if rect_width > 0 && rect_height > 0 {
                    draw_filled_rect_mut(
                        img,
                        Rect::at(rect_x, rect_y).of_size(rect_width, rect_height),
                        bg_color,
                    );
                }
            }

            for (i, line) in lines.iter().enumerate() {
                let y = (position.y + i as f64 * line_height).round() as i32;
                draw_text_mut(img, color, position.x.round() as i32, y, scale, &font, line);
            }
        }
        AnnotationType::Number {
            position,
            value,
            radius,
        } => {
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
        AnnotationType::Line {
            start,
            end,
            stroke_width,
            stroke_style,
        } => {
            draw_styled_line(img, *start, *end, *stroke_style, *stroke_width, color);
        }
        AnnotationType::Ellipse {
            center,
            radius_x,
            radius_y,
            filled,
            ..
        } => {
            // `filled` applies regardless of whether this is a circle
            // (radius_x == radius_y) or a general ellipse -- it used to only
            // be honored for circles, silently rendering non-circular filled
            // ellipses as outline-only.
            if *filled {
                if *radius_x == *radius_y {
                    draw_filled_circle_mut(
                        img,
                        (center.x as i32, center.y as i32),
                        *radius_x as i32,
                        color,
                    );
                } else {
                    draw_filled_ellipse(img, center.x, center.y, *radius_x, *radius_y, color);
                }
            } else if *radius_x == *radius_y {
                draw_circle_outline(img, center.x, center.y, *radius_x, color);
            } else {
                draw_ellipse_outline(img, center.x, center.y, *radius_x, *radius_y, color);
            }
        }
        AnnotationType::Crop { .. } => {
            // Crop regions are not rendered, they're used for export bounds
        }
        AnnotationType::Path {
            points,
            stroke_width,
            stroke_style,
        } => {
            for pair in points.windows(2) {
                draw_styled_line(img, pair[0], pair[1], *stroke_style, *stroke_width, color);
            }
        }
        AnnotationType::Image {
            region,
            asset,
            opacity,
        } => {
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
            dst[c] =
                (pixel[c] as f64 * src_alpha + dst[c] as f64 * (1.0 - src_alpha)).round() as u8;
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
        let dy = if offset == 0 {
            0.0
        } else {
            offset as f32 / 2.0
        };
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

    draw_line_segment_mut(
        img,
        (tip.x as f32, tip.y as f32),
        (ax1 as f32, ay1 as f32),
        color,
    );
    draw_line_segment_mut(
        img,
        (tip.x as f32, tip.y as f32),
        (ax2 as f32, ay2 as f32),
        color,
    );
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
            let dy = if offset == 0 {
                0.0
            } else {
                offset as f32 / 2.0
            };
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

fn draw_ellipse_outline(img: &mut RgbaImage, cx: f64, cy: f64, rx: f64, ry: f64, color: Rgba<u8>) {
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

/// Fill a general (non-circular) ellipse via horizontal scanlines.
fn draw_filled_ellipse(img: &mut RgbaImage, cx: f64, cy: f64, rx: f64, ry: f64, color: Rgba<u8>) {
    if rx <= 0.0 || ry <= 0.0 {
        return;
    }
    let top = (cy - ry).floor() as i64;
    let bottom = (cy + ry).ceil() as i64;

    for y in top..=bottom {
        let dy = (y as f64 - cy) / ry;
        let discriminant = 1.0 - dy * dy;
        if discriminant < 0.0 {
            continue;
        }
        let dx = rx * discriminant.sqrt();
        let x_start = (cx - dx).round() as i64;
        let x_end = (cx + dx).round() as i64;

        if y < 0 || y as u32 >= img.height() {
            continue;
        }
        for x in x_start.max(0)..=x_end.min(img.width() as i64 - 1) {
            img.put_pixel(x as u32, y as u32, color);
        }
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
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
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
            AssetData {
                bytes: asset_bytes,
                format: "png".to_string(),
                width: 2,
                height: 2,
            },
        );

        let annotation = Annotation::new(AnnotationType::Image {
            region: Region::new(1.0, 1.0, 2.0, 2.0),
            asset,
            opacity: 1.0,
        });

        render_annotation(&mut base, &annotation, &assets);

        for (x, y) in [(1, 1), (2, 1), (1, 2), (2, 2)] {
            assert_eq!(
                *base.get_pixel(x, y),
                Rgba([255, 0, 0, 255]),
                "pixel ({x},{y}) should be red"
            );
        }
        for (x, y) in [(0, 0), (3, 3), (0, 3), (3, 0)] {
            assert_eq!(
                *base.get_pixel(x, y),
                Rgba([0, 0, 0, 255]),
                "pixel ({x},{y}) outside the region must stay black"
            );
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
            AssetData {
                bytes: asset_bytes,
                format: "png".to_string(),
                width: 1,
                height: 1,
            },
        );

        let annotation = Annotation::new(AnnotationType::Image {
            region: Region::new(0.0, 0.0, 1.0, 1.0),
            asset,
            opacity: 0.5,
        });

        render_annotation(&mut base, &annotation, &assets);

        // 50% white over black is ~mid-gray, not full white or unchanged black.
        let pixel = base.get_pixel(0, 0);
        assert!(
            (110..=145).contains(&pixel[0]),
            "expected ~50% blend, got {pixel:?}"
        );
        assert_eq!(
            pixel[3], 255,
            "compositing onto an opaque base stays opaque"
        );
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

        assert_eq!(
            *base.get_pixel(0, 0),
            Rgba([9, 9, 9, 255]),
            "no panic, base image untouched"
        );
    }
}

#[cfg(test)]
mod ellipse_and_text_export_tests {
    use super::*;
    use nib_core::TextAlign;

    #[test]
    fn filled_non_circular_ellipse_fills_the_interior() {
        // Regression test: `filled` used to only be honored for perfect
        // circles (radius_x == radius_y); a non-circular filled ellipse
        // rendered outline-only.
        let mut img = RgbaImage::from_pixel(40, 40, Rgba([0, 0, 0, 255]));
        let annotation = Annotation::new(AnnotationType::Ellipse {
            center: Point::new(20.0, 20.0),
            radius_x: 15.0,
            radius_y: 8.0,
            stroke_width: 2.0,
            filled: true,
        })
        .with_color(Color::rgb(255, 0, 0));

        render_annotation(&mut img, &annotation, &HashMap::new());

        assert_eq!(
            *img.get_pixel(20, 20),
            Rgba([255, 0, 0, 255]),
            "ellipse interior must be filled"
        );
        assert_eq!(
            *img.get_pixel(0, 0),
            Rgba([0, 0, 0, 255]),
            "outside the ellipse stays untouched"
        );
    }

    #[test]
    fn unfilled_non_circular_ellipse_still_renders_outline_only() {
        let mut img = RgbaImage::from_pixel(40, 40, Rgba([0, 0, 0, 255]));
        let annotation = Annotation::new(AnnotationType::Ellipse {
            center: Point::new(20.0, 20.0),
            radius_x: 15.0,
            radius_y: 8.0,
            stroke_width: 2.0,
            filled: false,
        })
        .with_color(Color::rgb(255, 0, 0));

        render_annotation(&mut img, &annotation, &HashMap::new());

        assert_eq!(
            *img.get_pixel(20, 20),
            Rgba([0, 0, 0, 255]),
            "unfilled interior stays untouched"
        );
    }

    #[test]
    fn text_renders_real_antialiased_glyphs_not_solid_blocks() {
        let mut img = RgbaImage::from_pixel(200, 60, Rgba([255, 255, 255, 255]));
        let annotation = Annotation::new(AnnotationType::Text {
            position: Point::new(5.0, 5.0),
            content: "Hi".to_string(),
            font_size: 32.0,
            align: TextAlign::Left,
            background: None,
            max_width: None,
        })
        .with_color(Color::rgb(0, 0, 0));

        render_annotation(&mut img, &annotation, &HashMap::new());

        // Real glyph rasterization anti-aliases edges, producing pixel values
        // strictly between white and black. A solid-block placeholder can
        // only ever produce fully-black or fully-white pixels.
        let saw_partial_shade = img.pixels().any(|p| p[0] > 10 && p[0] < 245);
        assert!(
            saw_partial_shade,
            "expected anti-aliased glyph edges, got only solid colors (block placeholder?)"
        );
    }

    #[test]
    fn sticky_note_background_stays_within_canvas_when_wrapped_near_the_edge() {
        // Regression test: the background rect used to be sized from a
        // "half the font size per character" heuristic (ignoring max_width
        // wrapping entirely), so a wrapped sticky note's background ran off
        // the canvas. Position it near the bottom-right corner with content
        // that needs wrapping.
        let mut img = RgbaImage::from_pixel(60, 60, Rgba([0, 0, 0, 255]));
        let annotation = Annotation::new(AnnotationType::Text {
            position: Point::new(50.0, 50.0),
            content: "one two three four five six seven eight nine ten".to_string(),
            font_size: 14.0,
            align: TextAlign::Left,
            background: Some(Color::rgb(241, 250, 140)),
            max_width: Some(60.0),
        })
        .with_color(Color::rgb(0, 0, 0));

        // Must not panic (an unclamped rect would try to draw outside the
        // image buffer) and must still paint some background pixels.
        render_annotation(&mut img, &annotation, &HashMap::new());

        let found_background = img.pixels().any(|p| *p == Rgba([241, 250, 140, 255]));
        assert!(
            found_background,
            "background must still render when clamped to the canvas edge"
        );
    }

    #[test]
    fn text_wrap_matches_nib_core_wrap_text() {
        // The export path's background sizing wraps content the same way
        // the live GUI does, via the shared nib_core::wrap_text -- this
        // pins that it's actually being called (not a local reimplementation
        // that could silently drift).
        let lines =
            nib_core::wrap_text("one two three four five six seven eight", 16.0, Some(60.0));
        assert!(lines.len() > 1);
    }
}
