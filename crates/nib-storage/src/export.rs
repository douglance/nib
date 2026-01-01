//! Image export with baked annotations
//!
//! Renders annotations onto the image and exports as PNG/JPEG/WebP.

use crate::StorageResult;
use nib_core::blur::apply_blur_region;
use nib_core::{Annotation, AnnotationType, Color, NibImage, Region, StorageError};
use image::{DynamicImage, Rgba, RgbaImage};
use imageproc::drawing::{
    draw_filled_circle_mut, draw_filled_rect_mut, draw_hollow_rect_mut, draw_line_segment_mut,
};
use imageproc::rect::Rect;
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
        render_annotations(&mut img, &image.annotations);
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
fn render_annotations(img: &mut RgbaImage, annotations: &[Annotation]) {
    // Sort by z-index for proper layering
    let mut sorted: Vec<_> = annotations.iter().filter(|a| a.visible).collect();
    sorted.sort_by_key(|a| a.z_index);

    for annotation in sorted {
        render_annotation(img, annotation);
    }
}

/// Render a single annotation
fn render_annotation(img: &mut RgbaImage, annotation: &Annotation) {
    let color = color_to_rgba(&annotation.color);

    match &annotation.annotation_type {
        AnnotationType::Arrow { start, end, stroke_width, .. } => {
            draw_arrow(img, *start, *end, color, *stroke_width as i32);
        }
        AnnotationType::Box { region, stroke_width, filled, .. } => {
            let rect = Rect::at(region.x as i32, region.y as i32)
                .of_size(region.width as u32, region.height as u32);

            if *filled {
                let fill_color = Rgba([color.0[0], color.0[1], color.0[2], 80]);
                draw_filled_rect_mut(img, rect, fill_color);
            }

            // Draw border multiple times for stroke width
            for i in 0..(*stroke_width as i32).max(1) {
                let adjusted = Rect::at(region.x as i32 + i, region.y as i32 + i)
                    .of_size(
                        (region.width as i32 - 2 * i).max(1) as u32,
                        (region.height as i32 - 2 * i).max(1) as u32,
                    );
                draw_hollow_rect_mut(img, adjusted, color);
            }
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
        AnnotationType::Line { start, end, stroke_width, .. } => {
            // Draw line with thickness
            for offset in 0..(*stroke_width as i32).max(1) {
                let dy = if offset == 0 { 0 } else { offset / 2 };
                draw_line_segment_mut(
                    img,
                    (start.x as f32, start.y as f32 + dy as f32),
                    (end.x as f32, end.y as f32 + dy as f32),
                    color,
                );
            }
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
        AnnotationType::Path { points, stroke_width, .. } => {
            if points.len() >= 2 {
                // Draw connected line segments for the path
                for offset in 0..(*stroke_width as i32).max(1) {
                    let dy = if offset == 0 { 0.0 } else { offset as f32 / 2.0 };
                    for i in 0..points.len() - 1 {
                        let start = &points[i];
                        let end = &points[i + 1];
                        draw_line_segment_mut(
                            img,
                            (start.x as f32, start.y as f32 + dy),
                            (end.x as f32, end.y as f32 + dy),
                            color,
                        );
                    }
                }
            }
        }
    }
}

fn color_to_rgba(color: &Color) -> Rgba<u8> {
    Rgba([color.r, color.g, color.b, color.a])
}

fn draw_arrow(
    img: &mut RgbaImage,
    start: nib_core::Point,
    end: nib_core::Point,
    color: Rgba<u8>,
    stroke_width: i32,
) {
    // Draw line
    for offset in 0..stroke_width.max(1) {
        let dy = if offset == 0 { 0.0 } else { offset as f32 / 2.0 };
        draw_line_segment_mut(
            img,
            (start.x as f32, start.y as f32 + dy),
            (end.x as f32, end.y as f32 + dy),
            color,
        );
    }

    // Draw arrowhead
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let len = (dx * dx + dy * dy).sqrt();

    if len > 0.0 {
        let arrow_size: f64 = 15.0;
        let angle: f64 = 0.5; // radians

        // Normalize direction
        let ndx = dx / len;
        let ndy = dy / len;

        // Calculate arrowhead points
        let ax1 = end.x - arrow_size * (ndx * angle.cos() + ndy * angle.sin());
        let ay1 = end.y - arrow_size * (ndy * angle.cos() - ndx * angle.sin());
        let ax2 = end.x - arrow_size * (ndx * angle.cos() - ndy * angle.sin());
        let ay2 = end.y - arrow_size * (ndy * angle.cos() + ndx * angle.sin());

        // Draw arrowhead lines
        draw_line_segment_mut(img, (end.x as f32, end.y as f32), (ax1 as f32, ay1 as f32), color);
        draw_line_segment_mut(img, (end.x as f32, end.y as f32), (ax2 as f32, ay2 as f32), color);
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
        render_annotations(&mut img, &image.annotations);
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
