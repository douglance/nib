//! Image tool implementation
//!
//! Inserts an image annotation from the system clipboard. No file-dialog
//! crate is linked in this workspace, so clipboard-paste is the primary (and
//! only) insertion path, per the plan's documented fallback: "file dialog if
//! a linked crate offers it, else clipboard-paste first."

use std::any::Any;
use std::io::Cursor;

use nib_core::{Annotation, AnnotationType, AssetData, AssetRef, Point, Region};

use super::{MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolPreview, ToolResult};

/// Inserted images are scaled down to fit within this on either axis (image
/// pixels) so pasting a full screenshot doesn't drop a canvas-sized annotation;
/// the user can resize afterward via the existing 8-handle resize path.
const MAX_INSERT_DIMENSION: f64 = 400.0;

/// Tool that inserts an image annotation from the clipboard on click
pub struct ImageTool {
    /// Injected in tests to avoid touching the real system clipboard;
    /// `None` means "use `arboard::Clipboard`" (production behavior).
    #[cfg(test)]
    test_clipboard_image: Option<Option<(u32, u32, Vec<u8>)>>,
}

impl ImageTool {
    pub fn new() -> Self {
        Self {
            #[cfg(test)]
            test_clipboard_image: None,
        }
    }

    fn clipboard_rgba(&self) -> Option<(u32, u32, Vec<u8>)> {
        #[cfg(test)]
        if let Some(injected) = &self.test_clipboard_image {
            return injected.clone();
        }
        let mut clipboard = arboard::Clipboard::new().ok()?;
        let image_data = clipboard.get_image().ok()?;
        Some((image_data.width as u32, image_data.height as u32, image_data.bytes.into_owned()))
    }

    /// Build the Image annotation + its asset bytes for whatever's on the
    /// clipboard, placed with its top-left corner at `position`. `None` if
    /// there's no image on the clipboard (or, in tests, none injected).
    fn paste_at(&self, position: Point) -> Option<(Annotation, AssetData)> {
        let (width, height, rgba_bytes) = self.clipboard_rgba()?;
        let rgba = image::RgbaImage::from_raw(width, height, rgba_bytes)?;

        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageRgba8(rgba)
            .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .ok()?;

        let asset = AssetRef::from_bytes(&png_bytes);
        let (region_w, region_h) = scaled_insert_size(width as f64, height as f64);
        let region = Region::new(position.x, position.y, region_w, region_h);

        let annotation = Annotation::new(AnnotationType::Image {
            region,
            asset: asset.clone(),
            opacity: 1.0,
        });
        let asset_data = AssetData {
            bytes: png_bytes,
            format: "png".to_string(),
            width,
            height,
        };

        Some((annotation, asset_data))
    }
}

impl Default for ImageTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Scale `(width, height)` down (preserving aspect ratio) so neither side
/// exceeds `MAX_INSERT_DIMENSION`; leaves smaller images untouched.
fn scaled_insert_size(width: f64, height: f64) -> (f64, f64) {
    if width <= MAX_INSERT_DIMENSION && height <= MAX_INSERT_DIMENSION {
        return (width, height);
    }
    let scale = (MAX_INSERT_DIMENSION / width).min(MAX_INSERT_DIMENSION / height);
    (width * scale, height * scale)
}

impl Tool for ImageTool {
    fn id(&self) -> ToolId {
        ToolId::Image
    }

    fn name(&self) -> &'static str {
        "Image"
    }

    fn shortcut(&self) -> char {
        'i'
    }

    fn icon_path(&self) -> &'static str {
        "icons/image.svg"
    }

    fn handle_event(&mut self, event: ToolEvent, _ctx: &ToolContext) -> ToolResult {
        match event {
            ToolEvent::MouseDown {
                position,
                button: MouseButton::Left,
                ..
            } => match self.paste_at(position) {
                Some((annotation, asset)) => ToolResult::CreatedWithAsset {
                    asset_hash: asset_ref_hash(&annotation),
                    annotation,
                    asset,
                },
                None => ToolResult::Ignored,
            },
            _ => ToolResult::Ignored,
        }
    }

    fn preview(&self, _ctx: &ToolContext) -> ToolPreview {
        ToolPreview::None
    }

    fn reset(&mut self) {}

    fn is_active(&self) -> bool {
        false
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

/// Extract the asset hash from a freshly-built Image annotation.
fn asset_ref_hash(annotation: &Annotation) -> String {
    match &annotation.annotation_type {
        AnnotationType::Image { asset, .. } => asset.0.clone(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nib_core::{AnnotationStyle, Color, StrokeStyle};

    fn ctx() -> ToolContext<'static> {
        static EMPTY: Vec<Annotation> = Vec::new();
        ToolContext {
            style: AnnotationStyle::Custom,
            custom_color: Color::RED,
            stroke_width: 2.0,
            fill_enabled: false,
            stroke_style: StrokeStyle::Solid,
            arrow_head: nib_core::ArrowHead::End,
            font_size: 32.0,
            blur_intensity: nib_core::BlurIntensity::Medium,
            opacity: 1.0,
            image_size: (1920, 1080),
            scale: 1.0,
            offset: (0.0, 0.0),
            annotations: &EMPTY,
            min_drag_distance: 5.0,
        }
    }

    /// A tiny 2x2 opaque red RGBA buffer, for injecting as "clipboard contents".
    fn small_rgba(width: u32, height: u32) -> Vec<u8> {
        [255u8, 0, 0, 255].repeat((width * height) as usize)
    }

    #[test]
    fn click_with_no_clipboard_image_is_ignored() {
        let mut tool = ImageTool::new();
        tool.test_clipboard_image = Some(None);

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(10.0, 20.0),
                button: MouseButton::Left,
                modifiers: super::super::Modifiers::default(),
            },
            &ctx(),
        );
        assert!(matches!(result, ToolResult::Ignored));
    }

    #[test]
    fn click_with_clipboard_image_creates_annotation_with_asset() {
        let mut tool = ImageTool::new();
        tool.test_clipboard_image = Some(Some((2, 2, small_rgba(2, 2))));

        let result = tool.handle_event(
            ToolEvent::MouseDown {
                position: Point::new(10.0, 20.0),
                button: MouseButton::Left,
                modifiers: super::super::Modifiers::default(),
            },
            &ctx(),
        );

        match result {
            ToolResult::CreatedWithAsset { annotation, asset_hash, asset } => {
                match annotation.annotation_type {
                    AnnotationType::Image { region, asset: asset_ref, opacity } => {
                        assert_eq!(region.x, 10.0);
                        assert_eq!(region.y, 20.0);
                        assert_eq!(region.width, 2.0);
                        assert_eq!(region.height, 2.0);
                        assert_eq!(opacity, 1.0);
                        assert_eq!(asset_ref.0, asset_hash);
                    }
                    other => panic!("expected Image, got {other:?}"),
                }
                assert_eq!(asset.format, "png");
                assert_eq!(asset.width, 2);
                assert_eq!(asset.height, 2);
                assert!(!asset.bytes.is_empty());
                assert_eq!(asset_hash, AssetRef::from_bytes(&asset.bytes).0);
            }
            other => panic!("expected CreatedWithAsset, got {other:?}"),
        }
    }

    #[test]
    fn large_image_is_scaled_down_preserving_aspect_ratio() {
        assert_eq!(scaled_insert_size(800.0, 400.0), (400.0, 200.0));
        assert_eq!(scaled_insert_size(200.0, 100.0), (200.0, 100.0), "small images stay untouched");
    }
}
