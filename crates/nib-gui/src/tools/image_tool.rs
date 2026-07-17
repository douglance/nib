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
        build_image_annotation(width, height, rgba_bytes, position)
    }
}

/// Build the Image annotation + its asset bytes for a decoded RGBA buffer,
/// placed with its top-left corner at `position`. Shared by clipboard-paste
/// (`ImageTool::paste_at`) and drag-and-drop (`EditorView::handle_file_drop`
/// in app.rs) so both insertion paths go through identical
/// scaling/hashing/annotation-building logic.
pub(crate) fn build_image_annotation(
    width: u32,
    height: u32,
    rgba_bytes: Vec<u8>,
    position: Point,
) -> Option<(Annotation, AssetData)> {
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

/// True if `path`'s extension (case-insensitive) names a raster image format
/// this tool knows how to decode.
pub(crate) fn is_image_extension(path: &std::path::Path) -> bool {
    const IMAGE_EXTENSIONS: &[&str] =
        &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"];
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
}

/// `count` points diagonally staggered from `base` by 16px per step, so
/// multi-file drops don't stack invisibly on top of each other.
pub(crate) fn stagger_positions(base: Point, count: usize) -> Vec<Point> {
    (0..count)
        .map(|i| Point::new(base.x + 16.0 * i as f64, base.y + 16.0 * i as f64))
        .collect()
}

/// Read and decode an image file from disk into raw RGBA bytes. Mirrors the
/// shape `ImageTool::clipboard_rgba` returns so it plugs into
/// `build_image_annotation` the same way. Never panics: any failure (missing
/// file, unreadable bytes, undecodable format) yields `None`.
pub(crate) fn load_image_file(path: &std::path::Path) -> Option<(u32, u32, Vec<u8>)> {
    let bytes = std::fs::read(path).ok()?;
    let rgba = image::load_from_memory(&bytes).ok()?.to_rgba8();
    Some((rgba.width(), rgba.height(), rgba.into_raw()))
}

/// Build Image annotations for each image file dropped onto the canvas.
/// Filters `paths` down to recognized image extensions, staggers their
/// insertion positions from `base_position`, and builds an
/// (Annotation, AssetData) pair for each one that decodes successfully.
/// Returns the built pairs plus a count of everything skipped along the way
/// (non-image extension, unreadable/undecodable file, or annotation-build
/// failure). Never panics regardless of input.
pub(crate) fn images_from_dropped_paths(
    paths: &[std::path::PathBuf],
    base_position: Point,
) -> (Vec<(Annotation, AssetData)>, usize) {
    let image_paths: Vec<&std::path::PathBuf> =
        paths.iter().filter(|p| is_image_extension(p)).collect();
    let mut skipped = paths.len() - image_paths.len();

    let positions = stagger_positions(base_position, image_paths.len());
    let mut pairs = Vec::new();
    for (path, position) in image_paths.into_iter().zip(positions) {
        let built = load_image_file(path)
            .and_then(|(width, height, bytes)| build_image_annotation(width, height, bytes, position));
        match built {
            Some(pair) => pairs.push(pair),
            None => skipped += 1,
        }
    }

    (pairs, skipped)
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

    #[test]
    fn is_image_extension_accepts_known_image_extensions_case_insensitively() {
        assert!(is_image_extension(std::path::Path::new("photo.png")));
        assert!(is_image_extension(std::path::Path::new("photo.jpg")));
        assert!(is_image_extension(std::path::Path::new("PHOTO.JPG")));
        assert!(is_image_extension(std::path::Path::new("photo.webp")));
        assert!(is_image_extension(std::path::Path::new("photo.jpeg")));
        assert!(is_image_extension(std::path::Path::new("photo.gif")));
        assert!(is_image_extension(std::path::Path::new("photo.bmp")));
        assert!(is_image_extension(std::path::Path::new("photo.tiff")));
        assert!(is_image_extension(std::path::Path::new("photo.tif")));
    }

    #[test]
    fn is_image_extension_rejects_non_image_extensions_and_missing_extension() {
        assert!(!is_image_extension(std::path::Path::new("notes.txt")));
        assert!(!is_image_extension(std::path::Path::new("doc.nib")));
        assert!(!is_image_extension(std::path::Path::new("no_extension")));
    }

    #[test]
    fn stagger_positions_returns_empty_for_zero_count() {
        assert_eq!(stagger_positions(Point::new(10.0, 20.0), 0), Vec::new());
    }

    #[test]
    fn stagger_positions_returns_base_unchanged_for_one() {
        let base = Point::new(10.0, 20.0);
        assert_eq!(stagger_positions(base, 1), vec![base]);
    }

    #[test]
    fn stagger_positions_diagonally_offsets_each_subsequent_point_by_16px() {
        let base = Point::new(10.0, 20.0);
        assert_eq!(
            stagger_positions(base, 3),
            vec![
                Point::new(10.0, 20.0),
                Point::new(26.0, 36.0),
                Point::new(42.0, 52.0),
            ]
        );
    }

    /// Write a small solid-color PNG to `path`, mirroring how the clipboard
    /// tests build PNG bytes (RgbaImage -> DynamicImage -> write_to).
    fn write_solid_png(path: &std::path::Path, width: u32, height: u32) {
        let rgba = image::RgbaImage::from_raw(width, height, small_rgba(width, height)).unwrap();
        image::DynamicImage::ImageRgba8(rgba)
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }

    #[test]
    fn load_image_file_decodes_a_valid_png() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("photo.png");
        write_solid_png(&path, 3, 2);

        let (width, height, bytes) = load_image_file(&path).expect("should decode PNG");
        assert_eq!(width, 3);
        assert_eq!(height, 2);
        assert_eq!(bytes.len(), (3 * 2 * 4) as usize);
    }

    #[test]
    fn load_image_file_returns_none_for_corrupt_bytes() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("bad.png");
        std::fs::write(&path, b"not a real png").unwrap();

        assert!(load_image_file(&path).is_none());
    }

    #[test]
    fn load_image_file_returns_none_for_missing_path() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("does_not_exist.png");

        assert!(load_image_file(&path).is_none());
    }

    #[test]
    fn images_from_dropped_paths_inserts_all_valid_images_with_staggered_positions() {
        let dir = tempfile::TempDir::new().unwrap();
        let path_a = dir.path().join("a.png");
        let path_b = dir.path().join("b.png");
        write_solid_png(&path_a, 2, 2);
        write_solid_png(&path_b, 4, 4);

        let base = Point::new(100.0, 200.0);
        let (pairs, skipped) = images_from_dropped_paths(&[path_a, path_b], base);

        assert_eq!(skipped, 0);
        assert_eq!(pairs.len(), 2);

        let region_of = |annotation: &Annotation| match &annotation.annotation_type {
            AnnotationType::Image { region, .. } => *region,
            other => panic!("expected Image, got {other:?}"),
        };
        let region_a = region_of(&pairs[0].0);
        assert_eq!(region_a.x, 100.0);
        assert_eq!(region_a.y, 200.0);
        assert_eq!(pairs[0].1.width, 2);
        assert_eq!(pairs[0].1.height, 2);

        let region_b = region_of(&pairs[1].0);
        assert_eq!(region_b.x, 116.0);
        assert_eq!(region_b.y, 216.0);
        assert_eq!(pairs[1].1.width, 4);
        assert_eq!(pairs[1].1.height, 4);
    }

    #[test]
    fn images_from_dropped_paths_skips_non_image_files_but_keeps_images() {
        let dir = tempfile::TempDir::new().unwrap();
        let image_path = dir.path().join("a.png");
        let text_path = dir.path().join("notes.txt");
        write_solid_png(&image_path, 2, 2);
        std::fs::write(&text_path, b"hello").unwrap();

        let (pairs, skipped) =
            images_from_dropped_paths(&[image_path, text_path], Point::new(0.0, 0.0));

        assert_eq!(pairs.len(), 1);
        assert_eq!(skipped, 1);
    }

    #[test]
    fn images_from_dropped_paths_returns_empty_when_no_images() {
        let dir = tempfile::TempDir::new().unwrap();
        let text_path = dir.path().join("notes.txt");
        std::fs::write(&text_path, b"hello").unwrap();

        let paths = vec![text_path];
        let (pairs, skipped) = images_from_dropped_paths(&paths, Point::new(0.0, 0.0));

        assert!(pairs.is_empty());
        assert_eq!(skipped, paths.len());
    }
}
