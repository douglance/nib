//! GPUI-based graphical interface for Nib
//!
//! This crate provides the graphical annotation editor using GPUI.
//! Note: GPUI requires special setup. See https://www.gpui.rs/

pub mod app;
pub mod canvas;
pub mod color_picker;
pub mod elements;
pub mod group;
pub mod history;
pub mod layout;
pub mod sidebar;
pub mod style_panel;
pub mod tool_flyout;
pub mod toolbar;
pub mod tools;
pub mod zorder;

pub use app::NibApp;
pub use app::{
    annotations_file_path, deserialize_annotation, AnnotationGeometry, AnnotationsFile,
    SerializedAnnotation,
};

// Re-export commonly used tool types for convenience
pub use tools::{
    Modifiers, MouseButton, Tool, ToolContext, ToolEvent, ToolId, ToolManager, ToolMode,
    ToolPreview, ToolResult,
};
