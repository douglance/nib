//! OCR module using the OCRS library for text detection and recognition.
//!
//! This module provides text detection with precise bounding boxes for
//! annotating screenshots with highlight annotations.

use crate::core::Result;
use ocrs::{ImageSource, OcrEngine, OcrEngineParams, TextItem};
use rten::Model;
use std::path::PathBuf;
use std::sync::Mutex;

const DETECTION_MODEL_URL: &str =
    "https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten";
const RECOGNITION_MODEL_URL: &str =
    "https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten";

static OCR_ENGINE: Mutex<Option<OcrEngine>> = Mutex::new(None);

/// A detected text region with its bounding box.
#[derive(Debug, Clone)]
pub struct TextRegion {
    pub text: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub confidence: f32,
}

/// A rectangular region for filtering OCR results.
#[derive(Debug, Clone, Copy)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Region {
    /// Create a new region from coordinates.
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self { x, y, width, height }
    }

    /// Check if this region intersects with a text region.
    pub fn intersects(&self, text_region: &TextRegion) -> bool {
        // Two rectangles intersect if they overlap on both axes
        let self_right = self.x + self.width;
        let self_bottom = self.y + self.height;
        let text_right = text_region.x + text_region.width;
        let text_bottom = text_region.y + text_region.height;

        // Check for non-intersection and negate
        !(self.x >= text_right
            || text_region.x >= self_right
            || self.y >= text_bottom
            || text_region.y >= self_bottom)
    }
}

/// Get the directory where OCR models are cached.
fn models_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("quill")
        .join("ocr-models")
}

/// Download a model file if it doesn't exist locally.
fn ensure_model(url: &str, filename: &str) -> Result<PathBuf> {
    let models_path = models_dir();
    std::fs::create_dir_all(&models_path)?;

    let model_path = models_path.join(filename);

    if model_path.exists() {
        tracing::debug!("Model already cached: {}", model_path.display());
        return Ok(model_path);
    }

    tracing::info!("Downloading OCR model: {} -> {}", url, model_path.display());
    eprintln!("Downloading OCR model: {}...", filename);

    // Use a simple blocking HTTP request
    let response = ureq_download(url)?;
    std::fs::write(&model_path, response)?;

    tracing::info!("Model downloaded: {}", model_path.display());
    eprintln!("Model downloaded successfully.");

    Ok(model_path)
}

/// Simple blocking HTTP download (no async runtime needed).
fn ureq_download(url: &str) -> Result<Vec<u8>> {
    // Use std::process to run curl since we don't want to add another HTTP dep
    let output = std::process::Command::new("curl")
        .arg("-fsSL")
        .arg(url)
        .output()
        .map_err(|e| {
            crate::core::QuillError::Other(format!("Failed to run curl: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(crate::core::QuillError::Other(format!(
            "Failed to download model: {}",
            stderr
        )));
    }

    Ok(output.stdout)
}

/// Initialize the OCR engine (downloads models if needed).
fn init_engine() -> Result<OcrEngine> {
    let detection_path = ensure_model(DETECTION_MODEL_URL, "text-detection.rten")?;
    let recognition_path = ensure_model(RECOGNITION_MODEL_URL, "text-recognition.rten")?;

    let detection_model = Model::load_file(&detection_path).map_err(|e| {
        crate::core::QuillError::Other(format!("Failed to load detection model: {}", e))
    })?;

    let recognition_model = Model::load_file(&recognition_path).map_err(|e| {
        crate::core::QuillError::Other(format!("Failed to load recognition model: {}", e))
    })?;

    let engine = OcrEngine::new(OcrEngineParams {
        detection_model: Some(detection_model),
        recognition_model: Some(recognition_model),
        ..Default::default()
    })
    .map_err(|e| crate::core::QuillError::Other(format!("Failed to create OCR engine: {}", e)))?;

    Ok(engine)
}

/// Get or initialize the global OCR engine.
fn get_or_init_engine() -> Result<()> {
    let mut guard = OCR_ENGINE.lock().map_err(|e| {
        crate::core::QuillError::Other(format!("Failed to lock OCR engine: {}", e))
    })?;

    if guard.is_none() {
        *guard = Some(init_engine()?);
    }

    Ok(())
}

