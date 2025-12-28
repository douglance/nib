//! GUI module - GPUI-based graphical interface
//!
//! This module provides the graphical annotation editor using GPUI.
//! Note: GPUI requires special setup. See https://www.gpui.rs/

pub mod app;
pub mod canvas;
pub mod color_picker;
pub mod elements;
pub mod sidebar;
pub mod toolbar;
pub mod window;

pub use app::QuillApp;
