use std::fmt;
use std::str::FromStr;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const ALLOWED_ASPECTS: &[&str] = &[
    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
];
pub const MAX_PROMPT_CHARS: usize = 4_000;
pub const MAX_REFERENCE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_REFERENCE_TOTAL_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Fast,
    Standard,
    Pro,
}

impl Quality {
    pub fn model_id(self) -> &'static str {
        match self {
            Self::Fast => "google/nano-banana-2-lite",
            Self::Standard => "google/nano-banana-2",
            Self::Pro => "google/nano-banana-pro",
        }
    }

    pub fn price_cents(self, resolution: Resolution) -> Result<u32, UiError> {
        match (self, resolution) {
            (Self::Fast, Resolution::OneK) => Ok(12),
            (Self::Fast, _) => Err(UiError::UnsupportedQualityResolution),
            (Self::Standard, Resolution::OneK) => Ok(22),
            (Self::Standard, Resolution::TwoK) => Ok(32),
            (Self::Standard, Resolution::FourK) => Ok(48),
            (Self::Pro, Resolution::OneK | Resolution::TwoK) => Ok(43),
            (Self::Pro, Resolution::FourK) => Ok(75),
        }
    }
}

impl fmt::Display for Quality {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Fast => "fast",
            Self::Standard => "standard",
            Self::Pro => "pro",
        })
    }
}

impl FromStr for Quality {
    type Err = UiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "fast" => Ok(Self::Fast),
            "standard" => Ok(Self::Standard),
            "pro" => Ok(Self::Pro),
            _ => Err(UiError::InvalidOption("quality", value.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum Resolution {
    #[serde(rename = "1K")]
    OneK,
    #[serde(rename = "2K")]
    TwoK,
    #[serde(rename = "4K")]
    FourK,
}

impl fmt::Display for Resolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::OneK => "1K",
            Self::TwoK => "2K",
            Self::FourK => "4K",
        })
    }
}

impl FromStr for Resolution {
    type Err = UiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "1K" | "1k" => Ok(Self::OneK),
            "2K" | "2k" => Ok(Self::TwoK),
            "4K" | "4k" => Ok(Self::FourK),
            _ => Err(UiError::InvalidOption("resolution", value.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpg,
}

impl ImageFormat {
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpg => "image/jpeg",
        }
    }
}

impl FromStr for ImageFormat {
    type Err = UiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "png" => Ok(Self::Png),
            "jpg" | "jpeg" => Ok(Self::Jpg),
            _ => Err(UiError::InvalidOption("format", value.to_string())),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ReferenceImage {
    pub name: String,
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GenerationRequest {
    pub prompt: Option<String>,
    pub resume_job_id: Option<String>,
    pub references: Vec<ReferenceImage>,
    pub quality: Quality,
    pub aspect: String,
    pub resolution: Resolution,
    pub format: ImageFormat,
    pub background: bool,
}

impl GenerationRequest {
    pub fn validate(&self) -> Result<(), UiError> {
        let has_prompt = self
            .prompt
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty());
        let has_resume = self
            .resume_job_id
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty());
        if has_prompt == has_resume {
            return Err(UiError::PromptOrResumeRequired);
        }
        if self
            .prompt
            .as_ref()
            .is_some_and(|prompt| prompt.chars().count() > MAX_PROMPT_CHARS)
        {
            return Err(UiError::PromptTooLong);
        }
        if self.references.len() > 3 {
            return Err(UiError::TooManyReferences);
        }
        if !ALLOWED_ASPECTS.contains(&self.aspect.as_str()) {
            return Err(UiError::InvalidOption("aspect", self.aspect.clone()));
        }
        self.quality.price_cents(self.resolution)?;
        let mut total_reference_bytes = 0;
        for reference in &self.references {
            if !matches!(
                reference.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            ) {
                return Err(UiError::UnsupportedReferenceType(
                    reference.mime_type.clone(),
                ));
            }
            let padding = usize::from(reference.data.ends_with('='))
                + usize::from(reference.data.ends_with("=="));
            let bytes = (reference.data.len().saturating_mul(3) / 4).saturating_sub(padding);
            if bytes > MAX_REFERENCE_BYTES {
                return Err(UiError::ReferenceTooLarge);
            }
            total_reference_bytes += bytes;
        }
        if total_reference_bytes > MAX_REFERENCE_TOTAL_BYTES {
            return Err(UiError::ReferencesTooLarge);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn test_request(quality: Quality, resolution: Resolution) -> Self {
        Self {
            prompt: Some("A focused settings screen".to_string()),
            resume_job_id: None,
            references: Vec::new(),
            quality,
            aspect: "16:9".to_string(),
            resolution,
            format: ImageFormat::Png,
            background: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImagePayload {
    pub data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GenerationResponse {
    pub job_id: String,
    pub status: String,
    pub model: String,
    pub quality: Quality,
    pub aspect: String,
    pub resolution: Resolution,
    pub format: ImageFormat,
    pub usage_cents: u32,
    pub artifact_url: Option<String>,
    pub image: Option<ImagePayload>,
    pub output_path: Option<String>,
}

#[derive(Debug, Error)]
pub enum UiError {
    #[error("provide exactly one of a prompt or --resume")]
    PromptOrResumeRequired,
    #[error("at most three reference images are allowed")]
    TooManyReferences,
    #[error("prompt must be at most 4000 characters")]
    PromptTooLong,
    #[error("each reference image must be at most 10 MiB")]
    ReferenceTooLarge,
    #[error("reference images must total at most 20 MiB")]
    ReferencesTooLarge,
    #[error("fast quality only supports 1K resolution")]
    UnsupportedQualityResolution,
    #[error("unsupported reference image type: {0}")]
    UnsupportedReferenceType(String),
    #[error("invalid {0}: {1}")]
    InvalidOption(&'static str, String),
    #[error("could not read reference image {path}: {source}")]
    ReferenceRead {
        path: String,
        source: std::io::Error,
    },
    #[error("reference image must be a PNG, JPEG, or WebP: {0}")]
    ReferenceExtension(String),
    #[error("invalid reference data URI")]
    InvalidReferenceData,
    #[error("nib service request failed: {0}")]
    Service(String),
    #[error("could not write generated image {path}: {source}")]
    OutputWrite {
        path: String,
        source: std::io::Error,
    },
}

impl UiError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PromptOrResumeRequired => "PROMPT_OR_RESUME_REQUIRED",
            Self::TooManyReferences => "TOO_MANY_REFERENCES",
            Self::PromptTooLong => "PROMPT_TOO_LONG",
            Self::ReferenceTooLarge | Self::ReferencesTooLarge => "REFERENCE_TOO_LARGE",
            Self::UnsupportedQualityResolution => "UNSUPPORTED_QUALITY_RESOLUTION",
            Self::UnsupportedReferenceType(_) | Self::ReferenceExtension(_) => {
                "UNSUPPORTED_REFERENCE_TYPE"
            }
            Self::InvalidOption(_, _) => "INVALID_OPTION",
            Self::ReferenceRead { .. } | Self::InvalidReferenceData => "INVALID_REFERENCE",
            Self::Service(_) => "SERVICE_ERROR",
            Self::OutputWrite { .. } => "OUTPUT_WRITE_ERROR",
        }
    }
}