/// Extract all text regions from an image file.
pub fn extract_text_regions(image_path: &std::path::Path) -> Result<Vec<TextRegion>> {
    // Ensure engine is initialized
    get_or_init_engine()?;

    let guard = OCR_ENGINE.lock().map_err(|e| {
        crate::core::QuillError::Other(format!("Failed to lock OCR engine: {}", e))
    })?;

    let engine = guard.as_ref().ok_or_else(|| {
        crate::core::QuillError::Other("OCR engine not initialized".to_string())
    })?;

    // Load and prepare image
    let img = image::open(image_path)
        .map_err(|e| crate::core::QuillError::Other(format!("Failed to open image: {}", e)))?
        .into_rgb8();

    let img_source = ImageSource::from_bytes(img.as_raw(), img.dimensions()).map_err(|e| {
        crate::core::QuillError::Other(format!("Failed to create image source: {}", e))
    })?;

    let ocr_input = engine.prepare_input(img_source).map_err(|e| {
        crate::core::QuillError::Other(format!("Failed to prepare OCR input: {}", e))
    })?;

    // Step 1: Detect word bounding boxes
    let word_rects = engine.detect_words(&ocr_input).map_err(|e| {
        crate::core::QuillError::Other(format!("Failed to detect words: {}", e))
    })?;

    // Step 2: Group words into lines
    let line_rects = engine.find_text_lines(&ocr_input, &word_rects);

    // Step 3: Recognize text in each line
    let line_texts = engine.recognize_text(&ocr_input, &line_rects).map_err(|e| {
        crate::core::QuillError::Other(format!("Failed to recognize text: {}", e))
    })?;

    // Collect results with word-level bounding boxes
    let mut regions = Vec::new();

    for line in line_texts.iter().flatten() {
        for word in line.words() {
            let rect = word.bounding_rect();
            let text = word.to_string();

            if text.trim().is_empty() {
                continue;
            }

            regions.push(TextRegion {
                text,
                x: rect.left(),
                y: rect.top(),
                width: rect.width() as i32,
                height: rect.height() as i32,
                confidence: 1.0, // OCRS doesn't provide per-word confidence
            });
        }
    }

    Ok(regions)
}

/// Extract text regions matching a search query, optionally filtered by a bounding region.
///
/// # Arguments
/// * `image_path` - Path to the image file
/// * `search` - Optional search term (case-insensitive substring match)
/// * `region` - Optional region to filter results (only returns text that intersects with this region)
pub fn find_text(
    image_path: &std::path::Path,
    search: Option<&str>,
    region: Option<Region>,
) -> Result<Vec<TextRegion>> {
    let mut regions = extract_text_regions(image_path)?;

    // Filter by search term if provided
    if let Some(query) = search {
        let query_lower = query.to_lowercase();
        regions.retain(|r| r.text.to_lowercase().contains(&query_lower));
    }

    // Filter by region if provided
    if let Some(ref filter_region) = region {
        regions.retain(|r| filter_region.intersects(r));
    }

    Ok(regions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_models_dir() {
        let dir = models_dir();
        assert!(dir.to_string_lossy().contains("quill"));
        assert!(dir.to_string_lossy().contains("ocr-models"));
    }

    #[test]
    fn test_region_intersects_overlapping() {
        let region = Region::new(100, 100, 200, 100);
        let text = TextRegion {
            text: "test".to_string(),
            x: 150,
            y: 120,
            width: 50,
            height: 20,
            confidence: 1.0,
        };
        assert!(region.intersects(&text));
    }

    #[test]
    fn test_region_intersects_partial_overlap() {
        let region = Region::new(100, 100, 100, 100);
        let text = TextRegion {
            text: "test".to_string(),
            x: 150,
            y: 150,
            width: 100,
            height: 100,
            confidence: 1.0,
        };
        assert!(region.intersects(&text));
    }

    #[test]
    fn test_region_no_intersection_to_right() {
        let region = Region::new(100, 100, 50, 50);
        let text = TextRegion {
            text: "test".to_string(),
            x: 200,
            y: 100,
            width: 50,
            height: 50,
            confidence: 1.0,
        };
        assert!(!region.intersects(&text));
    }

    #[test]
    fn test_region_no_intersection_below() {
        let region = Region::new(100, 100, 50, 50);
        let text = TextRegion {
            text: "test".to_string(),
            x: 100,
            y: 200,
            width: 50,
            height: 50,
            confidence: 1.0,
        };
        assert!(!region.intersects(&text));
    }

    #[test]
    fn test_region_edge_touching_not_intersecting() {
        let region = Region::new(100, 100, 50, 50);
        let text = TextRegion {
            text: "test".to_string(),
            x: 150,
            y: 100,
            width: 50,
            height: 50,
            confidence: 1.0,
        };
        // Edge-touching rectangles are NOT considered intersecting
        assert!(!region.intersects(&text));
    }
}
