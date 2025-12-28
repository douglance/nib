//! Blur/redact region rendering

use crate::core::{BlurIntensity, Region};

/// Render parameters for blur region
pub struct BlurRender {
    pub region: Region,
    pub intensity: BlurIntensity,
}

impl BlurRender {
    pub fn new(region: Region, intensity: BlurIntensity) -> Self {
        Self { region, intensity }
    }

    /// Get blur radius in pixels
    pub fn blur_radius(&self) -> u32 {
        self.intensity.radius()
    }

    /// Whether to use pixelation instead of blur
    pub fn is_pixelate(&self) -> bool {
        matches!(self.intensity, BlurIntensity::Pixelate)
    }

    /// Get pixel block size for pixelation
    pub fn pixel_size(&self) -> u32 {
        self.intensity.pixel_size()
    }
}
