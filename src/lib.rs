//! Nib - Fast, native screenshot annotation tool
//!
//! Nib enables visual communication between humans and Claude AI through
//! semantic annotations. Each visual mark carries machine-readable meaning.
//!
//! # Features
//!
//! - **Screen Capture**: Full screen, region, or window capture
//! - **Annotations**: Rich annotation tools (arrows, boxes, text, numbers, blur)
//! - **QML Format**: Quick Markup Language for semantic annotations
//! - **Self-Describing Images**: Annotations embedded in PNG metadata
//!
//! # Quick Start
//!
//! ```no_run
//! use nib::capture;
//! use nib::core::{Annotation, AnnotationType, Point, ArrowHead};
//!
//! // Capture screen region
//! let image = capture::capture_screen(0)?;
//!
//! // Add annotation
//! let arrow = Annotation::new(AnnotationType::Arrow {
//!     start: Point::new(100.0, 100.0),
//!     end: Point::new(200.0, 200.0),
//!     head: ArrowHead::End,
//!     stroke_width: 2.0,
//! }).with_label("Look here");
//! # Ok::<(), nib::core::NibError>(())
//! ```

pub mod capture;
pub mod cli;
pub mod collab;
pub mod core;
pub mod events;
pub mod grid;
pub mod gui;
pub mod mcp;
pub mod ocr;
pub mod storage;

/// Re-export commonly used types
pub mod prelude {
    pub use crate::core::{
        Annotation, AnnotationId, AnnotationType, ArrowHead, BlurIntensity, Color, ImageSource,
        Point, NibError, NibImage, Region, Result, Severity, StrokeStyle, TextAlign,
    };
}
